import { checkpointChecksum, type TargetIdentityAuditRecord, type TargetIdentityCandidate,
  type TargetIdentityCatalogPublication, type TargetIdentityRegistrySnapshot,
  type TargetKnowledgePolicy, type TargetKnowledgePolicyWrite } from '../contracts/index.js';
import { TargetConfigurationError } from '../contracts/target.js';

export interface TargetIdentityCatalogInput {
  expectedVersion: number;
  presentTargetIds: readonly string[];
  candidates: readonly TargetIdentityCandidate[];
  publishedAt: string;
}

export interface TargetIdentityCatalogApplyResult {
  snapshot: TargetIdentityRegistrySnapshot;
  publication: TargetIdentityCatalogPublication;
  audit: readonly Omit<TargetIdentityAuditRecord, 'sequence'>[];
}

export function emptyTargetIdentitySnapshot(): TargetIdentityRegistrySnapshot {
  return { version: 0, targets: [], fingerprints: [], sources: [], profileOwners: [] };
}

/** Pure deterministic registry transition shared by SQLite and in-memory stores. */
export function applyTargetIdentityCatalog(
  current: TargetIdentityRegistrySnapshot,
  input: TargetIdentityCatalogInput,
): TargetIdentityCatalogApplyResult {
  if (input.expectedVersion !== current.version) throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
  const publishedAt = parseTimestamp(input.publishedAt);
  const targets = new Map(current.targets.map(record => [record.targetId, structuredClone(record)]));
  const fingerprints = new Map(current.fingerprints.map(record => [record.targetFingerprint, structuredClone(record)]));
  const sources = new Map(current.sources.map(record => [sourceKey(record), structuredClone(record)]));
  const profileOwners = new Map(current.profileOwners.map(record => [record.profileId, record.targetId]));
  const presentTargetIds = new Set(input.presentTargetIds);
  const fingerprintVariants = groupVariants(input.candidates, candidate => fingerprintIdentity(candidate));
  const conflictingFingerprints = new Set([...fingerprintVariants]
    .filter(([, values]) => values.size > 1).map(([key]) => key));
  const sourceVariants = groupVariants(input.candidates.flatMap(candidate => candidate.sourceIdentities), identity => sourceIdentity(identity));
  const conflictingSourceKeys = new Set([...sourceVariants]
    .filter(([, values]) => values.size > 1).map(([key]) => key));
  const maxCandidateGeneration = new Map<string, number>();
  for (const candidate of input.candidates) {
    for (const identity of candidate.sourceIdentities) {
      maxCandidateGeneration.set(identity.sourceId, Math.max(maxCandidateGeneration.get(identity.sourceId) ?? 0, identity.sourceGeneration));
    }
  }

  const nextVersion = current.version + 1;
  const acceptedTargetIds: string[] = [];
  const rejected: TargetIdentityCatalogPublication['rejected'][number][] = [];
  const audit: Omit<TargetIdentityAuditRecord, 'sequence'>[] = [];
  const candidates = [...input.candidates].sort((left, right) => left.targetId.localeCompare(right.targetId));

  for (const candidate of candidates) {
    if (!isValidCandidate(candidate) || conflictingFingerprints.has(candidate.targetFingerprint)
      || candidate.sourceIdentities.some(identity => conflictingSourceKeys.has(sourceKey(identity))
        || identity.sourceGeneration < (maxCandidateGeneration.get(identity.sourceId) ?? identity.sourceGeneration))) {
      rejected.push({ targetId: candidate.targetId, reasonCode: 'TARGET_IDENTITY_CONFLICT' });
      continue;
    }
    const priorTarget = targets.get(candidate.targetId);
    if (priorTarget?.status === 'tombstoned'
      || (priorTarget !== undefined && (priorTarget.projectId !== candidate.projectId
        || priorTarget.deploymentId !== candidate.deploymentId
        || priorTarget.scenarioId !== candidate.scenarioId
        || priorTarget.primaryServiceId !== candidate.primaryServiceId
        || candidate.deploymentGeneration < priorTarget.deploymentGeneration))) {
      rejected.push({ targetId: candidate.targetId, reasonCode: 'TARGET_IDENTITY_CONFLICT' });
      continue;
    }
    const profileOwner = profileOwners.get(candidate.profileId);
    if (profileOwner !== undefined && profileOwner !== candidate.targetId) {
      rejected.push({ targetId: candidate.targetId, reasonCode: 'TARGET_IDENTITY_CONFLICT' });
      continue;
    }
    if (candidate.sourceIdentities.some(identity => {
      const maxStored = maxSourceGeneration(sources, identity.sourceId);
      const prior = sources.get(sourceKey(identity));
      return identity.sourceGeneration < maxStored
        || (prior !== undefined && !sameIdentity(prior, identity));
    })) {
      rejected.push({ targetId: candidate.targetId, reasonCode: 'TARGET_IDENTITY_CONFLICT' });
      continue;
    }

    const fingerprint = fingerprintIdentity(candidate);
    const priorFingerprint = fingerprints.get(candidate.targetFingerprint);
    if (priorFingerprint !== undefined && !sameIdentity(priorFingerprint, fingerprint)) {
      rejected.push({ targetId: candidate.targetId, reasonCode: 'TARGET_IDENTITY_CONFLICT' });
      continue;
    }

    const nextTarget = {
      targetId: candidate.targetId,
      projectId: candidate.projectId,
      deploymentId: candidate.deploymentId,
      deploymentGeneration: candidate.deploymentGeneration,
      scenarioId: candidate.scenarioId,
      primaryServiceId: candidate.primaryServiceId,
      profileId: candidate.profileId,
      status: 'active' as const,
    };
    const isNewFingerprint = priorFingerprint === undefined;
    if (priorTarget === undefined || !sameIdentity(priorTarget, nextTarget) || isNewFingerprint) {
      targets.set(candidate.targetId, nextTarget);
      audit.push(auditEntry(candidate.targetId, priorTarget === undefined ? 'registered' : 'updated', nextVersion,
        checkpointChecksum({ target: nextTarget, fingerprint }), publishedAt));
    }
    if (profileOwner === undefined) profileOwners.set(candidate.profileId, candidate.targetId);
    if (priorFingerprint === undefined) fingerprints.set(candidate.targetFingerprint, fingerprint);
    for (const identity of candidate.sourceIdentities) sources.set(sourceKey(identity), structuredClone(identity));
    acceptedTargetIds.push(candidate.targetId);
  }

  for (const [targetId, prior] of targets) {
    if (prior.status === 'active' && !presentTargetIds.has(targetId)) {
      const tombstone = { ...prior, status: 'tombstoned' as const, tombstonedAt: publishedAt };
      targets.set(targetId, tombstone);
      audit.push(auditEntry(targetId, 'tombstoned', nextVersion, checkpointChecksum(tombstone), publishedAt));
    }
  }

  const snapshot: TargetIdentityRegistrySnapshot = {
    version: nextVersion,
    targets: [...targets.values()].sort((left, right) => left.targetId.localeCompare(right.targetId)),
    fingerprints: [...fingerprints.values()].sort((left, right) => left.targetFingerprint.localeCompare(right.targetFingerprint)),
    sources: [...sources.values()].sort((left, right) => sourceKey(left).localeCompare(sourceKey(right))),
    profileOwners: [...profileOwners].map(([profileId, targetId]) => ({ profileId, targetId }))
      .sort((left, right) => left.profileId.localeCompare(right.profileId)),
  };
  return {
    snapshot,
    publication: { version: nextVersion, acceptedTargetIds, rejected },
    audit,
  };
}

