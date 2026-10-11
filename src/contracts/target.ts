import type { MemoryScope } from './diagnostic-memory.js';
import type { ResolvedProfileSnapshot } from './governance.js';

export const TARGET_ERROR_CODES = [
  'TARGET_NOT_FOUND',
  'TARGET_DISABLED',
  'TARGET_BINDING_INVALID',
  'TARGET_SCOPE_MISMATCH',
  'TARGET_SNAPSHOT_UNAVAILABLE',
  'TARGET_GENERATION_CHANGED',
  'SCENARIO_VERSION_UNSUPPORTED',
  'SOURCE_MAPPING_INVALID',
  'TARGET_CATALOG_INVALID',
  'TARGET_CATALOG_LIMIT_EXCEEDED',
  'TARGET_REQUEST_CONFLICT',
  'TARGET_RUN_UNAVAILABLE',
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
  scenario: TargetScenarioBinding;
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

export interface TargetCatalogRejection {
  index: number;
  targetId?: string;
  reasonCode: 'TARGET_BINDING_INVALID' | 'SOURCE_MAPPING_INVALID' | 'SCENARIO_VERSION_UNSUPPORTED';
}

export interface TargetCatalogParseResult {
  targets: readonly TargetCatalogDefinition[];
  rejected: readonly TargetCatalogRejection[];
}

export class TargetConfigurationError extends Error {
  public constructor(public readonly code: TargetErrorCode) {
    super(code);
    this.name = 'TargetConfigurationError';
  }
}

export interface TargetResolver {
  resolve(input: TargetSelection & { capturedAt: string; signal: AbortSignal }): Promise<ResolvedTargetSnapshot>;
  listCatalog(): readonly TargetCatalogDto[];
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

export interface TargetBindingTransition {
  binding: TargetRunBindingRecord;
  /** Required for the root Run; child Runs refer to the already-persisted root snapshot. */
  snapshot?: ResolvedTargetSnapshot;
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
  getSnapshot(bindingId: string): Promise<ResolvedTargetSnapshot | null>;
  listByTarget(input: { targetId: string; cursor?: string; limit: number }): Promise<TargetRunBindingPage>;
}

/** Host-only input accepted by the Harness; never parsed from public request JSON. */
export interface TrustedTargetBinding {
  binding: TargetRunBindingRecord;
  snapshot: ResolvedTargetSnapshot;
}
