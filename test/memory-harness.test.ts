import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import type {
  AgentMessage,
  ChatModel,
  MemoryHint,
  MemoryScope,
  MemorySelection,
  MemoryPolicyPort,
  MemoryRecallPort,
  MemoryHintRenderer,
  ModelResponse,
  ModelStreamEvent,
  RunMemoryControl,
  RunMemoryState,
  Tool,
} from '../src/contracts/index.js';
import type { MemoryCoordinatorPort } from '../src/contracts/diagnostic-memory.js';
import type { PreparedEpisodicMemoryView } from '../src/contracts/diagnostic-memory.js';
import { toolInputJsonSchema } from '../src/tool/schema.js';
import { fixture as knowledgeFixture, now as knowledgeNow } from './helpers/memory-coordinator-fixture.js';
import { MemoryCoordinator } from '../src/memory/memory-coordinator.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import type { TargetRecoveryGate } from '../src/contracts/target.js';

describe('Harness governed knowledge qualification', () => {
  it.each([
    { requiredness: 'required' as const, timing: 'reasoning' }, { requiredness: 'optional' as const, timing: 'reasoning' },
    { requiredness: 'required' as const, timing: 'authorize' },
    { requiredness: 'optional' as const, timing: 'reasoning', episodic: true },
  ])('qualifies $requiredness revocation during $timing without rewriting prose', async ({ requiredness, timing, episodic }) => {
    const f = await knowledgeFixture(requiredness);
    const modelRequests: AgentMessage[][] = [];
    const model: ChatModel = { async *stream(messages): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      modelRequests.push(structuredClone(messages));
      if (timing === 'authorize') expect(JSON.stringify(messages)).not.toContain('A completed settlement');
      else if (!episodic) expect(JSON.stringify(messages)).toContain('A completed settlement');
      yield { type: 'text_delta', delta: '健康结论已生成' };
      f.setState({ ...f.getState(), status: 'revoked', governanceVersion: 4 });
      return { text: '健康结论已生成', toolCalls: [] };
    } };
    const registryVersion = f.snapshot.identityRegistryVersion;
    if (registryVersion === undefined) throw new Error('Resolved snapshot is missing its identity registry version.');
    const durable = new InMemoryDurableState({ now: () => new Date(knowledgeNow) },
      { getPublicationVersion: () => 1 }, () => registryVersion);
    const binding = { bindingId: 'knowledge-binding', targetId: f.snapshot.targetId, runId: 'knowledge-run', rootRunId: 'knowledge-run',
      snapshotDigest: f.snapshot.digest, createdAt: knowledgeNow, requestId: 'knowledge-request', requestDigest: `sha256:v1:${'a'.repeat(64)}` };
    await durable.targetBindings.reserveRequest({ requestId: binding.requestId, targetId: binding.targetId,
      requestDigest: binding.requestDigest, runId: binding.runId, createdAt: binding.createdAt });
    const claim = await durable.targetStarts.claimStart({ ...binding, ownerId: 'test-owner', now: knowledgeNow,
      leaseUntil: '2026-10-12T00:01:00.000Z' });
    if (claim.status !== 'claimed') throw new Error('claim unavailable');
    const lease = { model, tools: [], release: () => {}, operations: { authorize: async () => {
      if (timing === 'authorize') f.setState({ ...f.getState(), status: 'revoked', governanceVersion: 4 });
      return { ...binding, operation: 'model' as const, capability: 'reasoning', policyEpoch: 1, signal: new AbortController().signal };
    }, validate: async () => {} } };
    const gate: TargetRecoveryGate = { acquireForStart: async () => lease, acquireForResume: async () => lease, authorizeResume: async () => {} };
    let coordinatorRecallCalls = 0;
    let preparedEpisodic: PreparedEpisodicMemoryView | undefined;
    const memory = memoryHarness();
    const coordinatorOptions = { ...f.options, ...(episodic ? { episodic: {
      policy: { allows: () => true }, renderer: memory.dependencies.renderer,
      recall: { prepare: async () => { coordinatorRecallCalls += 1; throw new Error('duplicate Episodic recall'); } },
    } } : {}) };
    const implementation = new MemoryCoordinator(coordinatorOptions);
    const coordinator: MemoryCoordinatorPort = {
      prepare: (input, operation) => {
        preparedEpisodic = input.episodic;
        return implementation.prepare(input, operation);
      },
      revalidate: (input, operation) => implementation.revalidate(input, operation),
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], tools: [], includeExternalBash: false, durableState: durable,
      targetRecoveryGate: gate, clock: { now: () => new Date(knowledgeNow) }, memoryHarness: {
        ...memory.dependencies, modelWindowTokens: 32768, coordinator,
      } });
    try {
      const result = await runtime.agent.reply({ runId: binding.runId, profileId: f.snapshot.profile.profileId, message: 'settlement',
        ...(episodic ? { trustedMemoryControl: control } : {}),
        trustedTargetBinding: { binding, snapshot: f.snapshot, startClaim: claim.claim } });
      const saved = await durable.checkpoints.load(binding.runId);
      expect(result.status, JSON.stringify(saved?.context.failure)).toBe('completed'); expect(result.finalText).toBe('健康结论已生成');
      const events = await runtime.eventStoreV2.readRun(binding.runId, 0, 100);
      const finished = events.find(event => event.type === 'RUN_FINISHED');
      expect(finished?.payload).toMatchObject({ outcome: requiredness === 'required' ? 'partial' : 'complete', finalText: '健康结论已生成' });
      expect(saved?.context.knowledgeQualification?.diagnosisReady).toBe(requiredness === 'optional');
      expect(saved?.context.messages.some(message => message.id.startsWith('knowledge-hint:'))).toBe(false);
      expect(saved?.context.evidenceIds).toEqual([]);
      if (episodic) {
        expect(preparedEpisodic?.state.hints).toEqual([hint]);
        expect(preparedEpisodic).toMatchObject({ attempted: true, succeeded: true });
        expect(coordinatorRecallCalls).toBe(0);
        const request = JSON.stringify(modelRequests[0]);
        expect(request.match(new RegExp(hint.summary, 'gu'))).toHaveLength(1);
      }
    } finally { await runtime.close(); }
  });
});

