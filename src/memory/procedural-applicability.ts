import type { KnowledgeScope, ProceduralKnowledgeContent, ProceduralKnowledgeRevision } from '../contracts/knowledge-memory.js';
import type { KnowledgeRevisionStateSnapshot } from '../contracts/knowledge-memory-storage.js';
import { parseKnowledgeRecord, parseKnowledgeScope } from '../contracts/knowledge-memory-schema.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import type { ResolvedTargetSnapshotV2, TargetSourceKind } from '../contracts/target.js';
import { parseResolvedTargetSnapshotV2 } from '../contracts/target-schema.js';
import type { ProceduralReadonlyCapability, ProceduralReadonlyCapabilityRegistryPort } from './procedural-template-service.js';

export interface ProceduralApplicabilityCandidate {
  readonly revision: ProceduralKnowledgeRevision;
  /** Current mutable governance/source state, inspected for this query rather than trusted from an old revision object. */
  readonly state: KnowledgeRevisionStateSnapshot;
  /** Optional bounded ranking hint; it cannot affect eligibility. */
  readonly relevanceScore?: number;
}

export interface ProceduralTemplateSuggestionV1 {
  readonly schemaVersion: 1;
  readonly reference: { readonly id: string; readonly version: string; readonly digest: string };
  readonly templateId: string;
  readonly scenario: ProceduralKnowledgeContent['scenario'];
  readonly applicableTo: ProceduralKnowledgeContent['applicableTo'];
  readonly preconditions: ProceduralKnowledgeContent['preconditions'];
  readonly requiredEvidence: ProceduralKnowledgeContent['requiredEvidence'];
  readonly steps: ProceduralKnowledgeContent['steps'];
  readonly stopConditions: ProceduralKnowledgeContent['stopConditions'];
  readonly expectedReportFields: ProceduralKnowledgeContent['expectedReportFields'];
  readonly limitations: ProceduralKnowledgeContent['limitations'];
  readonly sourceReferences: ProceduralKnowledgeContent['sourceReferences'];
}

export interface FindApplicableProceduralTemplatesInput {
  readonly targetSnapshot: ResolvedTargetSnapshotV2;
  /** Complete host-derived scope; it must equal the scope deterministically reconstructed from the signed snapshot. */
  readonly targetScope: KnowledgeScope;
  readonly candidates: readonly ProceduralApplicabilityCandidate[];
  readonly capabilityRegistry: ProceduralReadonlyCapabilityRegistryPort;
  readonly now: string;
}

/**
 * Apply all deterministic gates before considering relevance. This is a pure projection/filter:
 * it never queries storage, constructs ToolCalls, or grants execution authority.
 */
export function findApplicableProceduralTemplates(
  input: FindApplicableProceduralTemplatesInput,
): readonly ProceduralTemplateSuggestionV1[] {
  const snapshot = parseResolvedTargetSnapshotV2(input.targetSnapshot);
  const scope = parseKnowledgeScope(input.targetScope);
  if (!isCanonicalTargetScope(snapshot, scope) || !isTimestamp(input.now)) return [];
  const nowMs = Date.parse(input.now);
  const eligible: { suggestion: ProceduralTemplateSuggestionV1; score: number; id: string; revision: number }[] = [];

  for (const candidate of input.candidates) {
    if (!isRecord(candidate)) continue;
    const revision = parseProceduralCandidate(candidate.revision);
    if (!revision || !isEligibleCurrentState(revision, candidate.state, nowMs)) continue;
    if (!sameScope(revision.scope, scope) || !snapshot.knowledgeRefs.some(reference =>
      reference.id === revision.id && reference.version === String(revision.contentRevision)
      && reference.digest === revision.contentDigest && reference.approval === 'approved')) continue;
    if (!matchesTarget(revision.content, snapshot) || !supportsRequiredEvidence(revision.content, snapshot)) continue;
    if (!hasCompatibleCapabilities(revision.content, snapshot, input.capabilityRegistry)) continue;
    const score = candidate.relevanceScore === undefined ? 0 : candidate.relevanceScore;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue;
    eligible.push({ suggestion: projectSuggestion(revision), score, id: revision.id, revision: revision.contentRevision });
  }

  eligible.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)
    || left.revision - right.revision);
  return eligible.map(entry => entry.suggestion);
}

