import type { DiagnosticMemoryCase, MemorySearch } from '../contracts/diagnostic-memory.js';
import { memoryInstant, memoryLimit } from './diagnostic-memory-state.js';
import { memoryScopeKey } from './memory-scope.js';
import { MemoryError } from './memory-error.js';
import { tokenizeMemoryText } from './chinese-tokenizer.js';

/** Shared input and eligibility checks keep both adapters on the same boundary. */
export function prepareMemorySearch(input: MemorySearch) {
  const scopeKey = memoryScopeKey(input.scope);
  const now = memoryInstant(input.now);
  const limit = memoryLimit(input.limit ?? 5, 10);
  if (!Array.isArray(input.excludeRunIds) || input.excludeRunIds.length > 64
    || input.excludeRunIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256 || id.trim().length === 0)
    || Buffer.byteLength(JSON.stringify(input.excludeRunIds), 'utf8') > 16 * 1024) {
    throw new MemoryError('MEMORY_DATA_INVALID');
  }
  return { scopeKey, now, limit, excluded: new Set(input.excludeRunIds), tokens: tokenizeMemoryText(input.text) };
}

export function isRecallableMemory(value: DiagnosticMemoryCase, scopeKey: string, now: string,
  excluded: ReadonlySet<string>): boolean {
  return memoryScopeKey(value.scope) === scopeKey && value.status === 'approved'
    && value.quality === 'sufficient' && value.sourceRunStatus === 'completed'
    && Date.parse(value.validUntil) > Date.parse(now) && !excluded.has(value.sourceRunId);
}

/** unicode61 splits ASCII underscores; quoted identifiers therefore match phrases. */
export function indexedMemoryWords(tokens: string): readonly string[] {
  return tokens.split(/[\s_]+/u).filter(Boolean);
}

function phraseFrequency(document: readonly string[], phrase: readonly string[]): number {
  let frequency = 0;
  for (let i = 0; i <= document.length - phrase.length; i++) {
    if (phrase.every((token, j) => document[i + j] === token)) frequency++;
  }
  return frequency;
}

/** FTS5 BM25: k1=1.2, b=.75, negative score, IDF floor=1e-6. */
export function memoryBm25(corpus: readonly (readonly string[])[], queryTokens: readonly string[]): readonly (number | null)[] {
  if (corpus.length === 0) return [];
  const averageLength = corpus.reduce((sum, doc) => sum + doc.length, 0) / corpus.length;
  const scores = corpus.map(() => 0);
  const matches = corpus.map(() => false);
  for (const token of queryTokens) {
    const phrase = indexedMemoryWords(token);
    if (phrase.length === 0) continue;
    const frequencies = corpus.map(doc => phraseFrequency(doc, phrase));
    const matchingDocuments = frequencies.filter(f => f > 0).length;
    const idf = Math.max(1e-6, Math.log((corpus.length - matchingDocuments + 0.5) / (matchingDocuments + 0.5)));
    frequencies.forEach((frequency, i) => {
      if (frequency === 0) return;
      matches[i] = true;
      const length = corpus[i]!.length;
      scores[i] = scores[i]! - idf * (frequency * 2.2)
        / (frequency + 1.2 * (0.25 + 0.75 * length / averageLength));
    });
  }
  return scores.map((score, i) => matches[i] ? score : null);
}
