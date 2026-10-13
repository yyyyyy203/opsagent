import { describe, expect, it } from 'vitest';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { createMetricsSubagentTool } from '../src/bootstrap/metrics-subagent.js';
import { settlementMetricsLabProfile } from '../src/profiles/settlement.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { PrometheusQueryError, type SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';

const snapshot: SettlementSnapshot = {
  status: 'available', counts: { total: 100, failed: 15 }, start: 700, end: 1000,
  raw: {
    original: 'raw-only-marker', url: 'https://metrics.example.test/private',
    query: 'sum(rate(checkout_failures_total[5m]))', credentials: 'credential-only-marker',
  },
};
async function fixture(
  query: (signal: AbortSignal) => Promise<SettlementSnapshot>,
  failStorage = false,
  executor?: ResilientExecutor,
  now: () => number = () => 1_010_000,
) {
  const server = await startSettlementMcpServer({ query }, { port: 0 });
  const connection = new HttpMcpConnection({ url: server.url });
  const evidence = new InMemoryEvidenceStore();
  const signal = new AbortController().signal;
  await connection.connect(signal);
  const sourceExecutor = executor ?? new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() });
  const tool = await bindSettlementEvidenceTool({ connection, evidence: failStorage ? { get: (id) => evidence.get(id), save: () => Promise.reject(new Error('private-storage-detail')) } : evidence,
    signal, executor: sourceExecutor,
    id: () => 'evidence-1', now });
  return { server, connection, tool, evidence, executor: sourceExecutor, async close() { await connection.close(); await server.close(); } };
}
async function inspect(f: Awaited<ReturnType<typeof fixture>>, input: Record<string, unknown> = { service: 'checkout' }) {
  const runtime = createInspectionRuntime({ model: new ScriptedModel([
    { toolCalls: [{ id: 'call-1', name: f.tool.name, input }] }, { toolCalls: [] },
  ]), workspaceRoots: [], tools: [f.tool], allowedToolNames: [f.tool.name] });
  const run = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
  const context = await runtime.checkpoints.load(run.runId);
  const block = context?.messages.flatMap((message) => message.blocks).find((item) => item.type === 'tool_result');
  if (block?.type !== 'tool_result') throw new Error('Missing result');
  return { run, context, result: block.result };
}
describe('settlement MCP to Harness evidence integration', () => {
  it('persists raw evidence before returning a deterministic finding with a reference', async () => {
    const f = await fixture(() => Promise.resolve(snapshot));
    try {
      const { run, context, result } = await inspect(f);
      expect(result.status).toBe('success');
      expect(result.response?.evidenceIds).toEqual(['evidence-1']);
      expect(result.response?.blocks).toContainEqual({ type: 'evidence_ref', evidenceId: 'evidence-1' });
      expect(result.response?.metadata).toEqual({
        sourceEvidence: {
          schemaVersion: 1,
          source: 'metrics',
          evidenceId: 'evidence-1',
          state: 'committed',
          coverage: 1,
          timeRange: {
            start: '1970-01-01T00:11:40.000Z',
            end: '1970-01-01T00:16:40.000Z',
          },
          missingEvidence: [],
        },
      });
      expect(await f.evidence.get('evidence-1')).toMatchObject({ runId: run.runId, source: 'metric', raw: snapshot.raw, summary: { status: 'breached', failureRate: 0.15, missingEvidence: ['logs', 'traces'] } });
      expect(JSON.stringify(context)).not.toContain('raw-only-marker');
      expect(JSON.stringify(result.response?.metadata)).not.toContain('raw-only-marker');
      expect(JSON.stringify(result.response?.metadata)).not.toContain('metrics.example.test');
      expect(JSON.stringify(result.response?.metadata)).not.toContain('checkout_failures_total');
      expect(JSON.stringify(result.response?.metadata)).not.toContain('credential-only-marker');
    } finally { await f.close(); }
  });
  it('retries upstream transient errors through the existing client budget', async () => {
    let calls = 0;
    const f = await fixture(() => ++calls < 3 ? Promise.reject(new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', 503)) : Promise.resolve(snapshot));
    try { expect((await inspect(f)).result.status).toBe('success'); expect(calls).toBe(3); }
    finally { await f.close(); }
  });
  it('bounds MCP retries, opens the source circuit, reports missing Metrics evidence, and recovers through one half-open probe', async () => {
    let currentTime = 1_010_000;
    let calls = 0;
    const now = () => currentTime;
    const breaker = new SourceCircuitBreaker({ threshold: 1, cooldownMs: 1_000, now });
    const executor = new ResilientExecutor(breaker, { maxRetries: 2, now, sleep: () => Promise.resolve() });
    const recoveredSnapshot: SettlementSnapshot = {
      ...snapshot,
      start: 711,
      end: 1011,
    };
    const f = await fixture(
      () => {
        calls += 1;
        return calls <= 3
          ? Promise.reject(new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', 503))
          : Promise.resolve(recoveredSnapshot);
      },
      false,
      executor,
      now,
    );
    try {
      const unavailable = await inspectMetricsSubagent(f, now, false);
      expect(unavailable).toMatchObject({
        status: 'unavailable', evidenceIds: [], missingEvidence: ['metrics'], missingEvidenceCodes: ['metrics'],
      });
      expect(JSON.stringify(unavailable)).not.toContain('failureRate');
      expect(calls).toBe(3);
      expect(breaker.state).toBe('open');

      const stillUnavailable = await inspectMetricsSubagent(f, now, false);
      expect(stillUnavailable).toMatchObject({ status: 'unavailable', missingEvidence: ['metrics'] });
      expect(calls).toBe(3);
      expect(breaker.state).toBe('open');

      currentTime += 1_000;
      const recovered = await inspectMetricsSubagent(f, now, true);
      expect(recovered).toMatchObject({ status: 'complete', evidenceIds: ['evidence-1'], missingEvidence: [] });
      expect(calls).toBe(4);
      expect(breaker.state).toBe('closed');
    } finally { await f.close(); }
  });
  it('does not retry upstream authentication failures', async () => {
    let calls = 0;
    const f = await fixture(() => { calls++; return Promise.reject(new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', 401)); });
    try { expect((await inspect(f)).result.error?.code).toBe('MCP_AUTH_ERROR'); expect(calls).toBe(1); }
    finally { await f.close(); }
  });
  it('returns insufficient evidence without inventing evidence references', async () => {
    const f = await fixture(() => Promise.resolve({ status: 'unavailable', reason: 'missing_series' }));
    try {
      const { result } = await inspect(f);
      expect(result.response?.blocks).toContainEqual({ type: 'json', value: { status: 'insufficient_data', reason: 'missing_series', missingEvidence: ['metrics', 'logs', 'traces'] } });
      expect(result.response?.metadata?.sourceEvidence).toBeUndefined();
      expect(result.response?.evidenceIds).toBeUndefined();
      expect(await f.evidence.get('evidence-1')).toBeNull();
    } finally { await f.close(); }
  });
  it('fails closed if evidence persistence fails', async () => {
    const f = await fixture(() => Promise.resolve(snapshot), true);
    try {
      const { result } = await inspect(f);
      expect(result.status).toBe('failed'); expect(result.error?.code).toBe('STORAGE_ERROR');
      expect(JSON.stringify(result)).not.toContain('private-storage-detail');
      expect(result.response?.evidenceIds).toBeUndefined();
    } finally { await f.close(); }
  });
  it('rejects out-of-scope queries before contacting the source', async () => {
    let calls = 0;
    const f = await fixture(() => { calls++; return Promise.resolve(snapshot); });
    try { expect((await inspect(f, { service: 'other' })).result.status).toBe('failed'); expect(calls).toBe(0); }
    finally { await f.close(); }
  });
  it('denies browser-origin requests and unknown paths', async () => {
    const f = await fixture(() => Promise.resolve(snapshot));
    try {
      expect((await fetch(f.server.url, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect((await fetch(f.server.url + '/other')).status).toBe(404);
    } finally { await f.close(); }
  });
});

async function inspectMetricsSubagent(f: Awaited<ReturnType<typeof fixture>>, now: () => number, reportSuccess: boolean) {
  const clock = { now: () => new Date(now()) };
  const start = new Date(now() - 300_000).toISOString();
  const end = new Date(now()).toISOString();
  const metricsTool = createMetricsSubagentTool({
    profile: settlementMetricsLabProfile,
    settlementTool: f.tool,
    clock,
    sourceWindow: { start, end },
    childAgentFactory: {
      create: (input) => createAgentRuntime({
        model: new ScriptedModel([
          { toolCalls: [{ id: 'metric-call', name: 'metrics.settlement', input: { service: 'checkout' } }] },
          ...(reportSuccess ? [{ toolCalls: [{ id: 'report-call', name: 'source_report', input: {
            summary: '读取模拟结算指标。',
            findings: [{ kind: 'observation' as const, statement: '指标事实见证据引用。', evidenceIds: ['evidence-1'] }],
            businessTraceIds: [],
            missingEvidence: [],
          } }] }] : []),
          { text: '指标取证结束。', toolCalls: [] },
        ]),
        workspaceRoots: [],
        includeExternalBash: false,
        tools: [...input.tools],
        clock,
      }).agent,
    },
  });
  const parent = createInspectionRuntime({
    model: new ScriptedModel([
      { toolCalls: [{ id: 'parent-metrics-call', name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout', start, end, question: '检查模拟结算指标',
      } }] },
      { text: '模拟指标取证已完成。', toolCalls: [] },
    ]),
    workspaceRoots: [],
    sourceSubagentTools: [metricsTool],
    allowedToolNames: ['metrics_subagent'],
    clock,
  });
  try {
    const run = await parent.agent.reply({ message: '检查模拟结算指标', profileId: 'simulation' });
    const context = await parent.checkpoints.load(run.runId);
    const result = context?.messages.flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result' && block.result.toolName === 'metrics_subagent');
    if (result?.type !== 'tool_result') throw new Error('Metrics Subagent ToolResult missing');
    const report = result.result.response?.blocks.find((block) => block.type === 'json');
    if (report?.type !== 'json' || typeof report.value !== 'object' || report.value === null) {
      throw new Error(`Metrics Subagent report missing: ${JSON.stringify(result.result)}`);
    }
    return report.value;
  } finally { await parent.close(); }
}
