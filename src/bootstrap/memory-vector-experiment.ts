import type { Clock } from '../contracts/common.js';
import type { MemoryEvidenceValidator, MemoryQueryStore, MemoryScope } from '../contracts/diagnostic-memory.js';
import type { EmbeddingSpace, MemoryExperimentCorpus } from '../contracts/memory-vector.js';
import { FileEmbeddingProvider } from '../infrastructure/memory/file-embedding-provider.js';
import { MemoryVectorDatabase } from '../infrastructure/sqlite/memory-vector-database.js';
import { SqliteVectorIndex } from '../infrastructure/sqlite/memory-vector-index.js';
import { ShadowMemoryRetriever } from '../memory/vector/shadow-retriever.js';
import { MemoryVectorIndexer } from '../memory/vector/vector-indexer.js';

/** Owns the experiment-only provider, database, and index lifecycle. */
export async function createMemoryVectorExperiment(input: {
  packPath: string;
  databasePath: string;
  scope: MemoryScope;
  space: EmbeddingSpace;
  corpusDigest: string;
  querySetDigest: string;
  corpus: MemoryExperimentCorpus;
  queries: MemoryQueryStore;
  evidence: MemoryEvidenceValidator;
  clock: Clock;
}): Promise<{
  indexer: MemoryVectorIndexer;
  retriever: ShadowMemoryRetriever;
  pack: { provenance: 'real' | 'synthetic'; generatorRevision: string; packSha256: string; space: EmbeddingSpace };
  close(): Promise<void>;
}> {
  const embeddings = await FileEmbeddingProvider.load({ path: input.packPath, expectedSpace: input.space,
    corpusDigest: input.corpusDigest, querySetDigest: input.querySetDigest, clock: input.clock });
  let database: MemoryVectorDatabase | undefined;
  let vectorIndex: SqliteVectorIndex | undefined;
  try {
    database = MemoryVectorDatabase.open(input.databasePath);
    vectorIndex = new SqliteVectorIndex({ database, clock: input.clock });
    const indexer = new MemoryVectorIndexer({ corpus: input.corpus, embeddings, index: vectorIndex, clock: input.clock });
    const retriever = new ShadowMemoryRetriever({ queries: input.queries, corpus: input.corpus,
      evidence: input.evidence, embeddings, index: vectorIndex, clock: input.clock });
    let closed = false;
    return {
      indexer,
      retriever,
      pack: { provenance: embeddings.provenance, generatorRevision: embeddings.generatorRevision,
        packSha256: embeddings.packSha256, space: embeddings.space },
      close: async () => {
        if (closed) return;
        closed = true;
        try { await vectorIndex?.close(); }
        finally { database?.close(); }
      },
    };
  } catch (error) {
    database?.close();
    throw error;
  }
}
