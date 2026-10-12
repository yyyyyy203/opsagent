import { systemClock, type Clock } from '../../contracts/common.js';
import { TargetConfigurationError, type TargetIdentityAuditRecord, type TargetIdentityCandidate,
  type TargetIdentityCatalogPublication, type TargetIdentityRegistry, type TargetIdentityRegistrySnapshot,
  type TargetKnowledgePolicy, type TargetKnowledgePolicyStore, type TargetKnowledgePolicyWrite,
  type TargetProfileOwnerRecord, type TargetSourceIdentity } from '../../contracts/target.js';
import { canonicalJson, checkpointChecksum } from '../../contracts/stable-json.js';
import { applyTargetIdentityCatalog, emptyTargetIdentitySnapshot, nextTargetKnowledgePolicy,
  type TargetIdentityCatalogInput } from '../../storage/target-identity-state.js';
import type { SqliteDatabase } from './database.js';

interface RegistryStateRow {
  registry_version: number;
  snapshot_json: string;
  snapshot_checksum: string;
}

interface AuditRow {
  sequence: number;
  target_id: string;
  action: TargetIdentityAuditRecord['action'];
  registry_version: number;
  identity_digest: string;
  recorded_at: string;
}

interface KnowledgePolicyRow {
  target_id: string;
  policy_epoch: number;
  policy_version: string;
  policy_json: string;
  policy_checksum: string;
  updated_at: string;
}

export interface SqliteTargetIdentityStoreOptions {
  clock?: Clock;
}

/** SQLite-backed append-only target identity history and epoch-CAS knowledge policies. */
export class SqliteTargetIdentityStore implements TargetIdentityRegistry, TargetKnowledgePolicyStore {
  private readonly clock: Clock;

  public constructor(private readonly database: SqliteDatabase, options: SqliteTargetIdentityStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  public readSnapshot(): Promise<TargetIdentityRegistrySnapshot> {
    return Promise.resolve().then(() => {
      const row = this.database.raw.prepare(`
        SELECT registry_version, snapshot_json, snapshot_checksum
        FROM target_identity_registry_state WHERE singleton_id = 1
      `).get() as RegistryStateRow | undefined;
      return row === undefined ? emptyTargetIdentitySnapshot() : parseRegistryState(row);
    });
  }

  /** Reads both authoritative rows synchronously on the caller's same-database transaction. */
  public inspectPublicationFence(targetId: string) {
    return inspectSqlitePublicationFence(this.database, targetId);
  }

  public publishCatalog(input: TargetIdentityCatalogInput): Promise<TargetIdentityCatalogPublication> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const row = this.database.raw.prepare(`
        SELECT registry_version, snapshot_json, snapshot_checksum
        FROM target_identity_registry_state WHERE singleton_id = 1
      `).get() as RegistryStateRow | undefined;
      const current = row === undefined ? emptyTargetIdentitySnapshot() : parseRegistryState(row);
      const result = applyTargetIdentityCatalog(current, sanitizeCatalogInput(input));
      const snapshotJson = canonicalJson(result.snapshot);
      const snapshotChecksum = checkpointChecksum(result.snapshot);

      if (row === undefined) {
        const inserted = this.database.raw.prepare(`
          INSERT INTO target_identity_registry_state(singleton_id, registry_version, snapshot_json, snapshot_checksum)
          VALUES (1, ?, ?, ?)
        `).run(result.snapshot.version, snapshotJson, snapshotChecksum);
        if (inserted.changes !== 1) throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
      } else {
        const updated = this.database.raw.prepare(`
          UPDATE target_identity_registry_state
          SET registry_version = ?, snapshot_json = ?, snapshot_checksum = ?
          WHERE singleton_id = 1 AND registry_version = ?
        `).run(result.snapshot.version, snapshotJson, snapshotChecksum, current.version);
        if (updated.changes !== 1) throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
      }

      if (result.audit.length > 0) {
        const recordedAt = timestamp(this.clock);
        const insertAudit = this.database.raw.prepare(`
          INSERT INTO target_identity_audit(target_id, action, registry_version, identity_digest, recorded_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const record of result.audit) {
          insertAudit.run(record.targetId, record.action, record.registryVersion, record.identityDigest, recordedAt);
        }
      }
      return structuredClone(result.publication);
    }).immediate());
  }

  public listAudit(targetId?: string): Promise<readonly TargetIdentityAuditRecord[]> {
    const rows = targetId === undefined
      ? this.database.raw.prepare(`
        SELECT sequence, target_id, action, registry_version, identity_digest, recorded_at
        FROM target_identity_audit ORDER BY sequence
      `).all() as AuditRow[]
      : this.database.raw.prepare(`
        SELECT sequence, target_id, action, registry_version, identity_digest, recorded_at
        FROM target_identity_audit WHERE target_id = ? ORDER BY sequence
      `).all(targetId) as AuditRow[];
    return Promise.resolve(rows.map(parseAuditRow));
  }

  public get(targetId: string): Promise<TargetKnowledgePolicy | null> {
    const row = this.database.raw.prepare(`
      SELECT target_id, policy_epoch, policy_version, policy_json, policy_checksum, updated_at
      FROM target_knowledge_policies WHERE target_id = ?
    `).get(targetId) as KnowledgePolicyRow | undefined;
    return Promise.resolve(row === undefined ? null : parseKnowledgePolicyRow(row));
  }

  public compareAndSet(input: TargetKnowledgePolicyWrite): Promise<TargetKnowledgePolicy> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = sanitizePolicyWrite(input);
      const row = this.database.raw.prepare(`
        SELECT target_id, policy_epoch, policy_version, policy_json, policy_checksum, updated_at
        FROM target_knowledge_policies WHERE target_id = ?
      `).get(normalized.targetId) as KnowledgePolicyRow | undefined;
      const current = row === undefined ? null : parseKnowledgePolicyRow(row);
      const next = nextTargetKnowledgePolicy(current, normalized);
      const policyJson = canonicalJson(next);
      const policyChecksum = checkpointChecksum(next);
      const updatedAt = timestamp(this.clock);

      if (row === undefined) {
        const inserted = this.database.raw.prepare(`
          INSERT INTO target_knowledge_policies(target_id, policy_epoch, policy_version, policy_json, policy_checksum, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(next.targetId, next.policyEpoch, next.policyVersion, policyJson, policyChecksum, updatedAt);
        if (inserted.changes !== 1) throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
      } else {
        const updated = this.database.raw.prepare(`
          UPDATE target_knowledge_policies
          SET policy_epoch = ?, policy_version = ?, policy_json = ?, policy_checksum = ?, updated_at = ?
          WHERE target_id = ? AND policy_epoch = ?
        `).run(next.policyEpoch, next.policyVersion, policyJson, policyChecksum, updatedAt,
          next.targetId, current?.policyEpoch);
        if (updated.changes !== 1) throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
      }
      return structuredClone(next);
    }).immediate());
  }
}

