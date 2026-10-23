import { checkpointChecksum } from '../../contracts/stable-json.js';
import { scenarioConclusionBounds, type ScenarioConclusionBounds } from './scenario-conclusions.js';
import {
  asReadonlyArray,
  isFiniteNonnegativeNumber,
  isPositiveSafeInteger,
  readExactRecord,
  readHostAuthorizedWindowV1,
  sortedUnique,
  type HostAuthorizedWindowV1,
  type ScenarioWindowErrorCode,
} from './scenario-window.js';

export const WINDOW_LATENCY_SCENARIO_ID = 'window_latency.v1' as const;
export const WINDOW_LATENCY_SCENARIO_VERSION = '1.0.0' as const;
export const WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION = 'window_latency_snapshot.v1' as const;

/*
 * Reviewed implementation identity. Bump the version whenever interpretation,
 * boundary comparison, quantile ordering, or required input semantics change.
 */
const implementationDescriptor = Object.freeze({
  id: WINDOW_LATENCY_SCENARIO_ID,
  version: WINDOW_LATENCY_SCENARIO_VERSION,
  input: Object.freeze({
    schemaVersion: WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: Object.freeze(['available', 'unavailable']),
    quantileUnit: 'milliseconds',
    computation: Object.freeze(['source_histogram_bucket', 'source_precomputed_quantile']),
    availableFact: Object.freeze({
      timestampUnit: 'unix_seconds',
      window: Object.freeze(['startUnixSeconds', 'endUnixSeconds']),
      fields: Object.freeze(['sampleCount', 'p50Ms', 'p95Ms', 'p99Ms', 'computation']),
      invariants: Object.freeze([
        'finite_window_boundaries',
        'start_precedes_end',
        'positive_safe_integer_sample_count',
        'finite_nonnegative_quantiles',
        'p50_not_greater_than_p95',
        'p95_not_greater_than_p99',
        'declared_computation_method',
      ]),
    }),
    unavailableFact: Object.freeze({
      reason: 'missing_window_evidence',
      missingEvidence: Object.freeze(['start_boundary', 'end_boundary', 'latency_series']),
    }),
    requestedWindow: Object.freeze({
      authority: 'host_authorized',
      timestampUnit: 'unix_seconds',
      matching: 'fact_window_exactly_equals_requested_window',
    }),
    analysisParameters: Object.freeze({
      p95ThresholdMs: 'finite_positive_number',
      minSamples: 'positive_safe_integer',
    }),
  }),
  output: Object.freeze({
    assessmentDiscriminants: Object.freeze(['complete', 'insufficient_samples', 'unavailable']),
    threshold: 'p95Ms >= configured_p95_threshold_ms',
    minimumSamples: 'sampleCount >= configured_min_samples',
    conclusions: 'stable_codes_with_always_forbidden_root_cause_and_system_health',
  }),
});

export const WINDOW_LATENCY_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

export const WINDOW_LATENCY_INSTALLATION_V1_0_0 = Object.freeze({
  id: WINDOW_LATENCY_SCENARIO_ID,
  version: WINDOW_LATENCY_SCENARIO_VERSION,
  implementationDigest: WINDOW_LATENCY_V1_0_0_IMPLEMENTATION_DIGEST,
});

/** Installable identities for this scenario family. */
export const WINDOW_LATENCY_INSTALLATIONS = Object.freeze([WINDOW_LATENCY_INSTALLATION_V1_0_0]);

export const WINDOW_LATENCY_IMPLEMENTATION_DIGEST = WINDOW_LATENCY_V1_0_0_IMPLEMENTATION_DIGEST;

export type WindowLatencyMissingEvidenceV1 = 'start_boundary' | 'end_boundary' | 'latency_series';
export type WindowLatencyComputationV1 = 'source_histogram_bucket' | 'source_precomputed_quantile';

