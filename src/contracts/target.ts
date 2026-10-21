import type { MemoryScope } from './diagnostic-memory.js';
import type { ResolvedProfileSnapshot } from './governance.js';
import type { ChatModel } from './model.js';
import type { Tool } from './tool.js';

export const TARGET_ERROR_CODES = [
  'TARGET_NOT_FOUND',
  'TARGET_DISABLED',
  'TARGET_BINDING_INVALID',
  'TARGET_SCOPE_MISMATCH',
  'TARGET_SNAPSHOT_UNAVAILABLE',
  'TARGET_GENERATION_CHANGED',
  'TARGET_IDENTITY_CONFLICT',
  'TARGET_IDENTITY_UNPROVEN',
  'SCENARIO_VERSION_UNSUPPORTED',
  'SCENARIO_DIGEST_MISMATCH',
  'SOURCE_MAPPING_INVALID',
  'TARGET_CATALOG_INVALID',
  'TARGET_CATALOG_LIMIT_EXCEEDED',
  'TARGET_REQUEST_CONFLICT',
  'TARGET_START_STATE_UNKNOWN',
  'TARGET_RUN_UNAVAILABLE',
  'TARGET_OPERATION_DENIED',
  'KNOWLEDGE_REQUIRED_DISABLED',
] as const;

export type TargetErrorCode = typeof TARGET_ERROR_CODES[number];
export type TargetEnvironment = 'simulation' | 'development' | 'staging' | 'production';
export type TargetDataClass = 'simulated' | 'live';
export type TargetSourceKind = 'metrics' | 'logs' | 'trace' | 'change';

export interface TargetMetricMapping {
  metricName: string;
  outcomeLabel: string;
  successValue: string;
  failureValue: string;
  serviceSelector: { label: string; value: string };
  staticLabels: Readonly<Record<string, string>>;
  /** Required by scenario 1.1.0; the same trusted selectors apply to both boundary metrics. */
  windowBoundaryMapping?: TargetWindowBoundaryMapping;
}

export interface TargetWindowBoundaryMapping {
  startMetricName: string;
  endMetricName: string;
  timestampUnit: 'unix_seconds';
}

export interface TargetScenarioBinding {
  id: 'window_failure_rate.v1';
  version: string;
  serviceId: string;
  serviceName: string;
  metricSemantics: 'integer_window_snapshot';
  metricMapping: TargetMetricMapping;
  threshold: number;
  minSamples: number;
}

/** Host-catalog scenario binding. The digest pins the installed implementation, not only its label. */
export interface TargetCatalogScenarioBinding extends TargetScenarioBinding {
  implementationDigest: string;
}

export interface TargetSourceBinding {
  sourceId: string;
  version: string;
  kind: TargetSourceKind;
  adapterId: string;
  required: boolean;
  allowedServiceIds: readonly string[];
}

export interface TargetKnowledgeReference {
  id: string;
  version: string;
  digest: string;
  approval: 'approved';
}

export interface TargetSourceIdentity {
  sourceId: string;
  dataDomainId: string;
  sourceGeneration: number;
  permissionScopeDigest: string;
}

export interface TargetKnowledgeRequirement {
  id: string;
  version: string;
  digest: string;
  requiredness: 'optional' | 'required';
  knowledgeClass?: 'semantic' | 'procedural';
}

/** Versioned host-owned policy; a missing reference entry defaults to optional. */
export interface TargetKnowledgePolicy {
  schemaVersion: 1;
  targetId: string;
  policyVersion: string;
  policyEpoch: number;
  defaultRequiredness: 'optional';
  requirements: readonly TargetKnowledgeRequirement[];
}

export interface TargetKnowledgePolicyWrite {
  targetId: string;
  policyVersion: string;
  requirements: readonly TargetKnowledgeRequirement[];
  expectedPolicyEpoch: number | null;
  publishedAt: string;
}

export type TargetCatalogDefinition = {
  targetId: string;
  projectId: string;
  projectName: string;
  deploymentId: string;
  deploymentGeneration: number;
  environment: TargetEnvironment;
  dataClass: TargetDataClass;
  datasetId?: string;
  targetFingerprint: string;
  profileId: string;
  profileRevision: string;
  displayName: string;
  description: string;
  enabled: boolean;
  scenario: TargetCatalogScenarioBinding;
  sourceBindings: readonly TargetSourceBinding[];
  knowledgeRefs: readonly TargetKnowledgeReference[];
} & (
  | { dataClass: 'simulated'; environment: 'simulation' | 'development' | 'staging'; datasetId: string }
  | { dataClass: 'live'; environment: 'development' | 'staging' | 'production'; datasetId?: never }
);

