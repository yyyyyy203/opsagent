import { checkpointChecksum } from '../../contracts/stable-json.js';
import { scenarioConclusionBounds, type ScenarioConclusionBounds } from './scenario-conclusions.js';
import {
  asReadonlyArray,
  isNonnegativeSafeInteger,
  isPositiveSafeInteger,
  readExactRecord,
  readHostAuthorizedWindowV1,
  sortedUnique,
  type HostAuthorizedWindowV1,
  type ScenarioWindowErrorCode,
} from './scenario-window.js';

export const DEPENDENCY_CORRELATION_SCENARIO_ID = 'dependency_correlation.v1' as const;
export const DEPENDENCY_CORRELATION_SCENARIO_VERSION = '1.0.0' as const;
export const DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION = 'dependency_window_snapshot.v1' as const;
export const DEPENDENCY_LOG_RECORD_LIMIT_V1 = 50;
export const DEPENDENCY_ID_MAX_BYTES_V1 = 128;

/*
 * Reviewed implementation identity. Window correlation can only ever produce an
 * association; proving a root cause needs evidence outside this scenario.
 */
const implementationDescriptor = Object.freeze({
  id: DEPENDENCY_CORRELATION_SCENARIO_ID,
  version: DEPENDENCY_CORRELATION_SCENARIO_VERSION,
  input: Object.freeze({
    schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
    facts: Object.freeze(['upstreamErrors', 'dependencyLogs']),
    upstreamAvailability: Object.freeze(['available', 'unavailable']),
    logAvailability: Object.freeze(['available', 'unavailable']),
    logRecord: Object.freeze({
      fields: Object.freeze(['timestampUnixSeconds', 'level', 'dependencyId']),
      levels: Object.freeze(['ERROR', 'WARN', 'INFO']),
      unknownIdentity: 'dependencyId null means the source did not attribute the record',
      recordLimit: DEPENDENCY_LOG_RECORD_LIMIT_V1,
      containment: 'start_inclusive_end_exclusive_inside_requested_window',
    }),
    requestedWindow: Object.freeze({
      authority: 'host_authorized',
      timestampUnit: 'unix_seconds',
      matching: 'both_fact_windows_exactly_equal_requested_window',
    }),
    analysisParameters: Object.freeze({
      minErrorCount: 'positive_safe_integer',
      minCorroboratingRecords: 'positive_safe_integer',
    }),
  }),
  output: Object.freeze({
    assessmentDiscriminants: Object.freeze([
      'corroborated', 'time_overlap_only', 'no_correlation', 'insufficient_evidence',
    ]),
    precedence: Object.freeze([
      'insufficient_evidence_when_any_fact_unavailable',
      'no_correlation_below_min_error_count',
      'insufficient_evidence_when_no_log_records',
      'corroborated_when_identity_and_level_match',
      'time_overlap_only_otherwise',
    ]),
    corroboration: 'ERROR records whose dependencyId equals the upstream dependencyId',
    rootCause: 'never established by window correlation alone',
    conclusions: 'stable_codes_with_always_forbidden_root_cause_and_system_health',
  }),
});

export const DEPENDENCY_CORRELATION_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

export const DEPENDENCY_CORRELATION_INSTALLATION_V1_0_0 = Object.freeze({
  id: DEPENDENCY_CORRELATION_SCENARIO_ID,
  version: DEPENDENCY_CORRELATION_SCENARIO_VERSION,
  implementationDigest: DEPENDENCY_CORRELATION_V1_0_0_IMPLEMENTATION_DIGEST,
});

/** Installable identities for this scenario family. */
export const DEPENDENCY_CORRELATION_INSTALLATIONS = Object.freeze([DEPENDENCY_CORRELATION_INSTALLATION_V1_0_0]);

export const DEPENDENCY_CORRELATION_IMPLEMENTATION_DIGEST = DEPENDENCY_CORRELATION_V1_0_0_IMPLEMENTATION_DIGEST;

export type DependencyUpstreamMissingEvidenceV1 = 'start_boundary' | 'end_boundary' | 'upstream_error_series';
export type DependencyLogMissingEvidenceV1 = 'log_window' | 'log_source' | 'log_records' | 'dependency_identity';
export type DependencyCorrelationMissingEvidenceV1 =
  | DependencyUpstreamMissingEvidenceV1
  | DependencyLogMissingEvidenceV1;
export type DependencyLogLevelV1 = 'ERROR' | 'WARN' | 'INFO';
export type DependencyCorrelationGapV1 = 'dependency_identity' | 'error_level';

export interface DependencyLogRecordV1 {
  readonly timestampUnixSeconds: number;
  readonly level: DependencyLogLevelV1;
  /** `null` means the log source did not attribute the record to a dependency. */
  readonly dependencyId: string | null;
}

