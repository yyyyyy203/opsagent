import { KnowledgeContractError, type KnowledgeRevision, type TargetKnowledgePublishCommand } from './knowledge-memory.js';
import { parseKnowledgeScope } from './knowledge-memory-schema.js';
import type { TargetKnowledgePolicy, TargetKnowledgeReference } from './target.js';
import type { KnowledgeCommandReplayIntent, GovernedKnowledgePublicationCommand, KnowledgePublicationFencePort } from './knowledge-memory-storage.js';
import { canonicalJson } from './stable-json.js';

/** Stored in the existing receipt result_json, independently of the full audit digest. */
export function knowledgeReplayPayload(intent: KnowledgeCommandReplayIntent,
  operation = intent.operation, requestId = intent.requestId, scope = intent.scope): string {
  const parsedScope = parseKnowledgeScope(intent.scope);
  if (intent.schemaVersion !== 1 || !['draft', 'review'].includes(intent.operation)
    || !intent.requestId.trim() || !/^[a-f0-9]{64}$/u.test(intent.intentDigest)
    || Object.keys(intent).some(key => !['schemaVersion', 'requestId', 'operation', 'intentDigest', 'scope'].includes(key))) {
    throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  }
  if (intent.operation !== operation || intent.requestId !== requestId
    || canonicalJson(parsedScope) !== canonicalJson(scope)) {
    throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
  }
  return canonicalJson({ schemaVersion: 1, type: 'host_command_intent', intent: { ...intent, scope: parsedScope } });
}

export function assertKnowledgeReplayPayload(resultJson: string, intent: KnowledgeCommandReplayIntent): void {
  const expected = knowledgeReplayPayload(intent);
  let actual: unknown;
  try { actual = JSON.parse(resultJson); } catch {
    throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
  }
  // Legacy {} or unknown versions cannot prove the supplied host intent. Never guess checks.
  if (canonicalJson(actual) !== expected) throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
}

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

export function assertGovernedPublicationFence(input: GovernedKnowledgePublicationCommand,
  current: ReturnType<KnowledgePublicationFencePort['inspectPublicationFence']>): void {
  const { command, context } = input;
  if (!Number.isSafeInteger(context.registryVersion) || context.registryVersion < 1
    || context.registryVersion !== current.registryVersion
    || canonicalJson(parseKnowledgeScope(context.scope)) !== canonicalJson(command.scope)) {
    throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
  }
  if (canonicalJson(context.hostPolicy) !== canonicalJson(current.policy)
    || command.policy.policyEpoch !== (current.policy?.policyEpoch ?? 0)
    || command.policy.policyVersion !== (current.policy?.policyVersion ?? 'default/v1')) {
    throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
  }
  // Publishing references cannot lower or replace a host requirement.
  for (const requirement of current.policy?.requirements ?? []) {
    if (!command.references.some(ref => ref.id === requirement.id && ref.version === requirement.version && ref.digest === requirement.digest)
      || !command.policy.requirements.some(item => canonicalJson(item) === canonicalJson(requirement))) {
      throw new KnowledgeContractError('KNOWLEDGE_PUBLICATION_CONFLICT');
    }
  }
  if (command.references.length > 20 || input.expectedRevisions.length !== command.references.length
    || new Set(command.references.map(ref => ref.id)).size !== command.references.length) {
    throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
  }
  for (const ref of command.references) {
    const pins = input.expectedRevisions.filter(pin => canonicalJson(pin.reference) === canonicalJson(ref));
    if (pins.length !== 1 || !Number.isSafeInteger(pins[0]!.governanceVersion) || pins[0]!.governanceVersion < 1
      || !Number.isSafeInteger(pins[0]!.sourceEpoch) || pins[0]!.sourceEpoch < 0) {
      throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
    }
  }
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
