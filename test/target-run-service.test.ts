import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModel, Clock } from '../src/contracts/index.js';
import type { DiagnosisAgent } from '../src/agent/types.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { TargetRunService } from '../src/application/target-run-service.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import type { ResolvedTargetSnapshotV2, TargetRecoveryGate, TargetRunBindingRecord,
  TargetRunRuntimeLease } from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import { fixture as publicationFixture } from './helpers/target-publication-fixture.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';

const now = '2026-10-11T10:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };
const runtimes: Array<Awaited<ReturnType<typeof createAgentRuntime>>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
});

async function createResolver() {
  return createStaticTargetResolver({
    ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
  });
}

function configureTestTargetGate(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  model: ChatModel,
): void {
  const makeLease = (binding: TargetRunBindingRecord, snapshot: ResolvedTargetSnapshotV2): TargetRunRuntimeLease => ({
    model,
    tools: [],
    operations: {
      authorize: async input => ({
        bindingId: binding.bindingId,
        runId: binding.runId,
        rootRunId: binding.rootRunId,
        snapshotDigest: snapshot.digest,
        operation: input.operation,
        capability: input.capability,
        policyEpoch: 1,
        signal: input.signal,
      }),
      validate: async permit => {
        if (permit.bindingId !== binding.bindingId || permit.snapshotDigest !== snapshot.digest
          || permit.policyEpoch !== 1 || permit.signal.aborted) {
          throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        }
      },
    },
    release: () => undefined,
  });
  const gate: TargetRecoveryGate = {
    acquireForStart: async input => makeLease(input.binding, input.snapshot),
    authorizeResume: async () => undefined,
    acquireForResume: async input => {
      const binding = await runtime.durableState?.targetBindings.getBinding(input.runId);
      const snapshot = binding === null || binding === undefined
        ? null
        : await runtime.durableState?.targetBindings.getSnapshot(binding.bindingId) ?? null;
      if (binding === null || binding === undefined || binding.bindingId !== input.targetBindingId
        || snapshot === null || snapshot.schemaVersion !== 2) {
        throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      }
      return makeLease(binding, snapshot);
    },
  };
  runtime.configureTargetRecoveryGate(gate);
}