export function inspectSqlitePublicationFence(database: SqliteDatabase, targetId: string) {
  const registry = database.raw.prepare(`SELECT registry_version, snapshot_json, snapshot_checksum
    FROM target_identity_registry_state WHERE singleton_id = 1`).get() as RegistryStateRow | undefined;
  const policy = database.raw.prepare(`SELECT target_id, policy_epoch, policy_version, policy_json, policy_checksum, updated_at
    FROM target_knowledge_policies WHERE target_id = ?`).get(targetId) as KnowledgePolicyRow | undefined;
  return { registryVersion: registry === undefined ? 0 : parseRegistryState(registry).version,
    policy: policy === undefined ? null : parseKnowledgePolicyRow(policy) };
}

function sanitizeCatalogInput(input: TargetIdentityCatalogInput): TargetIdentityCatalogInput {
  return {
    expectedVersion: input.expectedVersion,
    presentTargetIds: [...input.presentTargetIds],
    publishedAt: input.publishedAt,
    candidates: input.candidates.map((candidate): TargetIdentityCandidate => ({
      targetId: candidate.targetId,
      projectId: candidate.projectId,
      deploymentId: candidate.deploymentId,
      deploymentGeneration: candidate.deploymentGeneration,
      scenarioId: candidate.scenarioId,
      primaryServiceId: candidate.primaryServiceId,
      profileId: candidate.profileId,
      targetFingerprint: candidate.targetFingerprint,
      dataClass: candidate.dataClass,
      ...(candidate.datasetId === undefined ? {} : { datasetId: candidate.datasetId }),
      sourceIdentities: candidate.sourceIdentities.map((identity): TargetSourceIdentity => ({
        sourceId: identity.sourceId,
        dataDomainId: identity.dataDomainId,
        sourceGeneration: identity.sourceGeneration,
        permissionScopeDigest: identity.permissionScopeDigest,
      })),
    })),
  };
}

function sanitizePolicyWrite(input: TargetKnowledgePolicyWrite): TargetKnowledgePolicyWrite {
  return {
    targetId: input.targetId,
    policyVersion: input.policyVersion,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    publishedAt: input.publishedAt,
    requirements: input.requirements.map(requirement => ({
      id: requirement.id,
      version: requirement.version,
      digest: requirement.digest,
      requiredness: requirement.requiredness,
      ...(requirement.knowledgeClass === undefined ? {} : { knowledgeClass: requirement.knowledgeClass }),
    })),
  };
}

function parseRegistryState(row: RegistryStateRow): TargetIdentityRegistrySnapshot {
  try {
    const value: unknown = JSON.parse(row.snapshot_json);
    if (!isIdentitySnapshot(value) || value.version !== row.registry_version
      || canonicalJson(value) !== row.snapshot_json || checkpointChecksum(value) !== row.snapshot_checksum) {
      throw new Error('registry snapshot validation failed');
    }
    return structuredClone(value);
  } catch {
    throw new Error('Stored target identity registry state is corrupt');
  }
}

