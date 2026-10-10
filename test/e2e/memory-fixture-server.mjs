import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { createSqlitePersistence } from '../../dist/infrastructure/sqlite/persistence-bundle.js';
import { ScriptedModel } from '../../dist/model/scripted-model.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-memory-e2e-'));
const databasePath = join(dataDirectory, 'agent.sqlite');
const agentPort = Number(process.env.AGENTOPS_MEMORY_E2E_AGENT_PORT ?? 45400);
const webPort = Number(process.env.AGENTOPS_MEMORY_E2E_WEB_PORT ?? 45473);
const clock = { now: () => new Date() };
const persistence = createSqlitePersistence({ path: databasePath, clock });
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
const memoryConfig = process.env.AGENTOPS_MEMORY_E2E_DISABLED === '1' ? { enabled: false } : {
  enabled: true, profiles: [{ scope: profileScope, profilePolicyRevision: 'policy-v1', captureDefault: 'manual',
    recallDefault: false, allowAutomaticCapture: true, allowRecall: true }], requiredSources: ['metric'],
  modelWindowTokens: 32_768, reservedOutputTokens: 4_096,
};
const runtime = await startAgentWebRuntime({ dataDirectory, workspaceRoots: [dataDirectory], clock, model,
  tools: [fixtureTool], profiles: [{ id: 'simulation', name: 'simulation', description: 'Isolated memory web test.' }],
  diagnosticMemory: memoryConfig, host: '127.0.0.1', port: agentPort,
  allowedOrigins: [`http://127.0.0.1:${webPort}`] });

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await runtime.close(); }
  finally { persistence.close(); await rm(dataDirectory, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
