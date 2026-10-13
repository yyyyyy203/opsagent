import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedModel } from '../../dist/model/scripted-model.js';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { startMetricsLab } from '../../dist/bootstrap/metrics-lab.js';
import { PrometheusSettlementSource } from '../../dist/infrastructure/prometheus/settlement-source.js';

const agentPort = Number(process.env.AGENTOPS_CIRCUIT_E2E_AGENT_PORT ?? 45300);
const controlPort = Number(process.env.AGENTOPS_CIRCUIT_E2E_CONTROL_PORT ?? 45301);
const webPort = Number(process.env.AGENTOPS_CIRCUIT_E2E_WEB_PORT ?? 45373);
const prometheusUrl = process.env.AGENTOPS_CIRCUIT_E2E_PROMETHEUS_URL;
const prometheusMode = prometheusUrl !== undefined;
const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-circuit-e2e-'));
let clockNow = Math.floor(Date.now() / 1_000) * 1_000;
let successfulSourceQueries = 0;
let scriptedModelCalls = 0;
let circuitOpenResultsObserved = 0;
let faultConfigured = false;
let probeFaultConfigured = false;
let clockAdvanceMs = 0;
let latestSnapshotSummary = null;
let runtime;
let lab;
let control;
let closing = false;

const sourceEnd = Math.floor(clockNow / 1_000);
const sourceWindow = {
  start: new Date((sourceEnd - 300) * 1_000).toISOString(),
  end: new Date(sourceEnd * 1_000).toISOString(),
};
const clock = { now: () => new Date(clockNow) };

class CountingScriptedModel extends ScriptedModel {
  constructor(responses, countCall) {
    super(responses);
    this.countCall = countCall;
  }

  async *stream(messages, tools, options) {
    this.countCall();
    return yield* super.stream(messages, tools, options);
  }
}

class PerChildScriptedModel {
  models = new Map();
  nextScenario = 0;

  constructor(countCall, observeMessages) {
    this.countCall = countCall;
    this.observeMessages = observeMessages;
  }

  async *stream(messages, tools, options) {
    this.observeMessages(messages);
    let model = this.models.get(options.runId);
    if (model === undefined) {
      model = new CountingScriptedModel(childResponses(options.runId, this.nextScenario), this.countCall);
      this.nextScenario += 1;
      this.models.set(options.runId, model);
    }
    return yield* model.stream(messages, tools, options);
  }
}

try {
  if (prometheusMode) assertLocalPrometheusUrl(prometheusUrl);
  const sourceFactory = prometheusMode ? (url) => {
    const upstream = new PrometheusSettlementSource({ url });
    return {
      async query(signal) {
        const snapshot = await upstream.query(signal);
        successfulSourceQueries += 1;
        latestSnapshotSummary = snapshot.status === 'available'
          ? { status: snapshot.status, total: snapshot.counts.total, failed: snapshot.counts.failed }
          : { status: snapshot.status };
        return snapshot;
      },
    };
  } : () => ({
    query(signal) {
      signal.throwIfAborted();
      successfulSourceQueries += 1;
      latestSnapshotSummary = { status: 'available', total: 100, failed: 15 };
      return Promise.resolve({
        status: 'available',
        start: sourceEnd - 300,
        end: sourceEnd,
        counts: { total: 100, failed: 15 },
        raw: { data: { marker: 'CIRCUIT_E2E_PRIVATE_RAW', scenario: 'settlement_failure' } },
      });
    },
  });
  lab = await startMetricsLab({
    prometheusUrl: prometheusUrl ?? 'http://127.0.0.1:1',
    // Docker Desktop reaches the host exporter through host.docker.internal.
    metricsHost: prometheusMode ? '0.0.0.0' : '127.0.0.1',
    metricsPort: prometheusMode ? 19108 : 0,
    adminPort: 0,
    mcpPort: 0,
    initialScenario: 'settlement_failure',
    sourceFactory,
  });
  if (prometheusMode) await waitForPrometheusSnapshot(prometheusUrl);

  const parentModel = new CountingScriptedModel([
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-1')] },
    { text: '第一次来源故障调查已完成，保留熔断审计状态。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-2')] },
    { text: '熔断期间未访问指标来源。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-3')] },
    { text: '冷却尚未结束，来源仍被熔断阻止。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-4')] },
    { text: '恢复探测失败，来源重新熔断，未产生指标证据。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-5')] },
    { text: '重新熔断期间未访问指标来源。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-6')] },
    { text: '第二次冷却尚未结束，来源查询仍被阻止。', toolCalls: [] },
    { toolCalls: [metricsSubagentCall('circuit-parent-metrics-7')] },
    { text: '恢复探测成功，指标证据已记录。', toolCalls: [] },
  ], () => { scriptedModelCalls += 1; });
  const childModel = new PerChildScriptedModel(
    () => { scriptedModelCalls += 1; },
    (messages) => { if (JSON.stringify(messages).includes('CIRCUIT_OPEN')) circuitOpenResultsObserved += 1; },
  );

  runtime = await startAgentWebRuntime({
    dataDirectory,
    workspaceRoots: [dataDirectory],
    model: parentModel,
    metrics: { profileId: 'simulation', mcpUrl: lab.mcpUrl, childModel },
    sourceWindow,
    clock,
    host: '127.0.0.1',
    port: agentPort,
    allowedOrigins: [`http://127.0.0.1:${webPort}`],
  });
  control = await startControlServer();
} catch (error) {
  await close();
  throw error;
}

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

