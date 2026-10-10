import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticMemoryCase, MemoryEvidenceValidator, MemoryOperation, MemoryScope, RunMemoryState } from '../src/contracts/diagnostic-memory.js';
import { parseRunMemoryState } from '../src/contracts/diagnostic-memory-schema.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { createSqliteDiagnosticMemoryRepository, SqliteDiagnosticMemoryStore } from '../src/infrastructure/sqlite/diagnostic-memory-store.js';
import { InMemoryDiagnosticMemoryStore } from '../src/memory/in-memory-diagnostic-memory.js';
import { createInMemoryDiagnosticRecords, createInMemoryDiagnosticRepository } from '../src/memory/diagnostic-memory-state.js';
import { BoundedMemoryRecall } from '../src/memory/bounded-recall.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const scope = simulationMemoryScope();
const clock = { now: () => new Date(memoryNow) };
const operation: MemoryOperation = { now: memoryNow, clock, deadlineMs: Date.parse(memoryNow) + 1000, availableMemoryTokens: 1024 };
function candidate(id: string, overrides: Partial<DiagnosticMemoryCase> = {}) {
  const sourceRunId = `source-${id}`;
  return memoryCase({ id, sourceRunId, summary: '连接池 timeout', symptomCodes: [],
    evidenceRefs: memoryCase({ sourceRunId }).evidenceRefs, ...overrides });
}
function makeStore(backend: 'memory' | 'sqlite') {
  const database = backend === 'sqlite' ? SqliteDatabase.open(':memory:') : null;
  const transaction = { memory: createInMemoryDiagnosticRecords(), checkpointRecords: new Map(), executionRecords: new Map(), outboxRecords: new Map() };
  const repo = database === null ? createInMemoryDiagnosticRepository(transaction) : createSqliteDiagnosticMemoryRepository(database);
  const store = database === null ? new InMemoryDiagnosticMemoryStore({ clock, transaction }) : new SqliteDiagnosticMemoryStore(database, { clock });
  const insert = (value: DiagnosticMemoryCase, status: DiagnosticMemoryCase['status'] = 'approved') => {
    repo.putCase({ ...value, status: 'observation' });
    if (status !== 'observation') repo.putCase({ ...value, status, revision: 2 }, 1);
  };
  return { store, repo, database, insert, close: () => database?.close() };
}
function state(scopeOverride: MemoryScope = scope): RunMemoryState {
  return { schemaVersion: 1, scope: scopeOverride, selectionState: 'unselected', availability: 'empty', selections: [], hints: [] };
}
const evidence: MemoryEvidenceValidator = { validate: () => Promise.resolve(true) };

