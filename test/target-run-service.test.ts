import { afterEach, describe, expect, it } from 'vitest';
import type { ChatModel, Clock } from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { TargetRunService } from '../src/application/target-run-service.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';

const now = '2026-10-11T10:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };
const runtimes: Array<Awaited<ReturnType<typeof createAgentRuntime>>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
});

async function createResolver() {
  return createStaticTargetResolver({
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [{ id: 'window_failure_rate.v1', version: '1.0.0' }],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
  });
}

describe('TargetRunService', () => {
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
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false, clock });
    runtimeRef.current = runtime;
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints);
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

  it('coalesces concurrent requests with the same idempotency key before the first binding commits', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'ok', toolCalls: [] }]), workspaceRoots: [], clock,
    });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable query ports are unavailable.');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints);
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
});
