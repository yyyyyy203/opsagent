import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentMessage,
  ChatModel,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
  ToolCallOptions,
  ToolResponse,
  ToolResponseChunk,
} from '../src/contracts/index.js';
import type {
  TargetBindingStore,
  TargetOperationGuard,
  TargetOperationPermit,
  TargetRecoveryGate,
  TargetStartClaim,
  TargetRunBindingRecord,
  TrustedTargetBinding,
} from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import type { DiagnosisRunResult, SourceChildAgentFactory } from '../src/application/source-subagent-runner.js';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { createTargetMetricsSubagentRuntime } from '../src/bootstrap/target-metrics-subagent.js';
import { createSharedSourceChildAgentFactory } from '../src/bootstrap/shared-source-child.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';
import { TARGET_METRICS_WINDOW_TOOL_NAME } from '../src/application/target-metrics-source-report-collector.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { SourceCircuitBreaker, SourceFailure, ResilientExecutor } from '../src/mcp/resilience.js';
import { TargetSourcePartitionRegistry, type TargetSourceExecutionOptions } from '../src/infrastructure/target-source-partition-registry.js';
import { FetchWindowPrometheusQueryPort } from '../src/infrastructure/prometheus/http-window-query-port.js';

const capturedAt = '2026-10-12T02:00:00.000Z';
const capturedAtMs = Date.parse(capturedAt);
const windowStart = capturedAtMs / 1_000 - 300;
const windowEnd = capturedAtMs / 1_000;

