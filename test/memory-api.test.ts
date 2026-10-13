import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnosticMemoryConfig, MemoryCaptureTicket, DiagnosticMemoryCase, MemoryPreferences } from '../src/contracts/diagnostic-memory.js';
import type { ReplyOptions } from '../src/agent/types.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { captureContext } from './fixtures/diagnostic-memory-capture.js';
import { memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const clock = { now: () => new Date(memoryNow) };
const config: DiagnosticMemoryConfig = { enabled: true, profiles: [{ scope: simulationMemoryScope(),
  profilePolicyRevision: 'policy-v1', captureDefault: 'manual', recallDefault: false,
  allowAutomaticCapture: false, allowRecall: true }], requiredSources: ['metric'],
modelWindowTokens: 32_768, reservedOutputTokens: 4_096 };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

interface LocalHttpResponse {
  status: number;
  json: () => Promise<unknown>;
}

interface LocalHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function requestLocalJson(url: string, options: LocalHttpOptions = {}): Promise<LocalHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(options.body));
    }
    const call = request(new URL(url), { method: options.method ?? 'GET', headers }, response => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { responseText += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        json: async () => JSON.parse(responseText) as unknown,
      }));
      response.on('error', reject);
    });
    call.on('error', reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'agentops-t7-api-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const bundle = createSqlitePersistence({ path: join(root, 'agent.sqlite'), clock });
  for (const status of ['completed', 'failed', 'cancelled', 'running'] as const) {
    await bundle.checkpoints.save(captureContext(status, `source-${status}`), null);
    await bundle.evidence.save({ evidenceId: status === 'completed' ? 'capture-evidence' : `evidence-${status}`,
      runId: `source-${status}`, source: 'metric', capturedAt: memoryNow, businessTraceIds: [],
      summary: { start: Date.parse(memoryNow) / 1_000 - 300, end: Date.parse(memoryNow) / 1_000 },
      raw: { marker: 'PRIVATE_RAW_MARKER' } });
  }
  const old = captureContext('completed', 'old-run');
  delete old.memoryControl;
  await bundle.checkpoints.save(old, null);
  const alien = captureContext('completed', 'alien-run');
  alien.memoryControl!.scope = { ...simulationMemoryScope(), datasetId: 'alien' };
  await bundle.checkpoints.save(alien, null);
  bundle.close();
  const allowedOrigin = 'http://127.0.0.1:5173';
  const host = await startAgentWebRuntime({ dataDirectory: root, workspaceRoots: [root], clock,
    model: new ScriptedModel([{ text: '完成', toolCalls: [] }]),
    profiles: [{ id: 'simulation', name: 'simulation', description: 'Local memory test' }],
    diagnosticMemory: enabled ? config : { enabled: false },
    allowedOrigins: [allowedOrigin], maxBodyBytes: 2_048 });
  disposals.push(() => host.close());
  const post = (path: string, body: unknown) => requestLocalJson(host.url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: allowedOrigin }, body: JSON.stringify(body) });
  return { ...host, root, post, allowedOrigin };
}

