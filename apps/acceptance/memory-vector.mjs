import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NOW = '2026-10-11T12:00:00.000Z';
const MODES = ['bm25', 'vector', 'hybrid'];
const LIMIT = 5;
const SAFE_CODES = new Set([
  'VECTOR_INPUT_INVALID', 'VECTOR_SPACE_MISMATCH', 'VECTOR_PACK_INVALID',
  'VECTOR_EMBEDDING_MISSING', 'VECTOR_INDEX_UNAVAILABLE', 'VECTOR_CAPACITY_EXCEEDED',
  'VECTOR_EXPERIMENT_NOT_ENABLED', 'VECTOR_EMBEDDING_PACK_REQUIRED',
  'VECTOR_REAL_PACK_SOURCE_UNVERIFIED', 'VECTOR_ACCEPTANCE_FAILED',
  'VECTOR_EXTERNAL_REQUEST_BLOCKED', 'VECTOR_CLEANUP_FAILED',
]);

export async function runMemoryVectorAcceptance({ env = process.env, runtime = defaultRuntime() } = {}) {
  if (env.AGENTOPS_MEMORY_VECTOR_EXPERIMENT !== '1') {
    return outcome(1, { code: 'VECTOR_EXPERIMENT_NOT_ENABLED', status: 'not_run', realEmbedding: 'not_provided' });
  }
  const packPath = env.AGENTOPS_MEMORY_EMBEDDING_PACK;
  if (typeof packPath !== 'string' || packPath.trim().length === 0) {
    return outcome(2, { code: 'VECTOR_EMBEDDING_PACK_REQUIRED', status: 'not_run', realEmbedding: 'not_provided' });
  }

  let externalRequestsSent = 0;
  let cleanupFailed = false;
  let finalResult;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    externalRequestsSent += 1;
    return Promise.reject(Object.assign(new Error(), { code: 'VECTOR_EXTERNAL_REQUEST_BLOCKED' }));
  };
  let prepared;
  try {
    prepared = await runtime.prepare({ packPath, env });
    if (!isPreparedRuntime(prepared)) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
    const rebuildOperation = prepared.createOperation();
    const rebuildStarted = prepared.measurements.nowMs();
    const rebuild = await prepared.indexer.rebuild({ scope: prepared.scope, excludeRunIds: [] }, rebuildOperation);
    const rebuildMs = elapsed(prepared.measurements.nowMs(), rebuildStarted);
    if (!Number.isSafeInteger(rebuild.indexedCount) || rebuild.indexedCount < 0) {
      throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
    }

    const measurements = new Map(MODES.map((mode) => [mode, { durations: [], peakRssBytes: 0, queries: [] }]));
    let allRequestedModesUsed = true;
    for (const query of prepared.holdout) {
      for (const mode of MODES) {
        const measured = measurements.get(mode);
        if (measured === undefined) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
        const operation = prepared.createOperation();
        const started = prepared.measurements.nowMs();
        const result = await prepared.retriever.retrieve({ mode, scope: prepared.scope, text: query.text,
          excludeRunIds: [], limit: LIMIT }, operation);
        const duration = elapsed(prepared.measurements.nowMs(), started);
        const rss = prepared.measurements.rssBytes();
        if (!Number.isFinite(rss) || rss < 0 || !Array.isArray(result.hits)) {
          throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
        }
        measured.durations.push(duration);
        measured.peakRssBytes = Math.max(measured.peakRssBytes, rss);
        const rankedMemoryIds = result.hits.slice(0, LIMIT).map((hit) => hit.memoryId);
        if (rankedMemoryIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
          throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
        }
        if (result.requestedMode !== mode || result.usedMode !== mode || result.fallbackReason !== undefined) {
          allRequestedModesUsed = false;
        }
        measured.queries.push({
          queryId: query.id,
          rankedMemoryIds,
          ...(result.fallbackReason === undefined ? {} : { fallbackReason: safeCode(result.fallbackReason) }),
        });
      }
    }

    if (externalRequestsSent > 0) throw Object.assign(new Error(), { code: 'VECTOR_EXTERNAL_REQUEST_BLOCKED' });
    const reports = {};
    for (const mode of MODES) {
      const measured = measurements.get(mode);
      if (measured === undefined) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
      reports[mode] = {
        hitAt5: mean(measured.queries.map((row, index) => hitAtFive(row.rankedMemoryIds,
          prepared.holdout[index]?.relevantMemoryIds ?? []))),
        mrrAt5: mean(measured.queries.map((row, index) => reciprocalRank(row.rankedMemoryIds,
          prepared.holdout[index]?.relevantMemoryIds ?? []))),
        ndcgAt5: mean(measured.queries.map((row, index) => normalizedDcg(row.rankedMemoryIds,
          prepared.holdout[index]?.relevantMemoryIds ?? []))),
        emptyRecallCount: measured.queries.filter((row) => row.rankedMemoryIds.length === 0).length,
        queries: measured.queries,
      };
    }

    const indexBytes = await prepared.measurements.indexBytes();
    if (!Number.isSafeInteger(indexBytes) || indexBytes < 0) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
    const allDurations = MODES.flatMap((mode) => measurements.get(mode)?.durations ?? []);
    const peakRssBytes = Math.max(0, ...MODES.map((mode) => measurements.get(mode)?.peakRssBytes ?? 0));
    const pack = prepared.pack;
    const reviewedReal = pack.provenance === 'real'
      && isDigest(pack.packSha256)
      && env.AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256 === pack.packSha256
      && safeGeneratorRevision(pack.generatorRevision);
    const verified = reviewedReal && allRequestedModesUsed && externalRequestsSent === 0
      && prepared.holdout.length >= 12 && rebuild.indexedCount > 0;
    const report = {
      ...(pack.provenance === 'real' && !reviewedReal ? { code: 'VECTOR_REAL_PACK_SOURCE_UNVERIFIED' } : {}),
      status: verified ? 'verified' : 'mechanism_verified',
      realEmbedding: pack.provenance === 'synthetic' ? 'not_provided' : verified ? 'verified' : 'unverified',
      embeddingPack: {
        provenance: pack.provenance,
        packSha256: pack.packSha256,
        generatorRevision: pack.generatorRevision,
        space: publicEmbeddingSpace(pack.space),
      },
      semanticEvaluation: 'measured',
      externalRequestsSent,
      corpusCount: rebuild.indexedCount,
      queryCount: prepared.holdout.length,
      indexedCount: rebuild.indexedCount,
      metrics: reports,
      performance: {
        p50Ms: percentile(allDurations, 0.5),
        p95Ms: percentile(allDurations, 0.95),
        peakRssBytes,
        indexBytes,
        rebuildMs,
      },
    };
    finalResult = outcome(verified ? 0 : 2, report);
  } catch (error) {
    const code = safeCode(error?.code);
    finalResult = outcome(2, { code, status: 'failed', realEmbedding: 'unverified', externalRequestsSent });
  } finally {
    try {
      if (typeof prepared?.close === 'function') await prepared.close();
    } catch {
      cleanupFailed = true;
    } finally {
      globalThis.fetch = originalFetch;
    }
    if (externalRequestsSent > 0) {
      finalResult = outcome(2, { code: 'VECTOR_EXTERNAL_REQUEST_BLOCKED', status: 'failed',
        realEmbedding: 'unverified', externalRequestsSent });
    }
    if (cleanupFailed) {
      finalResult = outcome(2, { code: 'VECTOR_CLEANUP_FAILED', status: 'failed',
        realEmbedding: 'unverified', externalRequestsSent });
    }
  }
  return finalResult ?? outcome(2, { code: 'VECTOR_ACCEPTANCE_FAILED', status: 'failed', realEmbedding: 'unverified', externalRequestsSent });
}