describe('multi-Target Metrics M3 integration', () => {
  it('keeps concurrent Target-bound parent and child Harness messages, evidence, events, and budgets isolated', async () => {
    const currentTime = capturedAtMs;
    const clock = { now: () => new Date(currentTime) };
    const snapshots = await resolveSnapshots();
    const identityRegistryVersion = snapshots[0]?.identityRegistryVersion;
    if (identityRegistryVersion === undefined || snapshots.some(snapshot => snapshot.identityRegistryVersion !== identityRegistryVersion)) {
      throw new Error('Test Targets must share the same resolved identity registry version.');
    }
    const durableState = new InMemoryDurableState(clock, undefined, () => identityRegistryVersion);
    const host = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [], durableState, clock, includeExternalBash: false });
    await host.ready;
    const registry = createRegistry(() => currentTime);
    const observed = new Map<string, { childCalls: Array<{ runId: string; tools: string[]; message: string }>; queryCalls: string[] }>();
    const networkBudgets = new Map<string, { remaining: number }>();
    const targets: Array<{
      snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number];
      binding: TargetRunBindingRecord;
      startClaim: TargetStartClaim;
      parentRuntime: ReturnType<typeof createAgentRuntime>;
      metricsRuntime: ReturnType<typeof createTargetMetricsSubagentRuntime>;
      parentToolCallId: string;
      networkBudget: { remaining: number };
    }> = [];

    try {
      for (const snapshot of snapshots) {
        const runId = `harness-parent-${snapshot.targetId}`;
        const requestId = `harness-request-${snapshot.targetId}`;
        const requestDigest = `sha256:v1:${snapshot.targetId === 'market-a-sim' ? 'a' : 'b'}${'0'.repeat(63)}`;
        const reservation = await durableState.targetBindings.reserveRequest({
          requestId, targetId: snapshot.targetId, requestDigest, runId, createdAt: snapshot.capturedAt,
        });
        expect(reservation.created).toBe(true);
        const startClaimResult = await durableState.targetStarts.claimStart({
          requestId, runId, targetId: snapshot.targetId, requestDigest, ownerId: `owner-${snapshot.targetId}`,
          now: snapshot.capturedAt, leaseUntil: new Date(Date.parse(snapshot.capturedAt) + 60_000).toISOString(),
        });
        if (startClaimResult.status !== 'claimed') throw new Error(`Target start claim was not acquired: ${snapshot.targetId}`);
        const binding: TargetRunBindingRecord = {
          bindingId: `harness-binding-${snapshot.targetId}`, targetId: snapshot.targetId, runId, rootRunId: runId,
          snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt, requestId, requestDigest,
        };
        const startClaim = startClaimResult.claim;
        const parentToolCallId = `metrics-parent-${snapshot.targetId}`;
        const usage = snapshot.targetId === 'market-a-sim'
          ? { inputTokens: 11, outputTokens: 2 }
          : { inputTokens: 21, outputTokens: 4 };
        const parentUsage = snapshot.targetId === 'market-a-sim'
          ? { first: { inputTokens: 3, outputTokens: 1 }, second: { inputTokens: 2, outputTokens: 1 } }
          : { first: { inputTokens: 5, outputTokens: 2 }, second: { inputTokens: 7, outputTokens: 3 } };
        const observations = {
          childCalls: [] as Array<{ runId: string; tools: string[]; message: string }>,
          queryCalls: [] as string[],
        };
        observed.set(snapshot.targetId, observations);
        const childModel = createHarnessChildModel(snapshot.targetId, usage, observations.childCalls);
        const parentModel = new ScriptedModel([
          { toolCalls: [{ id: parentToolCallId, name: 'metrics_subagent', input: {
            profileId: snapshot.profile.profileId,
            service: snapshot.scenario.serviceId,
            start: new Date(windowStart * 1_000).toISOString(),
            end: new Date(windowEnd * 1_000).toISOString(),
            question: '检查当前 Target 的失败率',
          } }], usage: parentUsage.first },
          { text: `Target ${snapshot.targetId} 检查完成`, toolCalls: [], usage: parentUsage.second },
        ]);
        const metricsTools: Tool[] = [];
        const targetRecoveryGate = createHarnessTargetGate({
          snapshot,
          parentModel,
          childModel,
          getParentTool: () => metricsTools[0],
        });
        const childAgentFactory = createSharedSourceChildAgentFactory({
          model: childModel,
          workspaceRoots: [],
          checkpoints: host.checkpoints,
          evidence: host.evidence,
          evidenceRecorder: host.evidenceRecorder,
          sharedEvents: host.sharedEvents,
          targetRecoveryGate,
          clock,
        });
        let failFirstRequest = snapshot.targetId === 'market-a-sim';
        const queryPort = new FetchWindowPrometheusQueryPort({
          url: 'https://prometheus.test/',
          now: () => currentTime,
          fetch: async input => {
            const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : new URL(input.url);
            const query = url.searchParams.get('query');
            if (query === null) throw new Error('Expected the host-generated Prometheus query.');
            observations.queryCalls.push(query);
            if (failFirstRequest) {
              failFirstRequest = false;
              return new Response('private transport diagnostics must not be read', {
                status: 429,
                headers: { 'retry-after': '1' },
              });
            }
            const response = metricsResponse(snapshot, query);
            return new Response(response.body, { status: response.status });
          },
        });
        const metricsRuntime = createTargetMetricsSubagentRuntime({
          snapshot,
          sourcePartitions: registry,
          queryPort,
          windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
          evidenceRecorder: host.evidenceRecorder,
          childAgentFactory,
          targetBindings: durableState.targetBindings,
          checkpoints: host.checkpoints,
          clock,
          maxResponseBytes: 16 * 1024,
          timeoutMs: 1_000,
        });
        metricsTools.push(metricsRuntime.tool);
        const parentRuntime = createAgentRuntime({
          model: parentModel,
          workspaceRoots: [],
          durableState,
          sharedEvents: host.sharedEvents,
          targetRecoveryGate,
          includeExternalBash: false,
          clock,
        });
        await parentRuntime.ready;
        const networkBudget = { remaining: 8 };
        networkBudgets.set(snapshot.targetId, networkBudget);
        targets.push({ snapshot, binding, startClaim, parentRuntime, metricsRuntime, parentToolCallId, networkBudget });
      }

      const results = await Promise.all(targets.map(async target => {
        const result = await target.parentRuntime.agent.reply({
          runId: target.binding.runId,
          profileId: target.snapshot.profile.profileId,
          message: `检查 Target ${target.snapshot.targetId} 的结算失败率`,
          trustedTargetBinding: {
            binding: target.binding,
            snapshot: target.snapshot,
            startClaim: target.startClaim,
          },
          toolCallBudget: { remaining: 8 },
          networkAttemptBudget: target.networkBudget,
          maxToolCalls: 8,
        });
        return { target, result };
      }));

      expect(results.map(({ result }) => result.status)).toEqual(['completed', 'completed']);
      for (const target of targets) {
        const context = await target.parentRuntime.checkpoints.load(target.binding.runId);
        expect(context?.messages.some(message => message.blocks.some(block => block.type === 'tool_result'
          && block.result.toolName === 'metrics_subagent' && block.result.status === 'success'))).toBe(true);
      }
      expect(observed.get('market-a-sim')?.queryCalls).toHaveLength(5);
      expect(observed.get('market-b-sim')?.queryCalls).toHaveLength(4);
      expect(networkBudgets.get('market-a-sim')?.remaining).toBe(3);
      expect(networkBudgets.get('market-b-sim')?.remaining).toBe(4);

      const childIds = targets.map(target => stableSourceChildRunId('metrics', target.binding.runId, target.parentToolCallId));
      const [childEventsA, childEventsB, childMessagesA, childMessagesB, childCheckpointA, childCheckpointB] = await Promise.all([
        host.eventStoreV2.readRun(childIds[0]!, 0, 1_000),
        host.eventStoreV2.readRun(childIds[1]!, 0, 1_000),
        host.eventStoreV2.listMessagesByRun(childIds[0]!),
        host.eventStoreV2.listMessagesByRun(childIds[1]!),
        durableState.checkpoints.load(childIds[0]!),
        durableState.checkpoints.load(childIds[1]!),
      ]);
      expect(childEventsA.length).toBeGreaterThan(0);
      expect(childEventsB.length).toBeGreaterThan(0);
      expect(childEventsA.every(event => event.runId === childIds[0])).toBe(true);
      expect(childEventsB.every(event => event.runId === childIds[1])).toBe(true);
      expect(childEventsA.filter(event => event.type === 'DATASOURCE_RETRY_SCHEDULED').map(event => ({
        sourceId: event.payload.sourceId,
        delayMs: event.payload.delayMs,
      }))).toEqual([{ sourceId: 'market-a-metrics', delayMs: 1_000 }]);
      expect(childEventsB.filter(event => event.type === 'DATASOURCE_RETRY_SCHEDULED')).toEqual([]);
      expect(childEventsA.map(event => event.type)).toContain('MODEL_CALL_COMPLETED');
      expect(childEventsA.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.usage))
        .toEqual(Array.from({ length: 3 }, () => ({ inputTokens: 11, outputTokens: 2 })));
      expect(childEventsA.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.model))
        .toEqual(Array.from({ length: 3 }, () => 'market-a-sim-model'));
      expect(childEventsB.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.usage))
        .toEqual(Array.from({ length: 3 }, () => ({ inputTokens: 21, outputTokens: 4 })));
      expect(childEventsB.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.model))
        .toEqual(Array.from({ length: 3 }, () => 'market-b-sim-model'));
      expect(childEventsA.find(event => event.type === 'RUN_FINISHED')?.payload).toMatchObject({
        usage: { inputTokens: 33, outputTokens: 6 }, usageCompleteness: 'complete',
      });
      expect(childEventsB.find(event => event.type === 'RUN_FINISHED')?.payload).toMatchObject({
        usage: { inputTokens: 63, outputTokens: 12 }, usageCompleteness: 'complete',
      });
      expect(childMessagesA.length).toBeGreaterThan(0);
      expect(childMessagesB.length).toBeGreaterThan(0);
      expect(JSON.stringify(childMessagesA)).not.toContain('orders_submit_window_count');
      expect(JSON.stringify(childMessagesB)).not.toContain('market_checkout_window_requests');
      expect(observed.get('market-a-sim')?.childCalls.map(call => call.tools)).toEqual(
        Array.from({ length: 3 }, () => [TARGET_METRICS_WINDOW_TOOL_NAME, 'source_report']),
      );
      expect(observed.get('market-b-sim')?.childCalls.map(call => call.tools)).toEqual(
        Array.from({ length: 3 }, () => [TARGET_METRICS_WINDOW_TOOL_NAME, 'source_report']),
      );
      expect(observed.get('market-a-sim')?.childCalls.every(call => !call.message.includes('orders_submit_window_count'))).toBe(true);
      expect(observed.get('market-b-sim')?.childCalls.every(call => !call.message.includes('market_checkout_window_requests'))).toBe(true);
      expect(childCheckpointA?.context.messages.some(message => message.blocks.some(block => block.type === 'tool_result'
        && block.result.toolName === TARGET_METRICS_WINDOW_TOOL_NAME))).toBe(true);
      expect(childCheckpointB?.context.messages.some(message => message.blocks.some(block => block.type === 'tool_result'
        && block.result.toolName === TARGET_METRICS_WINDOW_TOOL_NAME))).toBe(true);

      const childBindings = await Promise.all(childIds.map(runId => durableState.targetBindings.getBinding(runId)));
      const childSnapshots = await Promise.all(childBindings.map(binding => binding === null
        ? Promise.resolve(null)
        : durableState.targetBindings.getSnapshot(binding.bindingId)));
      expect(childBindings.map(binding => binding?.rootRunId)).toEqual(targets.map(target => target.binding.runId));
      expect(childBindings.map(binding => binding?.snapshotDigest)).toEqual(targets.map(target => target.snapshot.digest));
      expect(childSnapshots.map(snapshot => snapshot?.memoryScope)).toEqual(targets.map(target => target.snapshot.memoryScope));
      expect(childSnapshots[0]?.memoryScope).not.toEqual(childSnapshots[1]?.memoryScope);

      const evidenceIdsA = evidenceIdsFromContext(childCheckpointA?.context.messages ?? []);
      const evidenceIdsB = evidenceIdsFromContext(childCheckpointB?.context.messages ?? []);
      expect(evidenceIdsA).toHaveLength(1);
      expect(evidenceIdsB).toHaveLength(1);
      expect(evidenceIdsA[0]).not.toBe(evidenceIdsB[0]);
      const [evidenceA, evidenceB] = await Promise.all([
        host.evidence.get(evidenceIdsA[0]!), host.evidence.get(evidenceIdsB[0]!),
      ]);
      expect(evidenceA?.runId).toBe(childIds[0]);
      expect(evidenceB?.runId).toBe(childIds[1]);
      expect(JSON.stringify(evidenceA?.raw)).toContain('market_checkout_window_requests');
      expect(JSON.stringify(evidenceA?.raw)).not.toContain('orders_submit_window_count');
      expect(JSON.stringify(evidenceB?.raw)).toContain('orders_submit_window_count');
      expect(JSON.stringify(evidenceB?.raw)).not.toContain('market_checkout_window_requests');

      const parentEvents = await Promise.all(targets.map(target => host.eventStoreV2.readRun(target.binding.runId, 0, 1_000)));
      expect(parentEvents[0]?.every(event => event.runId === targets[0]?.binding.runId)).toBe(true);
      expect(parentEvents[1]?.every(event => event.runId === targets[1]?.binding.runId)).toBe(true);
      expect(parentEvents[0]?.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.usage))
        .toEqual([{ inputTokens: 3, outputTokens: 1 }, { inputTokens: 2, outputTokens: 1 }]);
      expect(parentEvents[1]?.filter(event => event.type === 'MODEL_CALL_COMPLETED').map(event => event.payload.usage))
        .toEqual([{ inputTokens: 5, outputTokens: 2 }, { inputTokens: 7, outputTokens: 3 }]);
      expect(parentEvents[0]?.find(event => event.type === 'RUN_FINISHED')?.payload).toMatchObject({
        outcome: 'complete', usage: { inputTokens: 5, outputTokens: 2 }, usageCompleteness: 'complete',
      });
      expect(parentEvents[1]?.find(event => event.type === 'RUN_FINISHED')?.payload).toMatchObject({
        outcome: 'complete', usage: { inputTokens: 12, outputTokens: 5 }, usageCompleteness: 'complete',
      });
    } finally {
      for (const target of targets) {
        await target.parentRuntime.close();
        target.metricsRuntime.release();
      }
      registry.shutdown();
      await host.close();
    }
  });

  it('runs Target A and B concurrently with isolated mappings, verdicts, evidence, memory scope, child messages, budgets, and resilience events', async () => {
    const currentTime = capturedAtMs;
    const registry = createRegistry(() => currentTime);
    const evidenceStore = new InMemoryEvidenceStore();
    const snapshots = await resolveSnapshots();
    const observed = new Map<string, RuntimeObservation>();
    const networkBudgets = new Map<string, { remaining: number }>();
    const targets = snapshots.map(snapshot => {
      const parentRunId = `parent-${snapshot.projectId}`;
      const binding: TargetRunBindingRecord = {
        bindingId: `binding-${snapshot.projectId}`,
        targetId: snapshot.targetId,
        runId: parentRunId,
        rootRunId: parentRunId,
        snapshotDigest: snapshot.digest,
        createdAt: snapshot.capturedAt,
      };
      const observation: RuntimeObservation = { childTools: [], resilienceChunks: [], queryCalls: [], prompts: [] };
      observed.set(snapshot.targetId, observation);
      networkBudgets.set(snapshot.targetId, { remaining: 8 });
      let failFirstRequest = snapshot.targetId === 'market-a-sim';
      const runtime = createTargetMetricsSubagentRuntime({
        snapshot,
        sourcePartitions: registry,
        queryPort: {
          query: async ({ query }) => {
            observation.queryCalls.push(query);
            if (failFirstRequest) {
              failFirstRequest = false;
              return emptyResponse(503);
            }
            return metricsResponse(snapshot, query);
          },
        },
        windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
        evidenceRecorder: new DefaultEvidenceRecorder({ evidence: evidenceStore }),
        childAgentFactory: childFactory(snapshot, binding, observation),
        targetBindings: bindingStore(binding, snapshot),
        clock: { now: () => new Date(currentTime) },
        maxResponseBytes: 16 * 1024,
        timeoutMs: 1_000,
      });
      return { snapshot, binding, runtime, parentRunId };
    });

    try {
      const results = await Promise.all(targets.map(async ({ snapshot, runtime, parentRunId }) => {
        const result = await drainTool(runtime.tool, {
          profileId: snapshot.profile.profileId,
          service: snapshot.scenario.serviceId,
          start: new Date(windowStart * 1_000).toISOString(),
          end: new Date(windowEnd * 1_000).toISOString(),
          question: '检查本 Target 的窗口失败率',
        }, parentToolOptions(snapshot, parentRunId, networkBudgets.get(snapshot.targetId)));
        const block = result.response.blocks.find(item => item.type === 'json');
        if (block?.type !== 'json') throw new Error('Expected source subagent JSON result.');
        return { snapshot, response: result.response, result: block.value as SourceResult, outerChunks: result.chunks };
      }));

      expect(results.map(item => item.result.status)).toEqual(['complete', 'complete']);
      expect(results.map(item => item.result.toolCallsUsed)).toEqual([2, 2]);
      expect(networkBudgets.get('market-a-sim')?.remaining).toBe(3);
      expect(networkBudgets.get('market-b-sim')?.remaining).toBe(4);
      expect(results.map(item => item.result.evidenceIds)).toEqual([
        [expect.stringMatching(/^metric-evidence-/u)],
        [expect.stringMatching(/^metric-evidence-/u)],
      ]);
      expect(results[0]?.result.evidenceIds[0]).not.toBe(results[1]?.result.evidenceIds[0]);
      expect(results.map(item => item.snapshot.memoryScope)).not.toEqual([results[1]?.snapshot.memoryScope, results[0]?.snapshot.memoryScope]);

      const evidence = await Promise.all(results.map(item => evidenceStore.get(item.result.evidenceIds[0]!)));
      expect(evidence[0]?.runId).toContain('source-child-metrics-');
      expect(evidence[1]?.runId).toContain('source-child-metrics-');
      expect(evidence[0]?.runId).not.toBe(evidence[1]?.runId);
      const evidenceA = evidence[0];
      const evidenceB = evidence[1];
      expect(evidenceA?.summary).toMatchObject({ assessment: { status: 'complete', thresholdReached: false, threshold: 0.05 } });
      expect(evidenceB?.summary).toMatchObject({ assessment: { status: 'complete', thresholdReached: true, threshold: 0.02 } });
      expect(JSON.stringify(evidenceA?.raw)).toContain('market_checkout_window_requests');
      expect(JSON.stringify(evidenceA?.raw)).not.toContain('orders_submit_window_count');
      expect(JSON.stringify(evidenceB?.raw)).toContain('orders_submit_window_count');
      expect(JSON.stringify(evidenceB?.raw)).not.toContain('market_checkout_window_requests');
      expect(JSON.stringify(results[0]?.response)).not.toContain('orders_submit_window_count');
      expect(JSON.stringify(results[1]?.response)).not.toContain('market_checkout_window_requests');

      const [a, b] = targets;
      const observationA = observed.get(a!.snapshot.targetId)!;
      const observationB = observed.get(b!.snapshot.targetId)!;
      expect(observationA.childTools[0]).toEqual(['metrics.window_snapshot', 'source_report']);
      expect(observationB.childTools[0]).toEqual(['metrics.window_snapshot', 'source_report']);
      expect(observationA.inherited?.snapshot.memoryScope).toEqual(a!.snapshot.memoryScope);
      expect(observationB.inherited?.snapshot.memoryScope).toEqual(b!.snapshot.memoryScope);
      expect(observationA.inherited?.snapshot.memoryScope).not.toEqual(observationB.inherited?.snapshot.memoryScope);
      expect(observationA.prompts[0]).not.toContain('orders_submit_window_count');
      expect(observationB.prompts[0]).not.toContain('market_checkout_window_requests');
      expect(observationA.prompts[0]).not.toContain('private-market-b');
      expect(observationB.prompts[0]).not.toContain('private-market-a');
      expect(observationA.queryCalls.join('\n')).toContain('service="checkout"');
      expect(observationB.queryCalls.join('\n')).toContain('application="checkout-api"');
      expect(observationA.queryCalls.join('\n')).not.toContain('application="checkout-api"');
      expect(observationB.queryCalls.join('\n')).not.toContain('service="checkout"');
      expect(observationA.resilienceChunks).toHaveLength(1);
      const retryChunk = observationA.resilienceChunks[0];
      if (retryChunk?.type !== 'event') throw new Error('Expected a streamed retry event.');
      expect(retryChunk.name).toBe('source_resilience');
      expect(retryChunk.payload.kind).toBe('retry_scheduled');
      expect(retryChunk.payload.sourceId).toBe('market-a-metrics');
      expect(observationB.resilienceChunks).toEqual([]);
      expect(results.every(item => item.outerChunks.length === 0)).toBe(true);
    } finally {
      for (const item of targets) item.runtime.release();
      registry.shutdown();
    }
  });

  it('keeps an assessment with a missing business-window boundary partial and non-diagnostic', async () => {
    const currentTime = capturedAtMs;
    const registry = createRegistry(() => currentTime);
    const snapshot = (await resolveSnapshots())[0]!;
    const parentRunId = 'parent-missing-boundary';
    const binding: TargetRunBindingRecord = {
      bindingId: `binding-${snapshot.projectId}`, targetId: snapshot.targetId, runId: parentRunId,
      rootRunId: parentRunId, snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt,
    };
    const observation: RuntimeObservation = { childTools: [], resilienceChunks: [], queryCalls: [], prompts: [] };
    const evidenceStore = new InMemoryEvidenceStore();
    const runtime = createTargetMetricsSubagentRuntime({
      snapshot,
      sourcePartitions: registry,
      queryPort: { query: async ({ query }) => {
        observation.queryCalls.push(query);
        return query.startsWith(snapshot.scenario.metricMapping.windowBoundaryMapping!.startMetricName)
          ? emptyVectorResponse()
          : metricsResponse(snapshot, query);
      } },
      windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
      evidenceRecorder: new DefaultEvidenceRecorder({ evidence: evidenceStore }),
      childAgentFactory: childFactory(snapshot, binding, observation),
      targetBindings: bindingStore(binding, snapshot),
      clock: { now: () => new Date(currentTime) },
      maxResponseBytes: 16 * 1024,
      timeoutMs: 1_000,
    });

    try {
      const result = await drainTool(runtime.tool, {
        profileId: snapshot.profile.profileId,
        service: snapshot.scenario.serviceId,
        start: new Date(windowStart * 1_000).toISOString(),
        end: new Date(windowEnd * 1_000).toISOString(),
        question: '验证缺失窗口边界时应如何降级',
      }, parentToolOptions(snapshot, parentRunId));
      const block = result.response.blocks.find(item => item.type === 'json');
      if (block?.type !== 'json') throw new Error('Expected partial source report JSON.');
      const sourceResult = block.value as SourceResult & { findings: unknown[]; missingEvidence: string[] };
      expect(sourceResult.status).toBe('partial');
      expect(sourceResult.findings).toEqual([]);
      expect(sourceResult.missingEvidence).toContain('metric_evidence_partial');
      const record = await evidenceStore.get(sourceResult.evidenceIds[0]!);
      expect(record?.summary).toMatchObject({ assessment: { status: 'unavailable' } });
      expect(record?.summary).not.toHaveProperty('assessment.thresholdReached');
      expect(record?.raw).toBeDefined();
    } finally {
      runtime.release();
      registry.shutdown();
    }
  });

  it('does not retry unauthorized Prometheus HTTP responses as transient server failures', async () => {
    const currentTime = capturedAtMs;
    const registry = createRegistry(() => currentTime);
    const snapshot = (await resolveSnapshots())[0]!;
    const parentRunId = 'parent-auth-error';
    const binding: TargetRunBindingRecord = {
      bindingId: `binding-${snapshot.projectId}`, targetId: snapshot.targetId, runId: parentRunId,
      rootRunId: parentRunId, snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt,
    };
    const observation: RuntimeObservation = { childTools: [], resilienceChunks: [], queryCalls: [], prompts: [] };
    const runtime = createTargetMetricsSubagentRuntime({
      snapshot,
      sourcePartitions: registry,
      queryPort: { query: async ({ query }) => { observation.queryCalls.push(query); return emptyResponse(401); } },
      windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
      evidenceRecorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      childAgentFactory: childFactory(snapshot, binding, observation),
      targetBindings: bindingStore(binding, snapshot),
      clock: { now: () => new Date(currentTime) },
      maxResponseBytes: 16 * 1024,
      timeoutMs: 1_000,
    });

    try {
      const outcome = await drainTool(runtime.tool, {
        profileId: snapshot.profile.profileId,
        service: snapshot.scenario.serviceId,
        start: new Date(windowStart * 1_000).toISOString(),
        end: new Date(windowEnd * 1_000).toISOString(),
        question: '检查鉴权错误',
      }, parentToolOptions(snapshot, parentRunId)).then(value => ({ value }), (error: unknown) => ({ error }));
      expect(outcome).toMatchObject({ error: { code: 'MCP_AUTH_ERROR' } });
      expect(observation.queryCalls).toHaveLength(1);
      expect(observation.childError).toContain('MCP_AUTH_ERROR');
    } finally {
      runtime.release();
      registry.shutdown();
    }
  });

  it('opens A after logical failures, keeps B queryable, permits exactly one cooldown probe, and closes only after recovery', async () => {
    let currentTime = capturedAtMs;
    const snapshots = await resolveSnapshots();
    const registry = createRegistry(() => currentTime);
    const aSnapshot = snapshots.find(snapshot => snapshot.targetId === 'market-a-sim')!;
    const bSnapshot = snapshots.find(snapshot => snapshot.targetId === 'market-b-sim')!;
    const a = registry.acquire(aSnapshot, 'market-a-metrics');
    const b = registry.acquire(bSnapshot, 'market-b-metrics');
    const options = (): TargetSourceExecutionOptions => ({ signal: new AbortController().signal, deadline: currentTime + 120_000 });

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(a.execute(async () => { throw new SourceFailure('MCP_SERVER_ERROR'); }, options()))
          .rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
      }
      await expect(a.execute(async () => 'must be blocked', options())).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
      await expect(b.execute(async () => 'B remains queryable', options())).resolves.toBe('B remains queryable');

      currentTime += 30_000;
      let releaseProbe!: () => void;
      let probeStarted!: () => void;
      const probeGate = new Promise<void>(resolve => { releaseProbe = resolve; });
      const started = new Promise<void>(resolve => { probeStarted = resolve; });
      const probe = a.execute(async () => { probeStarted(); await probeGate; return 'A recovered'; }, options());
      await started;
      await expect(a.execute(async () => 'second probe must be blocked', options()))
        .rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
      await expect(b.execute(async () => 'B still queryable during A probe', options()))
        .resolves.toBe('B still queryable during A probe');
      releaseProbe();
      await expect(probe).resolves.toBe('A recovered');
      await expect(a.execute(async () => 'A recovered and closed', options())).resolves.toBe('A recovered and closed');
    } finally {
      a.release();
      b.release();
      registry.shutdown();
    }
  });
});