export type DependencyUpstreamErrorFactV1 =
  | Readonly<{
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    dependencyId: string;
    errorCount: number;
    callCount: number;
  }>
  | Readonly<{
    availability: 'unavailable';
    reason: 'missing_window_evidence';
    missingEvidence: readonly DependencyUpstreamMissingEvidenceV1[];
  }>;

export type DependencyLogFactV1 =
  | Readonly<{
    availability: 'available';
    timestampUnit: 'unix_seconds';
    window: HostAuthorizedWindowV1;
    records: readonly DependencyLogRecordV1[];
  }>
  | Readonly<{
    availability: 'unavailable';
    reason: 'missing_log_evidence';
    missingEvidence: readonly DependencyLogMissingEvidenceV1[];
  }>;

export interface DependencyWindowSnapshotV1 {
  readonly schemaVersion: typeof DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION;
  readonly upstreamErrors: DependencyUpstreamErrorFactV1;
  readonly dependencyLogs: DependencyLogFactV1;
}

export type DependencyCorrelationScenarioErrorCode =
  | ScenarioWindowErrorCode
  | 'INVALID_SNAPSHOT_SHAPE'
  | 'INVALID_SNAPSHOT_SCHEMA'
  | 'INVALID_UPSTREAM_SHAPE'
  | 'INVALID_UPSTREAM_AVAILABILITY'
  | 'INVALID_UPSTREAM_MISSING_EVIDENCE'
  | 'INVALID_DEPENDENCY_ID'
  | 'INVALID_ERROR_COUNT'
  | 'ERROR_COUNT_EXCEEDS_CALLS'
  | 'INVALID_LOG_SHAPE'
  | 'INVALID_LOG_AVAILABILITY'
  | 'INVALID_LOG_MISSING_EVIDENCE'
  | 'INVALID_RECORD'
  | 'RECORD_LIMIT_EXCEEDED'
  | 'RECORD_OUTSIDE_WINDOW'
  | 'WINDOW_MISMATCH'
  | 'INVALID_MIN_ERROR_COUNT'
  | 'INVALID_MIN_RECORDS';

export class DependencyCorrelationScenarioError extends Error {
  constructor(readonly code: DependencyCorrelationScenarioErrorCode) {
    super(code);
    this.name = 'DependencyCorrelationScenarioError';
  }
}

export interface DependencyCorrelationAssessmentInputV1 {
  snapshot: DependencyWindowSnapshotV1;
  requestedWindow: HostAuthorizedWindowV1;
  minErrorCount: number;
  minCorroboratingRecords: number;
}

export type DependencyCorrelationAssessmentV1 =
  | Readonly<{
    status: 'corroborated';
    requestedWindow: HostAuthorizedWindowV1;
    dependencyId: string;
    errorCount: number;
    callCount: number;
    errorRatio: number;
    recordCount: number;
    corroboratingRecordCount: number;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'time_overlap_only';
    requestedWindow: HostAuthorizedWindowV1;
    dependencyId: string;
    errorCount: number;
    callCount: number;
    errorRatio: number;
    recordCount: number;
    overlappingRecordCount: number;
    missingCorroboration: readonly DependencyCorrelationGapV1[];
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'no_correlation';
    requestedWindow: HostAuthorizedWindowV1;
    errorCount: number;
    callCount: number;
    errorRatio: number;
    recordCount: number;
    conclusions: ScenarioConclusionBounds;
  }>
  | Readonly<{
    status: 'insufficient_evidence';
    requestedWindow: HostAuthorizedWindowV1;
    missingEvidence: readonly DependencyCorrelationMissingEvidenceV1[];
    conclusions: ScenarioConclusionBounds;
  }>;

function fail(code: DependencyCorrelationScenarioErrorCode): never {
  throw new DependencyCorrelationScenarioError(code);
}

/** Validate an untrusted serialized fact pair and return only the versioned typed shape. */
export function parseDependencyWindowSnapshotV1(input: unknown): DependencyWindowSnapshotV1 {
  const record = readExactRecord(input, ['schemaVersion', 'upstreamErrors', 'dependencyLogs'], () => fail('INVALID_SNAPSHOT_SHAPE'));
  if (record.schemaVersion !== DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION) fail('INVALID_SNAPSHOT_SCHEMA');
  return Object.freeze({
    schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
    upstreamErrors: parseUpstreamFact(record.upstreamErrors),
    dependencyLogs: parseLogFact(record.dependencyLogs),
  });
}