export type WindowLatencySnapshotV1 =
  | Readonly<{
    schemaVersion: typeof WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    computation: WindowLatencyComputationV1;
  }>
  | Readonly<{
    schemaVersion: typeof WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly WindowLatencyMissingEvidenceV1[];
  }>;

export type WindowLatencyScenarioErrorCode =
  | ScenarioWindowErrorCode
  | 'INVALID_SNAPSHOT_SHAPE'
  | 'INVALID_SNAPSHOT_SCHEMA'
  | 'INVALID_SNAPSHOT_AVAILABILITY'
  | 'INVALID_MISSING_WINDOW_EVIDENCE'
  | 'INVALID_COMPUTATION'
  | 'INVALID_SAMPLE_COUNT'
  | 'INVALID_QUANTILE'
  | 'NON_MONOTONIC_QUANTILES'
  | 'WINDOW_MISMATCH'
  | 'INVALID_THRESHOLD'
  | 'INVALID_MIN_SAMPLES';

export class WindowLatencyScenarioError extends Error {
  constructor(readonly code: WindowLatencyScenarioErrorCode) {
    super(code);
    this.name = 'WindowLatencyScenarioError';
  }
}

export interface WindowLatencyAssessmentInputV1 {
  snapshot: WindowLatencySnapshotV1;
  requestedWindow: HostAuthorizedWindowV1;
  p95ThresholdMs: number;
  minSamples: number;
}

export type WindowLatencyAssessmentV1 =
  | Readonly<{
    status: 'complete';
    requestedWindow: HostAuthorizedWindowV1;
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    computation: WindowLatencyComputationV1;
    thresholdMs: number;
    thresholdReached: boolean;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'insufficient_samples';
    requestedWindow: HostAuthorizedWindowV1;
    sampleCount: number;
    minimumSamples: number;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'unavailable';
    requestedWindow: HostAuthorizedWindowV1;
    reason: 'missing_window_evidence';
    missingEvidence: readonly WindowLatencyMissingEvidenceV1[];
    conclusions: ScenarioConclusionBounds;
  }>;

function fail(code: WindowLatencyScenarioErrorCode): never {
  throw new WindowLatencyScenarioError(code);
}

