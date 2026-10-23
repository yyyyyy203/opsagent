import { checkpointChecksum } from '../../contracts/stable-json.js';
import { scenarioConclusionBounds, type ScenarioConclusionBounds } from './scenario-conclusions.js';
import {
  asReadonlyArray,
  isFiniteRatio,
  isNonnegativeSafeInteger,
  isPositiveSafeInteger,
  readExactRecord,
  readHostAuthorizedWindowV1,
  sortedUnique,
  type HostAuthorizedWindowV1,
  type ScenarioWindowErrorCode,
} from './scenario-window.js';

export const WINDOW_TRAFFIC_BASELINE_SCENARIO_ID = 'window_traffic_baseline.v1' as const;
export const WINDOW_TRAFFIC_BASELINE_SCENARIO_VERSION = '1.0.0' as const;
export const WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION = 'window_traffic_snapshot.v1' as const;

/*
 * Reviewed implementation identity. Bump the version whenever baseline alignment,
 * ratio semantics, precedence, or required input semantics change.
 */
const implementationDescriptor = Object.freeze({
  id: WINDOW_TRAFFIC_BASELINE_SCENARIO_ID,
  version: WINDOW_TRAFFIC_BASELINE_SCENARIO_VERSION,
  input: Object.freeze({
    schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: Object.freeze(['available', 'unavailable']),
    countSemantics: 'integer_window_snapshot',
    baseline: Object.freeze({
      availability: Object.freeze(['available', 'missing']),
      alignment: 'baseline_duration_equals_current_duration',
      ordering: 'baseline_end_not_after_current_start',
      missingEvidence: Object.freeze(['baseline_window', 'baseline_count']),
      neverInferred: true,
    }),
    requestedWindow: Object.freeze({
      authority: 'host_authorized',
      timestampUnit: 'unix_seconds',
      matching: 'fact_window_exactly_equals_requested_window',
    }),
    analysisParameters: Object.freeze({
      dropThresholdRatio: 'finite_ratio_inclusive_0_to_1',
      minSamples: 'positive_safe_integer',
    }),
  }),
  output: Object.freeze({
    assessmentDiscriminants: Object.freeze(['complete', 'baseline_missing', 'insufficient_samples', 'unavailable']),
    precedence: Object.freeze(['unavailable', 'baseline_missing', 'insufficient_samples', 'complete']),
    changeRatio: 'requestCount / baselineRequestCount - 1',
    dropRatio: '(baselineRequestCount - requestCount) / baselineRequestCount, negative means traffic increased',
    threshold: 'dropRatio >= configured_drop_threshold_ratio',
    minimumSamples: 'requestCount >= configured_min_samples',
    conclusions: 'stable_codes_with_always_forbidden_root_cause_and_system_health',
  }),
});

export const WINDOW_TRAFFIC_BASELINE_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

export const WINDOW_TRAFFIC_BASELINE_INSTALLATION_V1_0_0 = Object.freeze({
  id: WINDOW_TRAFFIC_BASELINE_SCENARIO_ID,
  version: WINDOW_TRAFFIC_BASELINE_SCENARIO_VERSION,
  implementationDigest: WINDOW_TRAFFIC_BASELINE_V1_0_0_IMPLEMENTATION_DIGEST,
});

/** Installable identities for this scenario family. */
export const WINDOW_TRAFFIC_BASELINE_INSTALLATIONS = Object.freeze([WINDOW_TRAFFIC_BASELINE_INSTALLATION_V1_0_0]);

export const WINDOW_TRAFFIC_BASELINE_IMPLEMENTATION_DIGEST = WINDOW_TRAFFIC_BASELINE_V1_0_0_IMPLEMENTATION_DIGEST;

export type WindowTrafficMissingEvidenceV1 = 'start_boundary' | 'end_boundary';
export type WindowTrafficBaselineMissingEvidenceV1 = 'baseline_window' | 'baseline_count';

export type WindowTrafficBaselineV1 =
  | Readonly<{
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    requestCount: number;
  }>
  | Readonly<{
    availability: 'missing';
    missingEvidence: readonly WindowTrafficBaselineMissingEvidenceV1[];
  }>;

export type WindowTrafficSnapshotV1 =
  | Readonly<{
    schemaVersion: typeof WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    requestCount: number;
    baseline: WindowTrafficBaselineV1;
  }>
  | Readonly<{
    schemaVersion: typeof WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly WindowTrafficMissingEvidenceV1[];
  }>;