async function startControlServer() {
  const server = createServer((request, response) => {
    void handleControlRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CIRCUIT_E2E_CONTROL_LISTEN_FAILED');
  return { server, expectedHost: `127.0.0.1:${address.port}` };
}

async function handleControlRequest(request, response) {
  if (request.headers.origin !== undefined || request.headers.host !== control.expectedHost) {
    response.writeHead(403).end();
    return;
  }
  if (request.method === 'GET' && request.url === '/__state') {
    const status = await fetch(`${lab.adminUrl}/source-fault`);
    if (!status.ok) throw new Error('CIRCUIT_E2E_ADMIN_UNAVAILABLE');
    const fault = await status.json();
    sendJson(response, 200, {
      clockNow,
      remainingFailures: fault.remainingFailures,
      sourceQueries: successfulSourceQueries,
      sourceMode: prometheusMode ? 'prometheus' : 'deterministic',
      latestSnapshot: latestSnapshotSummary,
      scriptedModelCalls,
      circuitOpenResultsObserved,
    });
    return;
  }
  if ((request.url === '/__fault' && request.method !== 'PUT')
    || (request.url === '/__advance-time' && request.method !== 'POST')
    || (request.url !== '/__fault' && request.url !== '/__advance-time')) {
    response.writeHead(404).end();
    return;
  }
  const body = await readJson(request);
  if (body === undefined) { response.writeHead(400).end(); return; }
  if (request.url === '/__fault') {
    if (!faultConfigured && body.failures === 9) {
      faultConfigured = true;
    } else if (faultConfigured && !probeFaultConfigured && body.failures === 1
      && clockAdvanceMs === 30_000 && circuitOpenResultsObserved === 2 && successfulSourceQueries === 0) {
      probeFaultConfigured = true;
    } else { response.writeHead(409).end(); return; }
    const injected = await fetch(`${lab.adminUrl}/source-fault`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failures: body.failures }),
    });
    sendJson(response, injected.status, await injected.json());
    return;
  }
  const phase = [
    { elapsed: 0, advance: 29_999, blocked: 1 },
    { elapsed: 29_999, advance: 1, blocked: 2 },
    { elapsed: 30_000, advance: 29_999, blocked: 3 },
    { elapsed: 59_999, advance: 1, blocked: 4 },
  ].find((entry) => entry.elapsed === clockAdvanceMs);
  if (!faultConfigured || phase === undefined || body.milliseconds !== phase.advance
    || circuitOpenResultsObserved !== phase.blocked || (clockAdvanceMs >= 30_000 && !probeFaultConfigured)) {
    response.writeHead(409).end();
    return;
  }
  const status = await fetch(`${lab.adminUrl}/source-fault`);
  if (!status.ok || (await status.json()).remainingFailures !== 0 || successfulSourceQueries !== 0) {
    response.writeHead(409).end();
    return;
  }
  clockAdvanceMs += body.milliseconds;
  clockNow += body.milliseconds;
  sendJson(response, 200, { clockNow });
}