/** Validate an untrusted serialized fact and return only the versioned typed shape. */
export function parseWindowLatencySnapshotV1(input: unknown): WindowLatencySnapshotV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_SNAPSHOT_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'unavailable') fail('INVALID_SNAPSHOT_AVAILABILITY');
  const keys = availability === 'available'
    ? ['schemaVersion', 'availability', 'timestampUnit', 'window', 'sampleCount', 'p50Ms', 'p95Ms', 'p99Ms', 'computation']
    : ['schemaVersion', 'availability', 'reason', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_SNAPSHOT_SHAPE'));
  if (record.schemaVersion !== WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION) fail('INVALID_SNAPSHOT_SCHEMA');

  if (availability === 'unavailable') {
    if (record.reason !== 'missing_window_evidence') fail('INVALID_MISSING_WINDOW_EVIDENCE');
    return Object.freeze({
      schemaVersion: WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: readMissingEvidence(record.missingEvidence),
    });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const sampleCount = record.sampleCount;
  if (!isPositiveSafeInteger(sampleCount)) throw new WindowLatencyScenarioError('INVALID_SAMPLE_COUNT');
  const p50Ms = record.p50Ms;
  const p95Ms = record.p95Ms;
  const p99Ms = record.p99Ms;
  if (!isFiniteNonnegativeNumber(p50Ms) || !isFiniteNonnegativeNumber(p95Ms) || !isFiniteNonnegativeNumber(p99Ms)) {
    throw new WindowLatencyScenarioError('INVALID_QUANTILE');
  }
  if (p50Ms > p95Ms || p95Ms > p99Ms) fail('NON_MONOTONIC_QUANTILES');
  const computation = record.computation;
  if (!isWindowLatencyComputation(computation)) throw new WindowLatencyScenarioError('INVALID_COMPUTATION');
  return Object.freeze({
    schemaVersion: WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window,
    sampleCount,
    p50Ms,
    p95Ms,
    p99Ms,
    computation,
  });
}

/** Deterministically assess one typed latency snapshot against the host-authorized window. */
export function assessWindowLatencyV1(input: WindowLatencyAssessmentInputV1): WindowLatencyAssessmentV1 {
  const requestedWindow = readHostAuthorizedWindowV1(input.requestedWindow, fail);
  const thresholdMs = input.p95ThresholdMs;
  if (!isFiniteNonnegativeNumber(thresholdMs) || thresholdMs <= 0) throw new WindowLatencyScenarioError('INVALID_THRESHOLD');
  const minSamples = input.minSamples;
  if (!isPositiveSafeInteger(minSamples)) throw new WindowLatencyScenarioError('INVALID_MIN_SAMPLES');

  const snapshot = parseWindowLatencySnapshotV1(input.snapshot);
  if (snapshot.availability === 'unavailable') {
    return Object.freeze({
      status: 'unavailable',
      requestedWindow,
      reason: 'missing_window_evidence',
      missingEvidence: snapshot.missingEvidence,
      conclusions: scenarioConclusionBounds(['missing_evidence_partial_diagnosis'], [
        'metric_threshold_breached', 'metric_within_threshold', 'insufficient_samples_no_attribution',
        'resource_saturation_confirmed', 'resource_saturation_candidate',
      ]),
    });
  }

  if (snapshot.window.startUnixSeconds !== requestedWindow.startUnixSeconds
    || snapshot.window.endUnixSeconds !== requestedWindow.endUnixSeconds) fail('WINDOW_MISMATCH');

  if (snapshot.sampleCount < minSamples) {
    return Object.freeze({
      status: 'insufficient_samples',
      requestedWindow,
      sampleCount: snapshot.sampleCount,
      minimumSamples: minSamples,
      conclusions: scenarioConclusionBounds(
        ['insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis'],
        ['metric_threshold_breached', 'metric_within_threshold', 'resource_saturation_confirmed'],
      ),
    });
  }

  const thresholdReached = snapshot.p95Ms >= thresholdMs;
  return Object.freeze({
    status: 'complete',
    requestedWindow,
    sampleCount: snapshot.sampleCount,
    p50Ms: snapshot.p50Ms,
    p95Ms: snapshot.p95Ms,
    p99Ms: snapshot.p99Ms,
    computation: snapshot.computation,
    thresholdMs,
    thresholdReached,
    conclusions: thresholdReached
      ? scenarioConclusionBounds(['metric_threshold_breached', 'correlation_not_root_cause'], [
        'metric_within_threshold', 'insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis',
      ])
      : scenarioConclusionBounds(['metric_within_threshold', 'correlation_not_root_cause'], [
        'metric_threshold_breached', 'insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis',
      ]),
  });
}

function readMissingEvidence(value: unknown): readonly WindowLatencyMissingEvidenceV1[] {
  const items = asReadonlyArray(value);
  if (items === undefined || items.length === 0) fail('INVALID_MISSING_WINDOW_EVIDENCE');
  const codes: WindowLatencyMissingEvidenceV1[] = [];
  for (const item of items) {
    if (!isWindowLatencyMissingEvidence(item)) throw new WindowLatencyScenarioError('INVALID_MISSING_WINDOW_EVIDENCE');
    if (codes.includes(item)) fail('INVALID_MISSING_WINDOW_EVIDENCE');
    codes.push(item);
  }
  return sortedUnique(codes);
}

function isWindowLatencyComputation(value: unknown): value is WindowLatencyComputationV1 {
  return value === 'source_histogram_bucket' || value === 'source_precomputed_quantile';
}

function isWindowLatencyMissingEvidence(value: unknown): value is WindowLatencyMissingEvidenceV1 {
  return value === 'start_boundary' || value === 'end_boundary' || value === 'latency_series';
}
