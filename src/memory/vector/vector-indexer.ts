import type { Clock } from '../../contracts/common.js';
import type { MemoryOperation, MemoryScope, MemorySelection } from '../../contracts/diagnostic-memory.js';
import type { EmbeddingProvider, MemoryExperimentCorpus, MemoryVectorDocument, MemoryVectorEntry, VectorIndex } from '../../contracts/memory-vector.js';
import { memoryScopeKey } from '../memory-scope.js';
import { embeddingSpaceKey, normalizeMemoryEmbeddingText, normalizeMemoryVector } from './embedding-space.js';
import { VectorExperimentError } from './vector-error.js';

const MAX_ROWS = 1000;
const BATCH_SIZE = 16;
const MAX_TEXT_BYTES = 2 * 1024;
const MAX_VECTOR_BYTES = 16 * 1024;

export class MemoryVectorIndexer {
  public constructor(private readonly dependencies: {
    corpus: MemoryExperimentCorpus;
    embeddings: EmbeddingProvider;
    index: VectorIndex;
    clock: Clock;
  }) {}

  public async rebuild(
    input: { scope: MemoryScope; excludeRunIds: readonly string[] },
    operation: MemoryOperation,
  ): Promise<{ indexedCount: number; spaceKey: string }> {
    assertOperation(operation, this.dependencies.clock);
    const scopeKey = safeScopeKey(input.scope);
    if (input.scope.dataClass !== 'simulated') throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    const excluded = parseExclusions(input.excludeRunIds);
    const space = this.dependencies.embeddings.space;
    const spaceKey = safeSpaceKey(space);
    const documentsResult: unknown = await this.dependencies.corpus.read(
      { scope: input.scope, excludeRunIds: [...excluded] }, operation);
    assertOperation(operation, this.dependencies.clock);
    if (!isUnknownArray(documentsResult) || documentsResult.length > MAX_ROWS) {
      throw new VectorExperimentError('VECTOR_CAPACITY_EXCEEDED');
    }

    const unique = new Map<string, { document: MemoryVectorDocument; selection: MemorySelection; text: string }>();
    for (let offset = 0; offset < documentsResult.length; offset += 1) {
      if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
      const document: unknown = documentsResult[offset];
      if (!isDocument(document)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      if (safeScopeKey(document.scope) !== scopeKey || document.kind !== 'episodic'
        || excluded.has(document.sourceRunId)) continue;
      const selection = parseSelection(document);
      const normalizedText = normalizeMemoryEmbeddingText(document.text);
      if (normalizedText.length === 0 || Buffer.byteLength(document.text, 'utf8') > MAX_TEXT_BYTES
        || Buffer.byteLength(normalizedText, 'utf8') > MAX_TEXT_BYTES) {
        throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      }
      if (unique.has(selection.memoryId)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      unique.set(selection.memoryId, { document, selection, text: normalizedText });
    }

    const eligible = [...unique.values()].sort((left, right) => compareId(left.selection.memoryId, right.selection.memoryId));
    const entries: MemoryVectorEntry[] = [];
    for (let offset = 0; offset < eligible.length; offset += BATCH_SIZE) {
      assertOperation(operation, this.dependencies.clock);
      const batch = eligible.slice(offset, offset + BATCH_SIZE);
      const vectorsResult: unknown = await this.dependencies.embeddings.embed(batch.map((item) => item.text), operation);
      assertOperation(operation, this.dependencies.clock);
      if (!isUnknownArray(vectorsResult) || vectorsResult.length !== batch.length) {
        throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      }
      const batchEntries: MemoryVectorEntry[] = batch.map((item, index) => {
        const candidate: unknown = vectorsResult[index];
        if (!(candidate instanceof Float32Array) || candidate.byteLength > MAX_VECTOR_BYTES) {
          throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        }
        return {
          ...item.selection,
          scope: input.scope,
          kind: 'episodic',
          space,
          vector: normalizeMemoryVector(candidate, space.dimensions),
        };
      });
      entries.push(...batchEntries);
    }
    for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
      assertOperation(operation, this.dependencies.clock);
      await this.dependencies.index.upsert(entries.slice(offset, offset + BATCH_SIZE), operation);
      assertOperation(operation, this.dependencies.clock);
    }
    return { indexedCount: entries.length, spaceKey };
}
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function assertOperation(operation: MemoryOperation, clock: Clock): void {
  operation.signal?.throwIfAborted();
  if (!Number.isSafeInteger(operation.deadlineMs)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  const now = clock.now().getTime();
  if (!Number.isFinite(now)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  if (now >= operation.deadlineMs) throw new DOMException('Memory vector operation deadline exceeded.', 'TimeoutError');
}

function safeScopeKey(scope: MemoryScope): string {
  try { return memoryScopeKey(scope); }
  catch { throw new VectorExperimentError('VECTOR_INPUT_INVALID'); }
}

function safeSpaceKey(space: EmbeddingProvider['space']): string {
  try { return embeddingSpaceKey(space); }
  catch { throw new VectorExperimentError('VECTOR_SPACE_MISMATCH'); }
}

function parseExclusions(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.length > MAX_ROWS) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || result.has(value)) {
      throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    }
    result.add(value);
  }
  return result;
}

function isDocument(value: unknown): value is MemoryVectorDocument {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<MemoryVectorDocument>;
  return typeof candidate.memoryId === 'string' && typeof candidate.revision === 'number'
    && typeof candidate.digest === 'string' && candidate.scope !== undefined
    && typeof candidate.kind === 'string' && typeof candidate.sourceRunId === 'string'
    && typeof candidate.text === 'string';
}

function parseSelection(value: MemorySelection): MemorySelection {
  if (typeof value.memoryId !== 'string' || value.memoryId.trim().length === 0 || value.memoryId.length > 256
    || !Number.isSafeInteger(value.revision) || value.revision <= 0
    || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  return { memoryId: value.memoryId, revision: value.revision, digest: value.digest };
}

function compareId(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