function parseProceduralCandidate(value: unknown): ProceduralKnowledgeRevision | null {
  try {
    const parsed = parseKnowledgeRecord(value);
    if (parsed.kind !== 'procedural' || parsed.contentDigest !== checkpointChecksum(parsed.content)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isEligibleCurrentState(revision: ProceduralKnowledgeRevision, value: unknown, nowMs: number): boolean {
  if (!isKnowledgeRevisionStateSnapshot(value)) return false;
  const state = value;
  return state.kind === 'procedural' && state.knowledgeId === revision.id
    && state.contentRevision === revision.contentRevision && state.contentDigest === revision.contentDigest
    && state.governanceVersion === revision.governanceVersion
    && state.status === 'approved' && revision.status === 'approved'
    && state.sourceValidity === 'active' && state.sourceDigestMatches
    && state.sourceEpoch === revision.sourceEpoch && state.currentSourceEpoch === revision.sourceEpoch
    && (revision.validUntil === undefined || Date.parse(revision.validUntil) > nowMs)
    && (state.validUntil === undefined || Date.parse(state.validUntil) > nowMs);
}

function isKnowledgeRevisionStateSnapshot(value: unknown): value is KnowledgeRevisionStateSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.knowledgeId === 'string' && value.knowledgeId.length > 0
    && (value.kind === 'semantic' || value.kind === 'procedural')
    && isPositiveInteger(value.contentRevision) && isPositiveInteger(value.governanceVersion)
    && typeof value.contentDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.contentDigest)
    && isKnowledgeStatus(value.status) && isNonnegativeInteger(value.sourceEpoch)
    && (value.currentSourceEpoch === null || isNonnegativeInteger(value.currentSourceEpoch))
    && isSourceValidity(value.sourceValidity) && typeof value.sourceDigestMatches === 'boolean'
    && (value.validUntil === undefined || (typeof value.validUntil === 'string' && isTimestamp(value.validUntil)))
    && typeof value.eligibleAt === 'string' && isTimestamp(value.eligibleAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnowledgeStatus(value: unknown): boolean {
  return value === 'draft' || value === 'review_pending' || value === 'approved' || value === 'rejected'
    || value === 'revoked' || value === 'expired' || value === 'conflict' || value === 'superseded';
}

function isSourceValidity(value: unknown): boolean {
  return value === 'active' || value === 'revoked' || value === 'digest_mismatch'
    || value === 'permission_revoked' || value === 'missing';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isCanonicalTargetScope(snapshot: ResolvedTargetSnapshotV2, scope: KnowledgeScope): boolean {
  const expected: KnowledgeScope = {
    targetId: snapshot.targetId,
    projectId: snapshot.projectId,
    deploymentId: snapshot.deploymentId,
    deploymentGeneration: snapshot.deploymentGeneration,
    targetFingerprint: snapshot.targetFingerprint,
    profileId: snapshot.profile.profileId,
    profileRevision: snapshot.profile.revision,
    scenarioId: snapshot.scenario.id,
    scenarioVersion: snapshot.scenario.version,
    serviceIds: [snapshot.scenario.serviceId],
    faultTypes: [snapshot.scenario.id],
    environment: snapshot.environment,
    dataClass: snapshot.dataClass,
    ...(snapshot.dataClass === 'simulated' ? { datasetId: snapshot.datasetId } : {}),
  } as KnowledgeScope;
  return sameScope(scope, expected);
}

function sameScope(left: KnowledgeScope, right: KnowledgeScope): boolean {
  try {
    return checkpointChecksum(parseKnowledgeScope(left)) === checkpointChecksum(parseKnowledgeScope(right));
  } catch {
    return false;
  }
}

function matchesTarget(content: ProceduralKnowledgeContent, snapshot: ResolvedTargetSnapshotV2): boolean {
  return content.scenario.id === snapshot.scenario.id && content.scenario.version === snapshot.scenario.version
    && content.applicableTo.serviceIds.includes(snapshot.scenario.serviceId)
    && content.applicableTo.faultTypes.includes(snapshot.scenario.id)
    && content.applicableTo.environments.includes(snapshot.environment);
}

function supportsRequiredEvidence(content: ProceduralKnowledgeContent, snapshot: ResolvedTargetSnapshotV2): boolean {
  return content.requiredEvidence.every(requirement => {
    const sourceKind = evidenceSourceKind(requirement.category);
    return snapshot.sourceBindings.some(source => source.kind === sourceKind
      && source.allowedServiceIds.includes(snapshot.scenario.serviceId)
      && !snapshot.unavailableOptionalSourceIds.includes(source.sourceId));
  });
}

function evidenceSourceKind(category: 'metric' | 'log' | 'trace' | 'change'): TargetSourceKind {
  switch (category) {
    case 'metric': return 'metrics';
    case 'log': return 'logs';
    case 'trace': return 'trace';
    case 'change': return 'change';
  }
}

function hasCompatibleCapabilities(
  content: ProceduralKnowledgeContent,
  snapshot: ResolvedTargetSnapshotV2,
  registry: ProceduralReadonlyCapabilityRegistryPort,
): boolean {
  return content.steps.every(step => {
    const capability = registry.resolveForTarget({ targetId: snapshot.targetId, capabilityId: step.capabilityId });
    return isCompatibleCapability(capability, step.capabilityId, content, snapshot);
  });
}

function isCompatibleCapability(
  capability: ProceduralReadonlyCapability | null,
  capabilityId: string,
  content: ProceduralKnowledgeContent,
  snapshot: ResolvedTargetSnapshotV2,
): boolean {
  if (capability === null || capability.capabilityId !== capabilityId || capability.access !== 'read_only'
    || !isUniqueStrings(capability.serviceIds) || !isUniqueStrings(capability.faultTypes)
    || !isUniqueStrings(capability.environments) || !isUniqueStrings(capability.dataClasses)) return false;
  return content.applicableTo.serviceIds.every(id => capability.serviceIds.includes(id))
    && content.applicableTo.faultTypes.every(id => capability.faultTypes.includes(id))
    && content.applicableTo.environments.every(environment => capability.environments.includes(environment))
    && capability.dataClasses.includes(snapshot.dataClass);
}

function isUniqueStrings(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function projectSuggestion(revision: ProceduralKnowledgeRevision): ProceduralTemplateSuggestionV1 {
  const content = structuredClone(revision.content);
  return {
    schemaVersion: 1,
    reference: { id: revision.id, version: String(revision.contentRevision), digest: revision.contentDigest },
    templateId: content.templateId,
    scenario: content.scenario,
    applicableTo: content.applicableTo,
    preconditions: content.preconditions,
    requiredEvidence: content.requiredEvidence,
    steps: content.steps,
    stopConditions: content.stopConditions,
    expectedReportFields: content.expectedReportFields,
    limitations: content.limitations,
    sourceReferences: content.sourceReferences,
  };
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