function createHarnessChildModel(
  targetId: string,
  usage: NonNullable<ModelResponse['usage']>,
  observations: Array<{ runId: string; tools: string[]; message: string }>,
): ChatModel {
  return {
    async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      observations.push({ runId: options.runId, tools: tools.map(tool => tool.name), message: JSON.stringify(messages) });
      const results = messages.flatMap(message => message.blocks.flatMap(block => (
        block.type === 'tool_result' ? [block.result] : []
      )));
      const metricResult = results.find(result => result.toolName === TARGET_METRICS_WINDOW_TOOL_NAME);
      if (metricResult === undefined) {
        return { toolCalls: [{ id: `${targetId}-metric-window-call`, name: TARGET_METRICS_WINDOW_TOOL_NAME, input: {} }], usage };
      }
      const reportResult = results.find(result => result.toolName === 'source_report');
      if (reportResult === undefined) {
        const evidenceId = metricResult.response?.evidenceIds?.[0];
        if (evidenceId === undefined) throw new Error('The real metrics ToolResult did not expose an evidence reference.');
        return { toolCalls: [{ id: `${targetId}-source-report-call`, name: 'source_report', input: {
          summary: '当前 Target 窗口指标已完成确定性计算。',
          findings: [{ kind: 'observation', statement: '窗口指标证据已采集。', evidenceIds: [evidenceId] }],
          businessTraceIds: [],
          missingEvidence: [],
        } }], usage };
      }
      yield { type: 'text_delta', delta: '当前 Target 的指标取证已完成。' };
      return { text: '当前 Target 的指标取证已完成。', toolCalls: [], usage };
    },
  };
}

