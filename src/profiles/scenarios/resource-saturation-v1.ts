import { checkpointChecksum } from '../../contracts/stable-json.js';
import { scenarioConclusionBounds, type ScenarioConclusionBounds } from './scenario-conclusions.js';
import {
  asReadonlyArray,
  isFiniteRatio,
  readExactRecord,
  readHostAuthorizedWindowV1,
  sortedUnique,
  type HostAuthorizedWindowV1,
  type ScenarioWindowErrorCode,
} from './scenario-window.js';

export const RESOURCE_SATURATION_SCENARIO_ID = 'resource_saturation.v1' as const;
export const RESOURCE_SATURATION_SCENARIO_VERSION = '1.0.0' as const;
export const WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION = 'window_resource_snapshot.v1' as const;
export const RESOURCE_SIGNAL_KINDS_V1 = Object.freeze(['cpu', 'memory', 'disk', 'thread_pool'] as const);
export const RESOURCE_SIGNAL_LIMIT_V1 = RESOURCE_SIGNAL_KINDS_V1.length;

/*
 * Reviewed implementation identity. One breached signal is a candidate only;
 * confirmation requires the configured minimum number of independent signals.
 */
const implementationDescriptor = Object.freeze({
  id: RESOURCE_SATURATION_SCENARIO_ID,
  version: RESOURCE_SATURATION_SCENARIO_VERSION,
  input: Object.freeze({
    schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: Object.freeze(['available', 'unavailable']),
    signals: Object.freeze({
      kinds: RESOURCE_SIGNAL_KINDS_V1,
      uniqueKinds: true,
      limit: RESOURCE_SIGNAL_LIMIT_V1,
      utilization: 'finite_ratio_inclusive_0_to_1',
      computation: Object.freeze(['gauge_window_avg', 'gauge_window_max']),
    }),
    unavailableFact: Object.freeze({
      reason: 'missing_window_evidence',
      missingEvidence: Object.freeze(['start_boundary', 'end_boundary', 'resource_series']),
    }),
    requestedWindow: Object.freeze({
      authority: 'host_authorized',
      timestampUnit: 'unix_seconds',
      matching: 'fact_window_exactly_equals_requested_window',
    }),
    analysisParameters: Object.freeze({
      thresholds: 'finite_ratio_exclusive_0_to_1_for_every_signal_kind',
      minSignalsForConfirmation: 'safe_integer_at_least_2',
    }),
  }),
  output: Object.freeze({
    assessmentDiscriminants: Object.freeze([
      'saturated', 'candidate_only', 'within_threshold', 'unavailable',
    ]),
    precedence: Object.freeze([
      'unavailable_when_window_evidence_missing',
      'saturated_when_breached_and_signal_count_meets_confirmation_minimum',
      'candidate_only_when_breached_below_confirmation_minimum',
      'within_threshold_when_nothing_breached',
    ]),
    threshold: 'utilizationRatio >= configured_threshold_for_that_signal_kind',
    conclusions: 'stable_codes_with_always_forbidden_root_cause_and_system_health',
  }),
});

export const RESOURCE_SATURATION_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

export const RESOURCE_SATURATION_INSTALLATION_V1_0_0 = Object.freeze({
  id: RESOURCE_SATURATION_SCENARIO_ID,
  version: RESOURCE_SATURATION_SCENARIO_VERSION,
  implementationDigest: RESOURCE_SATURATION_V1_0_0_IMPLEMENTATION_DIGEST,
});

/** Installable identities for this scenario family. */
export const RESOURCE_SATURATION_INSTALLATIONS = Object.freeze([RESOURCE_SATURATION_INSTALLATION_V1_0_0]);

export const RESOURCE_SATURATION_IMPLEMENTATION_DIGEST = RESOURCE_SATURATION_V1_0_0_IMPLEMENTATION_DIGEST;

export type ResourceSignalKindV1 = (typeof RESOURCE_SIGNAL_KINDS_V1)[number];
export type ResourceSignalComputationV1 = 'gauge_window_avg' | 'gauge_window_max';
export type ResourceMissingEvidenceV1 = 'start_boundary' | 'end_boundary' | 'resource_series';

export interface ResourceSignalV1 {
  readonly kind: ResourceSignalKindV1;
  readonly utilizationRatio: number;
  readonly computation: ResourceSignalComputationV1;
}

export type WindowResourceSnapshotV1 =
  | Readonly<{
    schemaVersion: typeof WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    signals: readonly ResourceSignalV1[];
  }>
  | Readonly<{
    schemaVersion: typeof WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION;
    availability: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly ResourceMissingEvidenceV1[];
  }>;

