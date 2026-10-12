import { systemClock, type Clock } from '../contracts/common.js';
import { TargetConfigurationError, type TargetIdentityAuditRecord, type TargetIdentityCandidate,
  type TargetIdentityCatalogPublication, type TargetIdentityRegistry, type TargetIdentityRegistrySnapshot,
  type TargetKnowledgePolicy, type TargetKnowledgePolicyStore, type TargetKnowledgePolicyWrite } from '../contracts/target.js';
import { applyTargetIdentityCatalog, emptyTargetIdentitySnapshot,
  nextTargetKnowledgePolicy, type TargetIdentityCatalogInput } from './target-identity-state.js';

export interface InMemoryTargetIdentityStoreOptions {
  clock?: Clock;
}

/** Deterministic in-memory implementation of the host identity and knowledge-policy ports. */
export class InMemoryTargetIdentityStore implements TargetIdentityRegistry, TargetKnowledgePolicyStore {
  private snapshot: TargetIdentityRegistrySnapshot = emptyTargetIdentitySnapshot();
  private readonly audit: TargetIdentityAuditRecord[] = [];
  private readonly policies = new Map<string, TargetKnowledgePolicy>();
  private readonly clock: Clock;

  public constructor(options: InMemoryTargetIdentityStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  public readSnapshot(): Promise<TargetIdentityRegistrySnapshot> {
    return Promise.resolve(structuredClone(this.snapshot));
  }

  public inspectPublicationFence(targetId: string) {
    return { registryVersion: this.snapshot.version, policy: structuredClone(this.policies.get(targetId) ?? null) };
  }

  public publishCatalog(input: TargetIdentityCatalogInput): Promise<TargetIdentityCatalogPublication> {
    const result = applyTargetIdentityCatalog(this.snapshot, sanitizeCatalogInput(input));
    const recordedAt = result.audit.length === 0 ? undefined : timestamp(this.clock);
    const audit = result.audit.map((record, index): TargetIdentityAuditRecord => ({
      ...record,
      sequence: this.audit.length + index + 1,
      recordedAt: recordedAt ?? record.recordedAt,
    }));

    this.snapshot = result.snapshot;
    this.audit.push(...audit);
    return Promise.resolve(structuredClone(result.publication));
  }

  public listAudit(targetId?: string): Promise<readonly TargetIdentityAuditRecord[]> {
    const records = targetId === undefined ? this.audit : this.audit.filter(record => record.targetId === targetId);
    return Promise.resolve(structuredClone(records));
  }

  public get(targetId: string): Promise<TargetKnowledgePolicy | null> {
    const policy = this.policies.get(targetId);
    return Promise.resolve(policy === undefined ? null : structuredClone(policy));
  }

  public compareAndSet(input: TargetKnowledgePolicyWrite): Promise<TargetKnowledgePolicy> {
    const normalized = sanitizePolicyWrite(input);
    const current = this.policies.get(normalized.targetId) ?? null;
    const next = nextTargetKnowledgePolicy(current, normalized);
    this.policies.set(next.targetId, structuredClone(next));
    return Promise.resolve(structuredClone(next));
  }
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
      sourceIdentities: candidate.sourceIdentities.map(identity => ({
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

function timestamp(clock: Clock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TargetConfigurationError('TARGET_CATALOG_INVALID');
  }
  return value.toISOString();
}
