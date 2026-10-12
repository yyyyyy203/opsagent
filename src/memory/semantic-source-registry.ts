import { KnowledgeContractError, type KnowledgeProvenance, type KnowledgeSourceReference } from '../contracts/knowledge-memory.js';
import { safeKnowledgeIdentifierSchema } from '../contracts/knowledge-memory-schema.js';

type KnowledgeSourceType = KnowledgeProvenance['sourceType'];
const SOURCE_TYPES: readonly KnowledgeSourceType[] = ['target_profile', 'controlled_runbook', 'operator_provided'];

export interface SemanticSourceManifestEntry {
  readonly sourceType: KnowledgeSourceType;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceDigest: string;
  readonly dataDomainId: string;
  readonly allowedTargetIds: readonly string[];
}

export interface SemanticSourceManifestV1 {
  readonly schemaVersion: 1;
  readonly sources: readonly SemanticSourceManifestEntry[];
}

/** Host-owned source registry. It resolves identities only; it never fetches URLs or opens paths. */
export class SemanticSourceRegistry {
  private readonly sources = new Map<string, SemanticSourceManifestEntry>();

  public constructor(input: unknown) {
    const parsed = parseManifest(input);
    for (const entry of parsed.sources) {
      const key = sourceKey(entry.sourceId, entry.sourceVersion);
      if (this.sources.has(key)) throw invalidManifest();
      this.sources.set(key, entry);
    }
  }

  public resolve(input: { readonly targetId: string; readonly reference: KnowledgeSourceReference }): SemanticSourceManifestEntry {
    if (!isSafeIdentifier(input.targetId) || !isRecord(input.reference)
      || Object.keys(input.reference).some(key => !['sourceId', 'sourceVersion', 'digest'].includes(key))
      || !isSafeIdentifier(input.reference.sourceId) || !isSourceVersion(input.reference.sourceVersion)
      || !isDigest(input.reference.digest)) {
      throw new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
    }
    const entry = this.sources.get(sourceKey(input.reference.sourceId, input.reference.sourceVersion));
    if (!entry) {
      const sourceExists = [...this.sources.values()].some(source => source.sourceId === input.reference.sourceId);
      throw new KnowledgeContractError(sourceExists ? 'KNOWLEDGE_DIGEST_MISMATCH' : 'KNOWLEDGE_NOT_FOUND');
    }
    if (entry.sourceDigest !== input.reference.digest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    if (!entry.allowedTargetIds.includes(input.targetId)) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    return entry;
  }
}

function parseManifest(value: unknown): SemanticSourceManifestV1 {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'sources')
    || value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > 2_000) {
    throw invalidManifest();
  }
  const sources = value.sources.map(parseEntry);
  if (sources.some(entry => entry === undefined)) throw invalidManifest();
  return { schemaVersion: 1, sources: Object.freeze(sources as SemanticSourceManifestEntry[]) };
}

function parseEntry(value: unknown): SemanticSourceManifestEntry | undefined {
  const allowedKeys = ['sourceType', 'sourceId', 'sourceVersion', 'sourceDigest', 'dataDomainId', 'allowedTargetIds'];
  if (!isRecord(value) || Object.keys(value).some(key => !allowedKeys.includes(key))
    || !SOURCE_TYPES.includes(value.sourceType as KnowledgeSourceType)
    || !isSafeIdentifier(value.sourceId) || !isSourceVersion(value.sourceVersion)
    || !isDigest(value.sourceDigest) || !isSafeIdentifier(value.dataDomainId)
    || !Array.isArray(value.allowedTargetIds) || value.allowedTargetIds.length === 0 || value.allowedTargetIds.length > 200) {
    return undefined;
  }
  const targetIds: unknown[] = value.allowedTargetIds;
  if (targetIds.some(targetId => !isSafeIdentifier(targetId)) || new Set(targetIds).size !== targetIds.length) return undefined;
  return Object.freeze({
    sourceType: value.sourceType as KnowledgeSourceType,
    sourceId: value.sourceId,
    sourceVersion: value.sourceVersion,
    sourceDigest: value.sourceDigest,
    dataDomainId: value.dataDomainId,
    allowedTargetIds: Object.freeze([...targetIds] as string[]),
  });
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && safeKnowledgeIdentifierSchema.safeParse(value).success
    && /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value);
}

function isSourceVersion(value: unknown): value is string {
  return typeof value === 'string' && safeKnowledgeIdentifierSchema.safeParse(value).success;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceKey(sourceId: string, sourceVersion: string): string {
  return `${sourceId}\u0000${sourceVersion}`;
}

function invalidManifest(): KnowledgeContractError {
  return new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
}
