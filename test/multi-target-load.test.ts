import { cpus } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatModel, Clock, ModelResponse, ModelStreamEvent } from '../src/contracts/index.js';
import type { TargetRecoveryGate, TargetRunBindingRecord, TargetRunRuntimeLease, ResolvedTargetSnapshotV2 } from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { TargetRunService } from '../src/application/target-run-service.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';

const shouldRun = process.env.AGENTOPS_RUN_MULTI_TARGET_LOAD === '1';
const configuredConcurrency = Number(process.env.AGENTOPS_MULTI_TARGET_CONCURRENCY ?? '2');
const capturedAt = '2026-10-21T00:00:00.000Z';
const runtimes: Array<Awaited<ReturnType<typeof createAgentRuntime>>> = [];
const executions: RunExecutionCoordinator[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map(execution => execution.close()));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
});

describe.skipIf(!shouldRun)('multi-Target concurrent Run acceptance', () => {
  it('schedules ten parent Runs while preserving Target identity and bounded execution', async () => {
    const clock: Clock = { now: () => new Date(capturedAt) };
    const identity = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({ ...identity, catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry, profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION], installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt });
    const durable = new InMemoryDurableState(clock, undefined, identity.identityRegistryVersion);
    const fallbackModel: ChatModel = { async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      yield { type: 'text_delta', delta: 'fallback' };
      return { text: 'fallback', toolCalls: [] };
    } };
    const runtime = createAgentRuntime({ model: fallbackModel, workspaceRoots: [], durableState: durable, clock, includeExternalBash: false });
    runtimes.push(runtime);
    await runtime.ready;
    let activeModels = 0;
    let peakModels = 0;
    const modelCounts = new Map<string, number>();
    const makeLease = (binding: TargetRunBindingRecord, snapshot: ResolvedTargetSnapshotV2): TargetRunRuntimeLease => {
      const model: ChatModel = { async *stream(_messages, _tools, options): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        const targetForRun = (await durable.targetBindings.getBinding(options.runId))?.targetId;
        if (targetForRun !== snapshot.targetId) throw new Error('Target lease changed during the model call.');
        activeModels += 1; peakModels = Math.max(peakModels, activeModels);
        modelCounts.set(snapshot.targetId, (modelCounts.get(snapshot.targetId) ?? 0) + 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        activeModels -= 1;
        const text = `${snapshot.targetId} scheduled`;
        yield { type: 'text_delta', delta: text };
        return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } };
      } };
      const operations = {
        authorize: async (input: { operation: 'model' | 'source'; capability: string; signal: AbortSignal }) => ({
          bindingId: binding.bindingId, runId: binding.runId, rootRunId: binding.rootRunId,
          snapshotDigest: snapshot.digest, operation: input.operation, capability: input.capability,
          policyEpoch: 1, signal: input.signal,
        }),
        validate: async (permit: { bindingId: string; snapshotDigest: string; signal: AbortSignal }) => {
          if (permit.bindingId !== binding.bindingId || permit.snapshotDigest !== snapshot.digest || permit.signal.aborted) {
            throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
          }
        },
      };
      return { model, tools: [], operations, release: () => undefined };
    };
    const gate: TargetRecoveryGate = {
      acquireForStart: async input => makeLease(input.binding, input.snapshot),
      authorizeResume: async input => {
        const binding = await durable.targetBindings.getBinding(input.runId);
        if (binding === null || binding.bindingId !== input.targetBindingId) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      },
      acquireForResume: async input => {
        const binding = await durable.targetBindings.getBinding(input.runId);
        const snapshot = binding === null ? null : await durable.targetBindings.getSnapshot(binding.bindingId);
        if (binding === null || snapshot === null || snapshot.schemaVersion !== 2 || binding.bindingId !== input.targetBindingId) {
          throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        }
        return makeLease(binding, snapshot);
      },
    };
    runtime.configureTargetRecoveryGate(gate);
    const queueWaitByRun = new Map<string, number>();
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      targetStarts: durable, clock, maxConcurrentRuns: configuredConcurrency, maxQueuedRuns: 10,
      onRunAdmitted: (runId, queueWaitMs) => queueWaitByRun.set(runId, queueWaitMs),
    });
    executions.push(execution);
    const service = new TargetRunService({ resolver, bindings: durable.targetBindings, queries: runtime.queries!, start: {
      startAccepted: options => execution.startAccepted(options),
    }, execution: { resume: runId => { void execution.resume(runId); }, cancel: runId => execution.cancel(runId) },
    targetRecoveryGate: gate, clock });

    const starts = Array.from({ length: 10 }, (_, index) => {
      const targetId = index % 2 === 0 ? 'market-a-sim' : 'market-b-sim';
      const startedAt = performance.now();
      return service.start({ targetId, requestId: `m5-load-${index}`, message: `load run ${index}` })
        .then(result => ({ ...result, targetId, acceptedMs: performance.now() - startedAt, startedAt }));
    });
    const accepted = await Promise.all(starts);
    await waitForCompletion(service, accepted.map(run => run.runId));
    const completedMs: number[] = [];
    for (const entry of accepted) {
      const run = await service.getRun(entry.targetId, entry.runId);
      expect(run?.status).toBe('completed');
      expect(run?.targetScope?.targetId).toBe(entry.targetId);
      expect(await service.getRun(entry.targetId === 'market-a-sim' ? 'market-b-sim' : 'market-a-sim', entry.runId)).toBeNull();
      completedMs.push(performance.now() - entry.startedAt);
    }
    expect(peakModels).toBeLessThanOrEqual(configuredConcurrency);
    expect(modelCounts.get('market-a-sim')).toBe(5);
    expect(modelCounts.get('market-b-sim')).toBe(5);
    const queueWaitMs = accepted.map(run => queueWaitByRun.get(run.runId) ?? 0);
    const agentSchedulingMs = accepted.map((run, index) => Math.max(0, run.acceptedMs - queueWaitMs[index]!));
    expect(queueWaitMs.some(waitMs => waitMs > 0)).toBe(true);
    process.stdout.write(`${JSON.stringify({ acceptance: 'multi-target-load', node: process.version, platform: process.platform,
      arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, runs: accepted.length,
      configuredConcurrency, peakModelConcurrency: peakModels, queueWaitMs: quantiles(queueWaitMs),
      agentSchedulingMs: quantiles(agentSchedulingMs), completionLatencyMs: quantiles(completedMs),
      externalCalls: 0, targetRuns: Object.fromEntries(modelCounts) })}\n`);

  }, 30_000);
});

async function waitForCompletion(service: TargetRunService, runIds: readonly string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const bindings = await Promise.all(runIds.map(id => service.bindingForRun(id)));
    const states = await Promise.all(bindings.map(async binding => binding === null ? null : service.getRun(binding.targetId, binding.runId)));
    if (states.every(run => run?.status === 'completed')) return;
    if (states.some(run => run?.status === 'failed' || run?.status === 'cancelled')) throw new Error('A Target load fixture Run failed.');
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent Target fixture Runs.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function quantiles(values: readonly number[]): { p50: number; p95: number; p99: number } {
  const ordered = [...values].sort((left, right) => left - right);
  const at = (percentile: number): number => Math.round(ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)]! * 100) / 100;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