describe('TargetRunService', () => {
  it('starts new Runs on the published overlay and never upgrades an already persisted Run snapshot', async () => {
    const f = await publicationFixture('memory');
    const state = new InMemoryDurableState(clock, f.memory, () => 1);
    const model = new ScriptedModel([{ text: 'ok', toolCalls: [] }, { text: 'ok', toolCalls: [] }, { text: 'ok', toolCalls: [] }]);
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock, durableState: state });
    runtimes.push(runtime);
    configureTestTargetGate(runtime, model);
    if (runtime.queries === undefined) throw new Error('Query ports unavailable');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, { targetStarts: state, clock });
    try {
      const r1 = await f.approved(1);
      await f.publisher.publishGoverned(await f.command([r1]));
      const service = new TargetRunService({ resolver: f.resolver, bindings: state, queries: runtime.queries, clock,
        start: { startAccepted: options => execution.startAccepted(options) } });
      const first = await service.start({ targetId: 'market-a-sim', requestId: 'published-run-one', message: 'inspect' });
      const binding = (await state.getBinding(first.runId))!;
      const old = (await state.getSnapshot(binding.bindingId))!;
      const r2 = await f.approved(2);
      const beforePublication = await service.start({ targetId: 'market-a-sim', requestId: 'published-run-two', message: 'inspect' });
      expect((await state.getSnapshot((await state.getBinding(beforePublication.runId))!.bindingId))!.knowledgeRefs[0]?.version).toBe('1');
      await f.publisher.publishGoverned(await f.command([r2], 1, 'publish-r2'));
      const second = await service.start({ targetId: 'market-a-sim', requestId: 'published-run-three', message: 'inspect' });
      expect(await state.getSnapshot((await state.getBinding(second.runId))!.bindingId)).toMatchObject({ publicationVersion: 2,
        knowledgeRefs: [{ id: r2.id, version: '2' }] });
      expect(await state.getSnapshot(binding.bindingId)).toEqual(old);
      expect(old).toMatchObject({ publicationVersion: 1, knowledgeRefs: [{ version: '1' }] });
    } finally { await execution.close(); f.database.close(); }
  });
  it('binds a new Run before any model request and scopes reads to the selected Target', async () => {
    const runtimeRef: { current?: Awaited<ReturnType<typeof createAgentRuntime>> } = {};
    const model: ChatModel = {
      async *stream(_messages, _tools, options) {
        const state = runtimeRef.current?.durableState;
        const binding = await state?.targetBindings.getBinding(options.runId);
        const snapshot = binding === null || binding === undefined
          ? null
          : await state?.targetBindings.getSnapshot(binding.bindingId);
        expect(binding).toMatchObject({
          runId: options.runId,
          rootRunId: options.runId,
          targetId: 'market-a-sim',
        });
        expect(snapshot).toMatchObject({ targetId: 'market-a-sim', profile: { profileId: 'market-a.lab.settlement' } });
        yield { type: 'text_delta', delta: 'ok' };
        return { text: 'ok', toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock,
      inMemoryTargetIdentityRegistryVersion: () => 1 });
    configureTestTargetGate(runtime, model);
    runtimeRef.current = runtime;
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      ...(runtime.durableState.targetStarts === undefined ? {} : { targetStarts: runtime.durableState.targetStarts }), clock,
    });
    const baseResolver = await createResolver();
    let resolveCalls = 0;
    let resolverUnavailable = false;
    const resolver = {
      listCatalog: () => baseResolver.listCatalog(),
      resolve: async (input: Parameters<typeof baseResolver.resolve>[0]) => {
        resolveCalls += 1;
        if (resolverUnavailable) throw new Error('current catalog is unavailable');
        return baseResolver.resolve(input);
      },
    };
    const service = new TargetRunService({
      resolver,
      bindings: runtime.durableState.targetBindings,
      queries: runtime.queries,
      clock,
      start: { startAccepted: options => execution.startAccepted(options) },
    });

    const accepted = await service.start({ targetId: 'market-a-sim', requestId: 'idem-1', message: 'inspect settlement failures' });
    expect(accepted.status).toBe('accepted');
    expect(await runtime.durableState.targetBindings.getBinding(accepted.runId)).toMatchObject({ targetId: 'market-a-sim' });
    expect(await service.getRun('market-a-sim', accepted.runId)).toMatchObject({ runId: accepted.runId });
    expect(await service.getRun('market-b-sim', accepted.runId)).toBeNull();
    expect((await service.listRuns('market-b-sim', { limit: 10 })).items).toEqual([]);

    const callsAfterFirstStart = resolveCalls;
    resolverUnavailable = true;
    const replayed = await service.start({ targetId: 'market-a-sim', requestId: 'idem-1', message: 'inspect settlement failures' });
    expect(replayed).toEqual({ runId: accepted.runId, status: 'reused' });
    expect(resolveCalls).toBe(callsAfterFirstStart);
    await expect(service.start({ targetId: 'market-a-sim', requestId: 'idem-1', message: 'different request' }))
      .rejects.toMatchObject({ code: 'TARGET_REQUEST_CONFLICT' });
    await expect(service.start({ targetId: 'market-b-sim', requestId: 'idem-1', message: 'inspect settlement failures' }))
      .rejects.toMatchObject({ code: 'TARGET_REQUEST_CONFLICT' });
    await execution.close();
  });

  it('does not advertise a Target as startable without an execution port', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), workspaceRoots: [], clock });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const service = new TargetRunService({
      resolver: await createResolver(), bindings: runtime.durableState.targetBindings,
      queries: runtime.queries, clock,
    });
    expect(service.listCatalog().every(item => !item.canStart)).toBe(true);
    await expect(service.start({ targetId: 'market-a-sim', requestId: 'no-runner', message: 'inspect' }))
      .rejects.toMatchObject({ code: 'TARGET_RUN_UNAVAILABLE' });
  });

  it('reports current required-knowledge blockers through a safe additive readiness result', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), workspaceRoots: [], clock });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const base = await createResolver();
    const resolver = {
      listCatalog: () => base.listCatalog(),
      resolve: async () => { throw new TargetConfigurationError('KNOWLEDGE_REQUIRED_DISABLED'); },
    };
    const service = new TargetRunService({ resolver, bindings: runtime.durableState.targetBindings,
      queries: runtime.queries, clock, start: { startAccepted: async () => undefined } });

    await expect(service.readiness('market-a-sim')).resolves.toEqual({ targetId: 'market-a-sim', status: 'blocked',
      canStart: false, reasonCode: 'KNOWLEDGE_REQUIRED_DISABLED' });
  });

  it('coalesces concurrent requests with the same idempotency key before the first binding commits', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'ok', toolCalls: [] }]), workspaceRoots: [], clock,
      inMemoryTargetIdentityRegistryVersion: () => 1,
    });
    const targetModel = new ScriptedModel([{ text: 'ok', toolCalls: [] }]);
    // Target model capabilities are isolated from the runtime-global model.
    runtime.configureTargetRecoveryGate({
      acquireForStart: async input => ({
        model: targetModel,
        tools: [],
        operations: { authorize: async request => ({
          bindingId: input.binding.bindingId, runId: input.binding.runId, rootRunId: input.binding.rootRunId,
          snapshotDigest: input.snapshot.digest, operation: request.operation, capability: request.capability,
          policyEpoch: 1, signal: request.signal,
        }), validate: async permit => { if (permit.policyEpoch !== 1) throw new TargetConfigurationError('TARGET_OPERATION_DENIED'); } },
        release: () => undefined,
      }),
      authorizeResume: async () => undefined,
      acquireForResume: async () => { throw new TargetConfigurationError('TARGET_OPERATION_DENIED'); },
    });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      ...(runtime.durableState.targetStarts === undefined ? {} : { targetStarts: runtime.durableState.targetStarts }), clock,
    });
    let startCalls = 0;
    let notifyStartEntered!: () => void;
    const startEntered = new Promise<void>(resolve => { notifyStartEntered = resolve; });
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const service = new TargetRunService({
      resolver: await createResolver(), bindings: runtime.durableState.targetBindings,
      queries: runtime.queries, clock,
      start: {
        async startAccepted(options) {
          startCalls += 1;
          notifyStartEntered();
          await startGate;
          await execution.startAccepted(options);
        },
      },
    });

    const input = { targetId: 'market-a-sim', requestId: 'concurrent-idem', message: 'inspect settlement failures' };
    const firstStart = service.start(input);
    await startEntered;
    const secondStart = service.start(input);
    releaseStart();
    const results = await Promise.all([firstStart, secondStart]);

    expect(results.map(result => result.runId)).toEqual([results[0]?.runId, results[0]?.runId]);
    expect(results.map(result => result.status).sort()).toEqual(['accepted', 'reused']);
    expect(startCalls).toBe(1);
    expect(await runtime.durableState.targetBindings.listByTarget({ targetId: input.targetId, limit: 10 }))
      .toMatchObject({ items: [{ runId: results[0]?.runId }] });
    await execution.close();
  });

  it('treats a lost RUN_STARTED acknowledgement as the original accepted Run without invoking the model', async () => {
    let modelCalls = 0;
    const model: ChatModel = {
      async *stream() {
        modelCalls += 1;
        yield { type: 'text_delta', delta: 'unexpected' };
        return { text: 'unexpected', toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock,
      inMemoryTargetIdentityRegistryVersion: () => 1 });
    configureTestTargetGate(runtime, model);
    runtimes.push(runtime);
    if (runtime.durableState?.targetStarts === undefined || runtime.queries === undefined) {
      throw new Error('Durable Target start ports are unavailable.');
    }
    let streamCalls = 0;
    const agent: DiagnosisAgent = {
      reply: options => runtime.agent.reply(options),
      async *replyStream(options) {
        streamCalls += 1;
        const stream = runtime.agent.replyStream(options);
        try {
          const first = await stream.next();
          if (first.done) return first.value;
          if (first.value.type !== 'RUN_STARTED') throw new Error('unexpected first event');
          throw new Error('simulated acknowledgement loss after durable start');
        } finally {
          await stream.return(undefined as never).catch(() => undefined);
        }
      },
      resumeStream: (runId, signal, toolCallBudget, networkAttemptBudget) =>
        runtime.agent.resumeStream(runId, signal, toolCallBudget, networkAttemptBudget),
    };
    const execution = new RunExecutionCoordinator(agent, runtime.checkpoints, {
      targetStarts: runtime.durableState.targetStarts, clock,
    });
    const service = new TargetRunService({ resolver: await createResolver(),
      bindings: runtime.durableState.targetBindings, queries: runtime.queries, clock,
      start: { startAccepted: options => execution.startAccepted(options) } });

    const request = { targetId: 'market-a-sim', requestId: 'lost-start-ack', message: 'inspect failures' };
    const first = await service.start(request);
    expect(first).toMatchObject({ status: 'accepted' });
    expect(await service.start(request)).toEqual({ ...first, status: 'reused' });
    expect(streamCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(await runtime.durableState.targetBindings.getBinding(first.runId)).toMatchObject({ runId: first.runId });
    await execution.close();
  });

  it('retries a confirmed-absent start with the same reserved Run ID', async () => {
    let modelCalls = 0;
    const model: ChatModel = {
      async *stream() {
        modelCalls += 1;
        yield { type: 'text_delta', delta: 'ok' };
        return { text: 'ok', toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock,
      inMemoryTargetIdentityRegistryVersion: () => 1 });
    configureTestTargetGate(runtime, model);
    runtimes.push(runtime);
    if (runtime.durableState?.targetStarts === undefined || runtime.queries === undefined) {
      throw new Error('Durable Target start ports are unavailable.');
    }
    let streamCalls = 0;
    const agent: DiagnosisAgent = {
      reply: options => runtime.agent.reply(options),
      async *replyStream(options) {
        streamCalls += 1;
        if (streamCalls === 1) throw new Error('transient failure before durable start');
        return yield* runtime.agent.replyStream(options);
      },
      resumeStream: (runId, signal, toolCallBudget, networkAttemptBudget) =>
        runtime.agent.resumeStream(runId, signal, toolCallBudget, networkAttemptBudget),
    };
    const execution = new RunExecutionCoordinator(agent, runtime.checkpoints, {
      targetStarts: runtime.durableState.targetStarts, clock,
    });
    const service = new TargetRunService({ resolver: await createResolver(),
      bindings: runtime.durableState.targetBindings, queries: runtime.queries, clock,
      start: { startAccepted: options => execution.startAccepted(options) } });
    const request = { targetId: 'market-a-sim', requestId: 'confirmed-absent-retry', message: 'inspect failures' };

    await expect(service.start(request)).rejects.toMatchObject({
      code: 'RUN_CONFLICT',
      message: 'Run did not commit its initial transition. Retry with the same request ID only while the resolved Target snapshot is unchanged; if it changed, submit a new request ID.',
    });
    const reserved = await runtime.durableState.targetBindings.getRequest(request.requestId);
    if (reserved === null) throw new Error('Expected the original request reservation to remain.');
    expect(await runtime.durableState.targetBindings.getBinding(reserved.runId)).toBeNull();
    const accepted = await service.start(request);
    expect(accepted).toEqual({ runId: reserved.runId, status: 'reused' });
    expect(streamCalls).toBe(2);
    await execution.close();
    expect(modelCalls).toBe(1);
  });

  it('keeps an unknown initial commit fenced and never substitutes a new Run ID', async () => {
    let modelCalls = 0;
    const model: ChatModel = {
      async *stream() {
        modelCalls += 1;
        yield { type: 'text_delta', delta: 'unexpected' };
        return { text: 'unexpected', toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock,
      inMemoryTargetIdentityRegistryVersion: () => 1 });
    configureTestTargetGate(runtime, model);
    runtimes.push(runtime);
    if (runtime.durableState?.targetStarts === undefined || runtime.queries === undefined) {
      throw new Error('Durable Target start ports are unavailable.');
    }
    let streamCalls = 0;
    const agent: DiagnosisAgent = {
      reply: options => runtime.agent.reply(options),
      async *replyStream() {
        streamCalls += 1;
        throw new Error('simulated pre-transition failure with unavailable reconciliation');
      },
      resumeStream: (runId, signal, toolCallBudget, networkAttemptBudget) =>
        runtime.agent.resumeStream(runId, signal, toolCallBudget, networkAttemptBudget),
    };
    const underlyingStarts = runtime.durableState.targetStarts;
    const starts = {
      claimStart: (input: Parameters<typeof underlyingStarts.claimStart>[0]) => underlyingStarts.claimStart(input),
      releaseStartClaim: () => Promise.resolve(false),
      reconcileStart: () => Promise.resolve({ status: 'unknown' as const }),
    };
    const checkpointLoad = vi.fn(async () => { throw new Error('checkpoint read unavailable'); });
    const execution = new RunExecutionCoordinator(agent, { load: checkpointLoad }, { targetStarts: starts, clock });
    const service = new TargetRunService({ resolver: await createResolver(),
      bindings: runtime.durableState.targetBindings, queries: runtime.queries, clock,
      start: { startAccepted: options => execution.startAccepted(options) } });

    const request = { targetId: 'market-a-sim', requestId: 'unknown-start', message: 'inspect failures' };
    await expect(service.start(request)).rejects.toMatchObject({ code: 'RUN_START_STATE_UNKNOWN' });
    const original = await runtime.durableState.targetBindings.getRequest(request.requestId);
    expect(original).not.toBeNull();
    await expect(service.start(request)).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    expect(await runtime.durableState.targetBindings.getRequest(request.requestId)).toEqual(original);
    expect(streamCalls).toBe(0);
    expect(checkpointLoad).toHaveBeenCalledTimes(1);
    expect(modelCalls).toBe(0);
    await execution.close();
  });
});
