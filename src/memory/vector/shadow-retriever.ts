import type { Clock } from '../../contracts/common.js';
import type {
  DiagnosticMemoryCase, MemoryEvidenceValidator, MemoryOperation, MemoryQueryStore, MemoryScope, MemorySelection,
} from '../../contracts/diagnostic-memory.js';
import { parseDiagnosticMemoryCase } from '../../contracts/diagnostic-memory-schema.js';
import type {
  EmbeddingProvider, MemoryExperimentCorpus, MemoryVectorDocument, MemoryVectorHit,
  ShadowRetrievalResult, VectorExperimentErrorCode, VectorIndex,
} from '../../contracts/memory-vector.js';
import { memoryScopeKey } from '../memory-scope.js';
import { MemoryError } from '../memory-error.js';
import { embeddingSpaceKey, normalizeMemoryEmbeddingText, normalizeMemoryVector } from './embedding-space.js';
import { reciprocalRankFusion } from './rrf.js';
import { VectorExperimentError } from './vector-error.js';

const MAX_ROWS = 1000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_TEXT_BYTES = 2 * 1024;

type RetrievalInput = {
  mode: 'bm25' | 'vector' | 'hybrid';
  scope: MemoryScope;
  text: string;
  excludeRunIds: readonly string[];
  limit: number;
};

export class ShadowMemoryRetriever {
  public constructor(private readonly dependencies: {
    queries: MemoryQueryStore;
    corpus: MemoryExperimentCorpus;
    evidence: MemoryEvidenceValidator;
    embeddings: EmbeddingProvider;
    index: VectorIndex;
    clock: Clock;
  }) {}

  public async retrieve(input: RetrievalInput, operation: MemoryOperation): Promise<ShadowRetrievalResult> {
    assertOperation(operation, this.dependencies.clock);
    const parsed = parseRequest(input);
    if (parsed.mode === 'bm25') {
      const hits = await this.searchBm25(parsed, operation);
      return { requestedMode: parsed.mode, usedMode: 'bm25', hits };
    }

    let vectorHits: readonly MemoryVectorHit[];
    try {
      const eligible = await this.readEligibleCorpus(parsed, operation);
      vectorHits = await this.searchVector(parsed, eligible, operation);
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (isAbort(error)) throw error;
      const fallbackReason = fallbackCode(error);
      if (isDeadlineExpired(operation, this.dependencies.clock)) {
        return { requestedMode: parsed.mode, usedMode: parsed.mode, hits: [], fallbackReason };
      }
      const hits = await this.searchBm25(parsed, operation);
      return { requestedMode: parsed.mode, usedMode: 'bm25', hits, fallbackReason };
    }

    if (parsed.mode === 'vector') {
      return { requestedMode: parsed.mode, usedMode: 'vector', hits: await this.revalidate(vectorHits, parsed, operation) };
    }

    let lexical: readonly MemorySelection[];
    try {
      lexical = await this.searchBm25(parsed, operation);
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (isAbort(error)) throw error;
      throw error;
    }
    const ranked = orderSelectionsByIdentity(lexical, vectorHits);
    const fused = reciprocalRankFusion(ranked, parsed.limit);
    return { requestedMode: 'hybrid', usedMode: 'hybrid', hits: await this.revalidate(fused, parsed, operation) };
  }