function createHarnessTargetGate(input: {
  snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number];
  parentModel: ChatModel;
  childModel: ChatModel;
  getParentTool: () => Tool | undefined;
}): TargetRecoveryGate {
  const metricsSourceId = input.snapshot.sourceBindings.find(source => source.kind === 'metrics')?.sourceId;
  if (metricsSourceId === undefined) throw new Error('Resolved Target is missing its Metrics source binding.');
  const acquire = async (request: {
    binding: TargetRunBindingRecord;
    snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number];
    signal: AbortSignal;
    sourceScopeId?: string;
  }) => {
    if (request.signal.aborted || request.snapshot.targetId !== input.snapshot.targetId
      || request.snapshot.digest !== input.snapshot.digest || request.binding.targetId !== input.snapshot.targetId
      || request.binding.snapshotDigest !== input.snapshot.digest) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const isChild = request.sourceScopeId !== undefined;
    if (isChild && request.sourceScopeId !== metricsSourceId) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    const tools = isChild ? [] : [input.getParentTool()];
    if (!isChild && tools[0] === undefined) throw new Error('Target parent Tool has not been assembled.');
    return {
      model: isChild ? input.childModel : input.parentModel,
      modelIdentity: { provider: 'simulation', model: `${input.snapshot.targetId}-model` },
      tools: tools.filter((tool): tool is Tool => tool !== undefined),
      operations: createHarnessTargetOperations(request.binding, request.snapshot, metricsSourceId),
      release: () => {},
    };
  };
  return {
    acquireForStart: acquire,
    authorizeResume: async () => { throw new TargetConfigurationError('TARGET_OPERATION_DENIED'); },
    acquireForResume: async () => { throw new TargetConfigurationError('TARGET_OPERATION_DENIED'); },
  };
}

