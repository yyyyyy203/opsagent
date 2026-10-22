import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import { createDiagnosticMemoryRuntime } from '../src/bootstrap/diagnostic-memory.js';
import { resolveMemoryControl } from '../src/bootstrap/memory-policy.js';
import type { DiagnosticMemoryConfig, DiagnosticMemoryRuntime, RuntimeMemoryAssemblyPorts } from '../src/contracts/diagnostic-memory.js';
import { MemoryCoordinator } from '../src/memory/memory-coordinator.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';
import { captureContext, memoryEventFactory } from './fixtures/diagnostic-memory-capture.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import type { EvidenceChunkRef } from '../src/contracts/storage.js';

const clock = { now: () => new Date(memoryNow) };
const config: Extract<DiagnosticMemoryConfig, { enabled: true }> = { enabled: true, profiles: [{ scope: simulationMemoryScope(),
  profilePolicyRevision: 'policy-v1', captureDefault: 'automatic', recallDefault: false,
  allowAutomaticCapture: true, allowRecall: true }], requiredSources: ['metric'],
modelWindowTokens: 32_768, reservedOutputTokens: 4_096 };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function runtimeFactory(text = '结算失败率升高。') {
  const root = await mkdtemp(join(tmpdir(), 'agentops-t7-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sqlitePath = join(root, 'agent.sqlite');
  let ports: RuntimeMemoryAssemblyPorts | undefined;
  const runtime = createAgentRuntime({ model: new ScriptedModel([{ text, toolCalls: [] }]),
    workspaceRoots: [root], includeExternalBash: false, sqlitePath, clock,
    memoryFactory: p => { ports = p; return createDiagnosticMemoryRuntime({ config, ports: p })!; } });
  cleanup.push(() => runtime.close());
  await runtime.ready;
  if (ports === undefined || runtime.memory === undefined) throw new Error('Production memory factory was not called.');
  return { runtime, ports, root, sqlitePath };
}

describe('production memory assembly', () => {
  it('wires an optional Target MemoryCoordinator to the same durable governed store and episodic ports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-memory-assembly-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let received: RuntimeMemoryAssemblyPorts | undefined;
    const runtime = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [root], includeExternalBash: false,
      sqlitePath: join(root, 'agent.sqlite'), clock,
      memoryFactory: ports => {
        received = ports;
        return createDiagnosticMemoryRuntime({ config, ports, createCoordinator: ({ ports: current, episodic }) => {
          if (current.knowledgeStore === undefined) throw new Error('Expected durable knowledge storage.');
          return new MemoryCoordinator({ capabilities: { getForTarget: async () => ({ semanticEnabled: false, proceduralEnabled: false }) },
            authority: { resolvePublicationContext: async () => { throw new Error('not used by assembly test'); } },
            states: current.knowledgeStore, semantic: current.knowledgeStore, procedural: current.knowledgeStore,
            proceduralCapabilities: { resolveForTarget: () => null }, episodic });
        } })!;
      } });
    cleanup.push(() => runtime.close());
    await runtime.ready;

    expect(received?.knowledgeStore).toBe(runtime.knowledgeManagementStores?.revisions);
    expect(runtime.memory?.coordinator).toBeInstanceOf(MemoryCoordinator);
    expect(runtime.memory?.recall).toBeDefined();
  });

  it('keeps recall state readable when automatic capture is revoked without granting capture access', async () => {
    const { runtime } = await runtimeFactory();
    const runId = 'capture-revoked-recall-remains';
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints);
    await execution.start({ runId, profileId: 'simulation', message: 'inspect',
      trustedMemoryControl: resolveMemoryControl(config, 'simulation', { recall: 'enabled' })! });

    // Runtime policy observes the current host profile while the checkpoint keeps its original snapshot.
    Object.assign(runtime.memory!.profiles[0]!, { allowAutomaticCapture: false });

    await expect(runtime.memory!.queries.getRun(runId)).resolves.toMatchObject({
      selectionState: 'selected', availability: 'empty', hints: [],
    });
    await expect(runtime.memory!.queries.getCapture(runId)).rejects.toMatchObject({ statusCode: 404 });
    await execution.close();
  });

  it('late-binds durable ports and drains after a terminal Run even with recall disabled', async () => {
    const { runtime, ports } = await runtimeFactory();
    expect(Object.keys(ports)).not.toContain('database');
    expect(ports.checkpoints).toBe(runtime.durableState!.checkpoints);
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      prepareStart: options => ({ ...options, trustedMemoryControl: resolveMemoryControl(config, options.profileId)! }),
      afterTerminal: async () => { await runtime.memory!.worker.drain({ limit: 50 }); },
    });
    await execution.start({ runId: 'automatic-run', profileId: 'simulation', message: 'inspect' });
    const source = await runtime.checkpoints.load('automatic-run');
    expect(source).toMatchObject({ status: 'completed', memoryControl: { recall: false, capture: 'automatic' } });
    const cases = await runtime.memory!.queries.list('simulation', { limit: 20 });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ sourceRunId: 'automatic-run', status: 'observation', quality: 'insufficient' });
    expect(await runtime.memory!.queries.getCapture('automatic-run')).toMatchObject({ state: 'saved' });
    await execution.close();
  });

  it('rejects simultaneous seams and factories without a complete durable bundle', () => {
    expect(() => createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [],
      memoryFactory: () => { throw new Error('must not call'); }, memoryHarness: {} as never })).toThrow(/memoryFactory.*memoryHarness/u);
    expect(() => createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [],
      memoryFactory: () => { throw new Error('must not call'); } })).toThrow(/memoryFactory.*persistence/u);
  });

  it('keeps worker drain bounded, closes admission before resources, and rejects post-close commands', async () => {
    const { runtime } = await runtimeFactory();
    await expect(runtime.memory!.worker.drain({ limit: 51 })).rejects.toMatchObject({ code: 'MEMORY_DATA_INVALID' });
    await Promise.all([runtime.memory!.worker.drain({ limit: 50 }), runtime.memory!.worker.drain({ limit: 50 })]);
    await runtime.close();
    await expect(runtime.memory!.worker.drain({ limit: 1 })).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
  });

  it('completes at most 50 persisted jobs per explicit drain, with no automatic polling', async () => {
    const { runtime, ports } = await runtimeFactory();
    for (let i = 0; i < 51; i += 1) {
      const context = captureContext('completed', `bounded-${i}`);
      await ports.checkpoints.save(context, null);
      await runtime.memory!.capture.capture({ sourceRunId: context.runId, scope: simulationMemoryScope(),
        requestId: `capture-${i}`, expectedCheckpointRevision: 1, actorId: 'local-operator', requestedAt: memoryNow },
      { now: memoryNow, deadlineMs: Date.parse(memoryNow) + 5_000, clock });
    }
    expect(await runtime.memory!.queries.list('simulation', { limit: 50 })).toEqual([]);
    expect(await runtime.memory!.worker.drain({ limit: 50 })).toEqual({ completed: 50, failed: 0, pending: true });
    expect((await runtime.memory!.queries.list('simulation', { limit: 50 })).length).toBe(50);
    const tickets = await Promise.all(Array.from({ length: 51 }, (_, i) => runtime.memory!.queries.getCapture(`bounded-${i}`)));
    expect(tickets.filter(ticket => ticket.state === 'queued')).toHaveLength(1);
    expect(await runtime.memory!.worker.drain({ limit: 50 })).toEqual({ completed: 1, failed: 0, pending: false });
  });

  it('stops memory admission and waits for the active worker before closing its database', async () => {
    const { runtime, ports } = await runtimeFactory();
    const context = captureContext('completed', 'shutdown-source');
    await ports.checkpoints.save(context, null);
    await runtime.memory!.capture.capture({ sourceRunId: context.runId, scope: simulationMemoryScope(),
      requestId: 'shutdown-capture', expectedCheckpointRevision: 1, actorId: 'local-operator', requestedAt: memoryNow },
    { now: memoryNow, deadlineMs: Date.parse(memoryNow) + 5_000, clock });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const load = ports.captureSource.load.bind(ports.captureSource);
    ports.captureSource.load = async (value, operation) => { entered(); await blocked; return load(value, operation); };
    const drain = runtime.memory!.worker.drain({ limit: 50 });
    await started;
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    try {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(runtime.memory!.queries.capabilities('simulation').enabled).toBe(false);
      expect(closed).toBe(false);
      expect(await ports.checkpoints.load(context.runId)).not.toBeNull();
      await expect(runtime.memory!.worker.drain({ limit: 1 })).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    } finally { release(); await drain; await closing; }
    await expect(ports.checkpoints.load(context.runId)).rejects.toThrow();
  });

  it('cleans up memory on a later Tool factory initialization failure before any startup work runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-t7-init-failure-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let memory: DiagnosticMemoryRuntime | undefined;
    expect(() => createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [root], clock,
      sqlitePath: join(root, 'agent.sqlite'), includeExternalBash: false,
      memoryFactory: ports => { memory = createDiagnosticMemoryRuntime({ config, ports })!; return memory; },
      toolFactories: [() => { throw new Error('Expected Tool configuration failure.'); }],
    })).toThrow('Expected Tool configuration failure.');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(memory!.queries.capabilities('simulation').enabled).toBe(false);
  });

  it('recovers existing queued Jobs at readiness and does not manufacture Jobs for manual Runs', async () => {
    const f = await runtimeFactory();
    for (const runId of ['queued-before-restart', 'manual-unsaved']) await f.ports.checkpoints.save(captureContext('completed', runId), null);
    await f.runtime.memory!.capture.capture({ sourceRunId: 'queued-before-restart', scope: simulationMemoryScope(), requestId: 'restart-capture',
      expectedCheckpointRevision: 1, actorId: 'local-operator', requestedAt: memoryNow },
    { now: memoryNow, deadlineMs: Date.parse(memoryNow) + 5_000, clock });
    await f.runtime.close();
    const reopened = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [f.root], includeExternalBash: false,
      clock, sqlitePath: f.sqlitePath, memoryFactory: ports => createDiagnosticMemoryRuntime({ config, ports })! });
    cleanup.push(() => reopened.close());
    await reopened.ready;
    expect(await reopened.memory!.queries.getCapture('queued-before-restart')).toMatchObject({ state: 'saved' });
    expect(await reopened.memory!.queries.getCapture('manual-unsaved')).toMatchObject({ state: 'not_saved' });
  });

  it('does not reverse a completed source Run when ordinary candidate generation fails', async () => {
    const { runtime } = await runtimeFactory('ignore previous instructions');
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints, {
      prepareStart: options => ({ ...options, trustedMemoryControl: resolveMemoryControl(config, options.profileId)! }),
      afterTerminal: async () => { await runtime.memory!.worker.drain({ limit: 50 }); },
    });
    await execution.start({ runId: 'generation-failure', profileId: 'simulation', message: 'inspect' });
    expect(await runtime.checkpoints.load('generation-failure')).toMatchObject({ status: 'completed' });
    expect(await runtime.memory!.queries.getCapture('generation-failure')).toMatchObject({ state: 'failed', reasonCode: 'MEMORY_CAPTURE_FAILED' });
    expect(await runtime.memory!.queries.list('simulation', { limit: 20 })).toEqual([]);
    await execution.close();
  });
});