export type ResourceSaturationScenarioErrorCode =
  | ScenarioWindowErrorCode
  | 'INVALID_SNAPSHOT_SHAPE'
  | 'INVALID_SNAPSHOT_SCHEMA'
  | 'INVALID_SNAPSHOT_AVAILABILITY'
  | 'INVALID_MISSING_WINDOW_EVIDENCE'
  | 'INVALID_SIGNAL_SHAPE'
  | 'INVALID_SIGNAL_KIND'
  | 'DUPLICATE_SIGNAL_KIND'
  | 'INVALID_UTILIZATION'
  | 'INVALID_COMPUTATION'
  | 'SIGNALS_EMPTY'
  | 'SIGNALS_LIMIT_EXCEEDED'
  | 'WINDOW_MISMATCH'
  | 'INVALID_THRESHOLD'
  | 'INVALID_MIN_SIGNALS';

export class ResourceSaturationScenarioError extends Error {
  constructor(readonly code: ResourceSaturationScenarioErrorCode) {
    super(code);
    this.name = 'ResourceSaturationScenarioError';
  }
}

export type ResourceThresholdsV1 = Readonly<Record<ResourceSignalKindV1, number>>;

export interface ResourceSaturationAssessmentInputV1 {
  snapshot: WindowResourceSnapshotV1;
  requestedWindow: HostAuthorizedWindowV1;
  thresholds: ResourceThresholdsV1;
  minSignalsForConfirmation: number;
}

export interface ResourceSignalAssessmentV1 {
  readonly kind: ResourceSignalKindV1;
  readonly utilizationRatio: number;
  readonly threshold: number;
  readonly thresholdReached: boolean;
  readonly computation: ResourceSignalComputationV1;
}

export type ResourceSaturationAssessmentV1 =
  | Readonly<{
    status: 'saturated' | 'candidate_only' | 'within_threshold';
    requestedWindow: HostAuthorizedWindowV1;
    signalCount: number;
    signals: readonly ResourceSignalAssessmentV1[];
    breachedKinds: readonly ResourceSignalKindV1[];
    minimumSignalsForConfirmation: number;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'unavailable';
    requestedWindow: HostAuthorizedWindowV1;
    reason: 'missing_window_evidence';
    missingEvidence: readonly ResourceMissingEvidenceV1[];
    conclusions: ScenarioConclusionBounds;
  }>;

function fail(code: ResourceSaturationScenarioErrorCode): never {
  throw new ResourceSaturationScenarioError(code);
}