function createHarnessTargetOperations(
  binding: TargetRunBindingRecord,
  snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number],
  metricsSourceId: string,
): TargetOperationGuard {
  return {
    authorize: async request => {
      if (request.signal.aborted
        || (request.operation === 'model' && request.capability !== 'model')
        || (request.operation === 'source' && request.capability !== metricsSourceId)) {
        throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      }
      return {
        bindingId: binding.bindingId,
        runId: binding.runId,
        rootRunId: binding.rootRunId,
        snapshotDigest: snapshot.digest,
        operation: request.operation,
        capability: request.capability,
        policyEpoch: 1,
        signal: request.signal,
      };
    },
    validate: async (permit, signal) => {
      if (signal?.aborted || permit.signal.aborted || permit.bindingId !== binding.bindingId
        || permit.runId !== binding.runId || permit.rootRunId !== binding.rootRunId
        || permit.snapshotDigest !== snapshot.digest || permit.capability.length === 0) {
        throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      }
    },
  };
}

function evidenceIdsFromContext(messages: readonly AgentMessage[]): string[] {
  return [...new Set(messages.flatMap(message => message.blocks.flatMap(block => (
    block.type === 'tool_result' ? block.result.response?.evidenceIds ?? [] : []
  ))))];
}

interface RuntimeObservation {
  childTools: string[][];
  resilienceChunks: ToolResponseChunk[];
  queryCalls: string[];
  prompts: string[];
  inherited?: TrustedTargetBinding;
  childError?: string;
}

