import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import type { DiagnosticMemoryConfig } from '../src/contracts/diagnostic-memory.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { createLocalTargetRuntime, readLocalTargetHostConfig } from '../src/bootstrap/local-target-runtime.js';
import { startLocalTargetSimulator } from '../src/bootstrap/local-target-simulator.js';
import { parseDiagnosticMemoryConfig } from '../src/bootstrap/memory-policy.js';

const roots: string[] = [];
const examplePath = fileURLToPath(new URL('../examples/local-inspection-targets.json', import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ordinary host Local Target assembly', () => {
  it('loads AGENTOPS_TARGET_CONFIG through the ordinary agent-server process entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-local-target-entrypoint-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    await mkdir(join(root, 'workspace'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/agent-server/index.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        AGENTOPS_DATA_DIR: join(root, 'data'),
        AGENTOPS_WORKSPACE_ROOTS: join(root, 'workspace'),
        AGENTOPS_WEB_PROFILE: 'simulation',
        AGENTOPS_METRICS_MCP_URL: simulator.legacyMetricsMcpUrl,
        AGENTOPS_LOGS_MCP_URL: simulator.logsMcpUrl,
        AGENTOPS_EVIDENCE_CURSOR_SECRET: 'ordinary-entrypoint-local-cursor-secret-over-32-bytes',
        AGENTOPS_TARGET_CONFIG: examplePath,
        AGENTOPS_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
        AGENTOPS_MODEL_API_KEY: 'local-test-placeholder',
        AGENTOPS_MODEL: 'local-model-not-called',
        AGENTOPS_HOST: '127.0.0.1',
        AGENTOPS_PORT: '0',
      },
    });
    try {
      const ready = await waitForServerReady(child);
      const response = await fetch(`${ready.url}/targets`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: 'market-a-sim', sourceKinds: ['metrics', 'logs'], canStart: true }),
        expect.objectContaining({ targetId: 'market-b-sim', sourceKinds: ['metrics', 'logs'], canStart: true }),
      ]));
    } finally {
      await stopServer(child);
      await simulator.close();
    }
  }, 15_000);

  it('starts both Targets through the production bootstrap with Metrics and Logs source Tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-local-target-host-'));
    roots.push(root);
    const config = await readLocalTargetHostConfig(examplePath);
    const local = createLocalTargetRuntime(config, 'local-host-test-cursor-secret-32-bytes-minimum');
    const acquired: Array<{ targetId: string; threshold: number; toolNames: string[] }> = [];
    const inputScopes: string[] = [];
    const originalProviderFactory = local.targetRuntime!.createRuntimeProvider!;
    const targetRuntime = {
      ...local.targetRuntime!,
      createRuntimeProvider: (ports: Parameters<typeof originalProviderFactory>[0]) => {
        const provider = originalProviderFactory(ports);
        return {
          acquire: async (snapshot: Parameters<typeof provider.acquire>[0]) => {
            const lease = await provider.acquire(snapshot);
            acquired.push({ targetId: snapshot.targetId, threshold: snapshot.scenario.threshold,
              toolNames: lease.tools.map(tool => tool.name).sort() });
            return lease;
          },
        };
      },
    };
    const model: ChatModel = {
      stream: async function* (messages: AgentMessage[], tools: Tool[]):
        AsyncGenerator<ModelStreamEvent, ModelResponse> {
        const context = messages.flatMap(message => message.blocks.flatMap(block =>
          block.type === 'text' ? [block.text] : [])).join('\n');
        inputScopes.push(context);
        expect(tools.map(tool => tool.name).sort()).toEqual(['logs_subagent', 'metrics_subagent']);
        const text = '本地 Target 双来源宿主接线已就绪。';
        yield { type: 'text_delta', delta: text };
        return { text, toolCalls: [] };
      },
    };
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model,
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
      clock: { now: () => new Date('2026-10-22T12:00:00.000Z') },
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19110/mcp' },
      logs: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19211/mcp',
        cursorSecret: 'local-host-test-cursor-secret-32-bytes-minimum' },
      profiles: local.profiles!,
      targetRuntime,
    });

    try {
      const catalogResponse = await fetch(`${runtime.url}/targets`);
      expect(catalogResponse.status).toBe(200);
      const catalog = await catalogResponse.json() as Array<{ targetId: string; sourceKinds: string[]; canStart: boolean }>;
      expect(catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: 'market-a-sim', sourceKinds: ['metrics', 'logs'], canStart: true }),
        expect.objectContaining({ targetId: 'market-b-sim', sourceKinds: ['metrics', 'logs'], canStart: true }),
      ]));

      for (const [index, targetId] of ['market-a-sim', 'market-b-sim'].entries()) {
        const acceptedResponse = await fetch(`${runtime.url}/targets/${targetId}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `local-host-${index}` },
          body: JSON.stringify({ message: '检查本地模拟结算指标和日志' }),
        });
        expect(acceptedResponse.status).toBe(202);
        const accepted = await acceptedResponse.json() as { runId: string };
        let status = 'unknown';
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const response = await fetch(`${runtime.url}/targets/${targetId}/runs/${encodeURIComponent(accepted.runId)}`);
          status = (await response.json() as { status: string }).status;
          if (status === 'completed' || status === 'failed') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(status).toBe('completed');
      }

      expect(acquired).toEqual([
        { targetId: 'market-a-sim', threshold: 0.05, toolNames: ['logs_subagent', 'metrics_subagent'] },
        { targetId: 'market-b-sim', threshold: 0.02, toolNames: ['logs_subagent', 'metrics_subagent'] },
      ]);
      expect(inputScopes).toHaveLength(2);
      for (const scope of inputScopes) {
        expect(scope).toContain('start=2026-10-22T11:55:00.000Z');
        expect(scope).toContain('end=2026-10-22T12:00:00.000Z');
        expect(scope).toContain('Use the exact same host-provided start and end for every source.');
      }
      expect(JSON.stringify(catalog)).not.toContain('endpoint');
      expect(JSON.stringify(catalog)).not.toContain('permissionScopeDigest');
    } finally {
      await runtime.close();
    }
  });

  it('publishes Semantic and Procedural knowledge and proves Target-scoped prompt injection and disabled fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-target-memory-host-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    const original = await readLocalTargetHostConfig(examplePath);
    const config = { ...original, connections: { ...original.connections,
      connections: original.connections.connections.map(item => ({ ...item,
        endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl })) } };
    const local = createLocalTargetRuntime(config, 'local-memory-host-cursor-secret-over-32-bytes');
    const memoryPath = fileURLToPath(new URL('../examples/local-inspection-memory.json', import.meta.url));
    const memoryConfig = parseDiagnosticMemoryConfig(JSON.parse(await readFile(memoryPath, 'utf8')) as unknown);
    const prompts: string[] = [];
    const model: ChatModel = { stream: async function* (messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      prompts.push(messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'));
      const text = '本地受治理知识上下文已读取。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    } };
    const fixedNow = Date.parse('2026-10-22T12:00:00.000Z');
    let runtime: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
    runtime = await startHost(root, local, model, fixedNow, simulator, 'local-memory-host-cursor-secret-over-32-bytes', memoryConfig);
    const source = { sourceId: 'local-settlement-runbook', sourceVersion: 'v1',
      digest: 'c'.repeat(64) };
    const semantic = await createApprovedKnowledge(runtime.url, 'semantic', source, {
      type: 'metric_definition', metricName: 'settlement_window_requests', businessMeaning: 'SEMANTIC_CANARY: local synthetic settlement request count.',
      unit: 'requests per fixed window', labels: [], allowedAggregations: ['count'], windowSemantics: ['fixed_window'],
      sourceReferences: [source],
    });
    const procedural = await createApprovedKnowledge(runtime.url, 'procedural', source, {
      type: 'investigation_template', templateId: 'local-settlement-window-review',
      scenario: { id: 'window_failure_rate.v1', version: '1.1.0' },
      applicableTo: { serviceIds: ['checkout'], faultTypes: ['window_failure_rate.v1'], environments: ['simulation'] },
      preconditions: ['Use only the current Target snapshot.'], requiredEvidence: [{ category: 'metric', minimumCount: 1 }],
      steps: [{ step: 1, goal: 'PROCEDURAL_CANARY: compare the deterministic five-minute rate with the Profile threshold.',
        capabilityId: 'metrics.read', completionCriterion: 'Record the measured value and threshold.' }],
      stopConditions: ['Stop if the required metric is unavailable.'], expectedReportFields: ['threshold', 'missingEvidence'],
      limitations: ['Guidance only; this template grants no action authority.'], sourceReferences: [source],
    });
    const expiring = await createApprovedKnowledge(runtime.url, 'semantic', source, {
      type: 'metric_definition', metricName: 'settlement_expiry_canary',
      businessMeaning: 'EXPIRY_CANARY: only available before its validity deadline.',
      unit: 'events', labels: [], allowedAggregations: ['count'], windowSemantics: ['fixed_window'],
      sourceReferences: [source],
    }, { requestSuffix: 'expiry-host-test', validUntil: '2026-10-22T12:01:00.000Z' });
    const publish = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/publication`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'publish-local-memory-knowledge',
        expectedPublicationVersion: 0, references: [semantic, procedural].map(revision => ({ id: revision.id,
          version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' })) }) });
    expect(publish.status).toBe(200);
    const published = await publish.json() as { publicationVersion: number };
    expect(published.publicationVersion).toBe(1);
    const statusResponse = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/status`);
    expect(statusResponse.status).toBe(200);
    const targetKnowledgeStatus = await statusResponse.json() as { references: readonly unknown[] };
    expect(targetKnowledgeStatus.references).toHaveLength(2);

    const runA = await startTargetRun(runtime.url, 'market-a-sim', 'run-with-semantic-procedural-knowledge');
    await waitForTargetRun(runtime.url, 'market-a-sim', runA);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('SEMANTIC_CANARY');
    expect(prompts[0]).toContain('PROCEDURAL_CANARY');
    for (const revision of [semantic, procedural]) {
      expect(prompts[0]).toContain(`"id":"${revision.id}"`);
      expect(prompts[0]).toContain(`"version":"${revision.contentRevision}"`);
      expect(prompts[0]).toContain(`"digest":"${revision.contentDigest}"`);
    }
    expect(prompts[0]!.match(/SEMANTIC_CANARY/gu)).toHaveLength(1);
    expect(prompts[0]!.match(/PROCEDURAL_CANARY/gu)).toHaveLength(1);

    const runB = await startTargetRun(runtime.url, 'market-b-sim', 'run-without-market-a-knowledge');
    await waitForTargetRun(runtime.url, 'market-b-sim', runB);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('SEMANTIC_CANARY');
    expect(prompts[1]).not.toContain('PROCEDURAL_CANARY');

    await runtime.close();
    runtime = undefined;
    runtime = await startHost(root, local, model, fixedNow, simulator, 'local-memory-host-cursor-secret-over-32-bytes', memoryConfig);
    const restartedRun = await startTargetRun(runtime.url, 'market-a-sim', 'run-after-knowledge-host-restart');
    await waitForTargetRun(runtime.url, 'market-a-sim', restartedRun);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('SEMANTIC_CANARY');
    expect(prompts[2]).toContain('PROCEDURAL_CANARY');

    const publishExpiring = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/publication`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'publish-expiring-knowledge',
        expectedPublicationVersion: 1, references: [semantic, procedural, expiring].map(revision => ({ id: revision.id,
          version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' })) }) });
    expect(publishExpiring.status).toBe(200);
    expect((await publishExpiring.json() as { publicationVersion: number }).publicationVersion).toBe(2);
    const beforeExpiryRun = await startTargetRun(runtime.url, 'market-a-sim', 'run-before-knowledge-expiry');
    await waitForTargetRun(runtime.url, 'market-a-sim', beforeExpiryRun);
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toContain('EXPIRY_CANARY');

    const revoke = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/procedural/${encodeURIComponent(procedural.id)}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        requestId: 'revoke-procedural-host-test', contentRevision: procedural.contentRevision,
        expectedGovernanceVersion: procedural.governanceVersion,
      }),
    });
    expect(revoke.status).toBe(200);
    const revoked = await revoke.json() as { status: string };
    expect(revoked.status).toBe('revoked');
    const afterRevokeRun = await startTargetRun(runtime.url, 'market-a-sim', 'run-after-knowledge-revoke');
    await waitForTargetRun(runtime.url, 'market-a-sim', afterRevokeRun);
    expect(prompts).toHaveLength(5);
    expect(prompts[4]).toContain('SEMANTIC_CANARY');
    expect(prompts[4]).toContain('EXPIRY_CANARY');
    expect(prompts[4]).not.toContain('PROCEDURAL_CANARY');

    await runtime.close();
    runtime = undefined;
    runtime = await startHost(root, local, model, fixedNow + 120_000, simulator,
      'local-memory-host-cursor-secret-over-32-bytes', memoryConfig);
    const afterExpiryRun = await startTargetRun(runtime.url, 'market-a-sim', 'run-after-knowledge-expiry');
    await waitForTargetRun(runtime.url, 'market-a-sim', afterExpiryRun);
    expect(prompts).toHaveLength(6);
    expect(prompts[5]).toContain('SEMANTIC_CANARY');
    expect(prompts[5]).not.toContain('PROCEDURAL_CANARY');
    expect(prompts[5]).not.toContain('EXPIRY_CANARY');

    await runtime.close();
    runtime = undefined;
    runtime = await startHost(root, local, model, fixedNow + 120_000, simulator,
      'local-memory-host-cursor-secret-over-32-bytes', { enabled: false });
    const disabledRun = await startTargetRun(runtime.url, 'market-a-sim', 'run-with-memory-disabled');
    await waitForTargetRun(runtime.url, 'market-a-sim', disabledRun);
    expect(prompts).toHaveLength(7);
    expect(prompts[6]).not.toContain('SEMANTIC_CANARY');
    expect(prompts[6]).not.toContain('PROCEDURAL_CANARY');
    expect(prompts[6]).not.toContain('EXPIRY_CANARY');
    } finally {
      await runtime?.close();
      await simulator.close();
    }
  }, 20_000);

  it('cancels an active Target Run through the ordinary host and aborts its model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-local-target-cancel-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    const original = await readLocalTargetHostConfig(examplePath);
    const config = {
      ...original,
      connections: {
        ...original.connections,
        connections: original.connections.connections.map(item => ({ ...item,
          endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl })),
      },
    };
    const cursorSecret = 'local-target-cancel-cursor-secret-with-more-than-32-bytes';
    const local = createLocalTargetRuntime(config, cursorSecret);
    let signalAborted: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const abortObserved = new Promise<void>(resolve => { signalAborted = resolve; });
    const modelStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const model: ChatModel = {
      async *stream(_messages, _tools, options) {
        markStarted?.();
        await new Promise<void>(resolve => {
          const onAbort = (): void => { signalAborted?.(); resolve(); };
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        });
        options.signal.throwIfAborted();
        return { text: 'unreachable', toolCalls: [] };
      },
    };
    const now = Date.now();
    const runtime = await startHost(root, local, model, now, simulator, cursorSecret);

    try {
      const acceptedResponse = await fetch(`${runtime.url}/targets/market-a-sim/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'local-target-cancel-active-run' },
        body: JSON.stringify({ message: '取消这个仍在等待推理的模拟巡检' }),
      });
      expect(acceptedResponse.status).toBe(202);
      const accepted = await acceptedResponse.json() as { runId: string };
      await modelStarted;

      const cancelResponse = await fetch(`${runtime.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/cancel`, {
        method: 'POST',
      });
      expect(cancelResponse.status).toBe(202);
      await abortObserved;
      await waitForTargetStatus(runtime.url, 'market-a-sim', accepted.runId, 'cancelled');
    } finally {
      await runtime.close();
      await simulator.close();
    }
  }, 15_000);

  it('runs Metrics and Logs through local sources and exposes both evidence types on the Target API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-local-target-sources-'));
    roots.push(root);
    let now = Date.parse('2026-10-22T12:00:00.000Z');
    const end = new Date(now).toISOString();
    const start = new Date(now - 300_000).toISOString();
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0,
      now: () => now, successCount: 96, failureCount: 4 });

    const original = await readLocalTargetHostConfig(examplePath);
    const localConfig = {
      ...original,
      connections: {
        ...original.connections,
        connections: original.connections.connections.map(item => ({
          ...item,
          endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl,
        })),
      },
    };
    const cursorSecret = 'local-target-source-test-cursor-secret-32-bytes';
    const local = createLocalTargetRuntime(localConfig, cursorSecret);
    const model = new LocalDualSourceModel(start, end);
    let runtime = await startHost(root, local, model, now, simulator, cursorSecret);

    try {
      const runs: Array<{ targetId: string; runId: string; childRunIds: readonly string[] }> = [];
      for (const [index, targetId] of ['market-a-sim', 'market-b-sim'].entries()) {
        const acceptedResponse = await fetch(`${runtime.url}/targets/${targetId}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `local-source-e2e-${index}` },
          body: JSON.stringify({ message: '检查模拟结算失败率并核对对应日志' }),
        });
        expect(acceptedResponse.status).toBe(202);
        const accepted = await acceptedResponse.json() as { runId: string };
        let detail: { status: string; childRunIds: readonly string[]; failure?: unknown } | undefined;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const response = await fetch(`${runtime.url}/targets/${targetId}/runs/${encodeURIComponent(accepted.runId)}`);
          detail = await response.json() as typeof detail;
          if (detail?.status === 'completed' || detail?.status === 'failed') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(detail?.status, `${targetId} detail=${JSON.stringify(detail)}`).toBe('completed');
        expect(detail?.childRunIds, `${targetId} detail=${JSON.stringify(detail)}`).toHaveLength(2);
        runs.push({ targetId, runId: accepted.runId, childRunIds: detail!.childRunIds });
      }
      for (const run of runs) {
        const evidencePages = await Promise.all(run.childRunIds.map(async childRunId => {
          const response = await fetch(`${runtime.url}/targets/${run.targetId}/runs/${encodeURIComponent(childRunId)}/evidence`);
          expect(response.status).toBe(200);
          return await response.json() as { items: Array<{ source: string; summary: Record<string, unknown> }> };
        }));
        const evidence = evidencePages.flatMap(page => page.items);
        expect(evidence.map(item => item.source).sort()).toEqual(['log', 'metric']);
        expect(evidence.find(item => item.source === 'metric')?.summary).toMatchObject({
          assessment: { status: 'complete', threshold: run.targetId === 'market-a-sim' ? 0.05 : 0.02,
            thresholdReached: run.targetId === 'market-b-sim' },
        });
        expect(evidence.find(item => item.source === 'log')?.summary).toMatchObject({ recordCount: 1 });
      }
      expect(model.sourceWindows).toEqual([
        `market-a-sim/${start}/${end}`, `market-a-sim/${start}/${end}`,
        `market-b-sim/${start}/${end}`, `market-b-sim/${start}/${end}`,
      ]);
      const crossTargetRead = await fetch(`${runtime.url}/targets/market-b-sim/runs/${encodeURIComponent(runs[0]!.runId)}`);
      expect(crossTargetRead.status).toBe(404);
      const crossTargetEvidence = await fetch(`${runtime.url}/targets/market-b-sim/runs/${encodeURIComponent(runs[0]!.childRunIds[0]!)}/evidence`);
      expect(crossTargetEvidence.status).toBe(404);

      await runtime.close();
      now += 60_000;
      const updatedConfig = {
        ...localConfig,
        catalog: {
          ...localConfig.catalog,
          targets: localConfig.catalog.targets.map(target => target.targetId === 'market-a-sim'
            ? { ...target, scenario: { ...target.scenario, threshold: 0.03 } } : target),
        },
      };
      const updatedLocal = createLocalTargetRuntime(updatedConfig, cursorSecret);
      const nextEnd = new Date(now).toISOString();
      const nextStart = new Date(now - 300_000).toISOString();
      const updatedModel = new LocalDualSourceModel(nextStart, nextEnd);
      runtime = await startHost(root, updatedLocal, updatedModel, now, simulator, cursorSecret);

      const historical = await fetch(`${runtime.url}/targets/market-a-sim/runs/${encodeURIComponent(runs[0]!.runId)}`);
      expect(historical.status).toBe(200);
      expect((await historical.json() as { status: string }).status).toBe('completed');
      const historicalMetric = await evidenceForSource(runtime.url, 'market-a-sim', runs[0]!, 'metric');
      expect(historicalMetric.summary).toMatchObject({ assessment: { threshold: 0.05, thresholdReached: false } });

      const accepted = await fetch(`${runtime.url}/targets/market-a-sim/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'local-source-after-restart' },
        body: JSON.stringify({ message: '按新配置检查模拟结算失败率和日志' }),
      });
      expect(accepted.status).toBe(202);
      const restartedRun = await accepted.json() as { runId: string };
      const restartedDetail = await waitForTargetRun(runtime.url, 'market-a-sim', restartedRun.runId);
      expect(restartedDetail.childRunIds).toHaveLength(2);
      const currentMetric = await evidenceForSource(runtime.url, 'market-a-sim', restartedDetail, 'metric');
      expect(currentMetric.summary).toMatchObject({ assessment: { threshold: 0.03, thresholdReached: true } });
    } finally {
      await runtime.close();
      await simulator.close();
    }
  }, 30_000);

  it('rejects knowledge at review so it can never be published or injected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-target-reject-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    const original = await readLocalTargetHostConfig(examplePath);
    const config = { ...original, connections: { ...original.connections,
      connections: original.connections.connections.map(item => ({ ...item,
        endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl })) } };
    const local = createLocalTargetRuntime(config, 'local-reject-cursor-secret-over-32-bytes');
    const memoryPath = fileURLToPath(new URL('../examples/local-inspection-memory.json', import.meta.url));
    const memoryConfig = parseDiagnosticMemoryConfig(JSON.parse(await readFile(memoryPath, 'utf8')) as unknown);
    const prompts: string[] = [];
    const model: ChatModel = { stream: async function* (messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      prompts.push(messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'));
      const text = '受治理知识拒绝语义已读取。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    } };
    const fixedNow = Date.parse('2026-10-22T12:00:00.000Z');
    const runtime = await startHost(root, local, model, fixedNow, simulator,
      'local-reject-cursor-secret-over-32-bytes', memoryConfig);
    try {
      const source = { sourceId: 'local-settlement-runbook', sourceVersion: 'v1', digest: 'c'.repeat(64) };
      const rejected = await createRejectedKnowledge(runtime.url, 'semantic', source, {
        type: 'metric_definition', metricName: 'rejected_canary_metric',
        businessMeaning: 'REJECT_CANARY: this knowledge must never enter a Target model input.',
        unit: 'events', labels: [], allowedAggregations: ['count'], windowSemantics: ['fixed_window'],
        sourceReferences: [source],
      });
      expect(rejected.status).toBe('rejected');
      const listed = await fetch(`${runtime.url}/targets/market-a-sim/knowledge?kind=semantic&status=rejected`);
      expect(listed.status).toBe(200);
      expect((await listed.json() as { items: Array<{ id: string; status: string }> }).items)
        .toContainEqual(expect.objectContaining({ id: rejected.id, status: 'rejected' }));

      const publish = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/publication`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'publish-rejected-knowledge',
          expectedPublicationVersion: 0, references: [{ id: rejected.id, version: String(rejected.contentRevision),
            digest: rejected.contentDigest, approval: 'approved' }] }) });
      expect(publish.status).toBe(422);

      const runA = await startTargetRun(runtime.url, 'market-a-sim', 'run-with-rejected-knowledge');
      await waitForTargetRun(runtime.url, 'market-a-sim', runA);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain('REJECT_CANARY');
    } finally {
      await runtime.close();
      await simulator.close();
    }
  }, 20_000);

  it('revokes a knowledge source through the ordinary host and excludes its knowledge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-target-source-revoke-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    const original = await readLocalTargetHostConfig(examplePath);
    const config = { ...original, connections: { ...original.connections,
      connections: original.connections.connections.map(item => ({ ...item,
        endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl })) } };
    const local = createLocalTargetRuntime(config, 'local-source-revoke-cursor-secret-over-32-bytes');
    const memoryPath = fileURLToPath(new URL('../examples/local-inspection-memory.json', import.meta.url));
    const memoryConfig = parseDiagnosticMemoryConfig(JSON.parse(await readFile(memoryPath, 'utf8')) as unknown);
    const prompts: string[] = [];
    const model: ChatModel = { stream: async function* (messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      prompts.push(messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'));
      const text = '受治理来源状态已读取。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    } };
    const fixedNow = Date.parse('2026-10-22T12:00:00.000Z');
    const runtime = await startHost(root, local, model, fixedNow, simulator,
      'local-source-revoke-cursor-secret-over-32-bytes', memoryConfig);
    try {
      const source = { sourceId: 'local-settlement-runbook', sourceVersion: 'v1', digest: 'c'.repeat(64) };
      const semantic = await createApprovedKnowledge(runtime.url, 'semantic', source, {
        type: 'metric_definition', metricName: 'source_revoke_canary_metric',
        businessMeaning: 'SOURCE_CANARY: this knowledge is bound to a revocable source.',
        unit: 'events', labels: [], allowedAggregations: ['count'], windowSemantics: ['fixed_window'],
        sourceReferences: [source],
      });
      const publish = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/publication`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'publish-source-revoke-knowledge',
          expectedPublicationVersion: 0, references: [{ id: semantic.id, version: String(semantic.contentRevision),
            digest: semantic.contentDigest, approval: 'approved' }] }) });
      expect(publish.status).toBe(200);

      const runA = await startTargetRun(runtime.url, 'market-a-sim', 'run-before-source-revoke');
      const detailA = await waitForTargetRunDetail(runtime.url, 'market-a-sim', runA);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('SOURCE_CANARY');
      expect(detailA.knowledgeQualification?.diagnosisReady).toBe(true);

      const revoked = await revokeKnowledgeSource(runtime.url, 'local-settlement-runbook', 'v1', 0,
        'revoke-settlement-source');
      expect(revoked.validity).toBe('revoked');

      const runB = await startTargetRun(runtime.url, 'market-a-sim', 'run-after-source-revoke');
      const detailB = await waitForTargetRunDetail(runtime.url, 'market-a-sim', runB);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain('SOURCE_CANARY');
      expect(detailB.knowledgeQualification?.missingKnowledge
        .some(item => item.reasonCode === 'KNOWLEDGE_SOURCE_REVOKED')).toBe(true);
      expect(detailB.knowledgeQualification?.diagnosisReady).toBe(true);
    } finally {
      await runtime.close();
      await simulator.close();
    }
  }, 20_000);

  it('gates the diagnosis when required knowledge becomes unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsagent-target-required-gate-'));
    roots.push(root);
    const simulator = await startLocalTargetSimulator({ metricsPort: 0, logsPort: 0, legacyMetricsPort: 0 });
    const original = await readLocalTargetHostConfig(examplePath);
    const config = { ...original, connections: { ...original.connections,
      connections: original.connections.connections.map(item => ({ ...item,
        endpoint: item.kind === 'metrics' ? simulator.metricsUrl : simulator.logsMcpUrl })) } };
    const local = createLocalTargetRuntime(config, 'local-required-gate-cursor-secret-over-32-bytes');
    const memoryPath = fileURLToPath(new URL('../examples/local-inspection-memory.json', import.meta.url));
    const memoryConfig = parseDiagnosticMemoryConfig(JSON.parse(await readFile(memoryPath, 'utf8')) as unknown);
    const prompts: string[] = [];
    const model: ChatModel = { stream: async function* (messages: AgentMessage[]): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      prompts.push(messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'));
      const text = '受治理必需知识门禁已读取。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    } };
    const fixedNow = Date.parse('2026-10-22T12:00:00.000Z');
    const runtime = await startHost(root, local, model, fixedNow, simulator,
      'local-required-gate-cursor-secret-over-32-bytes', memoryConfig);
    try {
      const source = { sourceId: 'local-settlement-runbook', sourceVersion: 'v1', digest: 'c'.repeat(64) };
      const semantic = await createApprovedKnowledge(runtime.url, 'semantic', source, {
        type: 'metric_definition', metricName: 'required_canary_metric',
        businessMeaning: 'REQUIRED_CANARY: this knowledge is required for a ready diagnosis.',
        unit: 'events', labels: [], allowedAggregations: ['count'], windowSemantics: ['fixed_window'],
        sourceReferences: [source],
      });
      const publish = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/publication`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'publish-required-knowledge',
          expectedPublicationVersion: 0, references: [{ id: semantic.id, version: String(semantic.contentRevision),
            digest: semantic.contentDigest, approval: 'approved' }] }) });
      expect(publish.status).toBe(200);

      const policy = await setKnowledgePolicy(runtime.url, 'market-a-sim', {
        requestId: 'require-required-canary',
        policyVersion: 'required/v1',
        expectedPolicyEpoch: null,
        requirements: [{ id: semantic.id, version: String(semantic.contentRevision), digest: semantic.contentDigest,
          requiredness: 'required', knowledgeClass: 'semantic' }],
      });
      expect(policy.policyEpoch).toBe(1);
      expect(policy.requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: semantic.id, requiredness: 'required' }),
      ]));

      const runA = await startTargetRun(runtime.url, 'market-a-sim', 'run-with-required-knowledge');
      const detailA = await waitForTargetRunDetail(runtime.url, 'market-a-sim', runA);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('REQUIRED_CANARY');
      expect(detailA.knowledgeQualification?.diagnosisReady).toBe(true);

      const revoke = await fetch(`${runtime.url}/targets/market-a-sim/knowledge/semantic/${encodeURIComponent(semantic.id)}/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'revoke-required-canary', contentRevision: semantic.contentRevision,
          expectedGovernanceVersion: semantic.governanceVersion }),
      });
      expect(revoke.status).toBe(200);

      const runB = await startTargetRun(runtime.url, 'market-a-sim', 'run-with-missing-required-knowledge');
      const detailB = await waitForTargetRunDetail(runtime.url, 'market-a-sim', runB);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain('REQUIRED_CANARY');
      expect(detailB.knowledgeQualification?.diagnosisReady).toBe(false);
      expect(detailB.knowledgeQualification?.missingKnowledge
        .some(item => item.reasonCode === 'KNOWLEDGE_REVOKED' && item.requiredness === 'required')).toBe(true);
    } finally {
      await runtime.close();
      await simulator.close();
    }
  }, 20_000);
});

function waitForServerReady(child: ReturnType<typeof spawn>): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    if (child.stdout === null || child.stderr === null) { reject(new Error('Agent server output is unavailable.')); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Agent server did not become ready.')), 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (error?: Error, value?: { url: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new Error('Agent server readiness response is invalid.'));
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n')) {
        try {
          const value = JSON.parse(line) as { status?: unknown; url?: unknown };
          if (value.status === 'ready' && typeof value.url === 'string') { finish(undefined, { url: value.url }); return; }
        } catch { /* Wait until the process writes a complete JSON line. */ }
      }
    };
    const onStderr = (chunk: Buffer): void => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000); };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void => finish(new Error(`Agent server exited before ready (${code}): ${stderr}`));
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

class LocalDualSourceModel implements ChatModel {
  public readonly sourceWindows: string[] = [];

  public constructor(private readonly start: string, private readonly end: string) {}

  public async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    const toolNames = new Set(tools.map(tool => tool.name));
    if (toolNames.has('metrics_subagent') && toolNames.has('logs_subagent')) {
      const context = messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join('\n');
      const profileId = /(?:^|\n)profile=([^\n]+)/u.exec(context)?.[1];
      const targetId = /(?:^|\n)targetId=([^\n]+)/u.exec(context)?.[1];
      const start = /(?:^|\n)start=([^\n]+)/u.exec(context)?.[1];
      const end = /(?:^|\n)end=([^\n]+)/u.exec(context)?.[1];
      if (targetId === undefined || profileId === undefined || start === undefined || end === undefined) {
        throw new Error('Trusted Target scope was not rendered into model context.');
      }
      if (!hasToolResult(messages, 'metrics_subagent')) {
        this.sourceWindows.push(`${targetId}/${start}/${end}`);
        return { toolCalls: [{ id: `local-parent-metrics-${options.runId}`, name: 'metrics_subagent', input: {
          profileId, service: 'checkout', start, end, question: '检查失败率窗口',
        } }] };
      }
      if (!hasToolResult(messages, 'logs_subagent')) {
        this.sourceWindows.push(`${targetId}/${start}/${end}`);
        return { toolCalls: [{ id: `local-parent-logs-${options.runId}`, name: 'logs_subagent', input: {
          profileId, service: 'checkout', start, end, question: '核对同窗口日志',
        } }] };
      }
      const text = '指标与日志均已从当前 Target 的只读来源取证。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }

    const resultName = toolNames.has('metrics.window_snapshot') ? 'metrics.window_snapshot'
      : toolNames.has('logs.capture') ? 'logs.capture' : undefined;
    if (resultName === undefined) throw new Error(`Unexpected local Target child tools: ${[...toolNames].join(',')}`);
    const report = tools.find(tool => tool.name === 'source_report');
    if (report === undefined) throw new Error('Target source report Tool is missing.');
    if (!hasToolResult(messages, resultName)) {
      return { toolCalls: [{ id: `local-${options.runId}-${resultName}`, name: resultName,
        input: resultName === 'logs.capture' ? { service: 'checkout', start: this.start, end: this.end } : {} }] };
    }
    const evidenceId = findToolEvidenceId(messages, resultName);
    if (evidenceId === undefined) throw new Error(`${resultName} did not return evidence.`);
    if (!hasToolResult(messages, 'source_report')) {
      return { toolCalls: [{ id: `local-${options.runId}-${resultName}-report`, name: 'source_report', input: {
        summary: '本地模拟来源已采集证据。',
        findings: [{ kind: 'observation', statement: '来源证据已采集，可回查原始记录。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } }] };
    }
    const text = `${resultName} 取证完成。`;
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}

async function startHost(root: string, local: ReturnType<typeof createLocalTargetRuntime>, model: ChatModel, now: number,
  simulator: Awaited<ReturnType<typeof startLocalTargetSimulator>>, cursorSecret: string,
  diagnosticMemory?: DiagnosticMemoryConfig) {
  return startAgentWebRuntime({
    dataDirectory: root,
    workspaceRoots: [root],
    model,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [],
    clock: { now: () => new Date(now) },
    metrics: { profileId: 'simulation', mcpUrl: simulator.legacyMetricsMcpUrl },
    logs: { profileId: 'simulation', mcpUrl: simulator.logsMcpUrl, cursorSecret },
    profiles: local.profiles!,
    targetRuntime: local.targetRuntime!,
    ...(diagnosticMemory === undefined ? {} : { diagnosticMemory }),
  });
}

async function createApprovedKnowledge(url: string, kind: 'semantic' | 'procedural',
  source: { sourceId: string; sourceVersion: string; digest: string }, content: unknown,
  options: { requestSuffix?: string; validUntil?: string } = {}) {
  const path = `${url}/targets/market-a-sim/knowledge/${kind}`;
  const requestSuffix = options.requestSuffix ?? 'host-test';
  const request = async (route: string, requestId: string, body: Record<string, unknown>) => {
    const response = await fetch(`${path}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, ...body }) });
    if (!response.ok) throw new Error(`Knowledge ${route} returned ${response.status}: ${await response.text()}`);
    return await response.json() as { id: string; contentRevision: number; governanceVersion: number; contentDigest: string };
  };
  const draft = await request('drafts', `draft-${kind}-${requestSuffix}`, { source, content,
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }) });
  const submitted = await request(`${encodeURIComponent(draft.id)}/submit`, `submit-${kind}-${requestSuffix}`, {
    contentRevision: draft.contentRevision, governanceVersion: draft.governanceVersion,
  });
  return await request(`${encodeURIComponent(draft.id)}/review`, `review-${kind}-${requestSuffix}`, {
    contentRevision: submitted.contentRevision, governanceVersion: submitted.governanceVersion, decision: 'approve',
  });
}