export type WindowTrafficScenarioErrorCode =
  | ScenarioWindowErrorCode
  | 'INVALID_SNAPSHOT_SHAPE'
  | 'INVALID_SNAPSHOT_SCHEMA'
  | 'INVALID_SNAPSHOT_AVAILABILITY'
  | 'INVALID_MISSING_WINDOW_EVIDENCE'
  | 'INVALID_REQUEST_COUNT'
  | 'INVALID_BASELINE_SHAPE'
  | 'INVALID_BASELINE_AVAILABILITY'
  | 'INVALID_BASELINE_COUNT'
  | 'BASELINE_WINDOW_MISALIGNED'
  | 'BASELINE_OVERLAPS_CURRENT'
  | 'WINDOW_MISMATCH'
  | 'INVALID_DROP_THRESHOLD'
  | 'INVALID_MIN_SAMPLES';

export class WindowTrafficScenarioError extends Error {
  constructor(readonly code: WindowTrafficScenarioErrorCode) {
    super(code);
    this.name = 'WindowTrafficScenarioError';
  }
}

export interface WindowTrafficAssessmentInputV1 {
  snapshot: WindowTrafficSnapshotV1;
  requestedWindow: HostAuthorizedWindowV1;
  dropThresholdRatio: number;
  minSamples: number;
}

export type WindowTrafficAssessmentV1 =
  | Readonly<{
    status: 'complete';
    requestedWindow: HostAuthorizedWindowV1;
    requestCount: number;
    baselineWindow: HostAuthorizedWindowV1;
    baselineRequestCount: number;
    changeRatio: number;
    dropRatio: number;
    dropThresholdRatio: number;
    dropThresholdReached: boolean;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'baseline_missing';
    requestedWindow: HostAuthorizedWindowV1;
    requestCount: number;
    missingEvidence: readonly WindowTrafficBaselineMissingEvidenceV1[];
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
    missingEvidence: readonly WindowTrafficMissingEvidenceV1[];
    conclusions: ScenarioConclusionBounds;
  }>;

function fail(code: WindowTrafficScenarioErrorCode): never {
  throw new WindowTrafficScenarioError(code);
}

