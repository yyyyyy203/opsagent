import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureSqliteIndexBytes, runMemoryVectorAcceptance } from '../apps/acceptance/memory-vector.mjs';

const fixtureSpace = {
  provider: 'local-provider', model: 'test-embedding', revision: 'r1', dimensions: 3,
  normalization: 'l2', metric: 'cosine',
};

function preparedRuntime(overrides: Record<string, unknown> = {}) {
  const holdout = Array.from({ length: 12 }, (_, index) => ({
    id: `holdout-${index + 1}`,
    text: `PRIVATE_QUERY_TEXT_${index + 1}`,
    relevantMemoryIds: [`memory-${index + 1}`],
  }));
  const retriever = { retrieve: vi.fn(({ mode, limit }: { mode: string; limit: number }) => Promise.resolve({
    requestedMode: mode,
    usedMode: mode,
    hits: [{ memoryId: `memory-${holdout.findIndex(value => value.text.endsWith(String(limit))) + 1}`,
      revision: 1, digest: 'a'.repeat(64) }],
  })) };
  let nowMs = 0;
  const runtime = {
    prepare: vi.fn(() => Promise.resolve({
      scope: { profileId: 'fixture' },
      corpusDigest: 'b'.repeat(64),
      querySetDigest: 'c'.repeat(64),
      holdout,
      pack: { provenance: 'synthetic', generatorRevision: 'offline-vectors-v1', packSha256: 'd'.repeat(64), space: fixtureSpace },
      indexer: { rebuild: vi.fn(() => Promise.resolve({ indexedCount: 12, spaceKey: 'fixture-space' })) },
      retriever,
      measurements: {
        nowMs: () => ++nowMs,
        rssBytes: () => 4096 + nowMs,
        indexBytes: () => Promise.resolve(8192),
      },
      createOperation: () => ({ now: '2026-10-10T00:00:00.000Z', deadlineMs: 1_000_000 }),
      close: vi.fn(() => Promise.resolve()),
      ...overrides,
    })),
  };
  return { runtime, retriever };
}