/** Deterministically classify upstream errors and dependency logs inside one authorized window. */
export function assessDependencyCorrelationV1(
  input: DependencyCorrelationAssessmentInputV1,
): DependencyCorrelationAssessmentV1 {
  const requestedWindow = readHostAuthorizedWindowV1(input.requestedWindow, fail);
  const minErrorCount = input.minErrorCount;
  if (!isPositiveSafeInteger(minErrorCount)) throw new DependencyCorrelationScenarioError('INVALID_MIN_ERROR_COUNT');
  const minCorroboratingRecords = input.minCorroboratingRecords;
  if (!isPositiveSafeInteger(minCorroboratingRecords)) {
    throw new DependencyCorrelationScenarioError('INVALID_MIN_RECORDS');
  }

  const snapshot = parseDependencyWindowSnapshotV1(input.snapshot);
  const upstream = snapshot.upstreamErrors;
  const logs = snapshot.dependencyLogs;

  if (upstream.availability === 'unavailable' || logs.availability === 'unavailable') {
    const missing: DependencyCorrelationMissingEvidenceV1[] = [
      ...(upstream.availability === 'unavailable' ? upstream.missingEvidence : []),
      ...(logs.availability === 'unavailable' ? logs.missingEvidence : []),
    ];
    return insufficientEvidence(requestedWindow, missing);
  }

  assertWindowMatches(upstream.window, requestedWindow);
  assertWindowMatches(logs.window, requestedWindow);

  const { dependencyId, errorCount, callCount } = upstream;
  const errorRatio = errorCount / callCount;
  const records = logs.records;
  for (const record of records) {
    if (record.timestampUnixSeconds < requestedWindow.startUnixSeconds
      || record.timestampUnixSeconds >= requestedWindow.endUnixSeconds) fail('RECORD_OUTSIDE_WINDOW');
  }

  if (errorCount < minErrorCount) {
    return Object.freeze({
      status: 'no_correlation',
      requestedWindow,
      errorCount,
      callCount,
      errorRatio,
      recordCount: records.length,
      conclusions: scenarioConclusionBounds(
        ['dependency_not_implicated_in_window', 'correlation_not_root_cause'],
        ['dependency_association_corroborated', 'temporal_coincidence_only'],
      ),
    });
  }

  if (records.length === 0) return insufficientEvidence(requestedWindow, ['log_records']);

  const corroborating = records.filter((record) => record.level === 'ERROR' && record.dependencyId === dependencyId);
  if (corroborating.length >= minCorroboratingRecords) {
    return Object.freeze({
      status: 'corroborated',
      requestedWindow,
      dependencyId,
      errorCount,
      callCount,
      errorRatio,
      recordCount: records.length,
      corroboratingRecordCount: corroborating.length,
      conclusions: scenarioConclusionBounds(
        ['dependency_association_corroborated', 'correlation_not_root_cause'],
        ['temporal_coincidence_only', 'dependency_not_implicated_in_window'],
      ),
    });
  }

  const gaps: DependencyCorrelationGapV1[] = [];
  if (!records.some((record) => record.dependencyId === dependencyId)) gaps.push('dependency_identity');
  if (!records.some((record) => record.level === 'ERROR')) gaps.push('error_level');
  if (gaps.length === 0) return insufficientEvidence(requestedWindow, ['dependency_identity']);
  return Object.freeze({
    status: 'time_overlap_only',
    requestedWindow,
    dependencyId,
    errorCount,
    callCount,
    errorRatio,
    recordCount: records.length,
    overlappingRecordCount: records.length,
    missingCorroboration: sortedUnique(gaps),
    conclusions: scenarioConclusionBounds(
      ['temporal_coincidence_only', 'correlation_not_root_cause', 'missing_evidence_partial_diagnosis'],
      ['dependency_association_corroborated', 'dependency_not_implicated_in_window'],
    ),
  });
}

function insufficientEvidence(
  requestedWindow: HostAuthorizedWindowV1,
  missingEvidence: readonly DependencyCorrelationMissingEvidenceV1[],
): DependencyCorrelationAssessmentV1 {
  if (missingEvidence.length === 0) fail('INVALID_UPSTREAM_MISSING_EVIDENCE');
  return Object.freeze({
    status: 'insufficient_evidence',
    requestedWindow,
    missingEvidence: sortedUnique(missingEvidence),
    conclusions: scenarioConclusionBounds(['missing_evidence_partial_diagnosis'], [
      'dependency_association_corroborated', 'temporal_coincidence_only', 'dependency_not_implicated_in_window',
    ]),
  });
}

function assertWindowMatches(window: HostAuthorizedWindowV1, requested: HostAuthorizedWindowV1): void {
  if (window.startUnixSeconds !== requested.startUnixSeconds
    || window.endUnixSeconds !== requested.endUnixSeconds) fail('WINDOW_MISMATCH');
}