async function createRejectedKnowledge(url: string, kind: 'semantic' | 'procedural',
  source: { sourceId: string; sourceVersion: string; digest: string }, content: unknown,
  options: { requestSuffix?: string } = {}) {
  const path = `${url}/targets/market-a-sim/knowledge/${kind}`;
  const requestSuffix = options.requestSuffix ?? 'host-reject';
  const request = async (route: string, requestId: string, body: Record<string, unknown>) => {
    const response = await fetch(`${path}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, ...body }) });
    if (!response.ok) throw new Error(`Knowledge ${route} returned ${response.status}: ${await response.text()}`);
    return await response.json() as { id: string; contentRevision: number; governanceVersion: number;
      contentDigest: string; status: string };
  };
  const draft = await request('drafts', `draft-${kind}-${requestSuffix}`, { source, content });
  const submitted = await request(`${encodeURIComponent(draft.id)}/submit`, `submit-${kind}-${requestSuffix}`, {
    contentRevision: draft.contentRevision, governanceVersion: draft.governanceVersion,
  });
  return request(`${encodeURIComponent(draft.id)}/review`, `review-${kind}-${requestSuffix}`, {
    contentRevision: submitted.contentRevision, governanceVersion: submitted.governanceVersion, decision: 'reject',
  });
}

async function revokeKnowledgeSource(url: string, sourceId: string, sourceVersion: string, expectedSourceEpoch: number,
  requestId: string) {
  const response = await fetch(`${url}/targets/market-a-sim/knowledge/sources/${encodeURIComponent(sourceId)}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, sourceVersion, expectedSourceEpoch }),
  });
  if (!response.ok) throw new Error(`Source revoke returned ${response.status}: ${await response.text()}`);
  return await response.json() as { sourceId: string; dataDomainId: string; sourceEpoch: number;
    sourceDigest: string; validity: string };
}

