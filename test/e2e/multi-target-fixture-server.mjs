import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { createStaticTargetResolver } from '../../dist/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../../dist/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../../dist/profiles/scenarios/window-failure-rate-v1.js';
import { StaticProfileResolver } from '../../dist/profiles/profile-resolver.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-multi-target-e2e-'));
const agentPort = Number(process.env.AGENTOPS_MULTI_TARGET_AGENT_PORT ?? 45600);
const webPort = Number(process.env.AGENTOPS_MULTI_TARGET_WEB_PORT ?? 45673);

class MultiTargetFixtureModel {
  constructor(snapshot) { this.snapshot = snapshot; }
  async *stream(messages) {
    if (this.snapshot.targetId === 'legacy') {
      const text = 'M5 模拟 Profile 兼容巡检完成。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }
    const isSlowTargetARequest = this.snapshot.targetId === 'market-a-sim'
      && JSON.stringify(messages).includes('slow-market-a');
    if (isSlowTargetARequest) await new Promise(resolve => setTimeout(resolve, 900));
    const failureRate = 0.04;
    const threshold = this.snapshot.scenario.threshold;
    const outcome = failureRate >= threshold ? `达到或超过 ${(threshold * 100).toFixed(0)}% 阈值`
      : `低于 ${(threshold * 100).toFixed(0)}% 阈值`;
    const marker = isSlowTargetARequest ? 'slow-market-a：' : '';
    const text = `${marker}${this.snapshot.projectId} · ${this.snapshot.deploymentId}#${this.snapshot.deploymentGeneration}：模拟样本失败率 4.00%，${outcome}。场景 ${this.snapshot.scenario.id}@${this.snapshot.scenario.version}。`;
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [], usage: { inputTokens: 12, outputTokens: 20 } };
  }
}

const runtime = await startAgentWebRuntime({
  dataDirectory,
  workspaceRoots: [dataDirectory],
  profiles: [{ id: 'simulation', name: 'simulation', description: 'M5 local legacy simulation.', enabled: true, readOnly: true }],
  model: new MultiTargetFixtureModel({ targetId: 'legacy' }),
  host: '127.0.0.1',
  port: agentPort,
  allowedOrigins: [`http://127.0.0.1:${webPort}`],
  targetRuntime: {
    createResolver: ports => createStaticTargetResolver({
      ...ports,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: '2026-10-21T00:00:00.000Z',
    }),
    createOperationPolicy: () => ({
      authorize: async request => ({ bindingId: request.binding.bindingId, runId: request.runId,
        rootRunId: request.rootRunId, snapshotDigest: request.snapshot.digest,
        operation: request.operation, capability: request.capability, policyEpoch: 1, signal: request.signal }),
      validate: async permit => { if (permit.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'TARGET_OPERATION_DENIED' }); },
    }),
    createRuntimeProvider: () => ({ acquire: async snapshot => ({
      model: new MultiTargetFixtureModel(snapshot), tools: [], modelIdentity: { provider: 'm5-fixture', model: snapshot.targetId }, release() {},
    }) }),
    createStarter: ports => ({ startAccepted: options => ports.execution.startAccepted(ports.prepareStart(options)) }),
  },
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await runtime.close(); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
