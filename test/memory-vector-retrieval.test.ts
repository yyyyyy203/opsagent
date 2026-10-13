import { describe, expect, it, vi } from 'vitest';
import type {
  DiagnosticMemoryCase, MemoryEvidenceValidator, MemoryOperation, MemoryScope, MemoryVectorDocument,
  MemoryVectorEntry, MemoryVectorHit, VectorIndex,
} from '../src/contracts/index.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { InMemoryDiagnosticMemoryStore } from '../src/memory/in-memory-diagnostic-memory.js';
import { createInMemoryDiagnosticRecords, createInMemoryDiagnosticRepository } from '../src/memory/diagnostic-memory-state.js';
import { MemoryVectorIndexer } from '../src/memory/vector/vector-indexer.js';
import { ShadowMemoryRetriever } from '../src/memory/vector/shadow-retriever.js';
import { reciprocalRankFusion } from '../src/memory/vector/rrf.js';
import { VectorExperimentError } from '../src/memory/vector/vector-error.js';
import type { EmbeddingProvider, MemoryExperimentCorpus } from '../src/contracts/memory-vector.js';
import { simulationMemoryScope, memoryNow } from './fixtures/diagnostic-memory.js';

const scope = simulationMemoryScope();
const now = memoryNow;
const clock = { now: () => new Date(now) };
const operation: MemoryOperation = { now, deadlineMs: Date.parse(now) + 60_000, clock };
const space = { provider: 'fixture', model: 'local', revision: 'r1', dimensions: 3, normalization: 'l2', metric: 'cosine' } as const;

function canonicalCase(input: {
  id: string;
  scope?: MemoryScope;
  summary?: string;
  status?: DiagnosticMemoryCase['status'];
  capturedAt?: string;
  validUntil?: string;
  sourceRunStatus?: DiagnosticMemoryCase['sourceRunStatus'];
  quality?: DiagnosticMemoryCase['quality'];
}): DiagnosticMemoryCase {
  const sourceRunId = `source-${input.id}`;
  const base = {
    schemaVersion: 1 as const,
    id: input.id,
    revision: 1,
    extractorVersion: 'episodic-v1' as const,
    scope: input.scope ?? scope,
    sourceRunId,
    sourceRunStatus: input.sourceRunStatus ?? 'completed',
    capturedAt: input.capturedAt ?? now,
    validUntil: input.validUntil ?? '2026-11-10T00:00:00.000Z',
    status: 'observation' as const,
    quality: input.quality ?? 'sufficient',
    summary: input.summary ?? '结算失败率升高，连接池 timeout 增加。',
    symptomCodes: ['SETTLEMENT_FAILURE_HIGH'],
    limitations: [],
    evidenceRefs: [{ evidenceId: `evidence-${input.id}`, ownerRunId: sourceRunId,
      source: 'metric' as const, capturedAt: now, rawSha256: 'b'.repeat(64) }],
    diagnosisOnly: true as const,
    eligibleForPromotion: false,
  };
  const status = input.status ?? 'approved';
  return {
    ...base,
    revision: status === 'observation' ? 1 : 2,
    status,
    digest: checkpointChecksum(base),
  };
}

function makeMemoryStore(cases: readonly DiagnosticMemoryCase[]): InMemoryDiagnosticMemoryStore {
  const transaction = {
    checkpointRecords: new Map(),
    executionRecords: new Map(),
    outboxRecords: new Map(),
    memory: createInMemoryDiagnosticRecords(),
  };
  const repository = createInMemoryDiagnosticRepository(transaction);
  for (const value of cases) {
    const observation = { ...value, revision: 1, status: 'observation' as const, eligibleForPromotion: false };
    repository.putCase(observation);
    if (value.status !== 'observation') repository.putCase(value, observation.revision);
  }
  return new InMemoryDiagnosticMemoryStore({ clock, transaction });
}

function document(value: DiagnosticMemoryCase, documentScope: MemoryScope = value.scope): MemoryVectorDocument {
  return {
    memoryId: value.id,
    revision: value.revision,
    digest: value.digest,
    scope: documentScope,
    kind: 'episodic',
    sourceRunId: value.sourceRunId,
    text: value.summary,
  };
}

function embeddings(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    space,
    embed: vi.fn((texts: readonly string[]) => Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])))),
    ...overrides,
  };
}