async function setKnowledgePolicy(url: string, targetId: string, input: { requestId: string; policyVersion: string;
  expectedPolicyEpoch: number | null; requirements: readonly { id: string; version: string; digest: string;
  requiredness: 'optional' | 'required'; knowledgeClass?: 'semantic' | 'procedural' }[] }) {
  const response = await fetch(`${url}/targets/${targetId}/knowledge/policy`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Policy update returned ${response.status}: ${await response.text()}`);
  return await response.json() as { targetId: string; policyVersion: string; policyEpoch: number;
    requirements: readonly { id: string; requiredness: string }[] };
}

async function waitForTargetRunDetail(url: string, targetId: string, runId: string) {
  let detail: { status: string; childRunIds: readonly string[]; knowledgeQualification?: {
    diagnosisReady: boolean; missingKnowledge: readonly { reasonCode: string; requiredness: string }[] } } | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/targets/${targetId}/runs/${encodeURIComponent(runId)}`);
    detail = await response.json() as typeof detail;
    if (detail?.status === 'completed' || detail?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(detail?.status, JSON.stringify(detail)).toBe('completed');
  return detail!;
}

async function startTargetRun(url: string, targetId: string, requestId: string): Promise<string> {
  const response = await fetch(`${url}/targets/${targetId}/runs`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
    body: JSON.stringify({ message: 'Inspect settlement window failure rate and settlement metric definition.' }) });
  if (response.status !== 202) throw new Error(`Target Run start returned ${response.status}: ${await response.text()}`);
  return (await response.json() as { runId: string }).runId;
}