describe('local memory query/capture/review API', () => {
  it('exposes disabled capabilities and fixed 503 for commands while old Run APIs work', async () => {
    const f = await fixture(false);
    const caps = await requestLocalJson(`${f.url}/memory/capabilities?profileId=simulation`);
    expect(caps.status).toBe(200);
    expect(await caps.json()).toMatchObject({ enabled: false, manualCapture: false, automaticCapture: false, recall: false });
    const capture = await f.post('/runs/source-completed/memory/capture', { requestId: 'capture-1', expectedCheckpointRevision: 1 });
    expect(capture.status).toBe(503);
    expect(await capture.json()).toMatchObject({ error: 'MEMORY_DISABLED' });
    expect((await requestLocalJson(`${f.url}/runs/source-completed`)).status).toBe(200);
    expect((await f.post('/memory/cases/missing/review', { profileId: 'simulation', requestId: 'review-1',
      expectedRevision: 1, decision: 'approved', claimCheck: 'supported' })).status).toBe(503);
  });

  it('captures, lists, approves, replays and revokes with recall disabled and preserves the source checkpoint', async () => {
    const f = await fixture();
    const before: unknown = await (await requestLocalJson(`${f.url}/runs/source-completed`)).json();
    const ticket = await (await requestLocalJson(`${f.url}/runs/source-completed/memory/capture`)).json() as MemoryCaptureTicket;
    expect(ticket).toMatchObject({ state: 'not_saved', sourceCheckpointRevision: 1 });
    const command = { requestId: 'capture-1', expectedCheckpointRevision: 1 };
    expect((await f.post('/runs/source-completed/memory/capture', command)).status).toBe(202);
    const saved = await (await requestLocalJson(`${f.url}/runs/source-completed/memory/capture`)).json() as MemoryCaptureTicket;
    expect(saved).toMatchObject({ state: 'saved', sourceCheckpointRevision: 1 });
    expect((await f.post('/runs/source-completed/memory/capture', command)).status).toBe(200);
    expect((await f.post('/runs/source-completed/memory/capture', { ...command, expectedCheckpointRevision: 2 })).status).toBe(409);
    const list = await (await requestLocalJson(`${f.url}/memory/cases?profileId=simulation`)).json() as DiagnosticMemoryCase[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ quality: 'sufficient', status: 'observation', eligibleForPromotion: false });
    const review = { profileId: 'simulation', requestId: 'review-1', expectedRevision: 1,
      decision: 'approved', claimCheck: 'supported' };
    const reviewed = await f.post(`/memory/cases/${saved.memoryId}/review`, review);
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({ status: 'approved', revision: 2, eligibleForPromotion: false });
    expect((await f.post(`/memory/cases/${saved.memoryId}/review`, review)).status).toBe(200);
    expect((await f.post(`/memory/cases/${saved.memoryId}/review`, { ...review, requestId: 'stale', decision: 'rejected' })).status).toBe(409);
    expect((await f.post(`/memory/cases/${saved.memoryId}/review`, { ...review, requestId: 'revoke', expectedRevision: 2, decision: 'rejected' })).status).toBe(200);
    expect(await (await requestLocalJson(`${f.url}/runs/source-completed`)).json()).toEqual(before);
    const current = await requestLocalJson(`${f.url}/runs/source-completed/memory`);
    expect(current.status).toBe(200);
    const body = JSON.stringify(await current.json());
    for (const field of ['messages', 'budget', 'pendingToolCalls', 'PRIVATE_RAW_MARKER', 'storageKey']) expect(body).not.toContain(field);
    await f.close();
    const bundle = createSqlitePersistence({ path: join(f.root, 'agent.sqlite'), clock });
    try {
      const events = await bundle.eventMessages.readRun('source-completed', 0, 100);
      expect(events.filter(e => e.type === 'EXPERIENCE_REVIEWED').map(e => e.payload))
        .toEqual([{ candidateId: saved.memoryId, decision: 'approved', reviewer: 'local-operator' },
          { candidateId: saved.memoryId, decision: 'rejected', reviewer: 'local-operator' }]);
      expect(events.every(e => e.visibility === 'audit')).toBe(true);
    } finally { bundle.close(); }
  });

  it.each(['trustedMemoryControl', 'memoryControl', 'memory', 'actorId', 'scope', 'eligibleForPromotion', 'raw', 'report'])(
    'rejects forged %s in capture, review and Run bodies', async (field: string) => {
    const f = await fixture();
    expect((await f.post('/runs/source-completed/memory/capture', { requestId: 'capture-1', expectedCheckpointRevision: 1, [field]: 'forged' })).status).toBe(400);
    expect((await f.post('/memory/cases/memory-1/review', { profileId: 'simulation', requestId: 'review-1', expectedRevision: 1,
      decision: 'approved', claimCheck: 'supported', [field]: 'forged' })).status).toBe(400);
    expect((await f.post('/runs', { profileId: 'simulation', message: 'inspect', [field]: 'forged' })).status).toBe(400);
  });

  it('checks preference whitelist and policy before accepting a Run', async () => {
    const f = await fixture();
    const start = { runId: 'new-run', profileId: 'simulation', message: 'inspect' };
    expect((await f.post('/runs', { ...start, memoryPreferences: { scope: simulationMemoryScope() } })).status).toBe(400);
    for (const field of ['kind', 'requiredness', 'actor', 'actorId', 'approval']) {
      const response = await f.post('/runs', { ...start,
        memoryPreferences: { semantic: 'enabled', procedural: 'profile', [field]: 'forged' } });
      expect(response.status).toBe(400);
    }
    const denied = await f.post('/runs', { ...start, memoryPreferences: { capture: 'automatic' } });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: 'MEMORY_POLICY_DENIED' });
    expect((await f.post('/runs', { ...start, memoryPreferences: { capture: 'skip', recall: 'disabled' } })).status).toBe(202);
  });

  it('accepts semantic and procedural preferences and preserves them in typed Run options', async () => {
    const received: ReplyOptions[] = [];
    const server = await startInspectionHttpServer({
      agent: {} as never,
      events: {} as never,
      allowedProfileIds: ['simulation'],
      execution: { start: async (options: ReplyOptions) => { received.push(options); } } as never,
    });
    const cases: readonly MemoryPreferences[] = [
      { semantic: 'profile', procedural: 'enabled' },
      { semantic: 'enabled', procedural: 'disabled' },
      { semantic: 'disabled', procedural: 'profile' },
    ];
    try {
      for (const [index, memoryPreferences] of cases.entries()) {
        const response = await requestLocalJson(`${server.url}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: `preferences-${index}`, profileId: 'simulation', message: 'inspect', memoryPreferences }),
        });
        expect(response.status).toBe(202);
        expect(received[index]?.memoryPreferences).toEqual(memoryPreferences);
      }
    } finally {
      await server.close();
    }
  });

  it('maps scope, terminal, CAS, approval errors and rejects malformed/pagination/trust input', async () => {
    const f = await fixture();
    for (const [id, status] of [['missing', 404], ['alien-run', 404], ['old-run', 422], ['source-running', 422]] as const) {
      expect((await f.post(`/runs/${id}/memory/capture`, { requestId: `capture-${id}`, expectedCheckpointRevision: 1 })).status).toBe(status);
    }
    expect((await f.post('/runs/source-completed/memory/capture', { requestId: 'bad-cas', expectedCheckpointRevision: 2 })).status).toBe(409);
    expect((await requestLocalJson(`${f.url}/memory/cases/missing?profileId=simulation`)).status).toBe(404);
    expect((await requestLocalJson(`${f.url}/memory/cases?profileId=other`)).status).toBe(404);
    for (const suffix of ['limit=51', 'limit=0', 'status=unknown', 'scope=forged', 'profileId=simulation']) {
      expect((await requestLocalJson(`${f.url}/memory/cases?profileId=simulation&${suffix}`)).status).toBe(400);
    }
    await f.post('/runs/source-failed/memory/capture', { requestId: 'failed-capture', expectedCheckpointRevision: 1 });
    const failed = await (await requestLocalJson(`${f.url}/runs/source-failed/memory/capture`)).json() as MemoryCaptureTicket;
    expect((await f.post(`/memory/cases/${failed.memoryId}/review`, { profileId: 'simulation', requestId: 'failed-review',
      expectedRevision: 1, decision: 'approved', claimCheck: 'supported' })).status).toBe(422);
    expect((await requestLocalJson(`${f.url}/runs/source-completed/memory/capture`, { method: 'POST', body: '{bad' })).status).toBe(400);
  });

  it('applies Host, Origin and body bounds before memory commands', async () => {
    const f = await fixture();
    expect((await requestLocalJson(`${f.url}/memory/capabilities?profileId=simulation`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const forgedHost = await requestLocalJson(`${f.url}/memory/capabilities?profileId=simulation`, { headers: { host: 'evil.example' } });
    expect(forgedHost.status).toBe(403);
    expect((await f.post('/runs/source-completed/memory/capture', { requestId: 'x'.repeat(3_000), expectedCheckpointRevision: 1 })).status).toBe(413);
  });
});