/** Secret-free, immutable Target configuration captured for one Run. */
export interface ResolvedTargetSnapshot {
  schemaVersion: 1;
  targetId: string;
  projectId: string;
  deploymentId: string;
  deploymentGeneration: number;
  environment: TargetEnvironment;
  dataClass: TargetDataClass;
  datasetId?: string;
  targetFingerprint: string;
  profile: ResolvedProfileSnapshot;
  scenario: TargetScenarioBinding;
  sourceBindings: readonly TargetSourceBinding[];
  unavailableOptionalSourceIds: readonly string[];
  knowledgeRefs: readonly TargetKnowledgeReference[];
  memoryScope: MemoryScope;
  capturedAt: string;
  digest: string;
}

/** New immutable Target snapshot. V1's shape and checksum remain unchanged. */
export interface ResolvedTargetSnapshotV2 {
  schemaVersion: 2;
  targetId: string;
  projectId: string;
  deploymentId: string;
  deploymentGeneration: number;
  environment: TargetEnvironment;
  dataClass: TargetDataClass;
  datasetId?: string;
  targetFingerprint: string;
  profile: ResolvedProfileSnapshot;
  scenario: TargetScenarioBinding;
  scenarioImplementationDigest: string;
  sourceBindings: readonly TargetSourceBinding[];
  sourceIdentities: readonly TargetSourceIdentity[];
  unavailableOptionalSourceIds: readonly string[];
  knowledgeRefs: readonly TargetKnowledgeReference[];
  knowledgePolicy: TargetKnowledgePolicy;
  /** Host-published Target knowledge binding version; absent only in pre-T3 V2 snapshots. */
  publicationVersion?: number;
  /** Target identity registry version used to resolve this snapshot; absent on historical V2 snapshots. */
  identityRegistryVersion?: number;
  memoryScope: MemoryScope;
  capturedAt: string;
  digest: string;
}

export type VersionedResolvedTargetSnapshot = ResolvedTargetSnapshot | ResolvedTargetSnapshotV2;

export type TargetIdentitySourceRecord = TargetSourceIdentity;

export interface TargetIdentityCandidate {
  targetId: string;
  projectId: string;
  deploymentId: string;
  deploymentGeneration: number;
  scenarioId: string;
  primaryServiceId: string;
  profileId: string;
  targetFingerprint: string;
  dataClass: TargetDataClass;
  datasetId?: string;
  sourceIdentities: readonly TargetIdentitySourceRecord[];
}

export interface TargetIdentityRecord {
  targetId: string;
  projectId: string;
  deploymentId: string;
  deploymentGeneration: number;
  scenarioId: string;
  primaryServiceId: string;
  profileId: string;
  status: 'active' | 'tombstoned';
  tombstonedAt?: string;
}

export interface TargetFingerprintIdentityRecord {
  targetFingerprint: string;
  projectId: string;
  deploymentId: string;
  deploymentGeneration: number;
  dataClass: TargetDataClass;
  datasetId?: string;
  sourceIdentities: readonly TargetIdentitySourceRecord[];
}

export interface TargetProfileOwnerRecord {
  profileId: string;
  targetId: string;
}

export interface TargetIdentityAuditRecord {
  sequence: number;
  targetId: string;
  action: 'registered' | 'updated' | 'tombstoned';
  registryVersion: number;
  identityDigest: string;
  recordedAt: string;
}

export interface TargetIdentityRegistrySnapshot {
  version: number;
  targets: readonly TargetIdentityRecord[];
  fingerprints: readonly TargetFingerprintIdentityRecord[];
  sources: readonly TargetIdentitySourceRecord[];
  profileOwners: readonly TargetProfileOwnerRecord[];
}

export interface TargetIdentityCatalogRejection {
  targetId: string;
  reasonCode: 'TARGET_IDENTITY_CONFLICT';
}

export interface TargetIdentityCatalogPublication {
  version: number;
  acceptedTargetIds: readonly string[];
  rejected: readonly TargetIdentityCatalogRejection[];
}

/** Host persistence port for append-only historical identity and catalog CAS. */
export interface TargetIdentityRegistry {
  readSnapshot(): Promise<TargetIdentityRegistrySnapshot>;
  publishCatalog(input: {
    expectedVersion: number;
    presentTargetIds: readonly string[];
    candidates: readonly TargetIdentityCandidate[];
    publishedAt: string;
  }): Promise<TargetIdentityCatalogPublication>;
  listAudit(targetId?: string): Promise<readonly TargetIdentityAuditRecord[]>;
}

