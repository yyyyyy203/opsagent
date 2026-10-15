import { describe, expect, it } from 'vitest';
import type { AgentEvent, Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../src/contracts/index.js';
import type { TargetBindingStore, TargetOperationGuard, TargetOperationPermit, TargetRunBindingRecord, TrustedTargetBinding } from '../src/contracts/target.js';
import type { DiagnosisRunResult, SourceChildAgentFactory } from '../src/application/source-subagent-runner.js';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { createTargetMetricsSubagentRuntime } from '../src/bootstrap/target-metrics-subagent.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const now = Date.parse('2026-10-12T02:00:00.000Z');
const start = (now - 300_000) / 1_000;
const end = now / 1_000;
const parentRunId = 'target-parent-run';

describe('Target-bound Metrics Subagent runtime', () => {
  it('exposes only the canonical subagent, inherits the exact parent binding, and keeps metric selectors host-bound', async () => {
    const snapshot = await resolveSnapshot();
    const binding: TargetRunBindingRecord = {
      bindingId: 'target-binding-a', targetId: snapshot.targetId, runId: parentRunId,
      rootRunId: parentRunId, snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt,
    };
    const targetBindings = bindingStore(binding, snapshot);
    const childTools: Tool[][] = [];
    const resilienceChunks: ToolResponseChunk[] = [];
    let inherited: TrustedTargetBinding | undefined;
    const childAgentFactory: SourceChildAgentFactory = {
      create: (input) => {
        childTools.push([...input.tools]);
        return {
          replyStream: async function* (options) {
            inherited = options.trustedTargetBinding;
            const metric = input.tools.find(tool => tool.name === 'metrics.window_snapshot');
            const report = input.tools.find(tool => tool.name === 'source_report');
            if (metric?.call === undefined || report?.call === undefined) throw new Error('child tools missing');
            const operations = createOperations(binding, snapshot, options.runId);
            const childOptions = createToolCallOptions({
              runId: options.runId,
              profileId: snapshot.profile.profileId,
              targetBindingId: binding.bindingId,
              targetSourceId: input.targetSourceId!,
              targetOperations: operations,
              targetOperationPermit: permit(binding, snapshot, options.runId, input.targetSourceId!),
              signal: options.signal,
            });
            const collected = await drainTool(metric, {}, childOptions);
            resilienceChunks.push(...collected.chunks);
            const evidenceId = collected.response.evidenceIds?.[0];
            if (evidenceId === undefined) throw new Error('metric evidence missing');
            yield toolResult(options.runId, 'metrics.window_snapshot', collected.response, 'metric-child-call');
            const reportResponse = report.call({
              summary: '模型提交的报告摘要',
              findings: [{ kind: 'inference', statement: '模型猜测的根因', evidenceIds: [evidenceId] }],
              businessTraceIds: [], missingEvidence: [],
            }, childOptions);
            if (isPromiseLike(reportResponse) || isAsyncIterable(reportResponse)) throw new Error('report tool must be synchronous');
            yield toolResult(options.runId, 'source_report', reportResponse, 'source-report-call');
            return completed(options.runId);
          },
          resumeStream: async function* (runId) { return completed(runId); },
        };
      },
    };
    const queryCalls: string[] = [];
    const store = new InMemoryEvidenceStore();
    const acquired: Array<{ snapshotDigest: string; sourceId: string }> = [];
    let released = 0;
    const runtime = createTargetMetricsSubagentRuntime({
      snapshot,
      sourcePartitions: {
        acquire: (captured, sourceId) => {
          acquired.push({ snapshotDigest: captured.digest, sourceId });
          return {
            execute: async (operation, options) => {
              options.onEvent?.({ type: 'retry', attempt: 1, code: 'MCP_NETWORK_ERROR', delayMs: 200 });
              options.onCircuitEvent?.({ type: 'opened', openUntil: now + 30_000, failureWindow: { failures: 3, windowMs: 2_000 } });
              return operation(options.signal);
            },
            release: () => { released += 1; },
          };
        },
        shutdown: () => undefined,
      },
      queryPort: {
        query: async ({ query }) => {
          queryCalls.push(query);
          return jsonResponse(query, start, end);
        },
      },
      windowPolicy: {
        authorize: () => 'authorized',
        authorizeObservations: () => 'authorized',
      },
      evidenceRecorder: new DefaultEvidenceRecorder({ evidence: store }),
      childAgentFactory,
      targetBindings,
      clock: { now: () => new Date(now) },
      maxResponseBytes: 64 * 1024,
      timeoutMs: 1_000,
    });

    try {
      expect(runtime.tool.name).toBe('metrics_subagent');
      expect(runtime.tool.targetSourceId).toBe('market-a-metrics');
      expect(runtime.tool.implementationVersion).toBeTruthy();
      expect(childTools).toHaveLength(0);
      const schema = runtime.tool.inputSchema;
      if (!('shape' in schema)) throw new Error('expected Zod schema');
      expect(Object.keys(schema.shape)).toEqual(['profileId', 'service', 'start', 'end', 'question', 'evidenceIds']);

      const input = {
        profileId: snapshot.profile.profileId,
        service: snapshot.scenario.serviceId,
        start: new Date(start * 1_000).toISOString(),
        end: new Date(end * 1_000).toISOString(),
        question: '查询本 Target 的失败率',
      };
      const response = await drainTool(runtime.tool, input, createToolCallOptions({
        runId: parentRunId,
        profileId: snapshot.profile.profileId,
        targetBindingId: binding.bindingId,
        targetSourceId: 'market-a-metrics',
        targetOperations: createOperations(binding, snapshot, parentRunId),
      }));

      expect(response.response.isError).not.toBe(true);
      expect(response.response.blocks.find(block => block.type === 'json')).toMatchObject({
        type: 'json', value: { source: 'metrics', status: 'complete', evidenceIds: [expect.any(String)], coverage: 1 },
      });
      expect(inherited).toMatchObject({
        binding: { bindingId: binding.bindingId, rootRunId: binding.rootRunId, snapshotDigest: snapshot.digest },
        snapshot: { digest: snapshot.digest, memoryScope: snapshot.memoryScope },
      });
      expect(childTools[0]?.map(tool => tool.name)).toEqual(['metrics.window_snapshot', 'source_report']);
      expect(childTools[0]?.[0]).toMatchObject({ targetSourceId: 'market-a-metrics', source: 'mcp', kind: 'evidence' });
      expect(resilienceChunks).toHaveLength(2);
      expect(resilienceChunks[0]).toMatchObject({ type: 'event', name: 'source_resilience' });
      expect(resilienceChunks[1]).toMatchObject({ type: 'event', name: 'source_resilience' });
      if (resilienceChunks[0]?.type !== 'event' || resilienceChunks[1]?.type !== 'event') {
        throw new Error('Expected structured source resilience events.');
      }
      expect(resilienceChunks[0].payload).toMatchObject({ kind: 'retry_scheduled', sourceId: 'market-a-metrics' });
      expect(resilienceChunks[1].payload).toMatchObject({ kind: 'circuit_opened', sourceId: 'market-a-metrics' });
      expect(acquired).toEqual([{ snapshotDigest: snapshot.digest, sourceId: 'market-a-metrics' }]);
      expect(queryCalls).toHaveLength(4);
      expect(queryCalls.join('\n')).toContain('market_checkout_window_requests');
      expect(queryCalls.join('\n')).toContain('service="checkout"');
      expect(queryCalls.join('\n')).not.toContain('market-b');
      expect(queryCalls.join('\n')).not.toContain('promql');

      const evidenceId = response.response.evidenceIds?.[0];
      expect(evidenceId).toBeTruthy();
      const evidence = await store.get(evidenceId!);
      expect(evidence?.runId).toContain('source-child-metrics-');
      expect(evidence?.source).toBe('metric');
      expect(JSON.stringify(evidence?.raw)).toContain('market_checkout_window_requests');
      expect(JSON.stringify(response.response)).not.toContain('market_checkout_window_requests');
    } finally {
      runtime.release();
      runtime.release();
    }
    expect(released).toBe(1);
  });

  it('rejects caller-supplied Target/source identity, endpoint, or metric selectors before creating a child Run', async () => {
    const snapshot = await resolveSnapshot();
    let childCreated = false;
    const runtime = createTargetMetricsSubagentRuntime({
      snapshot,
      sourcePartitions: inertPartitions(),
      queryPort: { query: async () => jsonResponse('', start, end) },
      windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
      evidenceRecorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      childAgentFactory: { create: () => { childCreated = true; throw new Error('child must not be created'); } },
      targetBindings: bindingStore(fakeBinding(snapshot), snapshot),
      clock: { now: () => new Date(now) },
      maxResponseBytes: 1024,
      timeoutMs: 1_000,
    });
    const invalid = {
      profileId: snapshot.profile.profileId, service: 'checkout',
      start: new Date(start * 1_000).toISOString(), end: new Date(end * 1_000).toISOString(),
      question: 'inspect', targetId: snapshot.targetId, sourceId: 'market-a-metrics', endpoint: 'http://attacker.invalid',
      promql: 'up', metricName: 'attacker_metric',
    };
    await expect(drainTool(runtime.tool, invalid, createToolCallOptions({
      runId: parentRunId, profileId: snapshot.profile.profileId,
      targetBindingId: 'binding-a', targetSourceId: 'market-a-metrics',
      targetOperations: createOperations(fakeBinding(snapshot), snapshot, parentRunId),
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(childCreated).toBe(false);
    runtime.release();
  });
});

async function resolveSnapshot() {
  const identity = createTargetIdentityTestPorts();
  const resolver = await createStaticTargetResolver({
    ...identity,
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: new Date(now).toISOString(),
  });
  return resolver.resolve({ targetId: 'market-a-sim', capturedAt: new Date(now).toISOString(), signal: new AbortController().signal });
}

function bindingStore(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshot>>): TargetBindingStore {
  return {
    reserveRequest: async () => { throw new Error('not used'); },
    getRequest: async () => null,
    getBinding: async runId => runId === binding.runId ? binding : null,
    getSnapshot: async bindingId => bindingId === binding.bindingId ? snapshot : null,
    listByTarget: async () => ({ items: [] }),
  };
}

function createOperations(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshot>>, runId: string): TargetOperationGuard {
  return {
    authorize: async input => permit(binding, snapshot, runId, input.capability),
    validate: async () => undefined,
  };
}

function permit(binding: TargetRunBindingRecord, snapshot: Awaited<ReturnType<typeof resolveSnapshot>>, runId: string, capability: string): TargetOperationPermit {
  return { bindingId: binding.bindingId, runId, rootRunId: binding.rootRunId, snapshotDigest: snapshot.digest,
    operation: 'source', capability, policyEpoch: 1, signal: new AbortController().signal };
}

function createToolCallOptions(input: { runId: string; profileId: string } & Omit<Partial<ToolCallOptions>, 'runId' | 'profileId'>): ToolCallOptions {
  return {
    ...input,
    toolCallId: 'parent-metrics-call', runId: input.runId, stepId: 'step-1', profileId: input.profileId,
    signal: input.signal ?? new AbortController().signal, mode: 'execute', deadline: now + 30_000,
    remainingToolCalls: 4, networkAttemptBudget: { remaining: 8 },
  };
}

async function drainTool(tool: Tool, input: Record<string, unknown>, options: ToolCallOptions): Promise<{ chunks: ToolResponseChunk[]; response: ToolResponse }> {
  const value = tool.call?.(input, options);
  if (value === undefined) throw new Error(`Tool ${tool.name} has no call implementation`);
  if (isPromiseLike(value)) return { chunks: [], response: await value };
  if (!isAsyncIterable(value)) return { chunks: [], response: value };
  const chunks: ToolResponseChunk[] = [];
  while (true) {
    const item = await value.next();
    if (item.done) return { chunks, response: item.value };
    chunks.push(item.value);
  }
}

function jsonResponse(query: string, windowStart: number, windowEnd: number) {
  const name = query.slice(0, query.indexOf('{'));
  const boundary = name.includes('_start_timestamp_seconds') ? windowStart
    : name.includes('_end_timestamp_seconds') ? windowEnd
      : query.includes('outcome="success"') ? 80 : 20;
  const metric: Record<string, string> = { __name__: name, service: 'checkout' };
  if (name === 'market_checkout_window_requests') metric.outcome = query.includes('outcome="success"') ? 'success' : 'failed';
  const payload = JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{
    metric, value: [windowEnd - 1, String(boundary)],
  }] } });
  return { status: 200, body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
  }) };
}

function toolResult(runId: string, toolName: string, response: ToolResponse, toolCallId: string): AgentEvent {
  const timestamp = new Date(now).toISOString();
  return { schemaVersion: 1, type: 'TOOL_RESULT', runId, stepId: 'child-step-1', timestamp,
    payload: { toolCallId, toolName, status: 'success', response, startedAt: timestamp, finishedAt: timestamp } };
}

function completed(runId: string): DiagnosisRunResult {
  return { runId, status: 'completed', finalText: '', contextVersion: 1 };
}

function fakeBinding(snapshot: Awaited<ReturnType<typeof resolveSnapshot>>): TargetRunBindingRecord {
  return { bindingId: 'binding-a', targetId: snapshot.targetId, runId: parentRunId, rootRunId: parentRunId,
    snapshotDigest: snapshot.digest, createdAt: snapshot.capturedAt };
}

function inertPartitions() {
  return { acquire: () => ({ execute: async <T>(operation: (signal: AbortSignal) => Promise<T>, options: { signal: AbortSignal }) => operation(options.signal), release: () => undefined }), shutdown: () => undefined };
}

function isPromiseLike(value: unknown): value is Promise<ToolResponse> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
