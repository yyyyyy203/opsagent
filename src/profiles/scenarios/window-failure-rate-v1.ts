import { checkpointChecksum } from '../../contracts/stable-json.js';
import { scenarioConclusionBounds, type ScenarioConclusionBounds } from './scenario-conclusions.js';

export const WINDOW_FAILURE_RATE_SCENARIO_ID = 'window_failure_rate.v1' as const;
export const WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0 = '1.0.0' as const;
export const WINDOW_FAILURE_RATE_SCENARIO_VERSION = '1.1.0' as const;

/*
 * This descriptor is the reviewed implementation identity. Update it whenever
 * the interpretation, boundary comparison, or required input semantics change.
 */
const implementationDescriptor = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0,
  semantics: 'integer_window_snapshot',
  rate: 'failed_samples / total_samples',
  threshold: 'failure_rate >= configured_threshold',
  minimumSamples: 'total_samples >= configured_min_samples',
});

export const WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

const implementationDescriptorV1_1_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  input: Object.freeze({
    schemaVersion: 'window_count_snapshot.v1',
    availability: Object.freeze(['available', 'unavailable']),
    countSemantics: 'integer_window_snapshot',
    availableFact: Object.freeze({
      timestampUnit: 'unix_seconds',
      window: Object.freeze(['startUnixSeconds', 'endUnixSeconds']),
      counts: Object.freeze(['successCount', 'failureCount', 'totalCount']),
      invariants: Object.freeze([
        'finite_window_boundaries',
        'start_precedes_end',
        'nonnegative_safe_integer_counts',
        'total_is_positive_safe_integer',
        'failure_count_does_not_exceed_total',
        'success_plus_failure_equals_total',
      ]),
    }),
    unavailableFact: Object.freeze({
      reason: 'missing_window_evidence',
      missingEvidence: Object.freeze(['start_boundary', 'end_boundary']),
    }),
    requestedWindow: Object.freeze({
      authority: 'host_authorized',
      timestampUnit: 'unix_seconds',
      matching: 'fact_start_and_end_exactly_equal_requested_start_and_end',
      durationPolicy: 'no_global_window_duration',
      freshnessPolicy: 'source_adapter_host_policy_and_injected_clock',
    }),
    analysisParameters: Object.freeze({
      threshold: 'finite_number_inclusive_0_to_1',
      minSamples: 'positive_safe_integer',
    }),
    selectors: 'trusted_service_selector_and_static_labels',
  }),
  output: Object.freeze({
    assessmentDiscriminants: Object.freeze(['complete', 'insufficient_samples', 'unavailable']),
    completeFields: Object.freeze([
      'requestedWindow', 'successCount', 'failureCount', 'totalCount', 'failureRate', 'threshold', 'thresholdReached',
    ]),
    insufficientSamplesFields: Object.freeze(['sampleCount', 'minimumSamples']),
    unavailableFields: Object.freeze(['reason', 'missingEvidence']),
    unavailableReason: 'missing_window_evidence',
    rate: 'failed_samples / total_samples',
    threshold: 'failure_rate >= configured_threshold',
    minimumSamples: 'total_samples >= configured_min_samples',
  }),
});

