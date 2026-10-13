import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { TargetRunService } from '../src/application/target-run-service.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import type { ResolvedTargetSnapshotV2, TargetRecoveryGate, TargetRunBindingRecord, TargetRunRuntimeLease } from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';

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
    const model = new ScriptedModel([{ text: 'Completed', toolCalls: [] }]);
    const identityPorts = createTargetIdentityTestPorts();
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [], includeExternalBash: false, clock,
      inMemoryTargetIdentityRegistryVersion: identityPorts.identityRegistryVersion,
    });
    runtimes.push(runtime);
    if (runtime.durableState === undefined || runtime.queries === undefined) throw new Error('Durable runtime ports are missing.');
    const resolver = await createStaticTargetResolver({
      ...identityPorts,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: now,
    });
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      ...(runtime.durableState.targetStarts === undefined ? {} : { targetStarts: runtime.durableState.targetStarts }), clock,
    });
    let resumeAllowed = true;
    let resumeAuthorizations = 0;
    const makeLease = (binding: TargetRunBindingRecord, snapshot: ResolvedTargetSnapshotV2): TargetRunRuntimeLease => ({
      model,
      tools: [],
      operations: {
        authorize: async input => ({
          bindingId: binding.bindingId,
          runId: binding.runId,
          rootRunId: binding.rootRunId,
          snapshotDigest: snapshot.digest,
          operation: input.operation,
          capability: input.capability,
          policyEpoch: 1,
          signal: input.signal,
        }),
        validate: async permit => {
          if (!resumeAllowed || permit.bindingId !== binding.bindingId || permit.snapshotDigest !== snapshot.digest
            || permit.policyEpoch !== 1 || permit.signal.aborted) {
            throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
          }
        },
      },
      release: () => undefined,
    });
    const targetGate: TargetRecoveryGate = {
      acquireForStart: async input => makeLease(input.binding, input.snapshot),
      authorizeResume: async input => {
        resumeAuthorizations += 1;
        const binding = await runtime.durableState!.targetBindings.getBinding(input.runId);
        if (!resumeAllowed || binding?.bindingId !== input.targetBindingId) {
          throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        }
      },
      acquireForResume: async input => {
        const binding = await runtime.durableState!.targetBindings.getBinding(input.runId);
        const snapshot = binding === null ? null : await runtime.durableState!.targetBindings.getSnapshot(binding.bindingId);
        if (binding === null || binding.bindingId !== input.targetBindingId || snapshot?.schemaVersion !== 2) {
          throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        }
        return makeLease(binding, snapshot);
      },
    };
    runtime.configureTargetRecoveryGate(targetGate);
    const scheduledResumes: string[] = [];
    const cancelledRuns: string[] = [];
    const confirmationDecisions: Array<{ runId: string; confirmed: boolean }> = [];
    const targetRuns = new TargetRunService({
      resolver, bindings: runtime.durableState.targetBindings, queries: runtime.queries,
      clock, start: { startAccepted: options => execution.startAccepted(options) },
      targetRecoveryGate: targetGate,
      execution: {
        resume: runId => { scheduledResumes.push(runId); },
        cancel: async runId => { cancelledRuns.push(runId); },
      },
      confirmation: {
        decide: async (runId, input) => {
          confirmationDecisions.push({ runId, confirmed: input.confirmed });
          return { outcome: input.confirmed ? 'approved' : 'rejected', revision: input.expectedRevision + 1 };
        },
      },
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

    expect((await fetch(`${server.url}/runs/${encodeURIComponent(accepted.runId)}/resume`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${server.url}/runs/${encodeURIComponent(accepted.runId)}/cancel`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${server.url}/runs/${encodeURIComponent(accepted.runId)}/confirmation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1', confirmed: false, expectedRevision: 0 }),
    })).status).toBe(404);

    expect((await fetch(`${server.url}/targets/market-b-sim/runs/${encodeURIComponent(accepted.runId)}/resume`, { method: 'POST' })).status).toBe(404);
    expect(resumeAuthorizations).toBe(0);
    resumeAllowed = false;
    const deniedResume = await fetch(`${server.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/resume`, { method: 'POST' });
    expect(deniedResume.status).toBe(403);
    expect(await deniedResume.json()).toMatchObject({ error: 'TARGET_OPERATION_DENIED' });
    expect(scheduledResumes).toEqual([]);

    const deniedApproval = await fetch(`${server.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/confirmation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1', confirmed: true, expectedRevision: 0 }),
    });
    expect(deniedApproval.status).toBe(403);
    expect(confirmationDecisions).toEqual([]);

    const rejection = await fetch(`${server.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/confirmation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1', confirmed: false, expectedRevision: 0 }),
    });
    expect(rejection.status).toBe(200);
    expect(confirmationDecisions).toEqual([{ runId: accepted.runId, confirmed: false }]);
    const cancellation = await fetch(`${server.url}/targets/market-a-sim/runs/${encodeURIComponent(accepted.runId)}/cancel`, { method: 'POST' });
    expect(cancellation.status).toBe(202);
    expect(cancelledRuns).toEqual([accepted.runId]);

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
