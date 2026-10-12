import { KnowledgeContractError, type KnowledgeRevision, type TargetKnowledgePublishCommand } from './knowledge-memory.js';
import { parseKnowledgeScope } from './knowledge-memory-schema.js';
import type { TargetKnowledgePolicy, TargetKnowledgeReference } from './target.js';

/** Common publication validation for persistent and test stores. */
export function normalizeKnowledgePublication(command: TargetKnowledgePublishCommand): TargetKnowledgePublishCommand {
  const scope = parseKnowledgeScope(command.scope);
  if (!command.requestId.trim() || !command.targetId.trim() || !Number.isSafeInteger(command.expectedPublicationVersion)
    || command.expectedPublicationVersion < 0 || !Number.isFinite(Date.parse(command.publishedAt))) {
    throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
  }
  if (scope.targetId !== command.targetId || command.policy.targetId !== command.targetId) {
    throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
  }
  validateKnowledgePublicationPolicy(command.policy);
  const references = command.references.map(validateKnowledgeReference);
  if (new Set(references.map((reference) => `${reference.id}\u0000${reference.version}`)).size !== references.length) {
    throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
  }
  return { ...structuredClone(command), scope, references };
}

export function validateKnowledgeReference(reference: TargetKnowledgeReference): TargetKnowledgeReference {
  if (!reference.id.trim() || reference.approval !== 'approved' || !/^[1-9]\d*$/u.test(reference.version)
    || !Number.isSafeInteger(Number(reference.version)) || !/^[a-f0-9]{64}$/u.test(reference.digest)) {
    throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  }
  return structuredClone(reference);
}

export function validateKnowledgePublicationPolicy(policy: TargetKnowledgePolicy): void {
  if (policy.schemaVersion !== 1 || !policy.policyVersion.trim() || !Number.isSafeInteger(policy.policyEpoch)
    || policy.policyEpoch < 0 || policy.defaultRequiredness !== 'optional') throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
  const keys = policy.requirements.map((item) => `${item.id}\u0000${item.version}`);
  if (new Set(keys).size !== keys.length || policy.requirements.some((item) =>
    !item.id.trim() || !/^[1-9]\d*$/u.test(item.version) || !['optional', 'required'].includes(item.requiredness)
    || (item.knowledgeClass !== undefined && !['semantic', 'procedural'].includes(item.knowledgeClass)))) {
    throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
  }
}

export function knowledgeContentText(revision: KnowledgeRevision): string {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
  };
  visit(revision.content);
  return values.join(' ');
}

/** Full tokens, never substring or prefix matching. */
export function knowledgeSearchTokens(text: string): string[] {
  return text.toLocaleLowerCase('en-US').normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [];
}
export function knowledgeQueryTokens(query: string): string[] {
  return [...new Set(knowledgeSearchTokens(query))].slice(0, 16);
}

/** FTS5 BM25 constants and IDF floor, computed only over the admissible corpus.
 * Native FTS5 global corpus statistics must not leak across scope/reference boundaries. */
export function rankKnowledgeSearch(candidates: readonly KnowledgeRevision[], query: readonly string[],
  indexedTexts: readonly string[]): KnowledgeRevision[] {
  const corpus = indexedTexts.map(knowledgeSearchTokens);
  const averageLength = corpus.reduce((sum, tokens) => sum + tokens.length, 0) / (corpus.length || 1);
  const idfs = query.map((token) => {
    const matching = corpus.filter((tokens) => tokens.includes(token)).length;
    return Math.max(1e-6, Math.log((corpus.length - matching + 0.5) / (matching + 0.5)));
  });
  const scored = candidates.map((revision) => {
    const tokens = knowledgeSearchTokens(knowledgeContentText(revision));
    const score = query.reduce((sum, token, index) => {
      const frequency = tokens.filter((candidate) => candidate === token).length;
      if (!frequency) return sum;
      return sum - idfs[index]! * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens.length / (averageLength || 1)));
    }, 0);
    return { revision, score };
  });
  scored.sort((left, right) => left.score - right.score
    || (left.revision.id < right.revision.id ? -1 : left.revision.id > right.revision.id ? 1 : 0)
    || left.revision.contentRevision - right.revision.contentRevision);
  return scored.map(({ revision }) => revision);
}