  private async readEligibleCorpus(input: ParsedRequest, operation: MemoryOperation): Promise<readonly EligibleDocument[]> {
    const documentResult: unknown = await this.dependencies.corpus.read(
      { scope: input.scope, excludeRunIds: [...input.excluded] }, operation);
    assertOperation(operation, this.dependencies.clock);
    if (!isUnknownArray(documentResult) || documentResult.length > MAX_ROWS) {
      throw new VectorExperimentError('VECTOR_CAPACITY_EXCEEDED');
    }

    const eligible: EligibleDocument[] = [];
    const ids = new Set<string>();
    for (let offset = 0; offset < documentResult.length; offset += 1) {
      if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
      const document: unknown = documentResult[offset];
      if (!isDocument(document)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      if (document.kind !== 'episodic' || input.excluded.has(document.sourceRunId)
        || safeScopeKey(document.scope) !== input.scopeKey) continue;
      const selection = parseSelection(document);
      if (ids.has(selection.memoryId)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      ids.add(selection.memoryId);
      const text = normalizeMemoryEmbeddingText(document.text);
      if (text.length === 0 || Buffer.byteLength(document.text, 'utf8') > MAX_TEXT_BYTES
        || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new VectorExperimentError('VECTOR_INPUT_INVALID');

      const current = await this.dependencies.queries.get(selection.memoryId, input.scope);
      assertOperation(operation, this.dependencies.clock);
      if (current === null || !matchesDocument(document, current)
        || !isEligibleCase(current, input.scopeKey, input.excluded, this.currentNow())) continue;
      if (!await this.validateEvidence(current, input.scope, operation)) continue;
      eligible.push({ selection, text });
    }
    assertOperation(operation, this.dependencies.clock);
    return eligible.sort((left, right) => compareId(left.selection.memoryId, right.selection.memoryId));
  }

  private async searchVector(
    input: ParsedRequest,
    eligible: readonly EligibleDocument[],
    operation: MemoryOperation,
  ): Promise<readonly MemoryVectorHit[]> {
    if (eligible.length === 0) return [];
    assertOperation(operation, this.dependencies.clock);
    let expectedSpaceKey: string;
    try { expectedSpaceKey = embeddingSpaceKey(this.dependencies.embeddings.space); }
    catch { throw new VectorExperimentError('VECTOR_SPACE_MISMATCH'); }
    void expectedSpaceKey;

    const vectors = await this.dependencies.embeddings.embed([input.text], operation);
    assertOperation(operation, this.dependencies.clock);
    if (!Array.isArray(vectors) || vectors.length !== 1 || !(vectors[0] instanceof Float32Array)) {
      throw new VectorExperimentError('VECTOR_EMBEDDING_MISSING');
    }
    const queryVector = normalizeMemoryVector(vectors[0], this.dependencies.embeddings.space.dimensions);
    if (queryVector.byteLength > 16 * 1024) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    const eligibleSelections = eligible.map(({ selection }) => selection);
    const candidatesResult: unknown = await this.dependencies.index.search({
      scope: input.scope,
      space: this.dependencies.embeddings.space,
      vector: queryVector,
      eligible: eligibleSelections,
      limit: input.limit,
    }, operation);
    assertOperation(operation, this.dependencies.clock);
    if (!isUnknownArray(candidatesResult) || candidatesResult.length > MAX_ROWS) {
      throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
    }

    const byId = new Map(eligible.map(({ selection }) => [selection.memoryId, selection]));
    const seen = new Set<string>();
    const normalized: MemoryVectorHit[] = [];
    for (let offset = 0; offset < candidatesResult.length; offset += 1) {
      if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
      const candidate: unknown = candidatesResult[offset];
      const hit = candidate;
      if (!isHit(hit)) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      const selected = byId.get(hit.memoryId);
      if (selected === undefined || selected.revision !== hit.revision || selected.digest !== hit.digest) continue;
      const key = selectionKey(hit);
      if (seen.has(key)) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      seen.add(key);
      normalized.push({ memoryId: hit.memoryId, revision: hit.revision, digest: hit.digest, score: hit.score });
    }
    return normalized.sort((left, right) => right.score - left.score || compareId(left.memoryId, right.memoryId))
      .slice(0, input.limit);
  }

  private async searchBm25(input: ParsedRequest, operation: MemoryOperation): Promise<readonly MemorySelection[]> {
    try {
      assertOperation(operation, this.dependencies.clock);
      const searchedResult: unknown = await this.dependencies.queries.search({ scope: input.scope, text: input.text,
        excludeRunIds: [...input.excluded], limit: input.limit, now: this.currentNow() });
      assertOperation(operation, this.dependencies.clock);
      if (!isUnknownArray(searchedResult) || searchedResult.length > MAX_ROWS) {
        throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      }

      const selections: MemorySelection[] = [];
      for (let offset = 0; offset < searchedResult.length; offset += 1) {
        if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
        let candidate: DiagnosticMemoryCase;
        try {
          candidate = parseDiagnosticMemoryCase(searchedResult[offset]);
        } catch {
          throw new MemoryError('MEMORY_LOOKUP_FAILED');
        }
        if (!isEligibleCase(candidate, input.scopeKey, input.excluded, this.currentNow())) continue;
        selections.push({ memoryId: candidate.id, revision: candidate.revision, digest: candidate.digest });
      }
      return await this.revalidate(selections, input, operation);
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (isAbort(error) || isTimeout(error) || error instanceof MemoryError) throw error;
      throw new MemoryError('MEMORY_LOOKUP_FAILED');
    }
  }

  private async revalidate(
    selections: readonly MemorySelection[],
    input: ParsedRequest,
    operation: MemoryOperation,
  ): Promise<readonly MemorySelection[]> {
    assertOperation(operation, this.dependencies.clock);
    const unique = uniqueSelections(selections);
    let currentCases: unknown;
    try {
      currentCases = await this.dependencies.queries.revalidate({ scope: input.scope,
        selections: unique, now: this.currentNow() });
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (isAbort(error) || isTimeout(error)) throw error;
      throw new MemoryError('MEMORY_LOOKUP_FAILED');
    }
    assertOperation(operation, this.dependencies.clock);
    if (!isUnknownArray(currentCases) || currentCases.length > MAX_ROWS) {
      throw new MemoryError('MEMORY_LOOKUP_FAILED');
    }
    const byId = new Map<string, DiagnosticMemoryCase>();
    for (let offset = 0; offset < currentCases.length; offset += 1) {
      if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
      let current: DiagnosticMemoryCase;
      try {
        current = parseDiagnosticMemoryCase(currentCases[offset]);
      } catch {
        throw new MemoryError('MEMORY_LOOKUP_FAILED');
      }
      if (isEligibleCase(current, input.scopeKey, input.excluded, this.currentNow())) {
        byId.set(current.id, current);
      }
    }

    const result: MemorySelection[] = [];
    for (let offset = 0; offset < unique.length; offset += 1) {
      if (offset % 64 === 0) assertOperation(operation, this.dependencies.clock);
      const selection = unique[offset];
      if (selection === undefined) continue;
      const current = byId.get(selection.memoryId);
      if (current === undefined || current.revision !== selection.revision || current.digest !== selection.digest) continue;
      if (await this.validateEvidence(current, input.scope, operation)) result.push(selection);
    }
    return result.slice(0, input.limit);
  }

  private async validateEvidence(current: DiagnosticMemoryCase, scope: MemoryScope, operation: MemoryOperation): Promise<boolean> {
    assertOperation(operation, this.dependencies.clock);
    try {
      const valid = await this.dependencies.evidence.validate({ sourceRunId: current.sourceRunId,
        refs: current.evidenceRefs, scope }, operation);
      assertOperation(operation, this.dependencies.clock);
      return valid;
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (isAbort(error)) throw error;
      throw error;
    }
  }

  private currentNow(): string {
    const value = this.dependencies.clock.now();
    if (!Number.isFinite(value.getTime())) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    return value.toISOString();
  }
}

interface ParsedRequest extends RetrievalInput {
  text: string;
  limit: number;
  scopeKey: string;
  excluded: Set<string>;
}
interface EligibleDocument { selection: MemorySelection; text: string }

function parseRequest(input: RetrievalInput): ParsedRequest {
  if (input === null || typeof input !== 'object' || !['bm25', 'vector', 'hybrid'].includes(input.mode)) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
  const text = normalizeMemoryEmbeddingText(input.text);
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  const scopeKey = safeScopeKey(input.scope);
  if (input.scope.dataClass !== 'simulated') throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  if (!Array.isArray(input.excludeRunIds) || input.excludeRunIds.length > 64) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
  const excluded = new Set<string>();
  for (const id of input.excludeRunIds) {
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 256 || excluded.has(id)) {
      throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    }
    excluded.add(id);
  }
  return { ...input, text, limit, scopeKey, excluded };
}

function assertOperation(operation: MemoryOperation, clock: Clock): void {
  operation.signal?.throwIfAborted();
  if (!Number.isSafeInteger(operation.deadlineMs)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  const now = clock.now().getTime();
  if (!Number.isFinite(now)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  if (now >= operation.deadlineMs) throw new DOMException('Memory vector operation deadline exceeded.', 'TimeoutError');
}

function isDeadlineExpired(operation: MemoryOperation, clock: Clock): boolean {
  return !Number.isFinite(operation.deadlineMs) || clock.now().getTime() >= operation.deadlineMs;
}

function safeScopeKey(scope: MemoryScope): string {
  try { return memoryScopeKey(scope); }
  catch { throw new VectorExperimentError('VECTOR_INPUT_INVALID'); }
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
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

function isEligibleCase(
  value: DiagnosticMemoryCase,
  scopeKey: string,
  excluded: ReadonlySet<string>,
  now: string,
): boolean {
  return value !== null && typeof value === 'object' && value.scope.dataClass === 'simulated'
    && safeScopeKey(value.scope) === scopeKey && !excluded.has(value.sourceRunId)
    && value.status === 'approved' && value.quality === 'sufficient' && value.sourceRunStatus === 'completed'
    && Date.parse(value.validUntil) > Date.parse(now);
}

function matchesDocument(document: MemoryVectorDocument, current: DiagnosticMemoryCase): boolean {
  return document.memoryId === current.id && document.revision === current.revision
    && document.digest === current.digest && document.sourceRunId === current.sourceRunId;
}

function isHit(value: unknown): value is MemoryVectorHit {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<MemoryVectorHit>;
  return typeof candidate.memoryId === 'string' && candidate.memoryId.trim().length > 0 && candidate.memoryId.length <= 256
    && Number.isSafeInteger(candidate.revision) && candidate.revision! > 0
    && typeof candidate.digest === 'string' && /^[a-f0-9]{64}$/u.test(candidate.digest)
    && typeof candidate.score === 'number' && Number.isFinite(candidate.score);
}

function fallbackCode(error: unknown): VectorExperimentErrorCode {
  return error instanceof VectorExperimentError ? error.code : 'VECTOR_INDEX_UNAVAILABLE';
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function uniqueSelections(selections: readonly MemorySelection[]): MemorySelection[] {
  const result = new Map<string, MemorySelection>();
  for (const selection of selections) {
    result.set(selectionKey(selection), { memoryId: selection.memoryId, revision: selection.revision, digest: selection.digest });
  }
  return [...result.values()];
}

function orderSelectionsByIdentity(
  lexical: readonly MemorySelection[],
  vector: readonly MemoryVectorHit[],
): readonly (readonly MemoryVectorHit[])[] {
  return [lexical.map((selection, index) => ({ ...selection, score: -index })), vector];
}

function selectionKey(value: MemorySelection): string {
  return JSON.stringify([value.memoryId, value.revision, value.digest]);
}

function compareId(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