function parseUpstreamFact(input: unknown): DependencyUpstreamErrorFactV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_UPSTREAM_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'unavailable') fail('INVALID_UPSTREAM_AVAILABILITY');
  const keys = availability === 'available'
    ? ['availability', 'timestampUnit', 'window', 'dependencyId', 'errorCount', 'callCount']
    : ['availability', 'reason', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_UPSTREAM_SHAPE'));

  if (availability === 'unavailable') {
    if (record.reason !== 'missing_window_evidence') fail('INVALID_UPSTREAM_MISSING_EVIDENCE');
    const items = asReadonlyArray(record.missingEvidence);
    if (items === undefined || items.length === 0) fail('INVALID_UPSTREAM_MISSING_EVIDENCE');
    const codes: DependencyUpstreamMissingEvidenceV1[] = [];
    for (const item of items) {
      if (item !== 'start_boundary' && item !== 'end_boundary' && item !== 'upstream_error_series') {
        throw new DependencyCorrelationScenarioError('INVALID_UPSTREAM_MISSING_EVIDENCE');
      }
      if (codes.includes(item)) fail('INVALID_UPSTREAM_MISSING_EVIDENCE');
      codes.push(item);
    }
    return Object.freeze({
      availability: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: sortedUnique(codes),
    });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const dependencyId = record.dependencyId;
  if (typeof dependencyId !== 'string' || dependencyId.length === 0
    || dependencyId.length > DEPENDENCY_ID_MAX_BYTES_V1) throw new DependencyCorrelationScenarioError('INVALID_DEPENDENCY_ID');
  const callCount = record.callCount;
  const errorCount = record.errorCount;
  if (!isPositiveSafeInteger(callCount) || !isNonnegativeSafeInteger(errorCount)) {
    throw new DependencyCorrelationScenarioError('INVALID_ERROR_COUNT');
  }
  if (errorCount > callCount) fail('ERROR_COUNT_EXCEEDS_CALLS');
  return Object.freeze({
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window,
    dependencyId,
    errorCount,
    callCount,
  });
}

function parseLogFact(input: unknown): DependencyLogFactV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_LOG_SHAPE');
  const shape = input as Record<string, unknown>;
  const availability = shape.availability;
  if (availability !== 'available' && availability !== 'unavailable') fail('INVALID_LOG_AVAILABILITY');
  const keys = availability === 'available'
    ? ['availability', 'timestampUnit', 'window', 'records']
    : ['availability', 'reason', 'missingEvidence'];
  const record = readExactRecord(shape, keys, () => fail('INVALID_LOG_SHAPE'));

  if (availability === 'unavailable') {
    if (record.reason !== 'missing_log_evidence') fail('INVALID_LOG_MISSING_EVIDENCE');
    const items = asReadonlyArray(record.missingEvidence);
    if (items === undefined || items.length === 0) fail('INVALID_LOG_MISSING_EVIDENCE');
    const codes: DependencyLogMissingEvidenceV1[] = [];
    for (const item of items) {
      if (item !== 'log_window' && item !== 'log_source' && item !== 'log_records' && item !== 'dependency_identity') {
        throw new DependencyCorrelationScenarioError('INVALID_LOG_MISSING_EVIDENCE');
      }
      if (codes.includes(item)) fail('INVALID_LOG_MISSING_EVIDENCE');
      codes.push(item);
    }
    return Object.freeze({ availability: 'unavailable', reason: 'missing_log_evidence', missingEvidence: sortedUnique(codes) });
  }

  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const window = readHostAuthorizedWindowV1(record.window, fail);
  const items = asReadonlyArray(record.records);
  if (items === undefined) fail('INVALID_RECORD');
  if (items.length > DEPENDENCY_LOG_RECORD_LIMIT_V1) fail('RECORD_LIMIT_EXCEEDED');
  const records = items.map((item) => parseLogRecord(item));
  return Object.freeze({ availability: 'available', timestampUnit: 'unix_seconds', window, records: Object.freeze(records) });
}

function parseLogRecord(input: unknown): DependencyLogRecordV1 {
  const record = readExactRecord(input, ['timestampUnixSeconds', 'level', 'dependencyId'], () => fail('INVALID_RECORD'));
  const timestampUnixSeconds = record.timestampUnixSeconds;
  if (typeof timestampUnixSeconds !== 'number' || !Number.isSafeInteger(timestampUnixSeconds) || timestampUnixSeconds < 0) {
    throw new DependencyCorrelationScenarioError('INVALID_RECORD');
  }
  const level = record.level;
  if (level !== 'ERROR' && level !== 'WARN' && level !== 'INFO') throw new DependencyCorrelationScenarioError('INVALID_RECORD');
  const dependencyId = record.dependencyId;
  if (dependencyId !== null && (typeof dependencyId !== 'string' || dependencyId.length === 0
    || dependencyId.length > DEPENDENCY_ID_MAX_BYTES_V1)) throw new DependencyCorrelationScenarioError('INVALID_RECORD');
  return Object.freeze({
    timestampUnixSeconds,
    level,
    dependencyId: dependencyId === null ? null : dependencyId,
  });
}
