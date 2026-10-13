import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { parseAgentContext } from '../src/storage/durable-codec.js';
import type { AgentMemoryHarness } from '../src/agent/types.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseResolvedTargetSnapshotV2 } from '../src/contracts/target-schema.js';
import type {
  AgentMessage,
  ChatModel,
  MemoryHint,
  MemoryPolicyPort,
  MemoryRecallPort,
  MemorySelection,
  ModelResponse,
  ModelStreamEvent,
  RunMemoryState,
  Tool,
} from '../src/contracts/index.js';
import type { TargetRecoveryGate } from '../src/contracts/target.js';
import { BoundedMemoryHintRenderer } from '../src/memory/hint-renderer.js';
import { MemoryCoordinator } from '../src/memory/memory-coordinator.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';
import { fixture as knowledgeFixture, now as knowledgeNow } from './helpers/memory-coordinator-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const value = memoryCase();
const selection: MemorySelection = { memoryId: value.id, revision: value.revision, digest: value.digest };
const hint: MemoryHint = {
  ...selection,
  sourceRunId: value.sourceRunId,
  capturedAt: value.capturedAt,
  validUntil: value.validUntil,
  summary: value.summary,
  limitations: ['历史证据仅用于形成待验证假设。'],
  evidenceRefs: value.evidenceRefs,
  diagnosisOnly: true,
};

class RecordingModel implements ChatModel {
  public readonly requests: AgentMessage[][] = [];

  public constructor(private readonly response: ModelResponse) {}

  public async *stream(
    messages: AgentMessage[],
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.requests.push(structuredClone(messages));
    await Promise.resolve();
    if (this.response.text !== undefined) yield { type: 'text_delta', delta: this.response.text };
    return this.response;
  }
}

function makeMemory(
  policy: MemoryPolicyPort,
  prepare?: MemoryRecallPort['prepare'],
): AgentMemoryHarness & { prepareCalls: Parameters<MemoryRecallPort['prepare']>[] } {
  const prepareCalls: Parameters<MemoryRecallPort['prepare']>[] = [];
  const recall: MemoryRecallPort = {
    prepare: (input, operation) => {
      prepareCalls.push([input, operation]);
      if (prepare !== undefined) return prepare(input, operation);
      return Promise.resolve({
        ...input.state,
        selectionState: 'selected' as const,
        availability: 'ready' as const,
        selections: [selection],
        hints: [hint],
        selectedAt: memoryNow,
        validatedAt: memoryNow,
      });
    },
  };
  return {
    recall,
    prepareCalls,
    renderer: new BoundedMemoryHintRenderer(),
    policy,
    requiredSources: ['metric'],
    modelWindowTokens: 8_192,
    reservedOutputTokens: 1_024,
  };
}

const queryTool: Tool = {
  name: 'metrics.query',
  description: 'Read a bounded metric window.',
  kind: 'evidence',
  requireUserConfirm: true,
  inputSchema: z.object({ service: z.string() }),
  call: () => ({ blocks: [{ type: 'text', text: 'metric evidence collected' }] }),
  isConcurrencySafe: () => true,
};

async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while (!(await stream.next()).done) { /* drain the resumed run */ }
}

