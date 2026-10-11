import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { TargetRunService } from '../src/application/target-run-service.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';

const now = '2026-10-11T10:00:00.000Z';
const clock = { now: () => new Date(now) };
const runtimes: Array<Awaited<ReturnType<typeof createAgentRuntime>>> = [];
const servers: Array<Awaited<ReturnType<typeof startInspectionHttpServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
});

describe('Target-scoped HTTP routes', () => {
  it('starts only through a Target route and denies Target Runs through legacy or cross-Target reads', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'Completed', toolCalls: [] }]),
      workspaceRoots: [], includeExternalBash: false, clock,
    });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable runtime ports are missing.');
    const resolver = await createStaticTargetResolver({
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [{ id: 'window_failure_rate.v1', version: '1.0.0' }],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: now,
    });
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints);
    const targetRuns = new TargetRunService({
      resolver, bindings: runtime.durableState.targetBindings, queries: runtime.queries,
      clock, start: { startAccepted: options => execution.startAccepted(options) },
    });
    const server = await startInspectionHttpServer({
      agent: runtime.agent, events: runtime.eventStreamV2, queries: runtime.queries,
      targetRuns, targetBindings: runtime.durableState.targetBindings,
    });
    servers.push(server);

    const catalog = await fetch(`${server.url}/targets`);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 'market-a-sim', canStart: true, readOnly: true }),
    ]));

    const response = await fetch(`${server.url}/targets/market-a-sim/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'target-http-1' },
      body: JSON.stringify({ message: 'inspect simulated settlement' }),
    });
    expect(response.status).toBe(202);
    const accepted = await response.json() as { runId: string; eventsUrl: string };
    expect(accepted.eventsUrl).toBe(`/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/events`);

    expect((await fetch(`${server.url}/runs/${encodeURIComponent(accepted.runId)}`)).status).toBe(404);
    expect((await fetch(`${server.url}/targets/market-b-sim/runs/${encodeURIComponent(accepted.runId)}`)).status).toBe(404);
    const legacyPage = await fetch(`${server.url}/runs?limit=10`);
    const legacyPageBody = await legacyPage.json() as { items: unknown[] };
    expect(legacyPageBody.items).toEqual([]);

    const stream = await fetch(`${server.url}${accepted.eventsUrl}`);
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Target event stream has no reader.');
    let text = '';
    while (!text.includes('event: RUN_FINISHED')) {
      const item = await reader.read();
      if (item.done) break;
      text += new TextDecoder().decode(item.value);
    }
    await reader.cancel();
    expect(text).toContain('event: RUN_STARTED');
    expect(text).toContain('event: RUN_FINISHED');
    expect((await fetch(`${server.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}`)).status).toBe(200);
    expect((await fetch(`${server.url}/targets/market-a-sim/runs?limit=10`)).status).toBe(200);

    const forged = await fetch(`${server.url}/targets/market-a-sim/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'target-forgery' },
      body: JSON.stringify({ message: 'inspect', trustedTargetBinding: { targetId: 'market-b-sim' } }),
    });
    expect(forged.status).toBe(400);
    const legacyForged = await fetch(`${server.url}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'inspect', profileId: 'market-a.lab.settlement', targetId: 'market-a-sim' }),
    });
    expect(legacyForged.status).toBe(400);
    await execution.close();
  }, 15_000);
});