describe.each(['memory', 'sqlite'] as const)('%s scoped lexical search', (backend) => {
  it('filters every scope dimension and eligibility before Top-K', async () => {
    const h = makeStore(backend);
    try {
      const otherScopes: MemoryScope[] = [
        { ...scope, profileId: 'other' }, { ...scope, profileRevision: 'v2' }, { ...scope, serviceId: 'other' },
        { ...scope, faultType: 'other' }, { ...scope, targetFingerprint: 'other' },
        { ...scope, datasetId: 'holdout' }, { ...scope, environment: 'development' },
        { profileId: scope.profileId, profileRevision: scope.profileRevision, serviceId: scope.serviceId,
          faultType: scope.faultType, targetFingerprint: scope.targetFingerprint, environment: 'production', dataClass: 'live' },
      ];
      otherScopes.forEach((other, i) => h.insert(candidate(`foreign-${i}`, { scope: other })));
      h.insert(candidate('observation'), 'observation');
      h.insert(candidate('rejected'), 'rejected');
      h.insert(candidate('insufficient', { quality: 'insufficient' }), 'observation');
      h.insert(candidate('failed', { sourceRunStatus: 'failed', quality: 'failed' }), 'observation');
      h.insert(candidate('expired', { capturedAt: '2026-10-01T00:00:00Z', validUntil: memoryNow }));
      h.insert(candidate('self', { sourceRunId: 'current' }));
      h.insert(candidate('allowed'));
      expect((await h.store.search({ scope, text: '连接池 timeout', excludeRunIds: ['current'], limit: 1, now: memoryNow })).map(c => c.id)).toEqual(['allowed']);
    } finally { h.close(); }
  });
  it('ranks by BM25 frequency/length and resolves ties by time then binary ID', async () => {
    const h = makeStore(backend);
    try {
      h.insert(candidate('long', { summary: 'timeout ' + 'noise '.repeat(30) }));
      h.insert(candidate('single', { summary: 'timeout' }));
      h.insert(candidate('repeat', { summary: 'timeout timeout timeout' }));
      h.insert(candidate('z-tie', { summary: 'timeout' }));
      h.insert(candidate('a-tie', { summary: 'timeout' }));
      h.insert(candidate('new', { summary: 'timeout', capturedAt: '2026-10-10T00:00:01Z' }));
      expect((await h.store.search({ scope, text: 'timeout', excludeRunIds: [], limit: 10, now: memoryNow })).map(c => c.id))
        .toEqual(['repeat', 'new', 'a-tie', 'single', 'z-tie', 'long']);
    } finally { h.close(); }
  });
  it('uses mixed tokens, safe FTS operators and identifier phrases', async () => {
    const h = makeStore(backend);
    try {
      h.insert(candidate('match', { summary: '连接池 pool_wait' }));
      h.insert(candidate('substring', { summary: 'timeouts' }));
      expect((await h.store.search({ scope, text: '连接池', excludeRunIds: [], limit: 5, now: memoryNow })).map(c => c.id)).toEqual(['match']);
      expect((await h.store.search({ scope, text: 'POOL_WAIT', excludeRunIds: [], limit: 5, now: memoryNow })).map(c => c.id)).toEqual(['match']);
      expect(await h.store.search({ scope, text: '"timeout" OR NEAR(foo) -*', excludeRunIds: [], limit: 5, now: memoryNow })).toEqual([]);
      expect(await h.store.search({ scope, text: '', excludeRunIds: [], limit: 5, now: memoryNow })).toEqual([]);
    } finally { h.close(); }
  });
  it('enforces search/exclusion bounds and returns isolated copies', async () => {
    const h = makeStore(backend);
    try {
      for (let i = 0; i < 12; i++) h.insert(candidate(`c-${String(i).padStart(2, '0')}`));
      const search = { scope, text: 'timeout', excludeRunIds: [], limit: 5, now: memoryNow };
      expect(await h.store.search(search)).toHaveLength(5);
      expect(await h.store.search({ ...search, limit: 10 })).toHaveLength(10);
      await expect(h.store.search({ ...search, limit: 11 })).rejects.toMatchObject({ code: 'MEMORY_DATA_INVALID' });
      await expect(h.store.search({ ...search, excludeRunIds: Array(65).fill('run') })).rejects.toMatchObject({ code: 'MEMORY_DATA_INVALID' });
      const result = await h.store.search(search);
      result[0]!.summary = 'mutated';
      expect((await h.store.search(search))[0]!.summary).toBe('连接池 timeout');
    } finally { h.close(); }
  });
  it('freezes selection and removes revoked/expired evidence without expanding search', async () => {
    const h = makeStore(backend);
    try {
      h.insert(candidate('original'));
      const search = vi.spyOn(h.store, 'search');
      const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
      const first = await recall.prepare({ runId: 'current', text: '连接池', state: state() }, operation);
      expect(first.hints.map(c => c.memoryId)).toEqual(['original']);
      expect(search.mock.calls[0]?.[0].excludeRunIds).toContain('current');
      h.insert(candidate('new'));
      const old = await h.store.get('original', scope);
      h.repo.putCase({ ...old!, status: 'rejected', revision: 3 }, 2);
      const later = await recall.prepare({ runId: 'current', text: 'timeout', state: structuredClone(first) }, operation);
      expect(later.hints).toEqual([]);
      expect(later.selections).toEqual(first.selections);
      expect(search).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });
});

describe('bounded recall snapshots', () => {
  function setup(values: readonly DiagnosticMemoryCase[] = [candidate('valid', { status: 'approved', evidenceRefs: memoryCase().evidenceRefs })]) {
    const h = makeStore('memory');
    values.forEach(c => h.insert({ ...c, status: 'observation' }));
    return h;
  }
  it('caps hint count, bytes and conservative tokens while keeping selection frozen', async () => {
    const h = setup(Array.from({ length: 8 }, (_, i) => candidate(`m-${i}`)));
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const result = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, { ...operation, availableMemoryTokens: 900 });
    expect(result.selections).toHaveLength(5);
    expect(result.hints.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.hints))).toBeLessThanOrEqual(900);
    expect(result.hints.length).toBeLessThanOrEqual(5);
    expect(parseRunMemoryState(result)).toEqual(result);
  });
  it('counts UTF-8 rather than characters and bounds custom options', async () => {
    const h = setup([candidate('large', { summary: '界'.repeat(400) })]);
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence, maxHints: 1, maxBytes: 4096, maxTokens: 1024 });
    const result = await recall.prepare({ runId: 'current', text: '界界', state: state() }, operation);
    expect(result.selections).toHaveLength(1);
    expect(result.hints).toEqual([]);
    expect(() => new BoundedMemoryRecall({ queries: h.store, evidence, maxHints: 6 })).toThrow();
    expect(() => new BoundedMemoryRecall({ queries: h.store, evidence, maxBytes: 4097 })).toThrow();
    expect(() => new BoundedMemoryRecall({ queries: h.store, evidence, maxTokens: 1025 })).toThrow();
  });
  it.each([undefined, 0, -1, NaN])('fails closed for unavailable token budget %s', async (availableMemoryTokens) => {
    const h = setup();
    const search = vi.spyOn(h.store, 'search');
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const { availableMemoryTokens: _unused, ...base } = operation;
    void _unused;
    const result = await recall.prepare({ runId: 'current', text: 'timeout', state: state() },
      { ...base, ...(availableMemoryTokens === undefined ? {} : { availableMemoryTokens }) });
    expect(result.hints).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
  it('does not query past deadline and discards late lookup results', async () => {
    const h = setup();
    const search = vi.spyOn(h.store, 'search');
    let time = Date.parse(memoryNow);
    const op = { ...operation, clock: { now: () => new Date(time) } };
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const expired = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, { ...op, deadlineMs: time });
    expect(expired.hints).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    search.mockImplementation(async () => { time += 2000; return [(await h.store.get('valid', scope))!]; });
    const late = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, op);
    expect(late.hints).toEqual([]);
  });
  it('makes first lookup failure a frozen empty selection and does not retry search', async () => {
    const h = setup();
    const search = vi.spyOn(h.store, 'search').mockRejectedValue(new Error('private detail'));
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(first).toMatchObject({ availability: 'unavailable', reasonCode: 'MEMORY_LOOKUP_FAILED', selectionState: 'selected', hints: [], selections: [] });
    expect(JSON.stringify(first)).not.toContain('private detail');
    await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it('returns unavailable when the search dependency throws TimeoutError within the budget', async () => {
    const h = setup();
    vi.spyOn(h.store, 'search').mockRejectedValue(new DOMException('dependency timeout', 'TimeoutError'));
    const result = await new BoundedMemoryRecall({ queries: h.store, evidence }).prepare(
      { runId: 'current', text: 'timeout', state: state() }, operation);
    expect(result).toMatchObject({ availability: 'unavailable', reasonCode: 'MEMORY_LOOKUP_FAILED', hints: [] });
  });
  it('returns unavailable when the evidence dependency throws TimeoutError within the budget', async () => {
    const h = setup();
    const result = await new BoundedMemoryRecall({ queries: h.store, evidence: {
      validate: () => Promise.reject(new DOMException('dependency timeout', 'TimeoutError')),
    } }).prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(result).toMatchObject({ availability: 'unavailable', reasonCode: 'MEMORY_LOOKUP_FAILED', hints: [] });
  });
  it('keeps selections on revalidation failure and can recover the same revision', async () => {
    const h = setup();
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    const revalidate = vi.spyOn(h.store, 'revalidate').mockRejectedValueOnce(new Error('lookup error'));
    const failed = await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation);
    expect(failed).toMatchObject({ availability: 'unavailable', hints: [], selections: first.selections });
    const recovered = await recall.prepare({ runId: 'current', text: 'timeout', state: failed }, operation);
    expect(recovered.hints.map(h => h.memoryId)).toEqual(['valid']);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });
  it('removes missing evidence and fails closed if validation throws', async () => {
    const h = setup();
    const validate = vi.fn<MemoryEvidenceValidator['validate']>().mockResolvedValue(false);
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence: { validate } });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(first.hints).toEqual([]);
    expect(first.selections).toHaveLength(1);
    validate.mockRejectedValueOnce(new Error('private'));
    const failed = await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation);
    expect(failed).toMatchObject({ availability: 'unavailable', hints: [], selections: first.selections });
  });
  it('never renders an approved case with no historical evidence references', async () => {
    const h = setup([candidate('no-evidence', { evidenceRefs: [] })]);
    const validate = vi.fn<MemoryEvidenceValidator['validate']>().mockResolvedValue(true);
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence: { validate } });
    const result = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(result.selections).toHaveLength(1);
    expect(result.hints).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });
  it.each(['revision', 'digest', 'expiry'] as const)('rechecks %s even with a misbehaving query adapter', async field => {
    const h = setup();
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    const current = (await h.store.get('valid', scope))!;
    const changed = field === 'revision' ? { ...current, revision: 3 } : field === 'digest' ? { ...current, digest: 'd'.repeat(64) }
      : { ...current, capturedAt: '2026-10-01T00:00:00Z', validUntil: memoryNow };
    vi.spyOn(h.store, 'revalidate').mockResolvedValue([changed]);
    const next = await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation);
    expect(next.hints).toEqual([]);
  });
  it('rejects cross-scope, current Run and unselected adapter responses', async () => {
    const h = setup();
    vi.spyOn(h.store, 'search').mockResolvedValue([
      candidate('foreign', { status: 'approved', scope: { ...scope, datasetId: 'holdout' } }),
      candidate('current', { status: 'approved', sourceRunId: 'current' }),
      candidate('valid', { status: 'approved' }),
    ]);
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(first.hints.map(h => h.memoryId)).toEqual(['valid']);
    vi.spyOn(h.store, 'revalidate').mockResolvedValue([candidate('new', { status: 'approved' })]);
    expect((await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation)).hints).toEqual([]);
  });
  it('propagates pre-abort, mid-lookup abort and explicit validator Abort', async () => {
    const h = setup();
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const controller = new AbortController();
    controller.abort();
    await expect(recall.prepare({ runId: 'current', text: 'timeout', state: state() }, { ...operation, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const mid = new AbortController();
    vi.spyOn(h.store, 'search').mockImplementation(() => {
      mid.abort();
      return Promise.reject(new Error('lookup cancelled'));
    });
    await expect(recall.prepare({ runId: 'current', text: 'timeout', state: state() }, { ...operation, signal: mid.signal })).rejects.toMatchObject({ name: 'AbortError' });
    vi.restoreAllMocks();
    const aborting = new BoundedMemoryRecall({ queries: h.store, evidence: {
      validate: () => Promise.reject(new DOMException('stop', 'AbortError')),
    } });
    await expect(aborting.prepare({ runId: 'current', text: 'timeout', state: state() }, operation)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not accept corrupted candidate JSON from an adapter', async () => {
    const h = setup();
    vi.spyOn(h.store, 'search').mockResolvedValue([{ ...candidate('bad', { status: 'approved' }), digest: 'bad' }]);
    const result = await new BoundedMemoryRecall({ queries: h.store, evidence }).prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    expect(result).toMatchObject({ availability: 'unavailable', hints: [] });
  });
  it('bounds a hanging lookup by deadline and clears active hints', async () => {
    const h = setup();
    vi.spyOn(h.store, 'search').mockImplementation(() => new Promise(() => {}));
    const result = await new BoundedMemoryRecall({ queries: h.store, evidence }).prepare(
      { runId: 'current', text: 'timeout', state: state() }, { ...operation, deadlineMs: Date.parse(memoryNow) + 10 });
    expect(result).toMatchObject({ selectionState: 'selected', availability: 'empty', hints: [] });
  });
  it('shares one deadline across sequential dependencies when no clock is injected', async () => {
    vi.useFakeTimers();
    const h = setup([candidate('first'), candidate('second')]);
    try {
      const realSearch = h.store.search.bind(h.store);
      vi.spyOn(h.store, 'search').mockImplementation(async input => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return realSearch(input);
      });
      const validate = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return true;
      });
      const { clock: _clock, ...withoutClock } = operation;
      void _clock;
      const pending = new BoundedMemoryRecall({ queries: h.store, evidence: { validate } }).prepare(
        { runId: 'current', text: 'timeout', state: state() },
        { ...withoutClock, deadlineMs: Date.parse(memoryNow) + 100 });

      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(20);

      const result = await pending;
      expect(validate).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ selectionState: 'selected', availability: 'empty', hints: [] });
    } finally {
      vi.useRealTimers();
      h.close();
    }
  });
  it('does not launch a query when cancelled before its async invocation', async () => {
    const h = setup();
    const search = vi.spyOn(h.store, 'search');
    const controller = new AbortController();
    const pending = new BoundedMemoryRecall({ queries: h.store, evidence }).prepare(
      { runId: 'current', text: 'timeout', state: state() }, { ...operation, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(search).not.toHaveBeenCalled();
  });
  it('preserves the saved order when the revalidation adapter reverses results', async () => {
    const h = setup([candidate('a'), candidate('b')]);
    const recall = new BoundedMemoryRecall({ queries: h.store, evidence });
    const first = await recall.prepare({ runId: 'current', text: 'timeout', state: state() }, operation);
    vi.spyOn(h.store, 'revalidate').mockResolvedValue([(await h.store.get('b', scope))!, (await h.store.get('a', scope))!]);
    const next = await recall.prepare({ runId: 'current', text: 'timeout', state: first }, operation);
    expect(next.hints.map(h => h.memoryId)).toEqual(first.hints.map(h => h.memoryId));
    expect(next.selectedAt).toBe(first.selectedAt);
  });
  it('produces the same BM25 ordering as SQLite with phrase/duplicate terms and foreign corpus statistics', async () => {
    const memory = makeStore('memory');
    const sqlite = makeStore('sqlite');
    try {
      const docs = [
        candidate('a', { summary: '连接池 pool_wait timeout timeout' }),
        candidate('b', { summary: '连接池 timeout' }),
        candidate('c', { summary: 'pool_wait pool_wait more noise noise' }),
        candidate('d', { summary: 'timeout ' + 'noise '.repeat(50) }),
        candidate('e', { summary: '𠮷连接 pool wait timeout' }),
        candidate('f', { summary: '连接池 timeout', scope: { ...scope, datasetId: 'holdout' } }),
        candidate('g', { summary: 'nomatch' }),
        candidate('h', { summary: 'pool__wait' }),
        candidate('i', { summary: '___' }),
      ];
      docs.forEach(c => { memory.insert(c); sqlite.insert(c); });
      for (const text of ['timeout', '连接池', 'POOL_WAIT', 'timeout timeout pool_wait', '𠮷连接', 'wait']) {
        const query = { scope, text, excludeRunIds: [], limit: 10, now: memoryNow };
        const actual = (await memory.store.search(query)).map(c => c.id);
        const expected = (await sqlite.store.search(query)).map(c => c.id);
        expect(actual, text).toEqual(expected);
      }
    } finally { memory.close(); sqlite.close(); }
  });
});