interface SourceResult {
  status: string;
  evidenceIds: string[];
  toolCallsUsed: number;
}

function createRegistry(now: () => number): TargetSourcePartitionRegistry {
  return new TargetSourcePartitionRegistry({
    maxPartitions: 16,
    maxConcurrentOperationsPerPartition: 4,
    maxQueuedOperationsPerPartition: 8,
    now,
    scheduleTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    createResilience: clock => {
      const breaker = new SourceCircuitBreaker({ threshold: 3, cooldownMs: 30_000, now: clock });
      const executor = new ResilientExecutor(breaker, {
        maxRetries: 1,
        now: clock,
        random: () => 0,
        sleep: async (_delay, signal) => { signal.throwIfAborted(); },
      });
      return {
        get state() { return breaker.state; },
        execute: (operation, options) => executor.execute(operation, options),
      };
    },
  });
}

async function resolveSnapshots() {
  const resolver = await createStaticTargetResolver({
    ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: capturedAt,
  });
  return Promise.all(['market-a-sim', 'market-b-sim'].map(targetId => resolver.resolve({
    targetId,
    capturedAt,
    signal: new AbortController().signal,
  })));
}

function childFactory(snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], binding: TargetRunBindingRecord,
  observation: RuntimeObservation): SourceChildAgentFactory {
  return {
    create: input => {
      observation.childTools.push(input.tools.map(tool => tool.name));
      return {
        replyStream: async function* (options) {
          if (options.trustedTargetBinding !== undefined) observation.inherited = options.trustedTargetBinding;
          observation.prompts.push(options.message);
          const metric = input.tools.find(tool => tool.name === 'metrics.window_snapshot');
          const report = input.tools.find(tool => tool.name === 'source_report');
          if (metric?.call === undefined || report?.call === undefined) throw new Error('Target child tools are missing.');
          const operations = createOperations(binding, snapshot, options.runId);
          const metricOptions = childToolOptions(snapshot, binding, options.runId, input.targetSourceId!, operations,
            `${snapshot.targetId}-metric-call`, options.networkAttemptBudget);
          let metricCall: Awaited<ReturnType<typeof drainTool>>;
          try { metricCall = await drainTool(metric, {}, metricOptions); }
          catch (error) {
            observation.childError = error instanceof Error
              ? `${error.name}:${error.message}:${'code' in error ? String(error.code) : 'no-code'}`
              : String(error);
            throw error;
          }
          observation.resilienceChunks.push(...metricCall.chunks);
          const evidenceId = metricCall.response.evidenceIds?.[0];
          if (evidenceId === undefined) throw new Error('Expected Target-scoped metric evidence.');
          yield toolResult(options.runId, 'metrics.window_snapshot', metricCall.response, metricOptions.toolCallId!);

          const reportOptions = childToolOptions(snapshot, binding, options.runId, input.targetSourceId!, operations,
            `${snapshot.targetId}-report-call`, options.networkAttemptBudget);
          const reportResponse = report.call({
            summary: 'model summary is not authoritative',
            findings: [{ kind: 'inference', statement: 'model root cause is not authoritative', evidenceIds: [evidenceId] }],
            businessTraceIds: [], missingEvidence: [],
          }, reportOptions);
          if (isPromiseLike(reportResponse) || isAsyncIterable(reportResponse)) throw new Error('source_report should be synchronous.');
          yield toolResult(options.runId, 'source_report', reportResponse, reportOptions.toolCallId!);
          return completed(options.runId);
        },
        resumeStream: async function* (runId) { return completed(runId); },
      };
    },
  };
}

