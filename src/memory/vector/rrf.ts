import type { MemorySelection } from '../../contracts/diagnostic-memory.js';
import type { MemoryVectorHit } from '../../contracts/memory-vector.js';
import { VectorExperimentError } from './vector-error.js';

const RRF_K = 60;
const MAX_LIMIT = 10;

/** Reciprocal-rank fusion over already ranked lists; scores do not affect rank. */
export function reciprocalRankFusion(
  lists: readonly (readonly MemoryVectorHit[])[],
  limit: number,
): readonly MemorySelection[] {
  const rawLists: unknown = lists;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !isUnknownArray(rawLists)) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }

  const totals = new Map<string, { selection: MemorySelection; score: number }>();
  const identitiesById = new Map<string, string>();
  for (const rawList of rawLists) {
    if (!isUnknownArray(rawList)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    const seenInList = new Set<string>();
    for (let index = 0; index < rawList.length; index += 1) {
      const candidate: unknown = rawList[index];
      if (!isMemoryVectorHit(candidate)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      const hit = candidate;
      const key = selectionKey(hit);
      if (seenInList.has(key)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      seenInList.add(key);

      const previousIdentity = identitiesById.get(hit.memoryId);
      if (previousIdentity !== undefined && previousIdentity !== key) {
        throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      }
      identitiesById.set(hit.memoryId, key);

      const contribution = 1 / (RRF_K + index + 1);
      const accumulated = totals.get(key);
      if (accumulated === undefined) {
        totals.set(key, { selection: { memoryId: hit.memoryId, revision: hit.revision, digest: hit.digest }, score: contribution });
      } else {
        accumulated.score += contribution;
      }
    }
  }

  return [...totals.values()]
    .sort((left, right) => right.score - left.score
      || Buffer.compare(Buffer.from(left.selection.memoryId), Buffer.from(right.selection.memoryId)))
    .slice(0, limit)
    .map(({ selection }) => selection);
}

function isMemoryVectorHit(value: unknown): value is MemoryVectorHit {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.memoryId === 'string' && candidate.memoryId.trim().length > 0
    && candidate.memoryId.length <= 256 && typeof candidate.revision === 'number'
    && Number.isSafeInteger(candidate.revision) && candidate.revision > 0
    && typeof candidate.digest === 'string' && /^[a-f0-9]{64}$/u.test(candidate.digest)
    && typeof candidate.score === 'number' && Number.isFinite(candidate.score);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function selectionKey(value: MemorySelection): string {
  return JSON.stringify([value.memoryId, value.revision, value.digest]);
}