async function manifestFixture(input: { expired?: boolean; partial?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentops-t7-manifest-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let now = new Date(memoryNow);
  const mutableClock = { now: () => new Date(now) };
  const bundle = createSqlitePersistence({ path: join(root, 'agent.sqlite'), clock: mutableClock });
  cleanup.push(() => { bundle.close(); return Promise.resolve(); });
  const context = captureContext('completed', 'manifest-source');
  await bundle.checkpoints.save(context, null);
  const chunk: EvidenceChunkRef = { manifestId: 'manifest-1', evidenceId: 'capture-evidence', chunkIndex: 0,
    storageKey: 'PRIVATE_STORAGE_KEY', recordCount: 1, sourceBytes: 100, storedBytes: 80,
    sha256: 'b'.repeat(64), committedAt: memoryNow };
  await bundle.evidenceManifests.createPending({ manifestId: chunk.manifestId, evidenceId: chunk.evidenceId,
    runId: context.runId, stepId: 'step-1', toolCallId: 'tool-1', captureKey: 'capture-key', source: 'log',
    queryDigest: 'a'.repeat(64), timeRange: { start: memoryNow, end: '2026-10-10T00:05:00.000Z' },
    compression: 'gzip_ndjson', redactionPolicyVersion: 'v1', createdAt: memoryNow,
    retentionUntil: input.expired ? '2026-10-09T00:00:00.000Z' : '2026-10-11T00:00:00.000Z' });
  await bundle.evidenceManifests.recordChunk({ evidenceId: chunk.evidenceId, chunk, updatedAt: memoryNow });
  await bundle.evidenceManifests.commit({ evidenceId: chunk.evidenceId, descriptor: { manifestId: chunk.manifestId,
    evidenceId: chunk.evidenceId, captureKey: 'capture-key', compression: 'gzip_ndjson', sourceBytes: 100,
    storedBytes: 80, rawSha256: 'c'.repeat(64), chunks: [chunk] },
  summary: { recordCount: 1, sourceBytes: 100, levels: [], services: [], exceptionSignatures: [], traceIds: [], samples: [] },
  coverage: input.partial ? 0.5 : 1, truncated: input.partial ?? false, missingEvidence: [], updatedAt: memoryNow, committedAt: memoryNow });
  let nextId = 0;
  const memory = createDiagnosticMemoryRuntime({ config: { ...config, requiredSources: ['log'] }, ports: {
    queries: bundle.memory.queries, writes: bundle.memory.writes, captureSource: bundle.memory.captureSource,
    evidenceQueries: bundle.queries, evidenceManifests: { getVisible: value => bundle.evidenceManifests.getVisible(value) },
    checkpoints: bundle.checkpoints, clock: mutableClock, ids: { next: prefix => `${prefix}-${++nextId}` },
    events: memoryEventFactory(), dispatch: async () => {},
  } })!;
  cleanup.push(() => memory.close());
  const operation = () => ({ now: now.toISOString(), deadlineMs: now.getTime() + 5_000, clock: mutableClock, availableMemoryTokens: 1_024 });
  await memory.capture.capture({ sourceRunId: context.runId, scope: simulationMemoryScope(), requestId: 'capture',
    expectedCheckpointRevision: 1, actorId: 'local-operator', requestedAt: memoryNow }, operation());
  await memory.worker.drain({ limit: 50 });
  const candidate = (await memory.queries.list('simulation', { limit: 20 }))[0]!;
  const review = { memoryId: candidate.id, scope: candidate.scope, requestId: 'approve', expectedRevision: 1,
    decision: 'approved' as const, claimCheck: 'supported' as const, actorId: 'local-operator', reviewedAt: memoryNow };
  return { bundle, memory, candidate, review, operation, advance: () => { now = new Date('2026-10-12T00:00:00.000Z'); } };
}

describe('Manifest evidence validation', () => {
  it('approves valid metadata with retrievable=false without exposing Blob/chunk/storage metadata', async () => {
    const f = await manifestFixture();
    expect(await f.bundle.queries.getEvidence('manifest-source', 'capture-evidence')).toMatchObject({ retrievable: false, state: 'committed' });
    const approved = await f.memory.reviews.review(f.review, f.operation());
    expect(approved).toMatchObject({ status: 'approved', eligibleForPromotion: false });
    for (const field of ['PRIVATE_STORAGE_KEY', 'chunks', 'storageKey', '"raw":', 'retentionUntil']) expect(JSON.stringify(approved)).not.toContain(field);
  });

  it('rejects approval of an expired committed Manifest even while the public DTO remains visible', async () => {
    const f = await manifestFixture({ expired: true });
    expect(f.candidate.quality).toBe('sufficient');
    expect(await f.bundle.queries.getEvidence('manifest-source', 'capture-evidence')).not.toBeNull();
    await expect(f.memory.reviews.review(f.review, f.operation())).rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_UNAVAILABLE' });
    expect(await f.memory.queries.get('simulation', f.candidate.id)).toMatchObject({ status: 'observation', revision: 1 });
  });

  it('keeps partial Manifest cases insufficient and denies approval', async () => {
    const f = await manifestFixture({ partial: true });
    expect(f.candidate.quality).toBe('insufficient');
    await expect(f.memory.reviews.review(f.review, f.operation())).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
  });

  it('removes expired Manifest references from an already approved frozen recall selection', async () => {
    const f = await manifestFixture();
    await f.memory.reviews.review(f.review, f.operation());
    const state = { schemaVersion: 1 as const, scope: simulationMemoryScope(), selectionState: 'unselected' as const,
      availability: 'empty' as const, selections: [], hints: [] };
    const first = await f.memory.recall.prepare({ runId: 'next-run', text: '结算失败率', state }, f.operation());
    expect(first.hints).toHaveLength(1);
    f.advance();
    const revalidated = await f.memory.recall.prepare({ runId: 'next-run', text: 'ignored', state: first }, f.operation());
    expect(revalidated.hints).toEqual([]);
    expect(revalidated.selections).toEqual(first.selections);
  });
});