function bindingStore(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number]): TargetBindingStore {
  return {
    reserveRequest: async () => { throw new Error('not used'); },
    getRequest: async () => null,
    getBinding: async runId => runId === binding.runId ? binding : null,
    getSnapshot: async bindingId => bindingId === binding.bindingId ? snapshot : null,
    listByTarget: async () => ({ items: [] }),
  };
}

function createOperations(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], runId: string): TargetOperationGuard {
  return {
    authorize: async input => permit(binding, snapshot, runId, input.capability),
    validate: async () => undefined,
  };
}

function permit(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], runId: string,
  capability: string): TargetOperationPermit {
  return { bindingId: binding.bindingId, runId, rootRunId: binding.rootRunId, snapshotDigest: snapshot.digest,
    operation: 'source', capability, policyEpoch: 1, signal: new AbortController().signal };
}

function parentToolOptions(snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], runId: string,
  networkAttemptBudget: { remaining: number } = { remaining: 8 }): ToolCallOptions {
  const binding: TargetRunBindingRecord = { bindingId: `binding-${snapshot.projectId}`, targetId: snapshot.targetId, runId,
    rootRunId: runId, snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt };
  const sourceId = snapshot.sourceBindings.find(source => source.kind === 'metrics')!.sourceId;
  return {
    toolCallId: `${snapshot.targetId}-parent-tool-call`, runId, stepId: 'parent-step', profileId: snapshot.profile.profileId,
    targetBindingId: binding.bindingId, targetSourceId: sourceId, targetOperations: createOperations(binding, snapshot, runId),
    signal: new AbortController().signal, mode: 'execute', deadline: capturedAtMs + 120_000,
    remainingToolCalls: 4, networkAttemptBudget,
  };
}

