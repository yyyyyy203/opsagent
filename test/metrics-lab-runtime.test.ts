import { describe, expect, it } from 'vitest';
import { startMetricsLab } from '../src/bootstrap/metrics-lab.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import type { Tool, ToolResponse, ToolResponseChunk } from '../src/contracts/tool.js';

describe('metrics lab composition', () => {
  it('starts isolated scrape, admin and MCP surfaces and closes them together', async () => {
    const lab = await startMetricsLab({ prometheusUrl: 'http://127.0.0.1:1', metricsHost: '127.0.0.1', metricsPort: 0, adminPort: 0, mcpPort: 0 });
    const connection = new HttpMcpConnection({ url: lab.mcpUrl });
    try {
      const changed = await fetch(`${lab.adminUrl}/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"scenario":"settlement_failure"}' });
      expect(changed.status).toBe(200);
      expect(await (await fetch(`${lab.metricsUrl}/metrics`)).text()).toContain('outcome="failure"} 15');
      await connection.connect(AbortSignal.timeout(2000));
      expect((await connection.listTools(AbortSignal.timeout(2000))).map((tool) => tool.name)).toEqual(['get_settlement_snapshot']);
    } finally { await connection.close(); await lab.close(); }
    await expect(fetch(`${lab.adminUrl}/scenarios`)).rejects.toThrow();
    await expect(fetch(`${lab.metricsUrl}/metrics`)).rejects.toThrow();
  });

  it('drives the simulator through retries, open-circuit rejection, one recovery probe, and evidence capture', async () => {
    let sourceQueries = 0;
    const lab = await startMetricsLab({
      prometheusUrl: 'http://127.0.0.1:1', metricsHost: '127.0.0.1', metricsPort: 0, adminPort: 0, mcpPort: 0,
      sourceFactory: () => ({ query: (signal) => {
        signal.throwIfAborted();
        sourceQueries += 1;
        const end = Math.floor(Date.now() / 1000);
        return Promise.resolve({ status: 'available', counts: { total: 100, failed: 15 }, start: end - 300, end, raw: { source: 'simulator' } });
      } }),
    });
    const connection = new HttpMcpConnection({ url: lab.mcpUrl });
    let circuitNow = Date.now();
    const executor = new ResilientExecutor(new SourceCircuitBreaker({ now: () => circuitNow }), {
      now: Date.now, sleep: () => Promise.resolve(),
    });
    const capturedEvidence: string[] = [];
    try {
      const injected = await fetch(`${lab.adminUrl}/source-fault`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"failures":9}',
      });
      expect(injected.status).toBe(200);
      await connection.connect(AbortSignal.timeout(2_000));
      const tool = await bindSettlementEvidenceTool({
        connection,
        executor,
        signal: AbortSignal.timeout(2_000),
        recorder: { capture: (request) => { capturedEvidence.push(request.record.evidenceId); return Promise.resolve(request.record); } },
      });
      const call = async (toolCallId: string) => drainResilienceTool(tool, toolCallId);

      const first = await call('metric-call-1');
      const second = await call('metric-call-2');
      const third = await call('metric-call-3');
      expect(first.events).toContainEqual(expect.objectContaining({ kind: 'retry_scheduled', sourceId: 'prometheus' }));
      expect(second.events).toContainEqual(expect.objectContaining({ kind: 'retry_scheduled', sourceId: 'prometheus' }));
      const openedEvent = third.events.find((event) => event.kind === 'circuit_opened');
      expect(openedEvent?.sourceId).toBe('prometheus');
      const openedWindow = openedEvent?.failureWindow;
      expect(typeof openedWindow).toBe('object');
      if (typeof openedWindow !== 'object' || openedWindow === null) throw new Error('Circuit event omitted failure window');
      expect(Reflect.get(openedWindow, 'failures')).toBe(3);
      expect(Number.isInteger(Reflect.get(openedWindow, 'windowMs'))).toBe(true);
      expect(third.error).toMatchObject({ code: 'MCP_NETWORK_ERROR' });
      const faultState = await fetch(`${lab.adminUrl}/source-fault`);
      expect(JSON.parse(await faultState.text()) as unknown).toEqual({ remainingFailures: 0 });

      const blocked = await call('metric-call-blocked');
      expect(blocked.error).toMatchObject({ code: 'CIRCUIT_OPEN' });
      expect(blocked.events).toEqual([]);
      expect(sourceQueries).toBe(0);

      circuitNow += 30_000;
      const recovered = await call('metric-call-recovery');
      expect(recovered.events).toEqual([
        expect.objectContaining({ kind: 'circuit_half_opened', probePolicy: 'single_probe' }),
        expect.objectContaining({ kind: 'circuit_closed', sourceId: 'prometheus' }),
      ]);
      expect(recovered.response?.evidenceIds).toHaveLength(1);
      expect(capturedEvidence).toEqual(recovered.response?.evidenceIds);
      expect(sourceQueries).toBe(1);
    } finally { await connection.close(); await lab.close(); }
  });
});

async function drainResilienceTool(tool: Tool, toolCallId: string): Promise<{
  events: Record<string, unknown>[];
  response?: ToolResponse;
  error?: { code?: string };
}> {
  const events: Record<string, unknown>[] = [];
  const invocation = tool.call?.({ service: 'checkout' }, {
    runId: 'simulated-run', stepId: `step-${toolCallId}`, toolCallId,
    signal: AbortSignal.timeout(5_000), mode: 'execute',
  });
  if (!invocation || typeof invocation !== 'object' || !(Symbol.asyncIterator in invocation)) throw new Error('Expected a streaming evidence Tool');
  const stream = invocation as AsyncGenerator<ToolResponseChunk, ToolResponse>;
  try {
    while (true) {
      const item = await stream.next();
      if (item.done) return { events, response: item.value };
      if (item.value.type === 'event' && item.value.name === 'source_resilience') events.push(item.value.payload);
    }
  } catch (error) {
    return { events, error: typeof error === 'object' && error !== null && 'code' in error ? { code: String(error.code) } : {} };
  }
}