const now = '2026-10-10T12:00:00.000Z';
const scope: MemoryScope = {
  profileId: 'simulation',
  profileRevision: 'profile-r1',
  serviceId: 'settlement',
  faultType: 'settlement_failure',
  targetFingerprint: 'sim-target-1',
  environment: 'simulation',
  dataClass: 'simulated',
  datasetId: 'dataset-1',
};
const control: RunMemoryControl = {
  schemaVersion: 1,
  scope,
  profilePolicyRevision: 'policy-r1',
  capture: 'manual',
  recall: true,
};
const selection: MemorySelection = {
  memoryId: 'memory-case-1',
  revision: 1,
  digest: 'a'.repeat(64),
};
const hint: MemoryHint = {
  ...selection,
  sourceRunId: 'historical-run-1',
  capturedAt: '2026-10-01T00:00:00.000Z',
  validUntil: '2026-11-01T00:00:00.000Z',
  summary: '历史案例：结算失败与下游超时同时出现。',
  limitations: ['仅用于形成待验证假设'],
  evidenceRefs: [{
    evidenceId: 'historical-evidence-1',
    ownerRunId: 'historical-run-1',
    source: 'metric',
    capturedAt: '2026-10-01T00:00:00.000Z',
    rawSha256: 'b'.repeat(64),
  }],
  diagnosisOnly: true,
};

class CapturingModel implements ChatModel {
  public readonly requests: AgentMessage[][] = [];
  public readonly toolSchemas: Array<Array<{ name: string; schema: unknown }>> = [];

  public async *stream(
    messages: AgentMessage[],
    tools: Parameters<ChatModel['stream']>[1],
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.requests.push(structuredClone(messages));
    this.toolSchemas.push(tools.map((tool) => ({ name: tool.name, schema: toolInputJsonSchema(tool) })));
    await Promise.resolve();
    yield { type: 'text_delta', delta: '已完成巡检。' };
    return { text: '已完成巡检。', toolCalls: [] };
  }
}

class RepeatedQueryModel implements ChatModel {
  public readonly requests: AgentMessage[][] = [];
  private index = 0;

  public async *stream(messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.requests.push(structuredClone(messages));
    await Promise.resolve();
    yield { type: 'usage' };
    if (this.index < 5) {
      const call = { id: `repeat-${this.index + 1}`, name: 'metrics.repeat', input: { service: 'settlement' } };
      this.index += 1;
      return { toolCalls: [call] };
    }
    return { text: '已完成巡检。', toolCalls: [] };
  }
}

