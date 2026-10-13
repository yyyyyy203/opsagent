export interface MemoryVectorAcceptanceReport {
  code?: string;
  status?: 'not_run' | 'failed' | 'mechanism_verified' | 'verified';
  realEmbedding?: 'not_provided' | 'unverified' | 'verified';
  semanticEvaluation?: 'measured';
  externalRequestsSent?: number;
  embeddingPack?: {
    provenance: 'real' | 'synthetic';
    packSha256: string;
    generatorRevision: string;
    space: { provider: string; model: string; revision: string; dimensions: number; normalization: 'l2'; metric: 'cosine' };
  };
  corpusCount?: number;
  queryCount?: number;
  indexedCount?: number;
  metrics?: Record<'bm25' | 'vector' | 'hybrid', {
    hitAt5: number;
    mrrAt5: number;
    ndcgAt5: number;
    emptyRecallCount: number;
    queries: readonly { queryId: string; rankedMemoryIds: readonly string[]; fallbackReason?: string }[];
  }>;
  performance?: { p50Ms: number; p95Ms: number; peakRssBytes: number; indexBytes: number; rebuildMs?: number };
}

export interface MemoryVectorAcceptanceRuntime {
  prepare(input: unknown): Promise<unknown>;
}

export function runMemoryVectorAcceptance(options?: {
  env?: Readonly<Record<string, string | undefined>>;
  runtime?: MemoryVectorAcceptanceRuntime;
}): Promise<{ exitCode: number; report: MemoryVectorAcceptanceReport }>;
export function measureSqliteIndexBytes(databasePath: string): Promise<number>;
