import { createServer } from 'node:http';
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
const controlPort = Number(process.env.AGENTOPS_MULTI_TARGET_CONTROL_PORT ?? 45674);
const modelInputs = [];
const fixtureClock = { current: Date.parse('2026-10-21T00:00:00.000Z'), now() { return new Date(this.current); } };
let control;

class MultiTargetFixtureModel {
  constructor(snapshot) { this.snapshot = snapshot; }
  async *stream(messages, _tools, options) {
    const renderedInput = JSON.stringify(messages);
    modelInputs.push({ targetId: this.snapshot.targetId, runId: options.runId, text: renderedInput });
    if (this.snapshot.targetId === 'legacy') {
      const text = 'M5 模拟 Profile 兼容巡检完成。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }
    const isSlowTargetARequest = this.snapshot.targetId === 'market-a-sim'
      && JSON.stringify(messages).includes('slow-market-a');
    if (isSlowTargetARequest) await new Promise(resolve => setTimeout(resolve, 900));
    const hasEvidence = messages.some(message => Array.isArray(message.blocks)
      && message.blocks.some(block => block.type === 'tool_result' && block.result.toolName === 'target.simulated_metric'));
    if (!hasEvidence) {
      yield { type: 'text_delta', delta: '正在读取当前 Target 的本地模拟指标。' };
      return { text: '正在读取当前 Target 的本地模拟指标。', toolCalls: [{ id: `metric-${options.runId}`,
        name: 'target.simulated_metric', input: {} }] };
    }
    const memoryMarker = this.snapshot.targetId === 'market-a-sim' ? 'TARGET_A_MEMORY_CASE_MARKER' : 'TARGET_B_MEMORY_CASE_MARKER';
    const hasMemory = renderedInput.includes('历史案例，非本轮事实') && renderedInput.includes(memoryMarker);
    const failureRate = 0.04;
    const threshold = this.snapshot.scenario.threshold;
    const outcome = failureRate >= threshold ? `达到或超过 ${(threshold * 100).toFixed(0)}% 阈值`
      : `低于 ${(threshold * 100).toFixed(0)}% 阈值`;
    const marker = isSlowTargetARequest ? 'slow-market-a：' : '';
    const memory = hasMemory ? ` 已结合历史参考 ${memoryMarker}。` : '';
    const text = `${marker}${this.snapshot.projectId} · ${this.snapshot.deploymentId}#${this.snapshot.deploymentGeneration}：模拟样本失败率 4.00%，${outcome}。场景 ${this.snapshot.scenario.id}@${this.snapshot.scenario.version}。${memory}${memoryMarker}`;
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [], usage: { inputTokens: 12, outputTokens: 20 } };
  }
}

const runtime = await startAgentWebRuntime({
  dataDirectory,
  workspaceRoots: [dataDirectory],
  profiles: [
    { id: 'simulation', name: 'simulation', description: 'M5 local legacy simulation.', enabled: true, readOnly: true },
    ...multiProjectProfiles.map(profile => ({ id: profile.profileId, name: profile.profileId,
      description: 'Target-scoped deterministic memory E2E fixture.', enabled: true, readOnly: true })),
  ],
  model: new MultiTargetFixtureModel({ targetId: 'legacy' }),
  host: '127.0.0.1',
  port: agentPort,
  allowedOrigins: [`http://127.0.0.1:${webPort}`],
  clock: fixtureClock,
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
    createRuntimeProvider: ports => ({ acquire: async snapshot => ({
      model: new MultiTargetFixtureModel(snapshot),
      tools: [createSimulatedMetricTool(snapshot, ports.evidenceRecorder)],
      modelIdentity: { provider: 'm5-fixture', model: snapshot.targetId }, release() {},
    }) }),
    createStarter: ports => ({ startAccepted: options => ports.execution.startAccepted(ports.prepareStart(options)) }),
  },
  diagnosticMemory: {
    enabled: true,
    profiles: ['market-a-sim', 'market-b-sim'].map(targetId => {
      const definition = multiProjectTargetCatalog.targets.find(item => item.targetId === targetId);
      return { scope: {
        profileId: definition.profileId, profileRevision: definition.profileRevision,
        serviceId: definition.scenario.serviceId, faultType: definition.scenario.id,
        targetFingerprint: definition.targetFingerprint, environment: definition.environment,
        dataClass: definition.dataClass, datasetId: definition.datasetId,
      }, profilePolicyRevision: 'target-memory-fixture-v1', captureDefault: 'manual', recallDefault: false,
      allowAutomaticCapture: false, allowRecall: true };
    }),
    requiredSources: ['metric'], modelWindowTokens: 32_768, reservedOutputTokens: 4_096,
  },
});

control = createServer((request, response) => {
  if (request.method === 'POST' && request.url?.startsWith('/__clock?now=')) {
    const value = decodeURIComponent(request.url.slice('/__clock?now='.length));
    const time = Date.parse(value);
    if (!Number.isFinite(time)) {
      response.writeHead(400).end();
      return;
    }
    fixtureClock.current = time;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ now: fixtureClock.now().toISOString() }));
    return;
  }
  if (request.method !== 'GET' || request.url !== '/__state') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ modelInputs, now: fixtureClock.now().toISOString() }));
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(controlPort, '127.0.0.1', () => { control.removeListener('error', reject); resolve(); });
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    if (control?.listening) await new Promise(resolve => control.close(resolve));
    await runtime.close();
  }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

function createSimulatedMetricTool(snapshot, evidenceRecorder) {
  const sourceId = snapshot.sourceBindings[0]?.sourceId;
  return Object.freeze({
    name: 'target.simulated_metric', description: '读取本地 Target 专属模拟指标并保存可审计证据。', kind: 'evidence',
    source: 'builtin', targetSourceId: sourceId, implementationVersion: 'target-memory-fixture.v1',
    inputSchema: { jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
      validate: input => Object.keys(input).length === 0 ? { valid: true, value: {} }
        : { valid: false, error: { code: 'TOOL_ARGUMENTS_SCHEMA_INVALID', message: 'No arguments are accepted.' } } },
    isConcurrencySafe: () => true,
    call: async (_input, options) => {
      const evidenceId = `evidence-${snapshot.targetId}-${options.runId}`;
      const capturedAt = fixtureClock.now().toISOString();
      const raw = { targetId: snapshot.targetId, datasetId: snapshot.datasetId,
        failureRate: snapshot.targetId === 'market-a-sim' ? 0.04 : 0.08, sampleCount: 100 };
      await evidenceRecorder.capture({
        record: { evidenceId, runId: options.runId, source: 'metric', summary: {
          label: 'simulated settlement failure rate', start: new Date(Date.parse(capturedAt) - 300_000).toISOString(), end: capturedAt,
        }, raw, businessTraceIds: [], capturedAt, toolCallId: options.toolCallId },
        stepId: options.stepId, toolCallId: options.toolCallId, coverage: 1,
        publicSummary: `${snapshot.targetId} local simulated settlement metric evidence.`,
      });
      return { blocks: [{ type: 'json', value: { status: 'available', evidenceIds: [evidenceId],
        statement: '模拟结算失败率升高，当前 Run 已采集指标证据。' } }, { type: 'evidence_ref', evidenceId }], evidenceIds: [evidenceId] };
    },
  });
}