async function waitForTargetRun(url: string, targetId: string, runId: string): Promise<{ status: string; childRunIds: readonly string[] }> {
  let detail: { status: string; childRunIds: readonly string[] } | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/targets/${targetId}/runs/${encodeURIComponent(runId)}`);
    detail = await response.json() as typeof detail;
    if (detail?.status === 'completed' || detail?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(detail?.status, JSON.stringify(detail)).toBe('completed');
  return detail!;
}

async function waitForTargetStatus(url: string, targetId: string, runId: string, expectedStatus: string): Promise<void> {
  let status = 'unknown';
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/targets/${targetId}/runs/${encodeURIComponent(runId)}`);
    status = (await response.json() as { status: string }).status;
    if (status === expectedStatus || status === 'failed' || status === 'completed' || status === 'cancelled') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(status).toBe(expectedStatus);
}

async function evidenceForSource(url: string, targetId: string, run: { childRunIds: readonly string[] }, source: string) {
  const pages = await Promise.all(run.childRunIds.map(async childRunId => {
    const response = await fetch(`${url}/targets/${targetId}/runs/${encodeURIComponent(childRunId)}/evidence`);
    expect(response.status).toBe(200);
    return await response.json() as { items: Array<{ source: string; summary: Record<string, unknown> }> };
  }));
  const item = pages.flatMap(page => page.items).find(candidate => candidate.source === source);
  if (item === undefined) throw new Error(`Missing ${source} evidence for ${targetId}.`);
  return item;
}

function hasToolResult(messages: readonly AgentMessage[], toolName: string): boolean {
  return messages.some(message => message.blocks.some(block => block.type === 'tool_result' && block.result.toolName === toolName));
}

function findToolEvidenceId(messages: readonly AgentMessage[], toolName: string): string | undefined {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.result.toolName === toolName) {
        return block.result.response?.evidenceIds?.[0]
          ?? block.result.response?.blocks.find(responseBlock => responseBlock.type === 'evidence_ref')?.evidenceId;
      }
    }
  }
  return undefined;
}
