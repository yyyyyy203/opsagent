import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { startMetricsLab } from '../../dist/bootstrap/metrics-lab.js';
import { startLogsMcpServer } from '../../dist/infrastructure/mcp/logs-server.js';
import { generateScenarioLogs } from '../../dist/infrastructure/simulator/log-fixtures.js';
import { ScriptedModel } from '../../dist/model/scripted-model.js';

const root = await mkdtemp(join(tmpdir(), 'agentops-memory-multisource-e2e-'));
const agentPort = Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT ?? 45700);
const webPort = Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT ?? 45773);
const controlPort = Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT ?? 45701);
const nowSeconds = Math.floor(Date.now() / 1_000);
const snapshot = { start: nowSeconds - 300, end: nowSeconds, success: 85, failure: 15 };
const sourceWindow = {
  start: new Date(snapshot.start * 1_000).toISOString(),
  end: new Date(snapshot.end * 1_000).toISOString(),
};
const totals = { parent: 0, metrics: 0, logs: 0, metricQueries: 0, metricAborts: 0, logPages: 0, recalledRuns: [] };
let activeScenario = 'normal';
const metricRaw = { data: { marker: 'MEMORY_MULTISOURCE_SIMULATED_METRIC' } };
let metricsLab;
let logsMcp;
let runtime;
let control;
let closing = false;
const observedBackendRequests = [];
let allowedBackendOrigins = [];
let blockedExternalRequests = 0;
let originalFetch;