describe('memory vector offline acceptance entry point', () => {
  it('measures the SQLite database, WAL, and shared-memory files together', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-vector-size-'));
    const databasePath = join(directory, 'index.sqlite');
    try {
      await writeFile(databasePath, Buffer.alloc(2));
      await writeFile(`${databasePath}-wal`, Buffer.alloc(3));
      await writeFile(`${databasePath}-shm`, Buffer.alloc(5));

      await expect(measureSqliteIndexBytes(databasePath)).resolves.toBe(10);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to run without explicit opt-in and does not initialize the runtime', async () => {
    const { runtime } = preparedRuntime();
    const result = await runMemoryVectorAcceptance({ env: {}, runtime });

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ code: 'VECTOR_EXPERIMENT_NOT_ENABLED', realEmbedding: 'not_provided' });
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it('requires an embedding pack after opt-in without echoing a path', async () => {
    const { runtime } = preparedRuntime();
    const result = await runMemoryVectorAcceptance({
      env: { AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1' },
      runtime,
    });

    expect(result.exitCode).toBe(2);
    expect(result.report).toMatchObject({ code: 'VECTOR_EMBEDDING_PACK_REQUIRED', realEmbedding: 'not_provided' });
    expect(JSON.stringify(result.report)).not.toContain('C:\\private\\vectors.json');
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it('measures all 12 holdouts with a synthetic pack but never calls it real embedding success', async () => {
    const { runtime, retriever } = preparedRuntime();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('external request forbidden')));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await runMemoryVectorAcceptance({
        env: {
          AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1',
          AGENTOPS_MEMORY_EMBEDDING_PACK: 'C:\\private\\vectors.json',
        },
        runtime,
      });

      expect(result.exitCode).toBe(2);
      expect(result.report).toMatchObject({
        status: 'mechanism_verified',
        realEmbedding: 'not_provided',
        externalRequestsSent: 0,
        corpusCount: 12,
        queryCount: 12,
        indexedCount: 12,
        semanticEvaluation: 'measured',
      });
      expect(result.report.performance?.indexBytes).toBe(8192);
      expect(retriever.retrieve).toHaveBeenCalledTimes(36);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result.report)).not.toContain('PRIVATE_QUERY_TEXT');
      expect(JSON.stringify(result.report)).not.toContain('private\\vectors.json');
      expect(runtime.prepare.mock.results[0]?.value).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('blocks and counts outbound fetch attempts in the acceptance runtime', async () => {
    const { runtime } = preparedRuntime();
    const underlyingFetch = vi.fn(() => Promise.reject(new Error('network must not be reached')));
    vi.stubGlobal('fetch', underlyingFetch);
    vi.mocked(runtime.prepare).mockImplementation(() => fetch('https://external.invalid') as Promise<never>);
    try {
      const result = await runMemoryVectorAcceptance({
        env: { AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1', AGENTOPS_MEMORY_EMBEDDING_PACK: 'C:\\private\\vectors.json' },
        runtime,
      });

      expect(result.exitCode).toBe(2);
      expect(result.report).toMatchObject({
        code: 'VECTOR_EXTERNAL_REQUEST_BLOCKED',
        status: 'failed',
        externalRequestsSent: 1,
      });
      expect(underlyingFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires a matching reviewed pack hash before a real pack can report verified', async () => {
    const { runtime } = preparedRuntime({
      pack: { provenance: 'real', generatorRevision: 'offline-generator-v2', packSha256: 'e'.repeat(64), space: fixtureSpace },
    });
    const result = await runMemoryVectorAcceptance({
      env: {
        AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1',
        AGENTOPS_MEMORY_EMBEDDING_PACK: 'C:\\private\\vectors.json',
        AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256: 'f'.repeat(64),
      },
      runtime,
    });

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe('mechanism_verified');
    expect(result.report.realEmbedding).toBe('unverified');
  });

  it('reports verified only when the real pack hash has an explicit matching review attestation', async () => {
    const reviewedHash = 'e'.repeat(64);
    const { runtime } = preparedRuntime({
      pack: {
        provenance: 'real', generatorRevision: 'offline-generator-v2', packSha256: reviewedHash,
        space: { ...fixtureSpace, endpoint: 'https://private.invalid', token: 'SECRET_PACK_TOKEN' },
      },
    });
    const result = await runMemoryVectorAcceptance({
      env: {
        AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1',
        AGENTOPS_MEMORY_EMBEDDING_PACK: 'C:\\private\\vectors.json',
        AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256: reviewedHash,
      },
      runtime,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe('verified');
    expect(result.report.realEmbedding).toBe('verified');
    expect(result.report.embeddingPack).toEqual({
      provenance: 'real',
      packSha256: reviewedHash,
      generatorRevision: 'offline-generator-v2',
      space: fixtureSpace,
    });
    expect(JSON.stringify(result.report)).not.toContain('SECRET_PACK_TOKEN');
    expect(JSON.stringify(result.report)).not.toContain('private.invalid');
  });

  it('does not report success when the temporary experiment cleanup fails', async () => {
    const reviewedHash = 'e'.repeat(64);
    const { runtime } = preparedRuntime({
      pack: { provenance: 'real', generatorRevision: 'offline-generator-v2', packSha256: reviewedHash, space: fixtureSpace },
      close: vi.fn(() => Promise.reject(new Error('PRIVATE_TEMP_DIRECTORY_DETAIL'))),
    });

    const result = await runMemoryVectorAcceptance({
      env: {
        AGENTOPS_MEMORY_VECTOR_EXPERIMENT: '1',
        AGENTOPS_MEMORY_EMBEDDING_PACK: 'C:\\private\\vectors.json',
        AGENTOPS_MEMORY_EMBEDDING_REVIEWED_SHA256: reviewedHash,
      },
      runtime,
    });

    expect(result.exitCode).toBe(2);
    expect(result.report).toMatchObject({ code: 'VECTOR_CLEANUP_FAILED', status: 'failed' });
    expect(JSON.stringify(result.report)).not.toContain('PRIVATE_TEMP_DIRECTORY_DETAIL');
  });
});
