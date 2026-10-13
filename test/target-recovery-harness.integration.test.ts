import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatModel, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import type { TargetOperationPolicy, TargetRecoveryGate, TargetRunBindingRecord, TargetRuntimeProvider } from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { TargetRecoveryService } from '../src/application/target-recovery-service.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const capturedAt = '2026-10-12T02:00:00.000Z';

describe('Target Harness recovery across runtime restart', () => {
  it.each([
    {
      label: 'same tool version and schema',
      resumedVersion: 'test.operation.v1',
      resumedSchema: z.object({}).strict(),
      expectedActionCalls: 1,
      removeDefinitionDigestBeforeConfirmation: false,
      approveBeforeRestart: false,
      expectConfirmationRejected: false,
      expectedRuntimeAcquisitions: 3,
      rejectAfterTargetRevocation: false,
    },
    {
      label: 'changed tool implementation version after approval',
      resumedVersion: 'test.operation.v2',
      resumedSchema: z.object({}).strict(),
      expectedActionCalls: 0,
      removeDefinitionDigestBeforeConfirmation: false,
      approveBeforeRestart: true,
      expectConfirmationRejected: false,
      expectedRuntimeAcquisitions: 3,
      rejectAfterTargetRevocation: false,
    },
    {
      label: 'changed tool input schema after approval',
      resumedVersion: 'test.operation.v1',
      resumedSchema: z.object({ approvalNonce: z.string().optional() }).strict(),
      expectedActionCalls: 0,
      removeDefinitionDigestBeforeConfirmation: false,
      approveBeforeRestart: true,
      expectConfirmationRejected: false,
      expectedRuntimeAcquisitions: 3,
      rejectAfterTargetRevocation: false,
    },
    {
      label: 'changed implementation before confirmation',
      resumedVersion: 'test.operation.v2',
      resumedSchema: z.object({}).strict(),
      expectedActionCalls: 0,
      removeDefinitionDigestBeforeConfirmation: false,
      approveBeforeRestart: false,
      expectConfirmationRejected: true,
      expectedRuntimeAcquisitions: 2,
      rejectAfterTargetRevocation: false,
    },
    {
      label: 'missing persisted tool definition digest',
      resumedVersion: 'test.operation.v1',
      resumedSchema: z.object({}).strict(),
      expectedActionCalls: 0,
      removeDefinitionDigestBeforeConfirmation: true,
      approveBeforeRestart: false,
      expectConfirmationRejected: true,
      expectedRuntimeAcquisitions: 1,
      rejectAfterTargetRevocation: false,
    },
    {
      label: 'user rejection remains available after Target revocation',
      resumedVersion: 'test.operation.v1',
      resumedSchema: z.object({}).strict(),
      expectedActionCalls: 0,
      removeDefinitionDigestBeforeConfirmation: false,
      approveBeforeRestart: false,
      expectConfirmationRejected: false,
      expectedRuntimeAcquisitions: 1,
      rejectAfterTargetRevocation: true,
    },
  ])('binds Target confirmation and resume to the current Tool definition with $label', async ({
    resumedVersion,
    resumedSchema,
    expectedActionCalls,
    removeDefinitionDigestBeforeConfirmation,
    approveBeforeRestart,
    expectConfirmationRejected,
    expectedRuntimeAcquisitions,
    rejectAfterTargetRevocation,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-target-recovery-'));
    const sqlitePath = join(root, 'target-runtime.sqlite');
    const clock = { now: () => new Date(capturedAt) };
    let persistence = createSqlitePersistence({ path: sqlitePath, clock });
    await createStaticTargetResolver({
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      identityRegistry: persistence.targetIdentityRegistry,
      knowledgePolicies: persistence.targetKnowledgePolicies,
      validationTime: capturedAt,
    });
    const identityPorts = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({
      ...identityPorts,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const runId = 'target-recovery-sqlite-resume';
    const requestId = 'request-target-recovery-sqlite-resume';
    const requestDigest = `sha256:v1:${'b'.repeat(64)}`;
    const binding: TargetRunBindingRecord = {
      bindingId: 'binding-target-recovery-sqlite-resume',
      targetId: snapshot.targetId,
      runId,
      rootRunId: runId,
      snapshotDigest: snapshot.digest,
      createdAt: capturedAt,
      requestId,
      requestDigest,
    };
    await persistence.targetBindings.reserveRequest({ requestId, targetId: snapshot.targetId, requestDigest, runId, createdAt: capturedAt });
    const claim = await persistence.targetStarts.claimStart({
      requestId,
      runId,
      targetId: snapshot.targetId,
      requestDigest,
      ownerId: 'runtime-owner-1',
      now: capturedAt,
      leaseUntil: new Date(Date.parse(capturedAt) + 60_000).toISOString(),
    });
    if (claim.status !== 'claimed') throw new Error('test Target start claim was not acquired');

    let initialModelCalls = 0;
    let resumedModelCalls = 0;
    let actionCalls = 0;
    const acquiredSnapshotDigests: string[] = [];
    const actionTool: Tool = {
      name: 'test.confirmed-operation',
      description: 'Runs one deterministic in-test operation after explicit confirmation.',
      kind: 'utility',
      source: 'builtin',
      implementationVersion: 'test.operation.v1',
      inputSchema: z.object({}).strict(),
      requireUserConfirm: true,
      call: async () => {
        actionCalls += 1;
        return { blocks: [{ type: 'text', text: 'operation completed' }] };
      },
    };
    const initialModel: ChatModel = {
      async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        initialModelCalls += 1;
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        return { toolCalls: [{ id: 'confirmed-operation-1', name: actionTool.name, input: {} }] };
      },
    };
    const resumedModel: ChatModel = {
      async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        resumedModelCalls += 1;
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        return { text: 'inspection completed', toolCalls: [] };
      },
    };
    const unusedBaseModel: ChatModel = {
      async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        throw new Error('Target-bound runs must use the model from their runtime lease.');
      },
    };
    const operationPolicy: TargetOperationPolicy = {
      authorize: async request => ({
        bindingId: request.binding.bindingId,
        runId: request.runId,
        rootRunId: request.rootRunId,
        snapshotDigest: request.snapshot.digest,
        operation: request.operation,
        capability: request.capability,
        policyEpoch: 1,
        signal: request.signal,
      }),
      validate: async (permit, request) => {
        if (request.signal.aborted || permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
    };
    const makeGate = (
      state: typeof persistence,
      model: ChatModel,
      runtimeTools: readonly Tool[] = [actionTool],
    ): TargetRecoveryGate => new TargetRecoveryService({
      bindings: state.targetBindings,
      identityRegistry: identityPorts.identityRegistry,
      resolver,
      operationPolicy,
      runtimeProvider: {
        acquire: async acquiredSnapshot => {
          acquiredSnapshotDigests.push(acquiredSnapshot.digest);
          expect(await state.targetBindings.getBinding(runId)).toEqual(binding);
          expect(await state.targetBindings.getSnapshot(binding.bindingId)).toEqual(snapshot);
          return { model, tools: runtimeTools, release: () => {} };
        },
      },
      clock,
    });
    const makeRuntime = (state: typeof persistence, gate: TargetRecoveryGate, model = unusedBaseModel) => createAgentRuntime({
      model,
      workspaceRoots: [],
      tools: [],
      includeExternalBash: false,
      durableState: state,
      targetRecoveryGate: gate,
      clock,
    });

    let firstRuntime: ReturnType<typeof createAgentRuntime> | undefined;
    let resumedRuntime: ReturnType<typeof createAgentRuntime> | undefined;
    try {
      firstRuntime = makeRuntime(persistence, makeGate(persistence, initialModel));
      await firstRuntime.ready;
      const paused = await firstRuntime.agent.reply({
        runId,
        profileId: snapshot.profile.profileId,
        message: 'inspect the target and request the controlled operation',
        trustedTargetBinding: { binding, snapshot, startClaim: claim.claim },
      });
      expect(paused.status).toBe('awaiting_confirmation');
      expect(initialModelCalls).toBe(1);
      expect(actionCalls).toBe(0);
      const pending = await persistence.checkpoints.load(runId);
      expect(pending?.context.pendingInterrupt?.toolCallId).toBe('confirmed-operation-1');
      expect(typeof pending?.context.pendingInterrupt?.payload.toolDefinitionDigest).toBe('string');
      expect(acquiredSnapshotDigests).toEqual([snapshot.digest]);
      if (rejectAfterTargetRevocation) {
        if (pending === null) throw new Error('Expected pending Target confirmation before rejection.');
        const identitySnapshot = await identityPorts.identityRegistry.readSnapshot();
        await identityPorts.identityRegistry.publishCatalog({
          expectedVersion: identitySnapshot.version,
          presentTargetIds: [],
          candidates: [],
          publishedAt: capturedAt,
        });
        await firstRuntime.hitl.decide({
          runId,
          toolCallId: 'confirmed-operation-1',
          confirmed: false,
          actor: 'test-operator',
          decidedAt: capturedAt,
          expectedRevision: pending.revision,
        });
        const rejected = await persistence.checkpoints.load(runId);
        expect(rejected?.context.status).toBe('running');
        expect(rejected?.context.rejectedToolCallIds).toContain('confirmed-operation-1');
        expect(actionCalls).toBe(0);
        expect(acquiredSnapshotDigests).toEqual([snapshot.digest]);
        return;
      }
      if (approveBeforeRestart) {
        if (pending === null) throw new Error('Expected pending Target confirmation before restart.');
        await firstRuntime.hitl.decide({
          runId,
          toolCallId: 'confirmed-operation-1',
          confirmed: true,
          actor: 'test-operator',
          decidedAt: capturedAt,
          expectedRevision: pending.revision,
        });
      }
      await firstRuntime.close();
      firstRuntime = undefined;
      persistence.close();

      persistence = createSqlitePersistence({ path: sqlitePath, clock });
      expect(await persistence.targetBindings.getBinding(runId)).toEqual(binding);
      expect(await persistence.targetBindings.getSnapshot(binding.bindingId)).toEqual(snapshot);
      const reopenedCheckpoint = await persistence.checkpoints.load(runId);
      expect(reopenedCheckpoint?.context.status).toBe(approveBeforeRestart ? 'running' : 'awaiting_confirmation');
      if (reopenedCheckpoint === null) throw new Error('Expected the Target checkpoint after reopening SQLite.');
      let confirmationCheckpoint = reopenedCheckpoint;
      if (removeDefinitionDigestBeforeConfirmation) {
        const contextWithoutDefinitionDigest = structuredClone(reopenedCheckpoint.context);
        if (contextWithoutDefinitionDigest.pendingInterrupt === undefined) {
          throw new Error('Expected the pending Target interrupt after reopening SQLite.');
        }
        delete contextWithoutDefinitionDigest.pendingInterrupt.payload.toolDefinitionDigest;
        confirmationCheckpoint = await persistence.checkpoints.save(contextWithoutDefinitionDigest, reopenedCheckpoint.revision);
      }

      const resumedActionTool: Tool = {
        ...actionTool,
        implementationVersion: resumedVersion,
        inputSchema: resumedSchema,
      };
      resumedRuntime = createAgentRuntime({
        model: unusedBaseModel,
        workspaceRoots: [],
        tools: [actionTool],
        includeExternalBash: false,
        durableState: persistence,
        targetRecoveryGate: makeGate(persistence, resumedModel, [resumedActionTool]),
        clock,
      });
      await resumedRuntime.ready;
      if (!approveBeforeRestart) {
        const confirmation = resumedRuntime.hitl.decide({
          runId,
          toolCallId: 'confirmed-operation-1',
          confirmed: true,
          actor: 'test-operator',
          decidedAt: capturedAt,
          expectedRevision: confirmationCheckpoint.revision,
        });
        if (expectConfirmationRejected) {
          await expect(confirmation).rejects.toThrow();
          const unchanged = await persistence.checkpoints.load(runId);
          expect(unchanged?.context.status).toBe('awaiting_confirmation');
          expect(unchanged?.context.confirmedToolCallIds).not.toContain('confirmed-operation-1');
          expect(actionCalls).toBe(0);
          expect(acquiredSnapshotDigests).toHaveLength(expectedRuntimeAcquisitions);
          return;
        }
        await confirmation;
      }
      const resumed = await drain(resumedRuntime.agent.resumeStream(runId));

      expect(resumed.status).toBe('completed');
      expect(initialModelCalls).toBe(1);
      expect(resumedModelCalls).toBe(1);
      expect(actionCalls).toBe(expectedActionCalls);
      if (expectedActionCalls === 0) {
        const terminal = await persistence.checkpoints.load(runId);
        const rejectedResult = terminal?.context.messages.flatMap(message => message.blocks)
          .find(block => block.type === 'tool_result' && block.result.toolCallId === 'confirmed-operation-1');
        expect(rejectedResult).toMatchObject({
          type: 'tool_result',
          result: { status: 'aborted', error: { code: 'POLICY_DENIED' } },
        });
      }
      expect(acquiredSnapshotDigests).toEqual(Array.from({ length: expectedRuntimeAcquisitions }, () => snapshot.digest));
      expect((await resumedRuntime.eventStoreV2.readRun(runId, 0, 1_000)).map(event => event.type))
        .toContain('RUN_RESUMED');
    } finally {
      await resumedRuntime?.close();
      await firstRuntime?.close();
      persistence.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not accept an external result against a stale global Tool when the Target Tool definition changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-target-external-result-'));
    const sqlitePath = join(root, 'target-external-result.sqlite');
    const clock = { now: () => new Date(capturedAt) };
    const persistence = createSqlitePersistence({ path: sqlitePath, clock });
    await createStaticTargetResolver({
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      identityRegistry: persistence.targetIdentityRegistry,
      knowledgePolicies: persistence.targetKnowledgePolicies,
      validationTime: capturedAt,
    });
    const identityPorts = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({
      ...identityPorts,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const runId = 'target-external-result-version-drift';
    const requestId = 'request-target-external-result-version-drift';
    const requestDigest = `sha256:v1:${'c'.repeat(64)}`;
    const binding: TargetRunBindingRecord = {
      bindingId: 'binding-target-external-result-version-drift',
      targetId: snapshot.targetId,
      runId,
      rootRunId: runId,
      snapshotDigest: snapshot.digest,
      createdAt: capturedAt,
      requestId,
      requestDigest,
    };
    let targetImplementationVersion = 'target.external.v1';
    const makeExternalTool = (version: () => string): Tool => ({
      name: 'test.target-external-operation',
      description: 'A host-executed Target operation.',
      kind: 'utility',
      source: 'external',
      get implementationVersion() { return version(); },
      inputSchema: z.object({}).strict(),
      userFacingLabel: () => 'Run Target operation',
    });
    const targetTool = makeExternalTool(() => targetImplementationVersion);
    const globalTool = makeExternalTool(() => 'target.external.v1');
    const model: ChatModel = {
      async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        return { toolCalls: [{ id: 'target-external-operation-1', name: targetTool.name, input: {} }] };
      },
    };
    const operationPolicy: TargetOperationPolicy = {
      authorize: async request => ({
        bindingId: request.binding.bindingId,
        runId: request.runId,
        rootRunId: request.rootRunId,
        snapshotDigest: request.snapshot.digest,
        operation: request.operation,
        capability: request.capability,
        policyEpoch: 1,
        signal: request.signal,
      }),
      validate: async (permit, request) => {
        if (request.signal.aborted || permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
    };
    const gate = new TargetRecoveryService({
      bindings: persistence.targetBindings,
      identityRegistry: identityPorts.identityRegistry,
      resolver,
      operationPolicy,
      runtimeProvider: {
        acquire: async () => ({ model, tools: [targetTool], release: () => {} }),
      },
      clock,
    });
    await persistence.targetBindings.reserveRequest({ requestId, targetId: snapshot.targetId, requestDigest, runId, createdAt: capturedAt });
    const claim = await persistence.targetStarts.claimStart({
      requestId,
      runId,
      targetId: snapshot.targetId,
      requestDigest,
      ownerId: 'external-result-owner',
      now: capturedAt,
      leaseUntil: new Date(Date.parse(capturedAt) + 60_000).toISOString(),
    });
    if (claim.status !== 'claimed') throw new Error('test Target start claim was not acquired');
    const runtime = createAgentRuntime({
      model: { async *stream() { throw new Error('Target runs must use their leased model.'); } },
      workspaceRoots: [],
      tools: [globalTool],
      includeExternalBash: false,
      durableState: persistence,
      targetRecoveryGate: gate,
      clock,
    });

    try {
      await runtime.ready;
      const paused = await runtime.agent.reply({
        runId,
        profileId: snapshot.profile.profileId,
        message: 'request a host operation',
        trustedTargetBinding: { binding, snapshot, startClaim: claim.claim },
      });
      expect(paused.status).toBe('paused');
      const checkpoint = await persistence.checkpoints.load(runId);
      expect(typeof checkpoint?.context.pendingInterrupt?.payload.toolDefinitionDigest).toBe('string');
      if (checkpoint === null) throw new Error('Expected pending Target external-execution checkpoint.');

      const originalLoad = persistence.checkpoints.load.bind(persistence.checkpoints);
      const checkpointRead = vi.spyOn(persistence.checkpoints, 'load').mockImplementation(async requestedRunId => {
        const loaded = await originalLoad(requestedRunId);
        if (requestedRunId !== runId || loaded === null) return loaded;
        const contextWithoutBinding = structuredClone(loaded.context);
        delete contextWithoutBinding.targetBindingId;
        return { ...loaded, context: contextWithoutBinding };
      });
      const executionRead = vi.spyOn(persistence.executions, 'get');
      try {
        await expect(runtime.externalTools.submit({
          runId,
          toolCallId: 'target-external-operation-1',
          response: { blocks: [{ type: 'text', text: 'result submitted without checkpoint Target binding' }] },
        })).rejects.toThrow();
        expect(executionRead).not.toHaveBeenCalled();
      } finally {
        checkpointRead.mockRestore();
        executionRead.mockRestore();
      }

      targetImplementationVersion = 'target.external.v2';
      await expect(runtime.externalTools.submit({
        runId,
        toolCallId: 'target-external-operation-1',
        response: { blocks: [{ type: 'text', text: 'completed by old implementation' }] },
      })).rejects.toThrow();

      const unchanged = await persistence.checkpoints.load(runId);
      expect(unchanged?.context.status).toBe('paused');
      expect(unchanged?.context.pendingInterrupt?.interruptType).toBe('external_tool_execution');
    } finally {
      await runtime.close();
      persistence.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not resume or call external capabilities after the bound Target is revoked', async () => {
    const clock = { now: () => new Date(capturedAt) };
    const identityPorts = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({
      ...identityPorts,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const registryVersion = snapshot.identityRegistryVersion;
    if (registryVersion === undefined) throw new Error('Resolved snapshot is missing its identity registry version.');
    const durable = new InMemoryDurableState(clock, undefined, () => registryVersion);
    const runId = 'target-recovery-restart-test';
    const requestId = 'request-target-recovery-restart-test';
    const requestDigest = `sha256:v1:${'a'.repeat(64)}`;
    await durable.targetBindings.reserveRequest({ requestId, targetId: snapshot.targetId, requestDigest, runId, createdAt: capturedAt });
    const claim = await durable.targetStarts.claimStart({
      requestId,
      runId,
      targetId: snapshot.targetId,
      requestDigest,
      ownerId: 'runtime-owner-1',
      now: capturedAt,
      leaseUntil: new Date(Date.parse(capturedAt) + 60_000).toISOString(),
    });
    if (claim.status !== 'claimed') throw new Error('test Target start claim was not acquired');
    const binding: TargetRunBindingRecord = {
      bindingId: 'binding-target-recovery-restart-test',
      targetId: snapshot.targetId,
      runId,
      rootRunId: runId,
      snapshotDigest: snapshot.digest,
      createdAt: capturedAt,
      requestId,
      requestDigest,
    };

    let modelCalls = 0;
    let runtimeAcquisitions = 0;
    const model: ChatModel = {
      async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        modelCalls += 1;
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        return { text: 'inspection finished', toolCalls: [] };
      },
    };
    const operationPolicy: TargetOperationPolicy = {
      authorize: async request => ({
        bindingId: request.binding.bindingId,
        runId: request.runId,
        rootRunId: request.rootRunId,
        snapshotDigest: request.snapshot.digest,
        operation: request.operation,
        capability: request.capability,
        policyEpoch: 1,
        signal: request.signal,
      }),
      validate: async (permit, request) => {
        if (request.signal.aborted || permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
    };
    const runtimeProvider: TargetRuntimeProvider = {
      acquire: async () => {
        runtimeAcquisitions += 1;
        expect(await durable.targetBindings.getBinding(runId)).toEqual(binding);
        expect(await durable.checkpoints.load(runId)).toMatchObject({
          context: { targetBindingId: binding.bindingId },
        });
        expect(modelCalls).toBe(0);
        return { model, tools: [], release: () => {} };
      },
    };
    const createRecoveryGate = (): TargetRecoveryGate => new TargetRecoveryService({
      bindings: durable.targetBindings,
      identityRegistry: identityPorts.identityRegistry,
      resolver,
      operationPolicy,
      runtimeProvider,
      clock,
    });
    const createRuntime = (withRecoveryGate = true) => createAgentRuntime({
      model,
      workspaceRoots: [],
      tools: [],
      includeExternalBash: false,
      durableState: durable,
      ...(withRecoveryGate ? { targetRecoveryGate: createRecoveryGate() } : {}),
      clock,
    });

    const firstRuntime = createRuntime();
    await firstRuntime.ready;
    try {
      const result = await firstRuntime.agent.reply({
        runId,
        profileId: snapshot.profile.profileId,
        message: 'inspect the target',
        trustedTargetBinding: { binding, snapshot, startClaim: claim.claim },
      });
      expect(result.status).toBe('completed');
      expect(modelCalls).toBe(1);
      expect(runtimeAcquisitions).toBe(1);
    } finally {
      await firstRuntime.close();
    }

    const noGateRuntime = createRuntime(false);
    await noGateRuntime.ready;
    try {
      const eventsBeforeResume = await noGateRuntime.eventStoreV2.readRun(runId, 0, 1_000);
      const resume = noGateRuntime.agent.resumeStream(runId);
      await expect(resume.next()).rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
      const eventsAfterResume = await noGateRuntime.eventStoreV2.readRun(runId, 0, 1_000);
      expect(eventsAfterResume).toHaveLength(eventsBeforeResume.length);
      expect(modelCalls).toBe(1);
      expect(runtimeAcquisitions).toBe(1);
    } finally {
      await noGateRuntime.close();
    }

    const identitySnapshot = await identityPorts.identityRegistry.readSnapshot();
    await identityPorts.identityRegistry.publishCatalog({
      expectedVersion: identitySnapshot.version,
      presentTargetIds: [],
      candidates: [],
      publishedAt: capturedAt,
    });

    const restartedRuntime = createRuntime();
    await restartedRuntime.ready;
    try {
      const eventsBeforeResume = await restartedRuntime.eventStoreV2.readRun(runId, 0, 1_000);
      const resume = restartedRuntime.agent.resumeStream(runId);
      await expect(resume.next()).rejects.toMatchObject({ code: 'TARGET_IDENTITY_UNPROVEN' });
      const eventsAfterResume = await restartedRuntime.eventStoreV2.readRun(runId, 0, 1_000);

      expect(eventsAfterResume.map(event => event.type)).not.toContain('RUN_RESUMED');
      expect(eventsAfterResume).toHaveLength(eventsBeforeResume.length);
      expect(modelCalls).toBe(1);
      expect(runtimeAcquisitions).toBe(1);
    } finally {
      await restartedRuntime.close();
    }
  });
});

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