try {
  metricsLab = await startMetricsLab({
    prometheusUrl: 'http://127.0.0.1:1',
    metricsHost: '127.0.0.1',
    metricsPort: 0,
    adminPort: 0,
    mcpPort: 0,
    initialScenario: 'settlement_failure',
    sourceFactory: () => ({
      async query(signal) {
        signal.throwIfAborted();
        totals.metricQueries += 1;
        if (activeScenario === 'metrics_timeout') {
          throw Object.assign(new Error('Simulated Metrics timeout.'), { name: 'TimeoutError' });
        }
        if (activeScenario === 'metrics_failure') throw new Error('Simulated Metrics source failure.');
        if (activeScenario === 'metrics_hang') {
          await new Promise((_, reject) => {
            const abort = () => {
              totals.metricAborts += 1;
              reject(signal.reason ?? Object.assign(new Error('Simulated Metrics request aborted.'), { name: 'AbortError' }));
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        }
        return { status: 'available', start: snapshot.start, end: snapshot.end,
          counts: { total: 100, failed: 15 }, raw: metricRaw };
      },
    }),
  });

  const simulatedRecords = [];
  for await (const record of generateScenarioLogs(snapshot, 'settlement_failure')) simulatedRecords.push(record);
  logsMcp = await startLogsMcpServer({
    async searchPage(input, signal) {
      signal.throwIfAborted();
      totals.logPages += 1;
      if (activeScenario === 'logs_failure'
        || (activeScenario === 'logs_partial' && input.cursor !== undefined)) {
        return { status: 'source_error', code: 'UNAVAILABLE', reason: 'simulated_failure' };
      }
      if (input.service !== 'checkout' || input.start !== sourceWindow.start || input.end !== sourceWindow.end) {
        return { status: 'source_error', code: 'POLICY_DENIED', reason: 'scope_denied' };
      }
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > simulatedRecords.length) {
        return { status: 'source_error', code: 'MCP_PROTOCOL_ERROR' };
      }
      const records = simulatedRecords.slice(offset, offset + 32);
      const next = offset + records.length;
      return {
        status: 'available', records, sourceSnapshotId: 'memory-multisource-logs-v1',
        ...(next < simulatedRecords.length ? { nextCursor: String(next) } : {}),
      };
    },
    async closeSnapshot() {},
    async close() {},
  }, { port: 0 });

  installBackendRequestGuard([metricsLab.mcpUrl, logsMcp.url]);
  await assertBackendRequestGuardBlocksRemote();

  runtime = await startAgentWebRuntime({
    dataDirectory: root,
    workspaceRoots: [root],
    model: createParentScriptedModel(),
    metrics: { profileId: 'simulation', mcpUrl: metricsLab.mcpUrl, childModel: createMetricsScriptedModel() },
    logs: { profileId: 'simulation', mcpUrl: logsMcp.url, childModel: createLogsScriptedModel(), cursorSecret: 'memory-multisource-local-cursor-secret-v1' },
    sourceWindow,
    diagnosticMemory: {
      enabled: true,
      profiles: [{
        scope: {
          profileId: 'simulation', profileRevision: 'sim-v1', serviceId: 'checkout', faultType: 'settlement_failure',
          targetFingerprint: 'memory-multisource-local', environment: 'simulation', dataClass: 'simulated',
          datasetId: 'memory-lab-v1',
        },
        profilePolicyRevision: 'sim-memory-policy-v1', captureDefault: 'manual', recallDefault: false,
        allowAutomaticCapture: false, allowRecall: true,
      }],
      requiredSources: ['metric', 'log'], modelWindowTokens: 32_768, reservedOutputTokens: 4_096,
    },
    host: '127.0.0.1', port: agentPort,
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

function createParentScriptedModel() {
  return {
    async *stream(messages, tools, options) {
    totals.parent += 1;
    const requestedScenario = findScenario(messages);
    if (requestedScenario !== undefined) activeScenario = requestedScenario;
    if (hasResult(messages, 'metrics_subagent') && hasResult(messages, 'logs_subagent')
      && containsText(messages, '历史案例，非本轮事实')) totals.recalledRuns.push(options.runId);
    let response;
    if (!hasResult(messages, 'metrics_subagent')) {
      response = { toolCalls: [{ id: `parent-metrics-${options.runId}`, name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...sourceWindow, question: '核验结算指标',
      } }] };
    } else if (!hasResult(messages, 'logs_subagent')) {
      response = { toolCalls: [{ id: `parent-logs-${options.runId}`, name: 'logs_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...sourceWindow, question: '调查结算日志',
      } }] };
    } else {
      const memoryUsed = containsText(messages, '历史案例，非本轮事实');
      const text = memoryUsed
        ? '结合已审核的历史参考，本轮指标与日志证据仍支持结算失败率升高；Trace 来源未配置，无法确认完整调用链或根因。SETTLEMENT_FAILURE_HIGH'
        : '本轮模拟指标与日志证据支持结算失败率升高；Trace 来源未配置，无法确认完整调用链或根因。SETTLEMENT_FAILURE_HIGH';
      response = { text, toolCalls: [] };
    }
      return yield* new ScriptedModel([response]).stream(messages, tools, options);
    },
  };
}

function createMetricsScriptedModel() {
  return {
    async *stream(messages, tools, options) {
    totals.metrics += 1;
    const observedId = evidenceFrom(messages, 'metrics.settlement');
    const observedResult = toolResult(messages, 'metrics.settlement');
    let response;
    if (observedResult !== undefined && observedResult.status !== 'success') {
      response = { text: '指标来源失败；停止本来源查询。', toolCalls: [] };
    } else if (observedId === undefined) {
      response = { toolCalls: [{ id: `metric-query-${options.runId}`, name: 'metrics.settlement', input: { service: 'checkout' } }] };
    } else if (!hasResult(messages, 'source_report')) {
      response = { toolCalls: [{ id: `metric-report-${options.runId}`, name: 'source_report', input: {
        summary: '模拟结算指标已核验。',
        findings: [{ kind: 'observation', statement: '指标窗口已观测到结算失败率升高。', evidenceIds: [observedId] }],
        businessTraceIds: [], missingEvidence: [],
      } }] };
    } else {
      response = { text: '指标来源调查完成。', toolCalls: [] };
    }
      return yield* new ScriptedModel([response]).stream(messages, tools, options);
    },
  };
}

function createLogsScriptedModel() {
  return {
    async *stream(messages, tools, options) {
    totals.logs += 1;
    const observedId = evidenceFrom(messages, 'logs.capture');
    const observedResult = toolResult(messages, 'logs.capture');
    let response;
    if (observedResult !== undefined && observedResult.status !== 'success') {
      response = { text: '日志来源失败；停止本来源查询。', toolCalls: [] };
    } else if (observedId === undefined) {
      response = { toolCalls: [{ id: `logs-capture-${options.runId}`, name: 'logs.capture', input: {
        service: 'checkout', ...sourceWindow,
      } }] };
    } else if (!hasResult(messages, 'logs.aggregate_evidence')) {
      response = { toolCalls: [{ id: `logs-aggregate-${options.runId}`, name: 'logs.aggregate_evidence', input: { evidenceId: observedId } }] };
    } else if (!hasResult(messages, 'source_report')) {
      response = { toolCalls: [{ id: `logs-report-${options.runId}`, name: 'source_report', input: {
        summary: '模拟结算日志已采集并聚合。',
        findings: [{ kind: 'observation', statement: '日志中观测到结算超时记录。', evidenceIds: [observedId] }],
        businessTraceIds: [], missingEvidence: [],
      } }] };
    } else {
      response = { text: '日志来源调查完成；没有完整 Trace 调用链。', toolCalls: [] };
    }
      return yield* new ScriptedModel([response]).stream(messages, tools, options);
    },
  };
}

function hasResult(messages, toolName) {
  return messages.some((message) => Array.isArray(message.blocks)
    && message.blocks.some((block) => block.type === 'tool_result' && block.result.toolName === toolName));
}

function toolResult(messages, toolName) {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.result.toolName === toolName) return block.result;
    }
  }
  return undefined;
}

