import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { createSqlitePersistence } from '../../dist/infrastructure/sqlite/persistence-bundle.js';
import { ScriptedModel } from '../../dist/model/scripted-model.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-memory-e2e-'));
const databasePath = join(dataDirectory, 'agent.sqlite');
const agentPort = Number(process.env.AGENTOPS_MEMORY_E2E_AGENT_PORT ?? 45400);
const webPort = Number(process.env.AGENTOPS_MEMORY_E2E_WEB_PORT ?? 45473);
const controlPort = Number(process.env.AGENTOPS_MEMORY_E2E_CONTROL_PORT ?? 45474);
const clock = { now: () => new Date() };
let persistence = createSqlitePersistence({ path: databasePath, clock });
const evidenceCapturedAt = '2026-10-11T00:04:00.000Z';

const fixtureTool = {
  name: 'fixture.metrics', description: 'Deterministic local memory E2E evidence.', kind: 'evidence', source: 'mcp',
  inputSchema: z.object({ fail: z.boolean().optional() }), isConcurrencySafe: () => true,
  call: async (input, options) => {
    if (input.fail) throw new Error('fixture investigation failed');
    const evidenceId = `memory-evidence-${options.runId}`;
    await persistence.evidence.save({ evidenceId, runId: options.runId, source: 'metric', capturedAt: evidenceCapturedAt,
      businessTraceIds: [], summary: { metric: 'settlement_failure_rate', value: 0.02,
        start: 1_791_676_800, end: 1_791_677_100 }, raw: { fixture: true } });
    return { blocks: [{ type: 'evidence_ref', evidenceId }, { type: 'json', value: { evidenceId, result: 'observed' } }], evidenceIds: [evidenceId] };
  },
};

const responses = [];
for (let run = 0; run < 20; run += 1) {
  responses.push({ text: '结算失败率升高，连接池等待增加。症状码：SETTLEMENT_FAILURE_HIGH', toolCalls: [] });
}
class MemoryFixtureModel extends ScriptedModel {
  privateCallCount = 0;
  async *stream(messages, tools, options) {
    const failed = messages.some((message) => JSON.stringify(message).includes('模拟失败调查'));
    const hasToolResult = messages.some((message) => message.role === 'tool'
      || (Array.isArray(message.blocks) && message.blocks.some((block) => block.type === 'tool_result')));
    if (!hasToolResult && failed) throw new Error('scripted failed investigation');
    if (!hasToolResult) {
      const call = { id: `memory-tool-${options.runId}`, name: 'fixture.metrics', input: {} };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    yield { type: 'text_delta', delta: '结算失败率升高，连接池等待增加。症状码：SETTLEMENT_FAILURE_HIGH' };
    return { text: '结算失败率升高，连接池等待增加。症状码：SETTLEMENT_FAILURE_HIGH', toolCalls: [] };
  }
}

const model = new MemoryFixtureModel(responses);
const profileScope = { profileId: 'simulation', profileRevision: 'sim-v1', serviceId: 'settlement',
  faultType: 'settlement_failure', targetFingerprint: 'a'.repeat(64), environment: 'simulation',
  dataClass: 'simulated', datasetId: 'memory-lab-v1' };
function diagnosticMemoryConfig(memoryEnabled) {
  if (!memoryEnabled) return { enabled: false };
  return { enabled: true, profiles: [{ scope: profileScope, profilePolicyRevision: 'policy-v1', captureDefault: 'manual',
    recallDefault: false, allowAutomaticCapture: true, allowRecall: true }], requiredSources: ['metric'],
    modelWindowTokens: 32_768, reservedOutputTokens: 4_096 };
}

function runtimeOptions(memoryEnabled) {
  return { dataDirectory, workspaceRoots: [dataDirectory], clock, model, tools: [fixtureTool],
    profiles: [{ id: 'simulation', name: 'simulation', description: 'Isolated memory web test.' }],
    diagnosticMemory: diagnosticMemoryConfig(memoryEnabled), host: '127.0.0.1', port: agentPort,
    allowedOrigins: [`http://127.0.0.1:${webPort}`] };
}

let memoryEnabled = process.env.AGENTOPS_MEMORY_E2E_DISABLED !== '1';
let runtime = await startAgentWebRuntime(runtimeOptions(memoryEnabled));
let restarting = false;
let closing = false;
async function restartRuntime(nextMemoryEnabled) {
  if (restarting || closing) throw new Error('MEMORY_E2E_RUNTIME_BUSY');
  restarting = true;
  try {
    await runtime.close();
    persistence.close();
    memoryEnabled = nextMemoryEnabled;
    persistence = createSqlitePersistence({ path: databasePath, clock });
    runtime = await startAgentWebRuntime(runtimeOptions(memoryEnabled));
  } finally {
    restarting = false;
  }
}

const controlServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/restart') {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      if (chunks.reduce((size, value) => size + value.length, 0) > 1_024) throw new Error('MEMORY_E2E_REQUEST_TOO_LARGE');
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof payload.memoryEnabled !== 'boolean') throw new Error('MEMORY_E2E_REQUEST_INVALID');
    await restartRuntime(payload.memoryEnabled);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready', memoryEnabled }));
  } catch {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'failed', code: 'MEMORY_E2E_RESTART_FAILED' }));
  }
});
await new Promise((resolve, reject) => {
  controlServer.once('error', reject);
  controlServer.listen(controlPort, '127.0.0.1', resolve);
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
async function close() {
  if (closing) return;
  closing = true;
  try { await new Promise((resolve) => controlServer.close(resolve)); await runtime.close(); }
  finally { persistence.close(); await rm(dataDirectory, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