/** Host persistence port for versioned, current knowledge-use policy. */
export interface TargetKnowledgePolicyStore {
  get(targetId: string): Promise<TargetKnowledgePolicy | null>;
  compareAndSet(input: TargetKnowledgePolicyWrite): Promise<TargetKnowledgePolicy>;
}

export interface TargetKnowledgeCapabilityState {
  semanticEnabled: boolean;
  proceduralEnabled: boolean;
}

/** Host-owned feature flags; callers and Run preferences cannot enable a disabled knowledge type. */
export interface TargetKnowledgeCapabilityPort {
  getForTarget(targetId: string): Promise<TargetKnowledgeCapabilityState>;
}

export interface TargetSelection {
  targetId: string;
}

export interface TargetCatalogDto {
  targetId: string;
  projectId: string;
  projectName: string;
  deploymentId: string;
  environment: TargetEnvironment;
  displayName: string;
  description: string;
  scenario: { id: string; version: string; serviceId: string; serviceName: string };
  sourceKinds: readonly TargetSourceKind[];
  readOnly: true;
  enabled: boolean;
  canStart: boolean;
}

/** Per-Target, read-only readiness result. A catalog entry alone does not authorize a Run. */
export interface TargetReadinessDto {
  targetId: string;
  status: 'ready' | 'blocked' | 'disabled' | 'unavailable';
  canStart: boolean;
  reasonCode?: 'TARGET_DISABLED' | 'TARGET_RUN_UNAVAILABLE' | 'KNOWLEDGE_REQUIRED_DISABLED'
    | 'TARGET_CONFIGURATION_UNAVAILABLE';
}

export interface TargetCatalogRejection {
  index: number;
  targetId?: string;
  reasonCode: 'TARGET_BINDING_INVALID' | 'SOURCE_MAPPING_INVALID' | 'SCENARIO_VERSION_UNSUPPORTED'
    | 'SCENARIO_DIGEST_MISMATCH' | 'TARGET_IDENTITY_CONFLICT';
}

export interface TargetCatalogParseResult {
  targets: readonly TargetCatalogDefinition[];
  /** Original catalog positions aligned with `targets` after invalid entries are isolated. */
  targetIndices: readonly number[];
  rejected: readonly TargetCatalogRejection[];
  /** Safe Target IDs observed even when their individual entries are invalid. */
  presentTargetIds: readonly string[];
}

export class TargetConfigurationError extends Error {
  public constructor(public readonly code: TargetErrorCode) {
    super(code);
    this.name = 'TargetConfigurationError';
  }
}

export interface TargetResolver {
  resolve(input: TargetSelection & { capturedAt: string; signal: AbortSignal }): Promise<ResolvedTargetSnapshotV2>;
  listCatalog(): readonly TargetCatalogDto[];
  /** Host-only profile ownership predicate; never included in the public catalog. */
  ownsProfileId?(profileId: string): boolean;
}

/** Durable Run-to-Target ownership record. A bindingId identifies one immutable snapshot shared by a Run tree. */
export interface TargetRunBindingRecord {
  bindingId: string;
  targetId: string;
  runId: string;
  rootRunId: string;
  snapshotDigest: string;
  createdAt: string;
  /** Present only on the root Run and matched against a prior idempotency reservation. */
  requestId?: string;
  requestDigest?: string;
}

/** Request reservation prevents retries from creating duplicate Runs before the first checkpoint exists. */
export interface TargetRunRequestRecord {
  requestId: string;
  targetId: string;
  requestDigest: string;
  runId: string;
  createdAt: string;
}

export type TargetStartRequestIdentity = Pick<TargetRunRequestRecord, 'requestId' | 'targetId' | 'requestDigest' | 'runId'>;

/** Fencing token for one owner of the initial Target Run durable transition. */
export interface TargetStartClaim extends TargetStartRequestIdentity {
  ownerId: string;
  epoch: number;
  leaseUntil: string;
}

export type TargetStartClaimResult =
  | { status: 'claimed'; claim: TargetStartClaim }
  | { status: 'busy' }
  | { status: 'already_started' }
  | { status: 'unknown' };

export type TargetStartReconciliation =
  | { status: 'confirmed_absent' }
  | { status: 'confirmed_present' }
  | { status: 'unknown' };