function findScenario(messages) {
  const text = messages.flatMap((message) => message.blocks ?? [])
    .filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const match = /E2E_SCENARIO=(normal|metrics_failure|logs_failure|metrics_timeout|metrics_hang|logs_partial)/u.exec(text);
  return match?.[1] ?? undefined;
}

function evidenceFrom(messages, toolName) {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool_result' || block.result.toolName !== toolName) continue;
      const response = block.result.response;
      const id = response?.evidenceIds?.[0] ?? response?.blocks?.find((part) => part.type === 'evidence_ref')?.evidenceId;
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

function containsText(messages, expected) {
  return messages.some((message) => message.blocks?.some((block) => block.type === 'text' && block.text?.includes(expected)));
}

async function startControlServer() {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/__state') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      runtimeReady: runtime !== undefined,
      sourceMode: 'deterministic-local-simulation',
      scriptedModelCalls: { parent: totals.parent, metrics: totals.metrics, logs: totals.logs },
      metricQueries: totals.metricQueries,
      metricAborts: totals.metricAborts,
      logPages: totals.logPages,
      recalledRuns: totals.recalledRuns,
      backendRequests: [...observedBackendRequests],
      allowedBackendOrigins,
      blockedExternalRequests,
    }));
  });
  server.requestTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

function installBackendRequestGuard(allowedUrls) {
  originalFetch = globalThis.fetch;
  const allowedOrigins = new Set(allowedUrls.map((value) => new URL(value).origin));
  allowedBackendOrigins = [...allowedOrigins].sort();
  globalThis.fetch = async (input, init) => {
    const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (!allowedOrigins.has(target.origin)) {
      blockedExternalRequests += 1;
      throw new Error(`E2E blocked non-local backend request to ${target.origin}`);
    }
    observedBackendRequests.push({ origin: target.origin, method: init?.method ?? 'GET' });
    return originalFetch(input, init);
  };
}

async function assertBackendRequestGuardBlocksRemote() {
  const before = blockedExternalRequests;
  await globalThis.fetch('https://agentops-memory-fixture.invalid/should-not-connect').then(
    () => { throw new Error('E2E backend request guard allowed a non-local URL.'); },
    () => undefined,
  );
  if (blockedExternalRequests !== before + 1) throw new Error('E2E backend request guard did not observe its blocked probe.');
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    if (control?.listening) {
      control.closeAllConnections();
      await new Promise((resolve) => control.close(resolve));
    }
    await runtime?.close();
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    await logsMcp?.close();
    await metricsLab?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