/** Validate an untrusted serialized fact and return only the versioned typed shape. */
export function parseWindowTrafficSnapshotV1(input: unknown): WindowTrafficSnapshotV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_SNAPSHOT_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'unavailable') fail('INVALID_SNAPSHOT_AVAILABILITY');
  const keys = availability === 'available'
    ? ['schemaVersion', 'availability', 'timestampUnit', 'window', 'requestCount', 'baseline']
    : ['schemaVersion', 'availability', 'reason', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_SNAPSHOT_SHAPE'));
  if (record.schemaVersion !== WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION) fail('INVALID_SNAPSHOT_SCHEMA');

  if (availability === 'unavailable') {
    if (record.reason !== 'missing_window_evidence') fail('INVALID_MISSING_WINDOW_EVIDENCE');
    return Object.freeze({
      schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: readWindowMissingEvidence(record.missingEvidence),
    });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const requestCount = record.requestCount;
  if (!isNonnegativeSafeInteger(requestCount)) throw new WindowTrafficScenarioError('INVALID_REQUEST_COUNT');
  return Object.freeze({
    schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window,
    requestCount,
    baseline: parseBaseline(record.baseline, window),
  });
}

/** Deterministically assess one typed traffic snapshot against its aligned baseline window. */
export function assessWindowTrafficBaselineV1(input: WindowTrafficAssessmentInputV1): WindowTrafficAssessmentV1 {
  const requestedWindow = readHostAuthorizedWindowV1(input.requestedWindow, fail);
  const dropThresholdRatio = input.dropThresholdRatio;
  if (!isFiniteRatio(dropThresholdRatio)) throw new WindowTrafficScenarioError('INVALID_DROP_THRESHOLD');
  const minSamples = input.minSamples;
  if (!isPositiveSafeInteger(minSamples)) throw new WindowTrafficScenarioError('INVALID_MIN_SAMPLES');

  const snapshot = parseWindowTrafficSnapshotV1(input.snapshot);
  if (snapshot.availability === 'unavailable') {
    return Object.freeze({
      status: 'unavailable',
      requestedWindow,
      reason: 'missing_window_evidence',
      missingEvidence: snapshot.missingEvidence,
      conclusions: scenarioConclusionBounds(['missing_evidence_partial_diagnosis'], [
        'metric_threshold_breached', 'metric_within_threshold', 'baseline_comparison_valid',
        'baseline_unavailable_no_comparison', 'insufficient_samples_no_attribution',
      ]),
    });
  }

  if (snapshot.window.startUnixSeconds !== requestedWindow.startUnixSeconds
    || snapshot.window.endUnixSeconds !== requestedWindow.endUnixSeconds) fail('WINDOW_MISMATCH');

  // Missing baselines stay visible before any sufficiency judgement: without a
  // baseline the scenario must never invent a comparison.
  if (snapshot.baseline.availability === 'missing') {
    return Object.freeze({
      status: 'baseline_missing',
      requestedWindow,
      requestCount: snapshot.requestCount,
      missingEvidence: snapshot.baseline.missingEvidence,
      conclusions: scenarioConclusionBounds(
        ['baseline_unavailable_no_comparison', 'missing_evidence_partial_diagnosis'],
        ['metric_threshold_breached', 'metric_within_threshold', 'baseline_comparison_valid',
          'insufficient_samples_no_attribution'],
      ),
    });
  }

  if (snapshot.requestCount < minSamples) {
    return Object.freeze({
      status: 'insufficient_samples',
      requestedWindow,
      sampleCount: snapshot.requestCount,
      minimumSamples: minSamples,
      conclusions: scenarioConclusionBounds(
        ['insufficient_samples_no_attribution', 'missing_evidence_partial_diagnosis'],
        ['metric_threshold_breached', 'metric_within_threshold', 'baseline_comparison_valid'],
      ),
    });
  }

  const baselineRequestCount = snapshot.baseline.requestCount;
  const changeRatio = snapshot.requestCount / baselineRequestCount - 1;
  const dropRatio = (baselineRequestCount - snapshot.requestCount) / baselineRequestCount;
  const dropThresholdReached = dropRatio >= dropThresholdRatio;
  return Object.freeze({
    status: 'complete',
    requestedWindow,
    requestCount: snapshot.requestCount,
    baselineWindow: snapshot.baseline.window,
    baselineRequestCount,
    changeRatio,
    dropRatio,
    dropThresholdRatio,
    dropThresholdReached,
    conclusions: dropThresholdReached
      ? scenarioConclusionBounds(
        ['metric_threshold_breached', 'baseline_comparison_valid', 'correlation_not_root_cause'],
        ['metric_within_threshold', 'baseline_unavailable_no_comparison', 'insufficient_samples_no_attribution'],
      )
      : scenarioConclusionBounds(
        ['metric_within_threshold', 'baseline_comparison_valid', 'correlation_not_root_cause'],
        ['metric_threshold_breached', 'baseline_unavailable_no_comparison', 'insufficient_samples_no_attribution'],
      ),
  });
}

function parseBaseline(input: unknown, current: HostAuthorizedWindowV1): WindowTrafficBaselineV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_BASELINE_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'missing') fail('INVALID_BASELINE_AVAILABILITY');
  const keys = availability === 'available'
    ? ['availability', 'timestampUnit', 'window', 'requestCount']
    : ['availability', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_BASELINE_SHAPE'));

  if (availability === 'missing') {
    const items = asReadonlyArray(record.missingEvidence);
    if (items === undefined || items.length === 0) fail('INVALID_MISSING_WINDOW_EVIDENCE');
    const codes: WindowTrafficBaselineMissingEvidenceV1[] = [];
    for (const item of items) {
      if (item !== 'baseline_window' && item !== 'baseline_count') {
        throw new WindowTrafficScenarioError('INVALID_MISSING_WINDOW_EVIDENCE');
      }
      if (codes.includes(item)) fail('INVALID_MISSING_WINDOW_EVIDENCE');
      codes.push(item);
    }
    return Object.freeze({ availability: 'missing', missingEvidence: sortedUnique(codes) });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const requestCount = record.requestCount;
  if (!isPositiveSafeInteger(requestCount)) throw new WindowTrafficScenarioError('INVALID_BASELINE_COUNT');
  const currentDuration = current.endUnixSeconds - current.startUnixSeconds;
  const baselineDuration = window.endUnixSeconds - window.startUnixSeconds;
  if (baselineDuration !== currentDuration) fail('BASELINE_WINDOW_MISALIGNED');
  if (window.endUnixSeconds > current.startUnixSeconds) fail('BASELINE_OVERLAPS_CURRENT');
  return Object.freeze({ availability: 'available', timestampUnit: 'unix_seconds', window, requestCount });
}

function readWindowMissingEvidence(value: unknown): readonly WindowTrafficMissingEvidenceV1[] {
  const items = asReadonlyArray(value);
  if (items === undefined || items.length === 0) fail('INVALID_MISSING_WINDOW_EVIDENCE');
  const codes: WindowTrafficMissingEvidenceV1[] = [];
  for (const item of items) {
    if (item !== 'start_boundary' && item !== 'end_boundary') {
      throw new WindowTrafficScenarioError('INVALID_MISSING_WINDOW_EVIDENCE');
    }
    if (codes.includes(item)) fail('INVALID_MISSING_WINDOW_EVIDENCE');
    codes.push(item);
  }
  return sortedUnique(codes);
}