class MultiStepModel implements ChatModel {
  public readonly requests: AgentMessage[][] = [];
  private index = 0;

  public async *stream(messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.requests.push(structuredClone(messages));
    await Promise.resolve();
    yield { type: 'usage' };
    if (this.index < 2) {
      const index = this.index++;
      return { toolCalls: [{ id: `multi-step-${index}`, name: 'metrics.repeat', input: { service: `service-${index}` } }] };
    }
    return { text: '已完成巡检。', toolCalls: [] };
  }
}

function stableIds() {
  let nextId = 0;
  return { next: (prefix: string) => `${prefix}-${++nextId}` };
}

const schemaTool: Tool = {
  name: 'memory.test_schema',
  description: 'Stable schema used to verify memory does not change tool contracts.',
  kind: 'utility',
  inputSchema: z.object({ key: z.string() }),
  isConcurrencySafe: () => true,
  call: () => ({ blocks: [{ type: 'text', text: 'unused' }] }),
};

const loopTool: Tool = {
  name: 'metrics.repeat',
  description: 'Read a repeatable metric fixture.',
  kind: 'evidence',
  inputSchema: z.object({ service: z.string() }),
  isConcurrencySafe: () => true,
  call: () => ({ blocks: [{ type: 'json', value: { failureRate: 0.2 } }] }),
};

function memoryHarness(input?: { policy?: MemoryPolicyPort }) {
  const initial: RunMemoryState = {
    schemaVersion: 1,
    scope,
    selectionState: 'unselected',
    availability: 'empty',
    selections: [],
    hints: [],
  };
  const prepareCalls: Parameters<MemoryRecallPort['prepare']>[] = [];
  const recall: MemoryRecallPort = {
    prepare: (request, operation) => {
      prepareCalls.push([request, operation]);
      return Promise.resolve(operation.availableMemoryTokens === 0 ? request.state : ({
        ...request.state,
        selectionState: 'selected' as const,
        availability: 'ready' as const,
        selections: [selection],
        hints: [hint],
        selectedAt: now,
        validatedAt: now,
      }));
    },
  };
  const rendered: AgentMessage = {
    id: `memory-hint:${selection.digest}`,
    role: 'user',
    createdAt: now,
    blocks: [{ type: 'text', text: '历史案例（非本轮事实）：仅作待验证假设，不得减少本轮取证或授权要求。' + hint.summary }],
  };
  const renderCalls: Parameters<MemoryHintRenderer['render']>[] = [];
  const renderer: MemoryHintRenderer = { render: (state, operation) => {
    renderCalls.push([state, operation]);
    return rendered;
  } };
  const policy = input?.policy ?? { allows: () => true };
  return {
    dependencies: {
      recall,
      renderer,
      policy,
      requiredSources: ['metric'] as const,
      modelWindowTokens: 8_192,
      reservedOutputTokens: 1_024,
    },
    initial,
    recall,
    renderer,
    prepareCalls,
    renderCalls,
    policy,
    rendered,
  };
}