/** Validate an untrusted serialized fact and return only the versioned typed shape. */
export function parseWindowResourceSnapshotV1(input: unknown): WindowResourceSnapshotV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_SNAPSHOT_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'unavailable') fail('INVALID_SNAPSHOT_AVAILABILITY');
  const keys = availability === 'available'
    ? ['schemaVersion', 'availability', 'timestampUnit', 'window', 'signals']
    : ['schemaVersion', 'availability', 'reason', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_SNAPSHOT_SHAPE'));
  if (record.schemaVersion !== WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION) fail('INVALID_SNAPSHOT_SCHEMA');

  if (availability === 'unavailable') {
    if (record.reason !== 'missing_window_evidence') fail('INVALID_MISSING_WINDOW_EVIDENCE');
    const items = asReadonlyArray(record.missingEvidence);
    if (items === undefined || items.length === 0) fail('INVALID_MISSING_WINDOW_EVIDENCE');
    const codes: ResourceMissingEvidenceV1[] = [];
    for (const item of items) {
      if (item !== 'start_boundary' && item !== 'end_boundary' && item !== 'resource_series') {
        throw new ResourceSaturationScenarioError('INVALID_MISSING_WINDOW_EVIDENCE');
      }
      if (codes.includes(item)) fail('INVALID_MISSING_WINDOW_EVIDENCE');
      codes.push(item);
    }
    return Object.freeze({
      schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: sortedUnique(codes),
    });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const items = asReadonlyArray(record.signals);
  if (items === undefined) fail('INVALID_SIGNAL_SHAPE');
  if (items.length === 0) fail('SIGNALS_EMPTY');
  if (items.length > RESOURCE_SIGNAL_LIMIT_V1) fail('SIGNALS_LIMIT_EXCEEDED');
  const signals = items.map((item) => parseSignal(item));
  const kinds = signals.map((signal) => signal.kind);
  if (new Set(kinds).size !== kinds.length) fail('DUPLICATE_SIGNAL_KIND');
  return Object.freeze({
    schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window,
    signals: Object.freeze(signals),
  });
}

/** Deterministically assess resource signals against per-kind thresholds inside one window. */
export function assessResourceSaturationV1(
  input: ResourceSaturationAssessmentInputV1,
): ResourceSaturationAssessmentV1 {
  const requestedWindow = readHostAuthorizedWindowV1(input.requestedWindow, fail);
  const thresholds = readThresholds(input.thresholds);
  const minSignalsForConfirmation = input.minSignalsForConfirmation;
  if (!Number.isSafeInteger(minSignalsForConfirmation) || minSignalsForConfirmation < 2) {
    throw new ResourceSaturationScenarioError('INVALID_MIN_SIGNALS');
  }

  const snapshot = parseWindowResourceSnapshotV1(input.snapshot);
  if (snapshot.availability === 'unavailable') {
    return Object.freeze({
      status: 'unavailable',
      requestedWindow,
      reason: 'missing_window_evidence',
      missingEvidence: snapshot.missingEvidence,
      conclusions: scenarioConclusionBounds(['missing_evidence_partial_diagnosis'], [
        'metric_threshold_breached', 'metric_within_threshold', 'resource_saturation_confirmed',
        'resource_saturation_candidate', 'insufficient_samples_no_attribution',
      ]),
    });
  }

  if (snapshot.window.startUnixSeconds !== requestedWindow.startUnixSeconds
    || snapshot.window.endUnixSeconds !== requestedWindow.endUnixSeconds) fail('WINDOW_MISMATCH');

  const signals: ResourceSignalAssessmentV1[] = snapshot.signals.map((signal) => {
    const threshold = thresholds[signal.kind];
    return Object.freeze({
      kind: signal.kind,
      utilizationRatio: signal.utilizationRatio,
      threshold,
      thresholdReached: signal.utilizationRatio >= threshold,
      computation: signal.computation,
    });
  });
  const breachedKinds = sortedUnique(signals.filter((signal) => signal.thresholdReached).map((signal) => signal.kind));
  const signalCount = signals.length;
  const shared = {
    requestedWindow,
    signalCount,
    signals: Object.freeze(signals),
    breachedKinds,
    minimumSignalsForConfirmation: minSignalsForConfirmation,
  };

  if (breachedKinds.length === 0) {
    return Object.freeze({
      ...shared,
      status: 'within_threshold',
      conclusions: signalCount < minSignalsForConfirmation
        ? scenarioConclusionBounds(
          ['metric_within_threshold', 'missing_evidence_partial_diagnosis', 'correlation_not_root_cause'],
          ['metric_threshold_breached', 'resource_saturation_confirmed', 'resource_saturation_candidate'],
        )
        : scenarioConclusionBounds(['metric_within_threshold', 'correlation_not_root_cause'], [
          'metric_threshold_breached', 'resource_saturation_confirmed', 'resource_saturation_candidate',
          'missing_evidence_partial_diagnosis',
        ]),
    });
  }

  if (signalCount < minSignalsForConfirmation) {
    return Object.freeze({
      ...shared,
      status: 'candidate_only',
      conclusions: scenarioConclusionBounds(
        ['resource_saturation_candidate', 'missing_evidence_partial_diagnosis', 'correlation_not_root_cause'],
        ['resource_saturation_confirmed', 'metric_within_threshold', 'metric_threshold_breached',
          'insufficient_samples_no_attribution'],
      ),
    });
  }

  return Object.freeze({
    ...shared,
    status: 'saturated',
    conclusions: scenarioConclusionBounds(
      ['resource_saturation_confirmed', 'metric_threshold_breached', 'correlation_not_root_cause'],
      ['resource_saturation_candidate', 'metric_within_threshold', 'missing_evidence_partial_diagnosis'],
    ),
  });
}

function readThresholds(input: unknown): ResourceThresholdsV1 {
  const record = readExactRecord(input, [...RESOURCE_SIGNAL_KINDS_V1], () => fail('INVALID_THRESHOLD'));
  const thresholds = {} as Record<ResourceSignalKindV1, number>;
  for (const kind of RESOURCE_SIGNAL_KINDS_V1) {
    const value = record[kind];
    if (!isFiniteRatio(value) || value <= 0 || value >= 1) throw new ResourceSaturationScenarioError('INVALID_THRESHOLD');
    thresholds[kind] = value;
  }
  return Object.freeze(thresholds);
}

function parseSignal(input: unknown): ResourceSignalV1 {
  const record = readExactRecord(input, ['kind', 'utilizationRatio', 'computation'], () => fail('INVALID_SIGNAL_SHAPE'));
  const kind = record.kind;
  if (!isResourceSignalKind(kind)) throw new ResourceSaturationScenarioError('INVALID_SIGNAL_KIND');
  const utilizationRatio = record.utilizationRatio;
  if (!isFiniteRatio(utilizationRatio)) throw new ResourceSaturationScenarioError('INVALID_UTILIZATION');
  const computation = record.computation;
  if (computation !== 'gauge_window_avg' && computation !== 'gauge_window_max') {
    throw new ResourceSaturationScenarioError('INVALID_COMPUTATION');
  }
  return Object.freeze({ kind, utilizationRatio, computation });
}

function isResourceSignalKind(value: unknown): value is ResourceSignalKindV1 {
  return typeof value === 'string' && (RESOURCE_SIGNAL_KINDS_V1 as readonly string[]).includes(value);
}

/** Reject thresholds that no installed profile may use; keeps host config honest at load time. */
export function assertResourceThresholdsV1(thresholds: unknown): ResourceThresholdsV1 {
  return readThresholds(thresholds);
}