describe('memory Harness checkpoint recovery', () => {
  it('rejects a confirmed pending Target ToolCall when required knowledge is revoked before SQLite resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-knowledge-hitl-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const f = await knowledgeFixture();
    const snapshotFields = { ...f.snapshot };
    Reflect.deleteProperty(snapshotFields, 'digest');
    const unsignedSnapshot = { ...snapshotFields, publicationVersion: 0 };
    const snapshot = parseResolvedTargetSnapshotV2({ ...unsignedSnapshot,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsignedSnapshot })}` });
    const runId = 'knowledge-hitl-recovery-run';
    const requestId = 'knowledge-hitl-recovery-request';
    const requestDigest = `sha256:v1:${'c'.repeat(64)}`;
    const binding = {
      bindingId: 'knowledge-hitl-recovery-binding',
      targetId: snapshot.targetId,
      runId,
      rootRunId: runId,
      snapshotDigest: snapshot.digest,
      createdAt: knowledgeNow,
      requestId,
      requestDigest,
    };
    const clock = { now: () => new Date(knowledgeNow) };
    let persistence = createSqlitePersistence({ path: sqlitePath, clock });
    await createStaticTargetResolver({
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      identityRegistry: persistence.targetIdentityRegistry,
      knowledgePolicies: persistence.targetKnowledgePolicies,
      validationTime: knowledgeNow,
    });
    expect(snapshot.identityRegistryVersion).toBe((await persistence.targetIdentityRegistry.readSnapshot()).version);
    await persistence.targetBindings.reserveRequest({ requestId, targetId: binding.targetId, requestDigest, runId, createdAt: knowledgeNow });
    const start = await persistence.targetStarts.claimStart({ requestId, runId, targetId: binding.targetId, requestDigest,
      ownerId: 'knowledge-hitl-recovery-owner', now: knowledgeNow, leaseUntil: '2026-10-12T00:01:00.000Z' });
    if (start.status !== 'claimed') throw new Error('test Target start claim was not acquired');

    const toolCallId = 'knowledge-revoked-confirmed-query';
    const queryCalls = vi.fn(() => ({ blocks: [{ type: 'text' as const, text: 'query executed after confirmation' }] }));
    const targetQueryTool: Tool = {
      ...queryTool,
      implementationVersion: 'metrics.query.v1',
      call: queryCalls,
    };
    const initialModel = new RecordingModel({
      toolCalls: [{ id: toolCallId, name: targetQueryTool.name, input: { service: 'checkout' } }],
    });
    const resumedModel = new RecordingModel({ text: '按最新资格重新推理后完成巡检。', toolCalls: [] });
    const makeGate = (model: ChatModel): TargetRecoveryGate => {
      const lease = {
        model,
        tools: [targetQueryTool],
        release: () => {},
        operations: {
          authorize: async ({ operation, capability, signal }: { operation: 'model' | 'source'; capability: string; signal: AbortSignal }) => ({
            bindingId: binding.bindingId,
            runId,
            rootRunId: runId,
            snapshotDigest: snapshot.digest,
            operation,
            capability,
            policyEpoch: 1,
            signal,
          }),
          validate: async () => {},
        },
      };
      return { acquireForStart: async () => lease, acquireForResume: async () => lease, authorizeResume: async () => {} };
    };
    const coordinatorMemory = makeMemory({ allows: () => true });
    const firstRuntime = createAgentRuntime({
      model: initialModel,
      memoryHarness: { ...coordinatorMemory, coordinator: new MemoryCoordinator(f.options) },
      workspaceRoots: [],
      tools: [],
      includeExternalBash: false,
      durableState: persistence,
      targetRecoveryGate: makeGate(initialModel),
      clock,
    });

    try {
      const paused = await firstRuntime.agent.reply({
        runId,
        profileId: snapshot.profile.profileId,
        message: '检查 checkout 的结算失败率',
        trustedTargetBinding: { binding, snapshot, startClaim: start.claim },
      });
      expect(paused.status).toBe('awaiting_confirmation');
      expect(queryCalls).not.toHaveBeenCalled();
      const pending = await persistence.checkpoints.load(runId);
      expect(pending?.context.knowledgeQualification).toMatchObject({ diagnosisReady: true, missingKnowledge: [] });
      expect(pending?.context.pendingInterrupt?.toolCallId).toBe(toolCallId);
      if (pending === null) throw new Error('Expected durable pending confirmation.');

      await firstRuntime.hitl.decide({ runId, toolCallId, confirmed: true, actor: 'memory-recovery-test',
        decidedAt: knowledgeNow, expectedRevision: pending.revision });
      const confirmed = await persistence.checkpoints.load(runId);
      expect(confirmed?.context.confirmedToolCallIds).toContain(toolCallId);
    } finally {
      await firstRuntime.close();
      persistence.close();
    }

    f.setState({ ...f.getState(), status: 'revoked', governanceVersion: 4 });
    persistence = createSqlitePersistence({ path: sqlitePath, clock });
    const resumedRuntime = createAgentRuntime({
      model: resumedModel,
      memoryHarness: { ...coordinatorMemory, coordinator: new MemoryCoordinator(f.options) },
      workspaceRoots: [],
      tools: [],
      includeExternalBash: false,
      durableState: persistence,
      targetRecoveryGate: makeGate(resumedModel),
      clock,
    });
    try {
      await drain(resumedRuntime.agent.resumeStream(runId));

      const resumed = await persistence.checkpoints.load(runId);
      const resultBlock = resumed?.context.messages.flatMap(message => message.blocks)
        .find(block => block.type === 'tool_result' && block.result.toolCallId === toolCallId);
      expect(queryCalls).not.toHaveBeenCalled();
      expect(resultBlock).toMatchObject({ type: 'tool_result', result: { status: 'aborted', error: { code: 'POLICY_DENIED' } } });
      expect(resumed?.context.pendingToolCalls).toEqual([]);
      expect(resumed?.context.pendingInterrupt).toBeUndefined();
      expect(resumed?.context.pendingToolBatch).toBeUndefined();
      expect(resumed?.context.confirmedToolCallIds).not.toContain(toolCallId);
      expect(resumed?.context.rejectedToolCallIds).toContain(toolCallId);
      expect(resumed?.context.knowledgeQualification?.diagnosisReady).toBe(false);
      expect(resumedModel.requests).toHaveLength(1);
      expect(JSON.stringify(resumedModel.requests[0])).toContain(toolCallId);
      expect(JSON.stringify(resumedModel.requests[0])).toContain('POLICY_DENIED');
      expect(JSON.stringify(resumedModel.requests[0])).not.toContain('A completed settlement');
      expect(resumed?.context.status).toBe('completed');
    } finally {
      await resumedRuntime.close();
      persistence.close();
    }
  });

  it('revalidates only the frozen selection and removes missing evidence after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-memory-harness-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const control = {
      schemaVersion: 1 as const,
      scope: simulationMemoryScope(),
      profilePolicyRevision: 'policy-v1',
      capture: 'automatic' as const,
      recall: true,
    };
    const firstModel = new RecordingModel({
      toolCalls: [{ id: 'memory-confirmed-query', name: 'metrics.query', input: { service: 'settlement' } }],
    });
    const queryCalls = vi.fn(() => ({ blocks: [{ type: 'text' as const, text: 'metric evidence collected' }] }));
    const recoveryQueryTool: Tool = { ...queryTool, call: queryCalls };
    const firstMemory = makeMemory({ allows: () => true });
    const firstRuntime = createAgentRuntime({
      model: firstModel,
      memoryHarness: firstMemory,
      workspaceRoots: [],
      sqlitePath,
      tools: [recoveryQueryTool],
    });

    let pausedRunId = '';
    let pausedStartedAt = '';
    let pausedIteration = 0;
    let pausedToolCallsUsed = 0;
    try {
      const paused = await firstRuntime.agent.reply({
        runId: 'memory-recovery-run',
        profileId: 'simulation',
        message: '检查结算失败率',
        trustedMemoryControl: control,
      });
      pausedRunId = paused.runId;
      expect(paused.status).toBe('awaiting_confirmation');
      expect(firstModel.requests[0]?.at(-1)).toMatchObject({ role: 'user' });
      expect(JSON.stringify(firstModel.requests[0])).toContain(value.summary);
      const pausedCheckpoint = await firstRuntime.checkpoints.load(paused.runId);
      expect(pausedCheckpoint?.budget.iteration).toBe(1);
      expect(pausedCheckpoint?.budget.toolCallsUsed).toBe(1);
      expect(queryCalls).not.toHaveBeenCalled();
      pausedStartedAt = pausedCheckpoint?.budget.startedAt ?? '';
      pausedIteration = pausedCheckpoint?.budget.iteration ?? 0;
      pausedToolCallsUsed = pausedCheckpoint?.budget.toolCallsUsed ?? 0;
      expect(pausedCheckpoint?.memory?.selections).toEqual([selection]);
      expect(pausedCheckpoint?.memory?.hints).toEqual([hint]);
      expect((await firstRuntime.eventStoreV2.readRun(paused.runId, 0, 200))
        .some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await firstRuntime.close?.();
    }

    const secondModel = new RecordingModel({ text: '已重新核验并完成巡检。', toolCalls: [] });
    const seenSnapshots: RunMemoryState[] = [];
    const revalidatedMemory = makeMemory({ allows: (_control, capability) => capability !== 'capture' }, ({ state }) => {
      seenSnapshots.push(structuredClone(state));
      return Promise.resolve({ ...state, availability: 'empty', hints: [], validatedAt: memoryNow });
    });
    const secondRuntime = createAgentRuntime({
      model: secondModel,
      memoryHarness: revalidatedMemory,
      workspaceRoots: [],
      sqlitePath,
      tools: [recoveryQueryTool],
    });

    try {
      await secondRuntime.hitl.decide({
        runId: pausedRunId,
        toolCallId: 'memory-confirmed-query',
        confirmed: true,
        actor: 'memory-recovery-test',
        decidedAt: memoryNow,
      });
      await drain(secondRuntime.agent.resumeStream(pausedRunId));

      const resumedCheckpoint = await secondRuntime.checkpoints.load(pausedRunId);
      const runEvents = await secondRuntime.eventStoreV2.readRun(pausedRunId, 0, 500);
      expect(queryCalls).toHaveBeenCalledOnce();
      expect(revalidatedMemory.prepareCalls).toHaveLength(1);
      expect(seenSnapshots[0]?.selectionState).toBe('selected');
      expect(seenSnapshots[0]?.selections).toEqual([selection]);
      expect(seenSnapshots[0]?.hints).toEqual([hint]);
      expect(secondModel.requests).toHaveLength(1);
      expect(JSON.stringify(secondModel.requests[0])).not.toContain(value.summary);
      expect(resumedCheckpoint?.memory?.selectionState).toBe('selected');
      expect(resumedCheckpoint?.memory?.selections).toEqual([selection]);
      expect(resumedCheckpoint?.memory?.hints).toEqual([]);
      expect(resumedCheckpoint?.memory?.availability).toBe('empty');
      expect(resumedCheckpoint?.budget.startedAt).toBe(pausedStartedAt);
      expect(resumedCheckpoint?.budget.iteration).toBeGreaterThan(pausedIteration);
      expect(resumedCheckpoint?.budget.toolCallsUsed).toBe(pausedToolCallsUsed);
      expect(runEvents.some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await secondRuntime.close?.();
    }
  });

  it('drops checkpointed hints on resume when the current Profile policy revokes recall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-memory-policy-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const runId = 'memory-policy-recovery-run';
    const control = {
      schemaVersion: 1 as const,
      scope: simulationMemoryScope(),
      profilePolicyRevision: 'policy-v1',
      capture: 'automatic' as const,
      recall: true,
    };
    const state: RunMemoryState = {
      schemaVersion: 1,
      scope: simulationMemoryScope(),
      selectionState: 'selected',
      availability: 'ready',
      selections: [selection],
      hints: [hint],
      selectedAt: memoryNow,
      validatedAt: memoryNow,
    };
    const context = parseAgentContext({
      runId,
      profileId: 'simulation',
      status: 'paused',
      stage: 'hypothesis',
      messages: [{ id: 'memory-policy-user', role: 'user', createdAt: memoryNow,
        blocks: [{ type: 'text', text: '检查结算失败率' }] }],
      pendingToolCalls: [],
      confirmedToolCallIds: [],
      rejectedToolCallIds: [],
      executedActions: [],
      evidenceIds: [],
      missingEvidence: [],
      budget: { startedAt: memoryNow, maxIterations: 10, iteration: 1,
        maxToolCalls: 10, toolCallsUsed: 1, maxDurationMs: 60_000 },
      contextVersion: 1,
      memoryControl: control,
      memory: state,
    });
    const seed = createSqlitePersistence({ path: sqlitePath, clock: { now: () => new Date(memoryNow) } });
    await seed.checkpoints.save(context, null);
    seed.close();

    const model = new RecordingModel({ text: '已按当前策略重新完成巡检。', toolCalls: [] });
    const memory = makeMemory({ allows: (_control, capability) => capability !== 'recall' && capability !== 'capture' });
    const runtime = createAgentRuntime({
      model,
      memoryHarness: memory,
      workspaceRoots: [],
      sqlitePath,
      clock: { now: () => new Date(memoryNow) },
    });
    try {
      await drain(runtime.agent.resumeStream(runId));
      const checkpoint = await runtime.checkpoints.load(runId);
      const events = await runtime.eventStoreV2.readRun(runId, 0, 200);

      expect(memory.prepareCalls).toHaveLength(0);
      expect(JSON.stringify(model.requests[0])).not.toContain(value.summary);
      expect(checkpoint?.memory?.selectionState).toBe('selected');
      expect(checkpoint?.memory?.selections).toEqual([selection]);
      expect(checkpoint?.memory?.hints).toEqual([]);
      expect(checkpoint?.memory?.availability).toBe('unavailable');
      expect(events.some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });
});