function index(overrides: Partial<VectorIndex> = {}): VectorIndex {
  return {
    upsert: vi.fn(() => Promise.resolve()),
    search: vi.fn(() => Promise.resolve([] as readonly MemoryVectorHit[])),
    remove: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function corpus(documents: readonly MemoryVectorDocument[]): MemoryExperimentCorpus {
  return { read: vi.fn(() => Promise.resolve(documents)) };
}

function retriever(input: {
  cases: readonly DiagnosticMemoryCase[];
  documents?: readonly MemoryVectorDocument[];
  vectorIndex?: VectorIndex;
  provider?: EmbeddingProvider;
  evidence?: MemoryEvidenceValidator;
  clockOverride?: { now(): Date };
}) {
  const queries = makeMemoryStore(input.cases);
  const evidence: MemoryEvidenceValidator = input.evidence ?? { validate: vi.fn(() => Promise.resolve(true)) };
  const documents = input.documents ?? input.cases.map(value => document(value));
  const source = corpus(documents);
  const vectorIndex = input.vectorIndex ?? index();
  const provider = input.provider ?? embeddings();
  const service = new ShadowMemoryRetriever({ queries, corpus: source, evidence, embeddings: provider,
    index: vectorIndex, clock: input.clockOverride ?? clock });
  return { service, queries, evidence, corpus: source, index: vectorIndex, embeddings: provider };
}

function hit(value: DiagnosticMemoryCase, score: number): MemoryVectorHit {
  return { memoryId: value.id, revision: value.revision, digest: value.digest, score };
}

describe('memory vector retrieval mechanisms', () => {
  it('fuses ranked lists from rank one, deduplicates full identities, and breaks ties by memoryId', () => {
    const a = { memoryId: 'a', revision: 1, digest: 'a'.repeat(64), score: 0.8 };
    const b = { memoryId: 'b', revision: 3, digest: 'b'.repeat(64), score: 0.2 };
    const c = { memoryId: 'c', revision: 1, digest: 'c'.repeat(64), score: 0.4 };
    expect(reciprocalRankFusion([[a, b], [b, c, a]], 3)).toEqual([
      { memoryId: 'b', revision: 3, digest: 'b'.repeat(64) },
      { memoryId: 'a', revision: 1, digest: 'a'.repeat(64) },
      { memoryId: 'c', revision: 1, digest: 'c'.repeat(64) },
    ]);
  });

  it('rejects duplicate identities within one ranked list and conflicting revisions across lists', () => {
    const first = { memoryId: 'same', revision: 1, digest: 'a'.repeat(64), score: 1 };
    const duplicate = { ...first };
    const changedRevision = { ...first, revision: 2 };
    expect(() => reciprocalRankFusion([[first, duplicate]], 5))
      .toThrowError(new VectorExperimentError('VECTOR_INPUT_INVALID'));
    expect(() => reciprocalRankFusion([[first], [changedRevision]], 5))
      .toThrowError(new VectorExperimentError('VECTOR_INPUT_INVALID'));
  });

  it('rebuilds only the requested scope and exclusions in bounded embedding/upsert batches', async () => {
    const allowed = Array.from({ length: 17 }, (_, i) => canonicalCase({ id: `case-${String(i).padStart(2, '0')}` }));
    const excluded = canonicalCase({ id: 'excluded' });
    const foreign = canonicalCase({ id: 'foreign', scope: { ...scope, datasetId: 'other-dataset' } });
    const documents = [...allowed.map(value => document(value)),
      document({ ...excluded, sourceRunId: 'current-run' }), document(foreign)];
    const upsert = vi.fn((entries: readonly MemoryVectorEntry[]) => {
      void entries;
      return Promise.resolve();
    });
    const vectorIndex = index({ upsert });
    const provider = embeddings();
    const providerEmbed = vi.spyOn(provider, 'embed');
    const service = new MemoryVectorIndexer({ corpus: corpus(documents), embeddings: provider,
      index: vectorIndex, clock });

    const result = await service.rebuild({ scope, excludeRunIds: ['current-run'] }, operation);

    expect(result).toEqual({ indexedCount: 17, spaceKey: JSON.stringify({
      dimensions: 3, metric: 'cosine', model: 'local', normalization: 'l2', provider: 'fixture', revision: 'r1',
    }) });
    expect(upsert.mock.calls.map(([entries]) => entries.length)).toEqual([16, 1]);
    expect(upsert.mock.calls.flatMap(([entries]) => entries.map(entry => entry.memoryId)))
      .toEqual(allowed.map(value => value.id));
    expect(providerEmbed.mock.calls).toHaveLength(2);
  });

  it('does not leave a partially rebuilt index when a later embedding batch fails', async () => {
    const documents = Array.from({ length: 17 }, (_, index) => document(canonicalCase({ id: `atomic-${index}` })));
    let embedCalls = 0;
    const provider = embeddings({ embed: vi.fn((texts: readonly string[]) => {
      embedCalls += 1;
      return embedCalls === 2
        ? Promise.reject(new Error('second batch failed'))
        : Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])));
    }) });
    const upsert = vi.fn(() => Promise.resolve());
    const service = new MemoryVectorIndexer({ corpus: corpus(documents), embeddings: provider,
      index: index({ upsert }), clock });

    await expect(service.rebuild({ scope, excludeRunIds: [] }, operation)).rejects.toThrow('second batch failed');
    expect(upsert.mock.calls).toHaveLength(0);
  });

  it('normalizes unordered index hits and excludes hits outside the eligible corpus', async () => {
    const a = canonicalCase({ id: 'a', summary: 'settlement timeout' });
    const b = canonicalCase({ id: 'b', summary: 'settlement pool wait' });
    const outsider = canonicalCase({ id: 'outsider' });
    const vectorIndex = index({ search: vi.fn(() => Promise.resolve([
      hit(b, 0.3), hit(outsider, 100), hit(a, 0.9),
    ])) });
    const vectorSearch = vi.spyOn(vectorIndex, 'search');
    const harness = retriever({ cases: [a, b], vectorIndex });

    const result = await harness.service.retrieve({ mode: 'vector', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation);

    expect(result.usedMode).toBe('vector');
    expect(result.hits).toEqual([
      { memoryId: 'a', revision: a.revision, digest: a.digest },
      { memoryId: 'b', revision: b.revision, digest: b.digest },
    ]);
    expect(vectorSearch.mock.calls[0]?.[0].eligible.map(value => value.memoryId)).toEqual(['a', 'b']);
  });

  it('reports malformed revalidation results as unavailable instead of ordinary empty recall', async () => {
    const value = canonicalCase({ id: 'corrupt-revalidation' });
    const harness = retriever({ cases: [value], vectorIndex: index({
      search: vi.fn(() => Promise.resolve([hit(value, 1)])),
    }) });
    vi.spyOn(harness.queries, 'revalidate').mockResolvedValue(null as never);

    await expect(harness.service.retrieve({ mode: 'vector', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation)).rejects.toMatchObject({
      code: 'MEMORY_LOOKUP_FAILED',
      message: 'Memory lookup failed.',
    });
  });

  it('filters revoked, expired, and wrong-scope cases before similarity ranking and final selection', async () => {
    const allowed = canonicalCase({ id: 'allowed' });
    const revoked = canonicalCase({ id: 'revoked', status: 'rejected' });
    const expired = canonicalCase({ id: 'expired', capturedAt: '2026-10-09T00:00:00.000Z', validUntil: now });
    const foreignScope = canonicalCase({ id: 'wrong-scope', scope: { ...scope, datasetId: 'foreign' } });
    const all = [allowed, revoked, expired, foreignScope];
    const vectorIndex = index({ search: vi.fn(() => Promise.resolve(all.map(value => hit(value, 1)))) });
    const vectorSearch = vi.spyOn(vectorIndex, 'search');
    const harness = retriever({ cases: all, documents: [
      document(allowed), document(revoked), document(expired), document(foreignScope, scope),
    ], vectorIndex });

    const result = await harness.service.retrieve({ mode: 'vector', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation);

    expect(vectorSearch.mock.calls[0]?.[0].eligible.map(value => value.memoryId)).toEqual(['allowed']);
    expect(result.hits.map(value => value.memoryId)).toEqual(['allowed']);
  });

  it.each([
    ['missing pack', 'VECTOR_EMBEDDING_MISSING'],
    ['space mismatch', 'VECTOR_SPACE_MISMATCH'],
    ['corrupt or unavailable index', 'VECTOR_INDEX_UNAVAILABLE'],
    ['capacity-limited index', 'VECTOR_CAPACITY_EXCEEDED'],
  ] as const)('falls back to concrete T5 BM25 on %s without external requests', async (_label, code) => {
    const value = canonicalCase({ id: 'bm25-hit', summary: 'settlement timeout increased' });
    const provider = embeddings({ embed: vi.fn(() => {
      if (code === 'VECTOR_EMBEDDING_MISSING' || code === 'VECTOR_SPACE_MISMATCH') {
        return Promise.reject(new VectorExperimentError(code));
      }
      return Promise.resolve([new Float32Array([1, 0, 0])]);
    }) });
    const vectorIndex = index({ search: vi.fn(() => Promise.reject(new VectorExperimentError(
      code === 'VECTOR_EMBEDDING_MISSING' ? 'VECTOR_INDEX_UNAVAILABLE' : code))) });
    const harness = retriever({ cases: [value], provider, vectorIndex });
    const networkSpy = vi.fn(() => Promise.reject(new Error('external request forbidden')));
    vi.stubGlobal('fetch', networkSpy);
    try {
      const result = await harness.service.retrieve({ mode: 'hybrid', scope, text: 'settlement timeout',
        excludeRunIds: [], limit: 5 }, operation);
      expect(result.usedMode).toBe('bm25');
      expect(result.fallbackReason).toBe(code);
      expect(result.hits.map(candidate => candidate.memoryId)).toEqual(['bm25-hit']);
      expect(networkSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports concrete T5 BM25 lookup failures as unavailable instead of ordinary empty recall', async () => {
    const value = canonicalCase({ id: 'bm25-unavailable', summary: 'settlement timeout increased' });
    const provider = embeddings({ embed: vi.fn(() => Promise.reject(new VectorExperimentError('VECTOR_EMBEDDING_MISSING'))) });
    const fallbackHarness = retriever({ cases: [value], provider });
    const privateFailure = new Error('PRIVATE_DATABASE_DETAIL');
    vi.spyOn(fallbackHarness.queries, 'search').mockRejectedValue(privateFailure);

    await expect(fallbackHarness.service.retrieve({ mode: 'hybrid', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation)).rejects.toMatchObject({
      code: 'MEMORY_LOOKUP_FAILED',
      message: 'Memory lookup failed.',
    });
    await expect(fallbackHarness.service.retrieve({ mode: 'bm25', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation)).rejects.toMatchObject({ code: 'MEMORY_LOOKUP_FAILED' });
  });

  it('propagates Abort immediately without starting corpus, index, or BM25 work', async () => {
    const value = canonicalCase({ id: 'abort-case' });
    const reason = new DOMException('cancelled', 'AbortError');
    const controller = new AbortController();
    controller.abort(reason);
    const vectorIndex = index();
    const harness = retriever({ cases: [value], vectorIndex });
    const corpusRead = vi.spyOn(harness.corpus, 'read');
    const vectorSearch = vi.spyOn(vectorIndex, 'search');
    const search = vi.spyOn(harness.queries, 'search');

    await expect(harness.service.retrieve({ mode: 'hybrid', scope, text: 'timeout', excludeRunIds: [], limit: 5 },
      { ...operation, signal: controller.signal })).rejects.toBe(reason);

    expect(corpusRead.mock.calls).toHaveLength(0);
    expect(vectorSearch.mock.calls).toHaveLength(0);
    expect(search.mock.calls).toHaveLength(0);
  });

  it('does not start BM25 fallback after the operation deadline expires', async () => {
    const value = canonicalCase({ id: 'deadline-case', summary: 'settlement timeout increased' });
    let time = Date.parse(now);
    const mutableClock = { now: () => new Date(time) };
    const vectorIndex = index({ search: vi.fn(() => {
      time = Date.parse(now) + 1_000;
      return Promise.reject(new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'));
    }) });
    const harness = retriever({ cases: [value], vectorIndex, clockOverride: mutableClock });
    const search = vi.spyOn(harness.queries, 'search');

    const result = await harness.service.retrieve({ mode: 'hybrid', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, { ...operation, deadlineMs: Date.parse(now) + 1_000 });

    expect(search.mock.calls).toHaveLength(0);
    expect(result.hits).toEqual([]);
    expect(result.fallbackReason).toBe('VECTOR_INDEX_UNAVAILABLE');
  });

  it('falls back after a vector adapter timeout while the shared deadline still has time', async () => {
    const value = canonicalCase({ id: 'adapter-timeout', summary: 'settlement timeout increased' });
    const vectorIndex = index({ search: vi.fn(() => Promise.reject(
      new DOMException('adapter timeout', 'TimeoutError'))) });
    const harness = retriever({ cases: [value], vectorIndex });
    const bm25Search = vi.spyOn(harness.queries, 'search');

    const result = await harness.service.retrieve({ mode: 'hybrid', scope, text: 'settlement timeout',
      excludeRunIds: [], limit: 5 }, operation);

    expect(bm25Search.mock.calls).toHaveLength(1);
    expect(result).toMatchObject({ usedMode: 'bm25', fallbackReason: 'VECTOR_INDEX_UNAVAILABLE' });
    expect(result.hits.map(hit => hit.memoryId)).toEqual([value.id]);
  });
});