function childToolOptions(snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], binding: TargetRunBindingRecord,
  runId: string, sourceId: string, operations: TargetOperationGuard, toolCallId: string,
  networkAttemptBudget: { remaining: number } | undefined): ToolCallOptions {
  return {
    toolCallId, runId, stepId: `${snapshot.targetId}-child-step`, profileId: snapshot.profile.profileId,
    targetBindingId: binding.bindingId, targetSourceId: sourceId, targetOperations: operations,
    targetOperationPermit: permit(binding, snapshot, runId, sourceId),
    signal: new AbortController().signal, mode: 'execute', deadline: capturedAtMs + 120_000,
    remainingToolCalls: 4, toolCallBudget: { remaining: 4 },
    ...(networkAttemptBudget === undefined ? {} : { networkAttemptBudget }),
  };
}

function metricsResponse(snapshot: Awaited<ReturnType<typeof resolveSnapshots>>[number], query: string) {
  const mapping = snapshot.scenario.metricMapping;
  const boundary = mapping.windowBoundaryMapping!;
  const name = query.slice(0, query.indexOf('{'));
  const outcome = name === mapping.metricName
    ? query.includes(`${mapping.outcomeLabel}=${JSON.stringify(mapping.successValue)}`) ? mapping.successValue : mapping.failureValue
    : undefined;
  const value = name === boundary.startMetricName ? windowStart
    : name === boundary.endMetricName ? windowEnd
      : snapshot.targetId === 'market-a-sim' ? outcome === mapping.successValue ? 96 : 4
        : outcome === mapping.successValue ? 97 : 3;
  const labels: Record<string, string> = {
    __name__: name,
    [mapping.serviceSelector.label]: mapping.serviceSelector.value,
    ...mapping.staticLabels,
    ...(outcome === undefined ? {} : { [mapping.outcomeLabel]: outcome }),
  };
  const body = JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{
    metric: labels, value: [windowEnd - 1, String(value)],
  }] } });
  return streamResponse(200, body);
}

function emptyResponse(status: number) { return streamResponse(status, 'private transport diagnostics must not be read'); }

function emptyVectorResponse() {
  return streamResponse(200, JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
}

function streamResponse(status: number, content: string) {
  return { status, body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(content)); controller.close(); },
  }) };
}

async function drainTool(tool: Tool, input: Record<string, unknown>, options: ToolCallOptions): Promise<{ chunks: ToolResponseChunk[]; response: ToolResponse }> {
  const value = tool.call?.(input, options);
  if (value === undefined) throw new Error(`Tool ${tool.name} has no call implementation.`);
  if (isPromiseLike(value)) return { chunks: [], response: await value };
  if (!isAsyncIterable(value)) return { chunks: [], response: value };
  const chunks: ToolResponseChunk[] = [];
  while (true) {
    const item = await value.next();
    if (item.done) return { chunks, response: item.value };
    chunks.push(item.value);
  }
}

function toolResult(runId: string, toolName: string, response: ToolResponse, toolCallId: string): AgentEvent {
  const timestamp = capturedAt;
  return { schemaVersion: 1, type: 'TOOL_RESULT', runId, stepId: 'child-step', timestamp,
    payload: { toolCallId, toolName, status: 'success', response, startedAt: timestamp, finishedAt: timestamp } };
}

function completed(runId: string): DiagnosisRunResult { return { runId, status: 'completed', finalText: '', contextVersion: 1 }; }

function isPromiseLike(value: unknown): value is Promise<ToolResponse> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