export const WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptorV1_1_0 })}`;

/** Current implementation alias; historical 1.0.0 snapshots use the explicit legacy identity below. */
export const WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST = WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST;

export const WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0,
  implementationDigest: WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST,
});

export const WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  implementationDigest: WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST,
});

export const WINDOW_FAILURE_RATE_INSTALLATION = WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0;

/** Both immutable implementations remain installable for old snapshots and new Target bindings. */
export const WINDOW_FAILURE_RATE_INSTALLATIONS = Object.freeze([
  WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0,
  WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0,
]);

export const WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION = 'window_count_snapshot.v1' as const;

export type WindowCountMissingEvidenceV1 = 'start_boundary' | 'end_boundary';

export interface HostAuthorizedRequestedWindowV1 {
  timestampUnit: 'unix_seconds';
  startUnixSeconds: number;
  endUnixSeconds: number;
}

export type WindowCountSnapshotV1 =
  | Readonly<{
    schemaVersion: typeof WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: Readonly<{
      startUnixSeconds: number;
      endUnixSeconds: number;
    }>;
    successCount: number;
    failureCount: number;
    totalCount: number;
  }>
  | Readonly<{
    schemaVersion: typeof WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly WindowCountMissingEvidenceV1[];
  }>;

export type WindowFailureRateScenarioErrorCode =
  | 'INVALID_SNAPSHOT_SHAPE'
  | 'INVALID_SNAPSHOT_SCHEMA'
  | 'INVALID_SNAPSHOT_AVAILABILITY'
  | 'INVALID_MISSING_WINDOW_EVIDENCE'
  | 'INVALID_TIMESTAMP_UNIT'
  | 'INVALID_BOUNDARY_WINDOW'
  | 'INVALID_BOUNDARY_TIMESTAMP'
  | 'INVALID_COUNT'
  | 'INVALID_TOTAL'
  | 'FAILURE_COUNT_EXCEEDS_TOTAL'
  | 'INCONSISTENT_TOTAL'
  | 'INVALID_REQUESTED_WINDOW'
  | 'WINDOW_MISMATCH'
  | 'INVALID_THRESHOLD'
  | 'INVALID_MIN_SAMPLES';

export class WindowFailureRateScenarioError extends Error {
  constructor(readonly code: WindowFailureRateScenarioErrorCode) {
    super(code);
    this.name = 'WindowFailureRateScenarioError';
  }
}

export interface WindowFailureRateAssessmentInputV1 {
  snapshot: WindowCountSnapshotV1;
  requestedWindow: HostAuthorizedRequestedWindowV1;
  threshold: number;
  minSamples: number;
}

export type WindowFailureRateAssessmentV1 =
  | Readonly<{
    status: 'complete';
    requestedWindow: HostAuthorizedRequestedWindowV1;
    successCount: number;
    failureCount: number;
    totalCount: number;
    failureRate: number;
    threshold: number;
    thresholdReached: boolean;
  }>
  | Readonly<{
    status: 'insufficient_samples';
    sampleCount: number;
    minimumSamples: number;
  }>
  | Readonly<{
    status: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly WindowCountMissingEvidenceV1[];
  }>;

/** Validate an untrusted serialized fact and return only the versioned typed shape. */
export function parseWindowCountSnapshotV1(input: unknown): WindowCountSnapshotV1 {
  const record = requireRecord(input, 'INVALID_SNAPSHOT_SHAPE');
  if (!hasExactKeys(record, ['schemaVersion', 'availability', ...(record.availability === 'available'
    ? ['timestampUnit', 'window', 'successCount', 'failureCount', 'totalCount']
    : ['reason', 'missingEvidence'])])) {
    throw new WindowFailureRateScenarioError('INVALID_SNAPSHOT_SHAPE');
  }
  if (record.schemaVersion !== WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION) {
    throw new WindowFailureRateScenarioError('INVALID_SNAPSHOT_SCHEMA');
  }

  if (record.availability === 'unavailable') {
    if (record.reason !== 'missing_window_evidence' || !Array.isArray(record.missingEvidence)
      || record.missingEvidence.length === 0
      || !record.missingEvidence.every(isWindowBoundaryEvidence)
      || new Set(record.missingEvidence).size !== record.missingEvidence.length) {
      throw new WindowFailureRateScenarioError('INVALID_MISSING_WINDOW_EVIDENCE');
    }
    return Object.freeze({
      schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: Object.freeze([...record.missingEvidence]),
    });
  }

  if (record.availability !== 'available') {
    throw new WindowFailureRateScenarioError('INVALID_SNAPSHOT_AVAILABILITY');
  }
  if (record.timestampUnit !== 'unix_seconds') {
    throw new WindowFailureRateScenarioError('INVALID_TIMESTAMP_UNIT');
  }

  const window = requireRecord(record.window, 'INVALID_BOUNDARY_WINDOW');
  if (!hasExactKeys(window, ['startUnixSeconds', 'endUnixSeconds'])) {
    throw new WindowFailureRateScenarioError('INVALID_BOUNDARY_WINDOW');
  }
  const { startUnixSeconds, endUnixSeconds } = window;
  if (typeof startUnixSeconds !== 'number' || typeof endUnixSeconds !== 'number'
    || !Number.isFinite(startUnixSeconds) || !Number.isFinite(endUnixSeconds)) {
    throw new WindowFailureRateScenarioError('INVALID_BOUNDARY_TIMESTAMP');
  }
  if (startUnixSeconds >= endUnixSeconds) {
    throw new WindowFailureRateScenarioError('INVALID_BOUNDARY_WINDOW');
  }

  const { successCount, failureCount, totalCount } = record;
  if (!isNonnegativeSafeInteger(successCount) || !isNonnegativeSafeInteger(failureCount)) {
    throw new WindowFailureRateScenarioError('INVALID_COUNT');
  }
  if (!isNonnegativeSafeInteger(totalCount) || totalCount === 0) {
    throw new WindowFailureRateScenarioError('INVALID_TOTAL');
  }
  if (failureCount > totalCount) {
    throw new WindowFailureRateScenarioError('FAILURE_COUNT_EXCEEDS_TOTAL');
  }
  if (!Number.isSafeInteger(successCount + failureCount) || successCount + failureCount !== totalCount) {
    throw new WindowFailureRateScenarioError('INCONSISTENT_TOTAL');
  }

  return Object.freeze({
    schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window: Object.freeze({ startUnixSeconds, endUnixSeconds }),
    successCount,
    failureCount,
    totalCount,
  });
}

/** Deterministically assess one typed snapshot against a host-authorized window and scenario policy. */
export function assessWindowFailureRateV1(
  input: WindowFailureRateAssessmentInputV1,
): WindowFailureRateAssessmentV1 {
  const requestedWindow = validateRequestedWindow(input.requestedWindow);
  if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) {
    throw new WindowFailureRateScenarioError('INVALID_THRESHOLD');
  }
  if (!Number.isSafeInteger(input.minSamples) || input.minSamples <= 0) {
    throw new WindowFailureRateScenarioError('INVALID_MIN_SAMPLES');
  }

  const snapshot = parseWindowCountSnapshotV1(input.snapshot);
  if (snapshot.availability === 'unavailable') {
    return Object.freeze({
      status: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: snapshot.missingEvidence,
    });
  }

  if (snapshot.window.startUnixSeconds !== requestedWindow.startUnixSeconds
    || snapshot.window.endUnixSeconds !== requestedWindow.endUnixSeconds) {
    throw new WindowFailureRateScenarioError('WINDOW_MISMATCH');
  }

  if (snapshot.totalCount < input.minSamples) {
    return Object.freeze({
      status: 'insufficient_samples',
      sampleCount: snapshot.totalCount,
      minimumSamples: input.minSamples,
    });
  }

  const failureRate = snapshot.failureCount / snapshot.totalCount;
  return Object.freeze({
    status: 'complete',
    requestedWindow,
    successCount: snapshot.successCount,
    failureCount: snapshot.failureCount,
    totalCount: snapshot.totalCount,
    failureRate,
    threshold: input.threshold,
    thresholdReached: failureRate >= input.threshold,
  });
}

function validateRequestedWindow(input: HostAuthorizedRequestedWindowV1): HostAuthorizedRequestedWindowV1 {
  const record = requireRecord(input, 'INVALID_REQUESTED_WINDOW');
  if (!hasExactKeys(record, ['timestampUnit', 'startUnixSeconds', 'endUnixSeconds'])) {
    throw new WindowFailureRateScenarioError('INVALID_REQUESTED_WINDOW');
  }
  if (record.timestampUnit !== 'unix_seconds') {
    throw new WindowFailureRateScenarioError('INVALID_TIMESTAMP_UNIT');
  }

  const { startUnixSeconds, endUnixSeconds } = record;
  if (typeof startUnixSeconds !== 'number' || typeof endUnixSeconds !== 'number'
    || !Number.isFinite(startUnixSeconds) || !Number.isFinite(endUnixSeconds)
    || startUnixSeconds >= endUnixSeconds) {
    throw new WindowFailureRateScenarioError('INVALID_REQUESTED_WINDOW');
  }
  return Object.freeze({ timestampUnit: 'unix_seconds', startUnixSeconds, endUnixSeconds });
}

function requireRecord(value: unknown, code: WindowFailureRateScenarioErrorCode): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WindowFailureRateScenarioError(code);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWindowBoundaryEvidence(value: unknown): value is WindowCountMissingEvidenceV1 {
  return value === 'start_boundary' || value === 'end_boundary';
}

/**
 * Conclusion vocabulary for the frozen 1.1.0 assessment shape.
 *
 * The assessment object itself stays byte-identical (its implementation digest is
 * pinned by existing Target snapshots), so the S3 conclusion bounds are published
 * as this pure mapping instead of a new field. A future 1.2.0 may inline it.
 */
export function windowFailureRateConclusionsV1(
  assessment: WindowFailureRateAssessmentV1,
): ScenarioConclusionBounds {
  if (assessment.status === 'insufficient_samples') {
    return scenarioConclusionBounds(
      ['insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis'],
      ['metric_threshold_breached', 'metric_within_threshold'],
    );
  }
  if (assessment.status === 'unavailable') {
    return scenarioConclusionBounds(['missing_evidence_partial_diagnosis'], [
      'metric_threshold_breached', 'metric_within_threshold', 'insufficient_samples_no_attribution',
    ]);
  }
  return assessment.thresholdReached
    ? scenarioConclusionBounds(['metric_threshold_breached', 'correlation_not_root_cause'], [
      'metric_within_threshold', 'insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis',
    ])
    : scenarioConclusionBounds(['metric_within_threshold', 'correlation_not_root_cause'], [
      'metric_threshold_breached', 'insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis',
    ]);
}