function defaultRuntime() {
  return { prepare: prepareDefaultRuntime };
}

async function prepareDefaultRuntime({ packPath }) {
  const [{ createMemoryVectorExperiment }, stableJson, memoryState, memoryStore, memoryScope, vectorSpace] = await Promise.all([
    import('../../dist/bootstrap/memory-vector-experiment.js'),
    import('../../dist/contracts/stable-json.js'),
    import('../../dist/memory/diagnostic-memory-state.js'),
    import('../../dist/memory/in-memory-diagnostic-memory.js'),
    import('../../dist/memory/memory-scope.js'),
    import('../../dist/memory/vector/embedding-space.js'),
  ]);
  const clock = { now: () => new Date(NOW) };
  const scope = {
    profileId: 'memory-vector-acceptance', profileRevision: 'fixture-v1', serviceId: 'settlement',
    faultType: 'settlement_failure', targetFingerprint: 'a'.repeat(64), environment: 'simulation',
    dataClass: 'simulated', datasetId: 'memory-vector-holdout-v1',
  };
  const fixture = buildHoldoutFixture();
  const records = memoryState.createInMemoryDiagnosticRecords();
  const transaction = { checkpointRecords: new Map(), executionRecords: new Map(), outboxRecords: new Map(), memory: records };
  const repository = memoryState.createInMemoryDiagnosticRepository(transaction);
  const cases = fixture.cases.map((definition) => makeCase(definition, scope, stableJson.checkpointChecksum));
  for (const value of cases) {
    repository.putCase(value);
    repository.putCase({ ...value, revision: 2, status: 'approved' }, 1);
  }
  const foreignScope = { ...scope, datasetId: 'foreign-dataset' };
  const foreignCase = makeCase({ id: 'memory-foreign', sourceRunId: 'source-foreign', text: 'foreign dataset fraud ledger outage' },
    foreignScope, stableJson.checkpointChecksum);
  repository.putCase(foreignCase);
  repository.putCase({ ...foreignCase, revision: 2, status: 'approved' }, 1);
  const queries = new memoryStore.InMemoryDiagnosticMemoryStore({ clock, transaction });
  const evidence = { validate: async ({ sourceRunId, refs, scope: evidenceScope }) =>
    memoryScope.memoryScopeKey(evidenceScope) === memoryScope.memoryScopeKey(scope)
      && refs.length > 0 && refs.every((ref) => ref.ownerRunId === sourceRunId) };
  const corpus = {
    read: async ({ scope: requestedScope, excludeRunIds }, operation) => {
      assertLocalOperation(operation, clock);
      const values = await queries.list({ scope: requestedScope, status: 'approved', limit: 100 });
      return values.filter((value) => value.quality === 'sufficient' && value.sourceRunStatus === 'completed'
        && Date.parse(value.validUntil) > clock.now().getTime() && !excludeRunIds.includes(value.sourceRunId))
        .map((value) => ({ memoryId: value.id, revision: value.revision, digest: value.digest,
          scope: value.scope, kind: 'episodic', sourceRunId: value.sourceRunId, text: value.summary }));
    },
  };
  const corpusDigest = sha256(stableJson.canonicalJson(cases.map((value) => ({
    memoryId: value.id, revision: 2, digest: value.digest, textDigest: vectorSpace.memoryEmbeddingTextDigest(value.summary),
  }))));
  const querySetDigest = sha256(stableJson.canonicalJson(fixture.holdout.map((query) => ({
    queryId: query.id, textDigest: vectorSpace.memoryEmbeddingTextDigest(query.text), relevantMemoryIds: query.relevantMemoryIds,
  }))));
  const space = { provider: 'local-reviewed-pack', model: 'offline-embedding', revision: 'holdout-v1',
    dimensions: 3, normalization: 'l2', metric: 'cosine' };
  const directory = await mkdtemp(join(tmpdir(), 'memory-vector-experiment-'));
  const databasePath = join(directory, 'vector-experiment.sqlite');
  let experiment;
  try {
    experiment = await createMemoryVectorExperiment({ packPath, databasePath, scope, space, corpusDigest, querySetDigest,
      corpus, queries, evidence, clock });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    scope,
    corpusDigest,
    querySetDigest,
    holdout: fixture.holdout,
    pack: experiment.pack,
    indexer: experiment.indexer,
    retriever: experiment.retriever,
    measurements: {
      nowMs: () => globalThis.performance.now(),
      rssBytes: () => process.memoryUsage().rss,
      indexBytes: () => measureSqliteIndexBytes(databasePath),
    },
    createOperation: () => ({ now: clock.now().toISOString(), deadlineMs: clock.now().getTime() + 30_000, clock }),
    close: async () => {
      try { await experiment.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

function buildHoldoutFixture() {
  const cases = [
    { id: 'memory-01', sourceRunId: 'source-01', text: '结算失败率升高，数据库连接池超时与等待持续增加。' },
    { id: 'memory-02', sourceRunId: 'source-02', text: 'Payment gateway latency delays settlement responses and increases timeout rates.' },
    { id: 'memory-03', sourceRunId: 'source-03', text: '订单重复提交与幂等键冲突导致结算失败。' },
    { id: 'memory-04', sourceRunId: 'source-04', text: 'Settlement queue backlog grows while consumer lag rises.' },
    { id: 'memory-05', sourceRunId: 'source-05', text: '数据库连接池等待增加，但结算成功率保持稳定。' },
    { id: 'memory-06', sourceRunId: 'source-06', text: '支付回调延迟，外部网关偶发 5xx 错误。' },
    { id: 'memory-07', sourceRunId: 'source-07', text: 'Settlement database deadlocks increase during peak load.' },
    { id: 'memory-08', sourceRunId: 'source-08', text: '库存锁等待延长，订单结算事务提交变慢。' },
    { id: 'memory-09', sourceRunId: 'source-09', text: '订单状态重复消费造成重复结算尝试。' },
    { id: 'memory-10', sourceRunId: 'source-10', text: 'Message broker consumer lag delays payment settlement events.' },
    { id: 'memory-11', sourceRunId: 'source-11', text: 'Settlement success rate falls after connection acquisition timeouts.' },
    { id: 'memory-12', sourceRunId: 'source-12', text: 'Prometheus scrape target is down; no settlement symptom is present.' },
  ];
  const holdout = [
    { id: 'q-zh-pool-timeout', text: '结算失败率升高，连接池 timeout 明显增加', relevantMemoryIds: ['memory-01'] },
    { id: 'q-en-pool-timeout', text: 'settlement failures with database connection pool timeouts', relevantMemoryIds: ['memory-01', 'memory-11'] },
    { id: 'q-syn-pool-exhaustion', text: '交易无法完成，数据库连接资源耗尽且等待变长', relevantMemoryIds: ['memory-01'] },
    { id: 'q-gateway-latency', text: 'payment gateway latency is delaying settlement callbacks', relevantMemoryIds: ['memory-02', 'memory-06'] },
    { id: 'q-gateway-near', text: 'external payment provider responds slowly with occasional server errors', relevantMemoryIds: ['memory-02', 'memory-06'] },
    { id: 'q-idempotency', text: '订单重复请求与 idempotency conflict', relevantMemoryIds: ['memory-03', 'memory-09'] },
    { id: 'q-queue-backlog', text: 'settlement event backlog and rising consumer lag', relevantMemoryIds: ['memory-04', 'memory-10'] },
    { id: 'q-db-deadlock', text: 'database deadlocks under peak settlement traffic', relevantMemoryIds: ['memory-07'] },
    { id: 'q-inventory-lock', text: '库存锁等待让订单事务提交缓慢', relevantMemoryIds: ['memory-08'] },
    { id: 'q-same-word-different', text: '连接池等待增加但结算并未失败', relevantMemoryIds: ['memory-05'] },
    { id: 'q-foreign-dataset', text: 'foreign dataset fraud ledger outage', relevantMemoryIds: [] },
    { id: 'q-no-match', text: 'Kubernetes node clock drift and certificate rotation', relevantMemoryIds: [] },
  ];
  return { cases, holdout };
}

export async function measureSqliteIndexBytes(databasePath) {
  let totalBytes = 0;
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const details = await stat(filePath);
      if (!details.isFile()) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
      totalBytes += details.size;
    } catch (error) {
      if (filePath !== databasePath && error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  if (!Number.isSafeInteger(totalBytes)) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
  return totalBytes;
}

function makeCase(definition, scope, checksum) {
  const sourceRunId = definition.sourceRunId;
  const base = {
    schemaVersion: 1,
    id: definition.id,
    revision: 1,
    extractorVersion: 'episodic-v1',
    scope,
    sourceRunId,
    sourceRunStatus: 'completed',
    capturedAt: NOW,
    validUntil: '2026-11-10T00:00:00.000Z',
    status: 'observation',
    quality: 'sufficient',
    summary: definition.text,
    symptomCodes: ['MEMORY_VECTOR_FIXTURE'],
    limitations: [],
    evidenceRefs: [{ evidenceId: `evidence-${definition.id}`, ownerRunId: sourceRunId,
      source: 'metric', capturedAt: NOW, rawSha256: 'b'.repeat(64) }],
    diagnosisOnly: true,
    eligibleForPromotion: false,
  };
  return { ...base, digest: checksum(base) };
}

function assertLocalOperation(operation, clock) {
  operation.signal?.throwIfAborted();
  if (!Number.isSafeInteger(operation.deadlineMs) || clock.now().getTime() >= operation.deadlineMs) {
    throw new globalThis.DOMException('Memory vector acceptance deadline exceeded.', 'TimeoutError');
  }
}

function isPreparedRuntime(value) {
  return value !== null && typeof value === 'object' && value.scope !== undefined
    && Array.isArray(value.holdout) && value.holdout.length >= 12
    && value.indexer?.rebuild !== undefined && value.retriever?.retrieve !== undefined
    && value.measurements?.nowMs !== undefined && value.measurements?.rssBytes !== undefined
    && value.measurements?.indexBytes !== undefined && value.createOperation !== undefined
    && value.close !== undefined && isPackMetadata(value.pack);
}

function isPackMetadata(value) {
  return value !== null && typeof value === 'object'
    && ['real', 'synthetic'].includes(value.provenance)
    && isDigest(value.packSha256) && safePublicIdentifier(value.generatorRevision)
    && value.space !== null && typeof value.space === 'object'
    && safePublicIdentifier(value.space.provider) && safePublicIdentifier(value.space.model)
    && safePublicIdentifier(value.space.revision)
    && Number.isSafeInteger(value.space.dimensions) && value.space.dimensions >= 2 && value.space.dimensions <= 4096
    && value.space.normalization === 'l2' && value.space.metric === 'cosine';
}

function publicEmbeddingSpace(space) {
  return {
    provider: space.provider,
    model: space.model,
    revision: space.revision,
    dimensions: space.dimensions,
    normalization: space.normalization,
    metric: space.metric,
  };
}

function outcome(exitCode, report) { return { exitCode, report }; }
function elapsed(ended, started) {
  const value = ended - started;
  if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error(), { code: 'VECTOR_ACCEPTANCE_FAILED' });
  return value;
}
function mean(values) { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function hitAtFive(ranked, relevant) { return ranked.slice(0, LIMIT).some((id) => relevant.includes(id)) ? 1 : 0; }
function reciprocalRank(ranked, relevant) {
  const position = ranked.slice(0, LIMIT).findIndex((id) => relevant.includes(id));
  return position < 0 ? 0 : 1 / (position + 1);
}
function normalizedDcg(ranked, relevant) {
  const dcg = ranked.slice(0, LIMIT).reduce((sum, id, index) =>
    sum + (relevant.includes(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealCount = Math.min(LIMIT, new Set(relevant).size);
  const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}
function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function safeGeneratorRevision(value) {
  return safePublicIdentifier(value)
    && !/synthetic|fixture|test/iu.test(value);
}
function safePublicIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/+~-]{0,127}$/u.test(value);
}
function safeCode(value) { return SAFE_CODES.has(value) ? value : 'VECTOR_ACCEPTANCE_FAILED'; }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMemoryVectorAcceptance({ env: process.env });
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
  process.exitCode = result.exitCode;
}