export function defaultTargetKnowledgePolicy(targetId: string): TargetKnowledgePolicy {
  return {
    schemaVersion: 1,
    targetId,
    policyVersion: 'default/v1',
    policyEpoch: 0,
    defaultRequiredness: 'optional',
    requirements: [],
  };
}

export function nextTargetKnowledgePolicy(
  existing: TargetKnowledgePolicy | null,
  input: TargetKnowledgePolicyWrite,
): TargetKnowledgePolicy {
  if (input.expectedPolicyEpoch !== (existing?.policyEpoch ?? null)) {
    throw new TargetConfigurationError('TARGET_IDENTITY_CONFLICT');
  }
  parseTimestamp(input.publishedAt);
  if (!isSafeId(input.targetId) || !isSafeRevision(input.policyVersion) || input.requirements.length > 20) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  const seen = new Set<string>();
  for (const requirement of input.requirements) {
    const key = `${requirement.id}\u0000${requirement.version}\u0000${requirement.digest}`;
    if (!isSafeId(requirement.id) || !isSafeRevision(requirement.version) || !/^[a-f0-9]{64}$/iu.test(requirement.digest)
      || !['optional', 'required'].includes(requirement.requiredness)
      || (requirement.knowledgeClass !== undefined && !['semantic', 'procedural'].includes(requirement.knowledgeClass))
      || seen.has(key)) {
      throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
    }
    seen.add(key);
  }
  return {
    schemaVersion: 1,
    targetId: input.targetId,
    policyVersion: input.policyVersion,
    policyEpoch: (existing?.policyEpoch ?? 0) + 1,
    defaultRequiredness: 'optional',
    requirements: input.requirements.map(item => structuredClone(item)),
  };
}