/** Durable start-reservation claims; implementations must fence commit by owner and epoch. */
export interface TargetStartStore {
  claimStart(input: TargetStartRequestIdentity & {
    ownerId: string;
    now: string;
    leaseUntil: string;
  }): Promise<TargetStartClaimResult>;
  reconcileStart(input: TargetStartRequestIdentity): Promise<TargetStartReconciliation>;
  releaseStartClaim(input: { claim: TargetStartClaim; now: string }): Promise<boolean>;
}

export interface TargetBindingTransition {
  binding: TargetRunBindingRecord;
  /** Required for the root Run; child Runs refer to the already-persisted root snapshot. */
  snapshot?: VersionedResolvedTargetSnapshot;
  /** Required on the first durable transition for a request-backed root Target Run. */
  startClaim?: TargetStartClaim;
}

export interface TargetBindingReservation {
  record: TargetRunRequestRecord;
  created: boolean;
}

export interface TargetRunBindingPage {
  items: readonly TargetRunBindingRecord[];
  nextCursor?: string;
}

export interface TargetBindingStore {
  reserveRequest(record: TargetRunRequestRecord): Promise<TargetBindingReservation>;
  getRequest(requestId: string): Promise<TargetRunRequestRecord | null>;
  getBinding(runId: string): Promise<TargetRunBindingRecord | null>;
  getSnapshot(bindingId: string): Promise<VersionedResolvedTargetSnapshot | null>;
  listByTarget(input: { targetId: string; cursor?: string; limit: number }): Promise<TargetRunBindingPage>;
}

/** Host-only input accepted by the Harness; never parsed from public request JSON. */
export interface TrustedTargetBinding {
  binding: TargetRunBindingRecord;
  snapshot: VersionedResolvedTargetSnapshot;
  /** Added by the execution coordinator; never accepted from external request JSON. */
  startClaim?: TargetStartClaim;
}

export type TargetOperation = 'start' | 'resume' | 'model' | 'source';

/** One attempt-scoped authorization request. Binding/snapshot values come only from host persistence. */
export interface TargetOperationRequest {
  binding: TargetRunBindingRecord;
  snapshot: ResolvedTargetSnapshotV2;
  runId: string;
  rootRunId: string;
  operation: TargetOperation;
  capability: string;
  signal: AbortSignal;
}

/** Ephemeral capability; never put it in AgentContext, events, or a checkpoint. */
export interface TargetOperationPermit {
  bindingId: string;
  runId: string;
  rootRunId: string;
  snapshotDigest: string;
  operation: TargetOperation;
  capability: string;
  policyEpoch: number;
  /** The policy implementation aborts this signal when the permit is revoked. */
  signal: AbortSignal;
}

/** Host authority; implementations must re-check current policy and fence revoked epochs. */
export interface TargetOperationPolicy {
  authorize(request: TargetOperationRequest): Promise<TargetOperationPermit>;
  validate(permit: TargetOperationPermit, request: TargetOperationRequest): Promise<void>;
}

export interface TargetOperationGuard {
  authorize(input: { operation: 'model' | 'source'; capability: string; signal: AbortSignal }): Promise<TargetOperationPermit>;
  validate(permit: TargetOperationPermit, signal?: AbortSignal): Promise<void>;
}

export interface TargetRuntimeLease {
  /** Concrete base model and Tools are reconstructed from this exact, validated snapshot. */
  model: ChatModel;
  /** Optional non-secret identity used by model-call audit events. */
  modelIdentity?: { provider: string; model: string };
  /** Every Target-scoped Tool must expose a non-empty implementationVersion for safe HITL recovery. */
  tools: readonly Tool[];
  release(): void | Promise<void>;
}

export interface TargetRuntimeProvider {
  acquire(snapshot: ResolvedTargetSnapshotV2): Promise<TargetRuntimeLease>;
}

export interface TargetRunRuntimeLease extends TargetRuntimeLease {
  operations: TargetOperationGuard;
}

/** Recovery gate shared by the Harness for both initial Target starts and checkpoint resumes. */
export interface TargetRecoveryGate {
  acquireForStart(input: {
    binding: TargetRunBindingRecord;
    snapshot: ResolvedTargetSnapshotV2;
    signal: AbortSignal;
    /** Optional child-Agent source scope; must exist in the persisted snapshot. */
    sourceScopeId?: string;
  }): Promise<TargetRunRuntimeLease>;
  authorizeResume(input: { runId: string; targetBindingId: string; signal: AbortSignal }): Promise<void>;
  acquireForResume(input: {
    runId: string;
    targetBindingId: string;
    signal: AbortSignal;
    /** Optional child-Agent source scope; must exist in the persisted snapshot. */
    sourceScopeId?: string;
  }): Promise<TargetRunRuntimeLease>;
}