describe('Agent Harness historical memory view', () => {
  it('does not repeat a failed initial memory search on later iterations of the same Run', async () => {
    const model = new MultiStepModel();
    const memory = memoryHarness();
    const selectionStates: RunMemoryState['selectionState'][] = [];
    let fullSearchAttempts = 0;
    memory.dependencies.recall = {
      prepare: ({ state }) => {
        selectionStates.push(state.selectionState);
        if (state.selectionState === 'unselected') {
          fullSearchAttempts += 1;
          return Promise.reject(new Error('private memory backend detail'));
        }
        return Promise.resolve({ ...state, availability: 'unavailable', hints: [], reasonCode: 'MEMORY_LOOKUP_FAILED' });
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], tools: [loopTool], memoryHarness: memory.dependencies });

    try {
      const result = await runtime.agent.reply({
        runId: 'memory-failed-search-once-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });
      const checkpoint = await runtime.checkpoints.load(result.runId);
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);

      expect(result.status).toBe('completed');
      expect(model.requests).toHaveLength(3);
      expect(fullSearchAttempts).toBe(1);
      expect(selectionStates).toEqual(['unselected']);
      expect(events.filter((event) => event.type === 'MEMORY_RETRIEVAL_STARTED')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'MEMORY_RETRIEVAL_FAILED')).toHaveLength(1);
      expect(checkpoint?.memory).toMatchObject({
        selectionState: 'selected',
        availability: 'unavailable',
        selections: [],
        hints: [],
        reasonCode: 'MEMORY_LOOKUP_FAILED',
      });
    } finally {
      await runtime.close?.();
    }
  });

  it('adds an opted-in hint only to the current model call, while persisting recall state without evidence pollution', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness();
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });

    try {
      const stream = runtime.agent.replyStream({
        runId: 'memory-harness-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });
      const v1Types: string[] = [];
      let result: Awaited<ReturnType<typeof runtime.agent.reply>> | undefined;
      while (true) {
        const item = await stream.next();
        if (item.done) { result = item.value; break; }
        v1Types.push(item.value.type);
      }
      const checkpoint = await runtime.checkpoints.load(result.runId);
      const request = model.requests[0] ?? [];
      const storedMessages = checkpoint?.messages ?? [];
      const lifecycle = await runtime.eventStoreV2.readRun(result.runId, 0, 100);

      expect(memory.prepareCalls).toHaveLength(1);
      expect(memory.renderCalls).toHaveLength(1);
      expect(request.at(-1)).toEqual(memory.rendered);
      expect(request.slice(0, -1)).toEqual(storedMessages.slice(0, -1));
      expect(storedMessages).not.toContainEqual(memory.rendered);
      expect(checkpoint?.evidenceIds).not.toContain('historical-evidence-1');
      expect(checkpoint?.memory?.selections).toEqual([selection]);
      expect(checkpoint?.memory?.hints).toEqual([hint]);
      expect(lifecycle.map((event) => event.type)).toContain('MEMORY_RETRIEVAL_STARTED');
      expect(lifecycle.map((event) => event.type)).toContain('MEMORY_RETRIEVAL_COMPLETED');
      expect(lifecycle.filter((event) => event.type.startsWith('MEMORY_RETRIEVAL_'))
        .every((event) => event.visibility === 'audit')).toBe(true);
      expect(v1Types).toEqual(['RUN_STARTED', 'STEP_STARTED', 'REASONING_STARTED', 'TEXT_DELTA', 'RUN_FINISHED']);
      const retrieval = lifecycle.filter((event) => event.type.startsWith('MEMORY_RETRIEVAL_'));
      expect(retrieval.map((event) => event.type)).toEqual(['MEMORY_RETRIEVAL_STARTED', 'MEMORY_RETRIEVAL_COMPLETED']);
      expect(Object.keys(retrieval[0]!.payload).sort()).toEqual(['filters', 'limit', 'scopes']);
      expect(Object.keys(retrieval[1]!.payload).sort()).toEqual(['durationMs', 'hitCount', 'memoryIds']);
      const runStarted = lifecycle.findIndex((event) => event.type === 'RUN_STARTED');
      const stepStarted = lifecycle.findIndex((event) => event.type === 'STEP_STARTED');
      const reasoningStarted = lifecycle.findIndex((event) => event.type === 'REASONING_STARTED');
      expect(runStarted).toBeLessThan(lifecycle.indexOf(retrieval[0]!));
      expect(lifecycle.indexOf(retrieval[1]!)).toBeLessThan(stepStarted);
      expect(stepStarted).toBeLessThan(reasoningStarted);
      expect(JSON.stringify(lifecycle)).not.toContain(hint.summary);
      expect(result.status).toBe('completed');
    } finally {
      await runtime.close?.();
    }
  });

  it('leaves the model message view unchanged when memory is not configured', async () => {
    const model = new CapturingModel();
    const runtime = createAgentRuntime({ model, workspaceRoots: [] });

    try {
      const result = await runtime.agent.reply({
        runId: 'memory-disabled-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });
      const checkpoint = await runtime.checkpoints.load(result.runId);

      expect(model.requests[0]).toEqual(checkpoint?.messages.slice(0, model.requests[0]?.length));
      expect(checkpoint?.memory).toBeUndefined();
      expect(checkpoint?.memoryControl).toBeUndefined();
    } finally {
      await runtime.close?.();
    }
  });

  it('keeps the model input and tool schemas byte-identical when recall is disabled', async () => {
    const baselineModel = new CapturingModel();
    const optedInModel = new CapturingModel();
    const memory = memoryHarness();
    const clock = { now: () => new Date(now) };
    const input = {
      runId: 'memory-disabled-view-run',
      profileId: 'simulation',
      message: '检查结算失败率升高',
      trustedSystemContext: 'Profile=simulation; service=settlement; read-only inspection.',
    };
    const baselineRuntime = createAgentRuntime({
      model: baselineModel,
      workspaceRoots: [],
      tools: [schemaTool],
      clock,
      ids: stableIds(),
    });
    const optedInRuntime = createAgentRuntime({
      model: optedInModel,
      workspaceRoots: [],
      tools: [schemaTool],
      memoryHarness: memory.dependencies,
      clock,
      ids: stableIds(),
    });

    try {
      await baselineRuntime.agent.reply(input);
      await optedInRuntime.agent.reply({ ...input, trustedMemoryControl: { ...control, recall: false } });

      expect(JSON.stringify(optedInModel.requests[0])).toBe(JSON.stringify(baselineModel.requests[0]));
      expect(optedInModel.toolSchemas[0]).toEqual(baselineModel.toolSchemas[0]);
      expect(memory.prepareCalls).toHaveLength(0);
      expect(memory.renderCalls).toHaveLength(0);
    } finally {
      await baselineRuntime.close?.();
      await optedInRuntime.close?.();
    }
  });

  it('reserves window budget for the ephemeral loop-hint system message', async () => {
    const clock = { now: () => new Date(now) };
    const baselineModel = new RepeatedQueryModel();
    const baselineRuntime = createAgentRuntime({
      model: baselineModel,
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [loopTool],
      clock,
      ids: stableIds(),
    });
    let baseBytes: number;
    try {
      await baselineRuntime.agent.reply({ runId: 'memory-loop-budget-baseline', profileId: 'simulation',
        message: '检查结算失败率升高', maxIterations: 7 });
      const loopIndex = baselineModel.requests.findIndex((messages) => messages.some((message) => message.id.startsWith('loop-hint:')));
      expect(loopIndex).toBeGreaterThanOrEqual(0);
      const tools = baselineRuntime.toolkit.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toolInputJsonSchema(tool),
      }));
      baseBytes = Buffer.byteLength(JSON.stringify({ messages: baselineModel.requests[loopIndex], tools }), 'utf8');
    } finally {
      await baselineRuntime.close?.();
    }

    const memoryModel = new RepeatedQueryModel();
    const memory = memoryHarness();
    const reservedOutputTokens = 1_024;
    const runtime = createAgentRuntime({
      model: memoryModel,
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [loopTool],
      memoryHarness: {
        ...memory.dependencies,
        modelWindowTokens: reservedOutputTokens + baseBytes + 32,
        reservedOutputTokens,
      },
      clock,
      ids: stableIds(),
    });
    try {
      await runtime.agent.reply({ runId: 'memory-loop-budget-run', profileId: 'simulation',
        message: '检查结算失败率升高', maxIterations: 7,
        trustedMemoryControl: { ...control, recall: true } });
      const loopIndex = memoryModel.requests.findIndex((messages) => messages.some((message) => message.id.startsWith('loop-hint:')));

      expect(loopIndex).toBeGreaterThanOrEqual(0);
      expect(memory.prepareCalls[loopIndex]?.[1].availableMemoryTokens).toBe(0);
      expect(memoryModel.requests[loopIndex]?.some((message) => message.id.startsWith('memory-hint:'))).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });

  it('rejects memory injection when the runtime cannot atomically persist checkpoint and V2 facts', () => {
    const model = new CapturingModel();
    const memory = memoryHarness();

    expect(() => createAgentRuntime({
      model,
      workspaceRoots: [],
      checkpoints: new InMemoryCheckpointStore(),
      memoryHarness: memory.dependencies,
    })).toThrow(/durable/i);
  });

  it('passes zero memory allowance when the post-compression input already consumes the configured window', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness();
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [],
      memoryHarness: {
        ...memory.dependencies,
        modelWindowTokens: 32,
        reservedOutputTokens: 16,
      },
    });

    try {
      const result = await runtime.agent.reply({
        runId: 'memory-zero-budget-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });

      expect(memory.prepareCalls).toHaveLength(1);
      expect(memory.prepareCalls[0]?.[0]).toMatchObject({ runId: result.runId });
      expect(memory.prepareCalls[0]?.[1]).toMatchObject({ availableMemoryTokens: 0 });
      expect(memory.renderCalls).toHaveLength(0);
      expect(model.requests[0]?.at(-1)).not.toEqual(memory.rendered);
    } finally {
      await runtime.close?.();
    }
  });

  it('does not query or render when the host policy revokes recall', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness({ policy: { allows: (_value, capability) => capability !== 'recall' } });
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });

    try {
      const result = await runtime.agent.reply({
        runId: 'memory-policy-denied-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });
      const checkpoint = await runtime.checkpoints.load(result.runId);

      expect(memory.prepareCalls).toHaveLength(0);
      expect(memory.renderCalls).toHaveLength(0);
      expect(checkpoint?.memory?.hints).toEqual([]);
      expect(model.requests[0]).toEqual(checkpoint?.messages.slice(0, model.requests[0]?.length));
    } finally {
      await runtime.close?.();
    }
  });

  it('fails closed without failing diagnosis when the memory policy port throws', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness({ policy: { allows: () => { throw new Error('private policy detail'); } } });
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });

    try {
      const result = await runtime.agent.reply({
        runId: 'memory-policy-error-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: control,
      });
      const checkpoint = await runtime.checkpoints.load(result.runId);
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);

      expect(result.status).toBe('completed');
      expect(memory.prepareCalls).toHaveLength(0);
      expect(memory.renderCalls).toHaveLength(0);
      expect(checkpoint?.memory?.availability).toBe('unavailable');
      expect(checkpoint?.memory?.hints).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('private policy detail');
    } finally {
      await runtime.close?.();
    }
  });

  it.each([
    { capture: 'manual' as const, recallEnabled: false, scheduled: false },
    { capture: 'manual' as const, recallEnabled: true, scheduled: false },
    { capture: 'automatic' as const, recallEnabled: false, scheduled: true },
    { capture: 'automatic' as const, recallEnabled: true, scheduled: true },
    { capture: 'skip' as const, recallEnabled: false, scheduled: false },
    { capture: 'skip' as const, recallEnabled: true, scheduled: false },
  ])('keeps automatic capture independent from recall ($capture, recall=$recallEnabled)', async ({ capture, recallEnabled, scheduled: shouldSchedule }) => {
    const model = new CapturingModel();
    const memory = memoryHarness();
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });

    try {
      const result = await runtime.agent.reply({
        runId: `memory-matrix-${capture}-${recallEnabled}`,
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: { ...control, capture, recall: recallEnabled },
      });
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
      const scheduledEvents = events.filter((event) => event.type === 'MEMORY_UPDATE_SCHEDULED');

      expect(result.status).toBe('completed');
      expect(scheduledEvents).toHaveLength(shouldSchedule ? 1 : 0);
      expect(memory.prepareCalls).toHaveLength(recallEnabled ? 1 : 0);
    } finally {
      await runtime.close?.();
    }
  });

  it('does not create automatic capture after the host revokes capture capability', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness({ policy: { allows: (_value, capability) => capability !== 'capture' } });
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });
    try {
      const result = await runtime.agent.reply({
        runId: 'memory-capture-revoked-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: { ...control, capture: 'automatic', recall: false },
      });
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);

      expect(result.status).toBe('completed');
      expect(events.some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });

  it('does not create automatic capture when an AbortSignal cancels a Run', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness();
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });
    const controller = new AbortController();
    controller.abort(new Error('test abort'));
    try {
      const result = await runtime.agent.reply({
        runId: 'memory-aborted-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        signal: controller.signal,
        trustedMemoryControl: { ...control, capture: 'automatic', recall: false },
      });
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);

      expect(result.status).toBe('cancelled');
      expect(events.some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });

  it('does not create automatic capture when the stream consumer closes early', async () => {
    const model = new CapturingModel();
    const memory = memoryHarness();
    const runtime = createAgentRuntime({ model, workspaceRoots: [], memoryHarness: memory.dependencies });
    try {
      const stream = runtime.agent.replyStream({
        runId: 'memory-consumer-closed-run',
        profileId: 'simulation',
        message: '检查结算失败率升高',
        trustedMemoryControl: { ...control, capture: 'automatic', recall: false },
      });
      const first = await stream.next();
      expect(first.done).toBe(false);
      await stream.return(undefined as never);
      const events = await runtime.eventStoreV2.readRun('memory-consumer-closed-run', 0, 100);
      const checkpoint = await runtime.checkpoints.load('memory-consumer-closed-run');

      expect(checkpoint?.status).toBe('cancelled');
      expect(events.some((event) => event.type === 'MEMORY_UPDATE_SCHEDULED')).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });
});