export function targetIdentityRecordDigest(value: unknown): string {
  return checkpointChecksum(value);
}

function fingerprintIdentity(candidate: TargetIdentityCandidate) {
  return {
    targetFingerprint: candidate.targetFingerprint,
    projectId: candidate.projectId,
    deploymentId: candidate.deploymentId,
    deploymentGeneration: candidate.deploymentGeneration,
    dataClass: candidate.dataClass,
    ...(candidate.datasetId === undefined ? {} : { datasetId: candidate.datasetId }),
    sourceIdentities: [...candidate.sourceIdentities].map(identity => structuredClone(identity))
      .sort((left, right) => sourceKey(left).localeCompare(sourceKey(right))),
  };
}

function sourceIdentity(identity: TargetIdentityCandidate['sourceIdentities'][number]) {
  return {
    sourceId: identity.sourceId,
    dataDomainId: identity.dataDomainId,
    sourceGeneration: identity.sourceGeneration,
    permissionScopeDigest: identity.permissionScopeDigest,
  };
}

function sourceKey(identity: TargetIdentityCandidate['sourceIdentities'][number]): string {
  return `${identity.sourceId}\u0000${identity.sourceGeneration}`;
}

function groupVariants<T>(items: readonly T[], identity: (item: T) => unknown): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const value = identity(item) as Record<string, unknown>;
    const key = typeof value.targetFingerprint === 'string'
      ? value.targetFingerprint
      : sourceKey(value as unknown as TargetIdentityCandidate['sourceIdentities'][number]);
    const values = groups.get(key) ?? new Set<string>();
    values.add(JSON.stringify(value));
    groups.set(key, values);
  }
  return groups;
}

function maxSourceGeneration(
  sources: ReadonlyMap<string, TargetIdentityCandidate['sourceIdentities'][number]>,
  sourceId: string,
): number {
  let max = 0;
  for (const source of sources.values()) if (source.sourceId === sourceId) max = Math.max(max, source.sourceGeneration);
  return max;
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}

function isValidCandidate(candidate: TargetIdentityCandidate): boolean {
  return isSafeId(candidate.targetId) && isSafeId(candidate.projectId) && isSafeId(candidate.deploymentId)
    && isSafeId(candidate.scenarioId) && isSafeId(candidate.primaryServiceId) && isSafeId(candidate.profileId)
    && isSafeId(candidate.targetFingerprint) && Number.isSafeInteger(candidate.deploymentGeneration)
    && candidate.deploymentGeneration > 0 && (candidate.dataClass === 'live'
      ? candidate.datasetId === undefined
      : candidate.dataClass === 'simulated' && isSafeId(candidate.datasetId))
    && candidate.sourceIdentities.every(identity => isSafeId(identity.sourceId) && isSafeId(identity.dataDomainId)
      && Number.isSafeInteger(identity.sourceGeneration) && identity.sourceGeneration > 0
      && /^[a-f0-9]{64}$/iu.test(identity.permissionScopeDigest))
    && new Set(candidate.sourceIdentities.map(sourceKey)).size === candidate.sourceIdentities.length;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value);
}

function isSafeRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(value) && !value.includes('://');
}

function parseTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  return new Date(value).toISOString();
}

function auditEntry(
  targetId: string,
  action: TargetIdentityAuditRecord['action'],
  registryVersion: number,
  identityDigest: string,
  recordedAt: string,
): Omit<TargetIdentityAuditRecord, 'sequence'> {
  return { targetId, action, registryVersion, identityDigest, recordedAt };
}