function parseAuditRow(row: AuditRow): TargetIdentityAuditRecord {
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !isSafeId(row.target_id)
    || !['registered', 'updated', 'tombstoned'].includes(row.action)
    || !Number.isSafeInteger(row.registry_version) || row.registry_version < 1
    || !isDigest(row.identity_digest) || !isTimestamp(row.recorded_at)) {
    throw new Error('Stored target identity audit record is corrupt');
  }
  return {
    sequence: row.sequence,
    targetId: row.target_id,
    action: row.action,
    registryVersion: row.registry_version,
    identityDigest: row.identity_digest,
    recordedAt: row.recorded_at,
  };
}

function parseKnowledgePolicyRow(row: KnowledgePolicyRow): TargetKnowledgePolicy {
  try {
    const value: unknown = JSON.parse(row.policy_json);
    if (!isKnowledgePolicy(value) || value.targetId !== row.target_id || value.policyEpoch !== row.policy_epoch
      || value.policyVersion !== row.policy_version || canonicalJson(value) !== row.policy_json
      || checkpointChecksum(value) !== row.policy_checksum || !isTimestamp(row.updated_at)) {
      throw new Error('knowledge policy validation failed');
    }
    return structuredClone(value);
  } catch {
    throw new Error(`Stored target knowledge policy is corrupt: ${row.target_id}`);
  }
}

function isIdentitySnapshot(value: unknown): value is TargetIdentityRegistrySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'targets', 'fingerprints', 'sources', 'profileOwners'])
    || !Number.isSafeInteger(value.version) || (value.version as number) < 0
    || !Array.isArray(value.targets) || !Array.isArray(value.fingerprints)
    || !Array.isArray(value.sources) || !Array.isArray(value.profileOwners)) return false;
  return value.targets.every(isTargetIdentity)
    && value.fingerprints.every(isFingerprintIdentity)
    && value.sources.every(isSourceIdentity)
    && value.profileOwners.every(isProfileOwner);
}

function isTargetIdentity(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['targetId', 'projectId', 'deploymentId', 'deploymentGeneration',
    'scenarioId', 'primaryServiceId', 'profileId', 'status'], ['tombstonedAt'])
    || !isSafeId(value.targetId) || !isSafeId(value.projectId) || !isSafeId(value.deploymentId)
    || !isPositiveInteger(value.deploymentGeneration) || !isSafeId(value.scenarioId)
    || !isSafeId(value.primaryServiceId) || !isSafeId(value.profileId)) return false;
  if (value.status === 'active') return value.tombstonedAt === undefined;
  return value.status === 'tombstoned' && isTimestamp(value.tombstonedAt);
}

function isFingerprintIdentity(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['targetFingerprint', 'projectId', 'deploymentId',
    'deploymentGeneration', 'dataClass', 'sourceIdentities'], ['datasetId'])
    && isSafeId(value.targetFingerprint) && isSafeId(value.projectId) && isSafeId(value.deploymentId)
    && isPositiveInteger(value.deploymentGeneration)
    && (value.dataClass === 'live' ? value.datasetId === undefined
      : value.dataClass === 'simulated' && isSafeId(value.datasetId))
    && Array.isArray(value.sourceIdentities) && value.sourceIdentities.every(isSourceIdentity);
}

function isSourceIdentity(value: unknown): value is TargetSourceIdentity {
  return isRecord(value) && hasExactKeys(value, ['sourceId', 'dataDomainId', 'sourceGeneration', 'permissionScopeDigest'])
    && isSafeId(value.sourceId) && isSafeId(value.dataDomainId) && isPositiveInteger(value.sourceGeneration)
    && isDigest(value.permissionScopeDigest);
}

function isProfileOwner(value: unknown): value is TargetProfileOwnerRecord {
  return isRecord(value) && hasExactKeys(value, ['profileId', 'targetId'])
    && isSafeId(value.profileId) && isSafeId(value.targetId);
}

function isKnowledgePolicy(value: unknown): value is TargetKnowledgePolicy {
  return isRecord(value) && hasExactKeys(value, ['schemaVersion', 'targetId', 'policyVersion',
    'policyEpoch', 'defaultRequiredness', 'requirements'])
    && value.schemaVersion === 1 && isSafeId(value.targetId) && isSafeRevision(value.policyVersion)
    && Number.isSafeInteger(value.policyEpoch) && (value.policyEpoch as number) >= 1
    && value.defaultRequiredness === 'optional' && Array.isArray(value.requirements)
    && value.requirements.length <= 20 && value.requirements.every(isKnowledgeRequirement);
}

function isKnowledgeRequirement(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'version', 'digest', 'requiredness'], ['knowledgeClass'])
    && isSafeId(value.id) && isSafeRevision(value.version) && isDigest(value.digest)
    && (value.requiredness === 'optional' || value.requiredness === 'required')
    && (value.knowledgeClass === undefined || value.knowledgeClass === 'semantic' || value.knowledgeClass === 'procedural');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value);
}

function isSafeRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(value) && !value.includes('://');
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function timestamp(clock: Clock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  return value.toISOString();
}