function metricsSubagentCall(id) {
  return {
    id,
    name: 'metrics_subagent',
    input: {
      profileId: 'simulation',
      service: 'checkout',
      start: sourceWindow.start,
      end: sourceWindow.end,
      question: 'checkout 的结算失败率是否升高？',
    },
  };
}

function childResponses(childRunId, scenario) {
  if (scenario === 0) {
    return [
      ...[1, 2, 3].map((attempt) => ({ toolCalls: [metricCall(`circuit-failure-${attempt}`)] })),
      { text: '模拟指标来源连续失败，未采集到指标证据。', toolCalls: [] },
    ];
  }
  if (scenario === 1 || scenario === 2 || scenario === 4 || scenario === 5) {
    return [
      { toolCalls: [metricCall(`circuit-blocked-call-${scenario}`)] },
      { text: '数据源熔断期间来源查询被阻止。', toolCalls: [] },
    ];
  }
  if (scenario === 3) {
    return [
      { toolCalls: [metricCall('circuit-failed-probe-call')] },
      { text: '半开探测失败，未采集到指标证据，等待新的冷却窗口。', toolCalls: [] },
    ];
  }
  if (scenario === 6) {
    const metricToolCallId = 'circuit-recovery-call';
    const digest = createHash('sha256')
      .update(`${childRunId}\u0000${metricToolCallId}`)
      .digest('hex')
      .slice(0, 32);
    const evidenceId = `metric-evidence-${digest}`;
    return [
      { toolCalls: [metricCall(metricToolCallId)] },
      { toolCalls: [{
        id: 'circuit-recovery-report',
        name: 'source_report',
        input: {
          summary: '模拟结算指标已恢复并完成核验。',
          findings: [{ kind: 'observation', statement: '模拟结算失败率为 15%，高于 5% 阈值。', evidenceIds: [evidenceId] }],
          businessTraceIds: [],
          missingEvidence: [],
        },
      }] },
      { text: '恢复探测成功，来源报告已提交。', toolCalls: [] },
    ];
  }
  throw new Error('CIRCUIT_E2E_CHILD_SCENARIO_EXHAUSTED');
}

function metricCall(id) {
  return { id, name: 'metrics.settlement', input: { service: 'checkout' } };
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    size += chunk.length;
    if (size > 1024) return undefined;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function assertLocalPrometheusUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('CIRCUIT_E2E_PROMETHEUS_URL_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '19090'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CIRCUIT_E2E_PROMETHEUS_URL_MUST_BE_LOCAL');
  }
}

async function waitForPrometheusSnapshot(url) {
  const source = new PrometheusSettlementSource({ url });
  const signal = AbortSignal.timeout(50_000);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    signal.throwIfAborted();
    try {
      const snapshot = await source.query(signal);
      if (snapshot.status === 'available' && snapshot.counts.total === 100 && snapshot.counts.failed === 15) return;
    } catch {
      signal.throwIfAborted();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('CIRCUIT_E2E_PROMETHEUS_SIMULATOR_NOT_SCRAPED');
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function close() {
  if (closing) return;
  closing = true;
  const results = await Promise.allSettled([
    (async () => {
      if (!control?.server.listening) return;
      control.server.closeAllConnections();
      await new Promise((resolve) => control.server.close(() => resolve()));
    })(),
    runtime?.close(),
    lab?.close(),
  ]);
  try {
    await rm(dataDirectory, { recursive: true, force: true });
  } catch (error) {
    results.push({ status: 'rejected', reason: error });
  }
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Circuit E2E fixture cleanup failed.');
}
