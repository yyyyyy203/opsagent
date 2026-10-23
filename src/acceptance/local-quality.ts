import { z } from 'zod';
import { systemClock, type Clock } from '../contracts/common.js';
import {
  ALWAYS_FORBIDDEN_SCENARIO_CONCLUSIONS,
  SCENARIO_FAMILY_CODES,
  assessDependencyCorrelationV1,
  assessResourceSaturationV1,
  assessWindowFailureRateV1,
  assessWindowLatencyV1,
  assessWindowTrafficBaselineV1,
  windowFailureRateConclusionsV1,
  isScenarioConclusionCode,
  isScenarioFamilyCode,
  scenarioFamilyApplicability,
  type DependencyCorrelationAssessmentV1,
  type DependencyWindowSnapshotV1,
  type ResourceSaturationAssessmentV1,
  type ResourceThresholdsV1,
  type ScenarioConclusionBounds,
  type ScenarioConclusionCode,
  type ScenarioFamilyCode,
  type WindowCountSnapshotV1,
  type WindowFailureRateAssessmentV1,
  type WindowLatencyAssessmentV1,
  type WindowLatencySnapshotV1,
  type WindowResourceSnapshotV1,
  type WindowTrafficAssessmentV1,
  type WindowTrafficSnapshotV1,
} from '../profiles/scenarios/index.js';
import type { HostAuthorizedWindowV1 } from '../profiles/scenarios/scenario-window.js';

export const LOCAL_QUALITY_REPORT_SCHEMA_VERSION = 1 as const;
export const LOCAL_QUALITY_DEFAULT_MAX_CASES = 64;
export const LOCAL_QUALITY_DEFAULT_DEADLINE_MS = 30_000;
export const LOCAL_QUALITY_NUMBER_TOLERANCE = 1e-9;
export const LOCAL_QUALITY_SOURCE_MODE = 'simulated' as const;

export type LocalQualityModelMode = 'offline_deterministic' | 'online_opt_in';
export type LocalQualityTransport = 'injected' | 'loopback_http';

export type LocalQualityCheckCode =
  | 'SCENARIO_APPLICABILITY'
  | 'FIXTURE_LOADABLE'
  | 'DATASET_WINDOW_CONSISTENT'
  | 'STATUS_MATCH'
  | 'NUMERIC_MATCH'
  | 'BOOLEAN_MATCH'
  | 'STRING_MATCH'
  | 'MISSING_EVIDENCE_VISIBLE'
  | 'CONCLUSION_BOUNDS'
  | 'EVIDENCE_ATTRIBUTION'
  | 'NO_FABRICATED_COMPLETENESS'
  | 'ERROR_INFORMATION_SAFE';

export type LocalQualityCaseVerdict = 'passed' | 'failed' | 'not_run';
export type LocalQualityVerdict = 'passed' | 'failed';

export type LocalQualityErrorCode =
  | 'INVALID_CASE'
  | 'DUPLICATE_CASE'
  | 'EMPTY_CASE_SET'
  | 'BUDGET_EXCEEDED'
  | 'REPORT_TAMPERED';

export class LocalQualityError extends Error {
  constructor(readonly code: LocalQualityErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = 'LocalQualityError';
  }
}

/** Statuses that must expose a limitation conclusion instead of a determination. */
export const LOCAL_QUALITY_LIMITING_STATUSES: readonly string[] = Object.freeze([
  'unavailable', 'baseline_missing', 'insufficient_samples', 'insufficient_evidence', 'time_overlap_only',
  'candidate_only',
]);

/** Statuses that may not expose any ratio or threshold-reached determination value. */
export const LOCAL_QUALITY_NO_DETERMINATION_VALUE_STATUSES: readonly string[] = Object.freeze([
  'unavailable', 'baseline_missing', 'insufficient_samples', 'insufficient_evidence',
]);

/** Statuses whose missing-evidence list must be non-empty; others expose counts or gaps. */
export const LOCAL_QUALITY_MISSING_EVIDENCE_REQUIRED_STATUSES: readonly string[] = Object.freeze([
  'unavailable', 'baseline_missing', 'insufficient_evidence',
]);

const DETERMINATION_NUMBER_KEYS: readonly string[] = Object.freeze([
  'failureRate', 'changeRatio', 'dropRatio', 'errorRatio', 'thresholdMs',
]);
const DETERMINATION_BOOLEAN_KEYS: readonly string[] = Object.freeze(['thresholdReached', 'dropThresholdReached']);
const LIMITATION_CONCLUSIONS: readonly ScenarioConclusionCode[] = Object.freeze([
  'missing_evidence_partial_diagnosis', 'insufficient_samples_no_attribution', 'baseline_unavailable_no_comparison',
  'resource_saturation_candidate', 'temporal_coincidence_only',
]);

const FAMILY_STATUSES: Readonly<Record<ScenarioFamilyCode, readonly string[]>> = Object.freeze({
  failure_rate: Object.freeze(['complete', 'insufficient_samples', 'unavailable']),
  latency: Object.freeze(['complete', 'insufficient_samples', 'unavailable']),
  traffic: Object.freeze(['complete', 'baseline_missing', 'insufficient_samples', 'unavailable']),
  dependency: Object.freeze(['corroborated', 'time_overlap_only', 'no_correlation', 'insufficient_evidence']),
  resource: Object.freeze(['saturated', 'candidate_only', 'within_threshold', 'unavailable']),
});

const SCENARIO_ERROR_NAMES: readonly string[] = Object.freeze([
  'WindowFailureRateScenarioError', 'WindowLatencyScenarioError', 'WindowTrafficScenarioError',
  'DependencyCorrelationScenarioError', 'ResourceSaturationScenarioError',
]);

export type LocalQualityParamsV1 =
  | Readonly<{ family: 'failure_rate'; threshold: number; minSamples: number }>
  | Readonly<{ family: 'latency'; p95ThresholdMs: number; minSamples: number }>
  | Readonly<{ family: 'traffic'; dropThresholdRatio: number; minSamples: number }>
  | Readonly<{ family: 'dependency'; minErrorCount: number; minCorroboratingRecords: number }>
  | Readonly<{ family: 'resource'; thresholds: ResourceThresholdsV1; minSignalsForConfirmation: number }>;

export interface LocalQualityExpectationV1 {
  /** Expected assessment discriminant; mutually exclusive with `errorCode`. */
  readonly status?: string;
  /** Expected stable scenario error code when the case asserts rejected input. */
  readonly errorCode?: string;
  readonly numbers?: Readonly<Record<string, number>>;
  readonly booleans?: Readonly<Record<string, boolean>>;
  readonly strings?: Readonly<Record<string, string>>;
  /** Sorted expected missing-evidence codes; required for every non-error case. */
  readonly missingEvidence?: readonly string[];
  readonly allowedConclusions: readonly ScenarioConclusionCode[];
  readonly forbiddenConclusions: readonly ScenarioConclusionCode[];
  readonly evidenceSources: readonly string[];
}

export interface LocalQualityCaseV1 {
  readonly caseId: string;
  readonly family: ScenarioFamilyCode;
  readonly title: string;
  readonly fixtureId: string;
  readonly params: LocalQualityParamsV1;
  readonly expectation: LocalQualityExpectationV1;
}

export interface LocalQualityFactV1 {
  readonly factId: string;
  readonly sourceId: string;
  readonly family: ScenarioFamilyCode;
  readonly availability: string;
  readonly schemaVersion: string;
  readonly window: { timestampUnit: 'unix_seconds'; startUnixSeconds: number; endUnixSeconds: number } | null;
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
}

/** Structural view of a simulated fixture; the simulator owns the concrete type. */
export interface LocalQualityFixtureV1 {
  readonly fixtureId: string;
  readonly family: ScenarioFamilyCode;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly windowSeconds: number;
  readonly evaluationTimeUnixSeconds: number;
  readonly requestedWindow: HostAuthorizedWindowV1;
  readonly facts: readonly LocalQualityFactV1[];
  readonly snapshot: unknown;
}

export type LocalQualityFixtureLoader = (fixtureId: string) => LocalQualityFixtureV1;

export interface LocalQualityAssessmentProjectionV1 {
  readonly status: string;
  readonly numbers: Readonly<Record<string, number>>;
  readonly booleans: Readonly<Record<string, boolean>>;
  readonly strings: Readonly<Record<string, string>>;
  readonly missingEvidence: readonly string[];
  readonly allowedConclusions: readonly ScenarioConclusionCode[];
  readonly forbiddenConclusions: readonly ScenarioConclusionCode[];
}

export interface LocalQualityOutcomeV1 {
  readonly projection?: LocalQualityAssessmentProjectionV1;
  readonly errorCode?: string;
  readonly unexpectedError?: 'UNEXPECTED_ERROR' | 'PARAM_FAMILY_MISMATCH';
}

export interface LocalQualityCaseReportV1 {
  readonly caseId: string;
  readonly title: string;
  readonly family: ScenarioFamilyCode;
  readonly fixtureId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly implementationDigest: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly requestedWindow: { startUnixSeconds: number; endUnixSeconds: number } | null;
  readonly checks: readonly { code: LocalQualityCheckCode; passed: boolean }[];
  readonly verdict: LocalQualityCaseVerdict;
  readonly errorCode?: string;
  readonly projection?: LocalQualityAssessmentProjectionV1;
}

export interface LocalQualityFamilySummaryV1 {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
}

export interface LocalQualityReportV1 {
  readonly schemaVersion: typeof LOCAL_QUALITY_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly modelMode: LocalQualityModelMode;
  readonly sourceMode: typeof LOCAL_QUALITY_SOURCE_MODE;
  readonly transport: LocalQualityTransport;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly windowSeconds: number;
  readonly cases: readonly LocalQualityCaseReportV1[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
    readonly byFamily: Readonly<Record<ScenarioFamilyCode, LocalQualityFamilySummaryV1>>;
  };
  readonly budget: {
    readonly maxCases: number;
    readonly deadlineMs: number;
    readonly usedMs: number;
    readonly exhausted: 'deadline' | 'abort' | null;
  };
  readonly verdict: LocalQualityVerdict;
}

export interface RunLocalQualitySetOptions {
  readonly cases: readonly LocalQualityCaseV1[];
  readonly loadFixture: LocalQualityFixtureLoader;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly maxCases?: number;
  readonly transport?: LocalQualityTransport;
  readonly modelMode?: LocalQualityModelMode;
}

/** Validate the authored case table before any run; a malformed case is a hard error. */
export function validateLocalQualityCases(cases: readonly LocalQualityCaseV1[]): void {
  if (cases.length === 0) throw new LocalQualityError('EMPTY_CASE_SET');
  const seen = new Set<string>();
  for (const definition of cases) {
    if (!isScenarioFamilyCode(definition.family)) throw new LocalQualityError('INVALID_CASE', definition.caseId);
    if (seen.has(definition.caseId)) throw new LocalQualityError('DUPLICATE_CASE', definition.caseId);
    seen.add(definition.caseId);
    if (definition.caseId.length === 0 || definition.title.length === 0 || definition.fixtureId.length === 0) {
      throw new LocalQualityError('INVALID_CASE', definition.caseId);
    }
    if (definition.params.family !== definition.family) throw new LocalQualityError('INVALID_CASE', definition.caseId);
    const expectation = definition.expectation;
    const expectedStatus = expectation.status;
    const hasErrorCode = expectation.errorCode !== undefined;
    if ((expectedStatus !== undefined) === hasErrorCode) throw new LocalQualityError('INVALID_CASE', definition.caseId);
    if (expectedStatus !== undefined) {
      if (!FAMILY_STATUSES[definition.family].includes(expectedStatus)) {
        throw new LocalQualityError('INVALID_CASE', definition.caseId);
      }
      if (expectation.missingEvidence === undefined) throw new LocalQualityError('INVALID_CASE', definition.caseId);
    }
    assertConclusionList(expectation.allowedConclusions, definition.caseId);
    assertConclusionList(expectation.forbiddenConclusions, definition.caseId);
    for (const code of expectation.allowedConclusions) {
      if (expectation.forbiddenConclusions.includes(code)) throw new LocalQualityError('INVALID_CASE', definition.caseId);
    }
    if (expectation.evidenceSources.length === 0) throw new LocalQualityError('INVALID_CASE', definition.caseId);
  }
}

/** Run the offline quality set with a bounded budget. Never retries and never calls a model. */
export function runLocalQualitySet(options: RunLocalQualitySetOptions): LocalQualityReportV1 {
  const cases = options.cases;
  validateLocalQualityCases(cases);
  const clock = options.clock ?? systemClock;
  const maxCases = options.maxCases ?? LOCAL_QUALITY_DEFAULT_MAX_CASES;
  const deadlineMs = options.deadlineMs ?? LOCAL_QUALITY_DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(maxCases) || maxCases < cases.length) throw new LocalQualityError('BUDGET_EXCEEDED');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new LocalQualityError('INVALID_CASE', 'deadlineMs');

  const startedAt = clock.now().getTime();
  let exhausted: 'deadline' | 'abort' | null = null;
  const reports: LocalQualityCaseReportV1[] = [];
  for (const definition of cases) {
    if (exhausted === null) {
      if (options.signal?.aborted === true) exhausted = 'abort';
      else if (clock.now().getTime() - startedAt > deadlineMs) exhausted = 'deadline';
    }
    if (exhausted !== null) {
      reports.push(notRunCaseReport(definition));
      continue;
    }
    reports.push(runCase(definition, options.loadFixture));
  }
  const usedMs = clock.now().getTime() - startedAt;
  return buildReport(reports, {
    generatedAt: clock.now().toISOString(),
    modelMode: options.modelMode ?? 'offline_deterministic',
    transport: options.transport ?? 'injected',
    budget: { maxCases, deadlineMs, usedMs, exhausted },
  });
}

/** Evaluate one case against an already loaded fixture; pure and deterministic. */
export function evaluateLocalQualityCase(
  definition: LocalQualityCaseV1,
  fixture: LocalQualityFixtureV1 | undefined,
  outcome: LocalQualityOutcomeV1 | undefined,
): LocalQualityCaseReportV1 {
  const expectation = definition.expectation;
  const applicability = tryApplicability(definition.family);
  const checks: { code: LocalQualityCheckCode; passed: boolean }[] = [];
  const loaded = fixture !== undefined;
  checks.push({ code: 'SCENARIO_APPLICABILITY', passed: applicability !== undefined && loaded && fixture.family === definition.family });
  checks.push({ code: 'FIXTURE_LOADABLE', passed: loaded && fixture.fixtureId === definition.fixtureId });
  checks.push({ code: 'DATASET_WINDOW_CONSISTENT', passed: loaded && isDatasetWindowConsistent(fixture) });

  if (!loaded || outcome === undefined) {
    for (const code of ['STATUS_MATCH', 'MISSING_EVIDENCE_VISIBLE', 'CONCLUSION_BOUNDS', 'EVIDENCE_ATTRIBUTION',
      'NO_FABRICATED_COMPLETENESS', 'ERROR_INFORMATION_SAFE'] as const) {
      checks.push({ code, passed: false });
    }
    if (expectation.numbers !== undefined) checks.push({ code: 'NUMERIC_MATCH', passed: false });
    if (expectation.booleans !== undefined) checks.push({ code: 'BOOLEAN_MATCH', passed: false });
    if (expectation.strings !== undefined) checks.push({ code: 'STRING_MATCH', passed: false });
    return finalizeCase(definition, fixture, applicability, checks, outcome);
  }

  const projection = outcome.projection;
  const expectsError = expectation.errorCode !== undefined;
  checks.push({
    code: 'STATUS_MATCH',
    passed: expectsError
      ? outcome.errorCode === expectation.errorCode
      : projection !== undefined && projection.status === expectation.status,
  });
  if (expectation.numbers !== undefined) {
    checks.push({
      code: 'NUMERIC_MATCH',
      passed: !expectsError && projection !== undefined && numbersMatch(expectation.numbers, projection.numbers),
    });
  }
  if (expectation.booleans !== undefined) {
    checks.push({
      code: 'BOOLEAN_MATCH',
      passed: !expectsError && projection !== undefined && booleansMatch(expectation.booleans, projection.booleans),
    });
  }
  if (expectation.strings !== undefined) {
    checks.push({
      code: 'STRING_MATCH',
      passed: !expectsError && projection !== undefined && stringsMatch(expectation.strings, projection.strings),
    });
  }
  // On the error path these three checks verify that a rejected input produced no
  // assessment at all: no missing-evidence claim, no conclusion, no completeness.
  checks.push({
    code: 'MISSING_EVIDENCE_VISIBLE',
    passed: expectsError
      ? projection === undefined
      : projection !== undefined
        && sameStrings(expectation.missingEvidence ?? [], projection.missingEvidence)
        && !(expectation.status !== undefined
          && LOCAL_QUALITY_MISSING_EVIDENCE_REQUIRED_STATUSES.includes(expectation.status)
          && projection.missingEvidence.length === 0),
  });
  checks.push({
    code: 'CONCLUSION_BOUNDS',
    passed: expectsError
      ? projection === undefined
      : projection !== undefined && conclusionsBounded(expectation, projection),
  });
  checks.push({ code: 'EVIDENCE_ATTRIBUTION', passed: evidenceAttributed(expectation, fixture) });
  checks.push({
    code: 'NO_FABRICATED_COMPLETENESS',
    passed: expectsError
      ? projection === undefined && outcome.unexpectedError === undefined
      : projection !== undefined
        && !fabricatesCompleteness(expectation.status, projection)
        && ALWAYS_FORBIDDEN_SCENARIO_CONCLUSIONS.every((code) => projection.forbiddenConclusions.includes(code)),
  });
  checks.push({
    code: 'ERROR_INFORMATION_SAFE',
    passed: expectsError
      ? outcome.errorCode === expectation.errorCode && outcome.unexpectedError === undefined
      : outcome.errorCode === undefined && outcome.unexpectedError === undefined,
  });
  return finalizeCase(definition, fixture, applicability, checks, outcome);
}

/** Run the deterministic scenario for one case; captures stable error codes only. */
export function assessLocalQualityCase(
  definition: LocalQualityCaseV1,
  fixture: LocalQualityFixtureV1,
): LocalQualityOutcomeV1 {
  if (definition.params.family !== definition.family) return { unexpectedError: 'PARAM_FAMILY_MISMATCH' };
  try {
    return { projection: projectAssessment(definition.family, runAssessment(definition, fixture)) };
  } catch (error) {
    const code = scenarioErrorCode(error);
    return code === undefined ? { unexpectedError: 'UNEXPECTED_ERROR' } : { errorCode: code };
  }
}

function runCase(definition: LocalQualityCaseV1, loadFixture: LocalQualityFixtureLoader): LocalQualityCaseReportV1 {
  let fixture: LocalQualityFixtureV1 | undefined;
  try {
    fixture = loadFixture(definition.fixtureId);
  } catch {
    fixture = undefined;
  }
  const outcome = fixture === undefined ? undefined : assessLocalQualityCase(definition, fixture);
  return evaluateLocalQualityCase(definition, fixture, outcome);
}

function runAssessment(
  definition: LocalQualityCaseV1,
  fixture: LocalQualityFixtureV1,
): WindowFailureRateAssessmentV1 | WindowLatencyAssessmentV1 | WindowTrafficAssessmentV1
  | DependencyCorrelationAssessmentV1 | ResourceSaturationAssessmentV1 {
  const params = definition.params;
  const requestedWindow = fixture.requestedWindow;
  switch (params.family) {
    case 'failure_rate':
      return assessWindowFailureRateV1({
        snapshot: fixture.snapshot as WindowCountSnapshotV1,
        requestedWindow,
        threshold: params.threshold,
        minSamples: params.minSamples,
      });
    case 'latency':
      return assessWindowLatencyV1({
        snapshot: fixture.snapshot as WindowLatencySnapshotV1,
        requestedWindow,
        p95ThresholdMs: params.p95ThresholdMs,
        minSamples: params.minSamples,
      });
    case 'traffic':
      return assessWindowTrafficBaselineV1({
        snapshot: fixture.snapshot as WindowTrafficSnapshotV1,
        requestedWindow,
        dropThresholdRatio: params.dropThresholdRatio,
        minSamples: params.minSamples,
      });
    case 'dependency':
      return assessDependencyCorrelationV1({
        snapshot: fixture.snapshot as DependencyWindowSnapshotV1,
        requestedWindow,
        minErrorCount: params.minErrorCount,
        minCorroboratingRecords: params.minCorroboratingRecords,
      });
    case 'resource':
      return assessResourceSaturationV1({
        snapshot: fixture.snapshot as WindowResourceSnapshotV1,
        requestedWindow,
        thresholds: params.thresholds,
        minSignalsForConfirmation: params.minSignalsForConfirmation,
      });
  }
}

function projectAssessment(
  family: ScenarioFamilyCode,
  assessment: WindowFailureRateAssessmentV1 | WindowLatencyAssessmentV1 | WindowTrafficAssessmentV1
    | DependencyCorrelationAssessmentV1 | ResourceSaturationAssessmentV1,
): LocalQualityAssessmentProjectionV1 {
  switch (family) {
    case 'failure_rate': return projectFailureRate(assessment as WindowFailureRateAssessmentV1);
    case 'latency': return projectLatency(assessment as WindowLatencyAssessmentV1);
    case 'traffic': return projectTraffic(assessment as WindowTrafficAssessmentV1);
    case 'dependency': return projectDependency(assessment as DependencyCorrelationAssessmentV1);
    case 'resource': return projectResource(assessment as ResourceSaturationAssessmentV1);
  }
}

function projectFailureRate(assessment: WindowFailureRateAssessmentV1): LocalQualityAssessmentProjectionV1 {
  const conclusions = windowFailureRateConclusionsV1(assessment);
  if (assessment.status === 'complete') {
    return projection('complete', {
      windowStartUnixSeconds: assessment.requestedWindow.startUnixSeconds,
      windowEndUnixSeconds: assessment.requestedWindow.endUnixSeconds,
      successCount: assessment.successCount,
      failureCount: assessment.failureCount,
      totalCount: assessment.totalCount,
      failureRate: assessment.failureRate,
      threshold: assessment.threshold,
    }, { thresholdReached: assessment.thresholdReached }, {}, [], conclusions);
  }
  if (assessment.status === 'insufficient_samples') {
    return projection('insufficient_samples', {
      sampleCount: assessment.sampleCount,
      minimumSamples: assessment.minimumSamples,
    }, {}, {}, [], conclusions);
  }
  return projection('unavailable', {}, {}, { reason: assessment.reason }, assessment.missingEvidence, conclusions);
}

function projectLatency(assessment: WindowLatencyAssessmentV1): LocalQualityAssessmentProjectionV1 {
  const window = windowNumbers(assessment.requestedWindow);
  if (assessment.status === 'complete') {
    return projection('complete', {
      ...window,
      sampleCount: assessment.sampleCount,
      p50Ms: assessment.p50Ms,
      p95Ms: assessment.p95Ms,
      p99Ms: assessment.p99Ms,
      thresholdMs: assessment.thresholdMs,
    }, { thresholdReached: assessment.thresholdReached }, { computation: assessment.computation }, [], assessment.conclusions);
  }
  if (assessment.status === 'insufficient_samples') {
    return projection('insufficient_samples', {
      ...window, sampleCount: assessment.sampleCount, minimumSamples: assessment.minimumSamples,
    }, {}, {}, [], assessment.conclusions);
  }
  return projection('unavailable', window, {}, { reason: assessment.reason }, assessment.missingEvidence, assessment.conclusions);
}

function projectTraffic(assessment: WindowTrafficAssessmentV1): LocalQualityAssessmentProjectionV1 {
  const window = windowNumbers(assessment.requestedWindow);
  if (assessment.status === 'complete') {
    return projection('complete', {
      ...window,
      requestCount: assessment.requestCount,
      baselineRequestCount: assessment.baselineRequestCount,
      baselineStartUnixSeconds: assessment.baselineWindow.startUnixSeconds,
      baselineEndUnixSeconds: assessment.baselineWindow.endUnixSeconds,
      changeRatio: assessment.changeRatio,
      dropRatio: assessment.dropRatio,
      dropThresholdRatio: assessment.dropThresholdRatio,
    }, { dropThresholdReached: assessment.dropThresholdReached }, {}, [], assessment.conclusions);
  }
  if (assessment.status === 'baseline_missing') {
    return projection('baseline_missing', { ...window, requestCount: assessment.requestCount }, {}, {},
      assessment.missingEvidence, assessment.conclusions);
  }
  if (assessment.status === 'insufficient_samples') {
    return projection('insufficient_samples', {
      ...window, sampleCount: assessment.sampleCount, minimumSamples: assessment.minimumSamples,
    }, {}, {}, [], assessment.conclusions);
  }
  return projection('unavailable', window, {}, { reason: assessment.reason }, assessment.missingEvidence, assessment.conclusions);
}

function projectDependency(assessment: DependencyCorrelationAssessmentV1): LocalQualityAssessmentProjectionV1 {
  const window = windowNumbers(assessment.requestedWindow);
  if (assessment.status === 'insufficient_evidence') {
    return projection('insufficient_evidence', window, {}, {}, assessment.missingEvidence, assessment.conclusions);
  }
  if (assessment.status === 'no_correlation') {
    return projection('no_correlation', {
      ...window, errorCount: assessment.errorCount, callCount: assessment.callCount,
      errorRatio: assessment.errorRatio, recordCount: assessment.recordCount,
    }, {}, {}, [], assessment.conclusions);
  }
  if (assessment.status === 'time_overlap_only') {
    return projection('time_overlap_only', {
      ...window, errorCount: assessment.errorCount, callCount: assessment.callCount,
      errorRatio: assessment.errorRatio, recordCount: assessment.recordCount,
      overlappingRecordCount: assessment.overlappingRecordCount,
    }, {}, { dependencyId: assessment.dependencyId, missingCorroboration: assessment.missingCorroboration.join(',') }, [], assessment.conclusions);
  }
  return projection('corroborated', {
    ...window, errorCount: assessment.errorCount, callCount: assessment.callCount,
    errorRatio: assessment.errorRatio, recordCount: assessment.recordCount,
    corroboratingRecordCount: assessment.corroboratingRecordCount,
  }, {}, { dependencyId: assessment.dependencyId }, [], assessment.conclusions);
}

function projectResource(assessment: ResourceSaturationAssessmentV1): LocalQualityAssessmentProjectionV1 {
  if (assessment.status === 'unavailable') {
    return projection('unavailable', windowNumbers(assessment.requestedWindow), {}, { reason: assessment.reason },
      assessment.missingEvidence, assessment.conclusions);
  }
  const numbers: Record<string, number> = {
    ...windowNumbers(assessment.requestedWindow),
    signalCount: assessment.signalCount,
    minimumSignalsForConfirmation: assessment.minimumSignalsForConfirmation,
    breachedSignalCount: assessment.breachedKinds.length,
  };
  const booleans: Record<string, boolean> = {};
  for (const signal of assessment.signals) {
    numbers[`signals.${signal.kind}.utilizationRatio`] = signal.utilizationRatio;
    numbers[`signals.${signal.kind}.threshold`] = signal.threshold;
    booleans[`signals.${signal.kind}.thresholdReached`] = signal.thresholdReached;
  }
  return projection(assessment.status, numbers, booleans, { breachedKinds: assessment.breachedKinds.join(',') }, [], assessment.conclusions);
}

function projection(
  status: string,
  numbers: Readonly<Record<string, number>>,
  booleans: Readonly<Record<string, boolean>>,
  strings: Readonly<Record<string, string>>,
  missingEvidence: readonly string[],
  conclusions: ScenarioConclusionBounds,
): LocalQualityAssessmentProjectionV1 {
  return Object.freeze({
    status,
    numbers: Object.freeze({ ...numbers }),
    booleans: Object.freeze({ ...booleans }),
    strings: Object.freeze({ ...strings }),
    missingEvidence: Object.freeze([...missingEvidence].sort()),
    allowedConclusions: Object.freeze([...conclusions.allowed]),
    forbiddenConclusions: Object.freeze([...conclusions.forbidden]),
  });
}

function windowNumbers(window: HostAuthorizedWindowV1): Record<string, number> {
  return {
    windowStartUnixSeconds: window.startUnixSeconds,
    windowEndUnixSeconds: window.endUnixSeconds,
  };
}

function finalizeCase(
  definition: LocalQualityCaseV1,
  fixture: LocalQualityFixtureV1 | undefined,
  applicability: ReturnType<typeof tryApplicability>,
  checks: readonly { code: LocalQualityCheckCode; passed: boolean }[],
  outcome: LocalQualityOutcomeV1 | undefined,
): LocalQualityCaseReportV1 {
  // Conclusions come from the assessment itself, never from the case table.
  const projection = outcome?.projection;
  const frozenChecks = Object.freeze(checks.map((check) => Object.freeze({ ...check })));
  return Object.freeze({
    caseId: definition.caseId,
    title: definition.title,
    family: definition.family,
    fixtureId: definition.fixtureId,
    scenarioId: applicability?.scenarioId ?? 'unavailable',
    scenarioVersion: applicability?.scenarioVersion ?? 'unavailable',
    implementationDigest: applicability?.implementationDigest ?? 'unavailable',
    datasetId: fixture?.datasetId ?? 'unavailable',
    datasetVersion: fixture?.datasetVersion ?? 'unavailable',
    datasetDigest: fixture?.datasetDigest ?? 'unavailable',
    requestedWindow: fixture === undefined ? null : Object.freeze({
      startUnixSeconds: fixture.requestedWindow.startUnixSeconds,
      endUnixSeconds: fixture.requestedWindow.endUnixSeconds,
    }),
    checks: frozenChecks,
    verdict: frozenChecks.every((check) => check.passed) ? 'passed' : 'failed',
    ...(outcome?.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    ...(projection === undefined ? {} : { projection }),
  });
}

function notRunCaseReport(definition: LocalQualityCaseV1): LocalQualityCaseReportV1 {
  const applicability = tryApplicability(definition.family);
  const checks: readonly { code: LocalQualityCheckCode; passed: boolean }[] = Object.freeze([
    { code: 'SCENARIO_APPLICABILITY', passed: false },
    { code: 'FIXTURE_LOADABLE', passed: false },
    { code: 'DATASET_WINDOW_CONSISTENT', passed: false },
    { code: 'STATUS_MATCH', passed: false },
    { code: 'MISSING_EVIDENCE_VISIBLE', passed: false },
    { code: 'CONCLUSION_BOUNDS', passed: false },
    { code: 'EVIDENCE_ATTRIBUTION', passed: false },
    { code: 'NO_FABRICATED_COMPLETENESS', passed: false },
    { code: 'ERROR_INFORMATION_SAFE', passed: false },
  ]);
  return Object.freeze({
    caseId: definition.caseId,
    title: definition.title,
    family: definition.family,
    fixtureId: definition.fixtureId,
    scenarioId: applicability?.scenarioId ?? 'unavailable',
    scenarioVersion: applicability?.scenarioVersion ?? 'unavailable',
    implementationDigest: applicability?.implementationDigest ?? 'unavailable',
    datasetId: 'unavailable',
    datasetVersion: 'unavailable',
    datasetDigest: 'unavailable',
    requestedWindow: null,
    checks,
    verdict: 'not_run',
  });
}

function tryApplicability(family: ScenarioFamilyCode): {
  applicable: boolean; scenarioId: string; scenarioVersion: string; implementationDigest: string;
} | undefined {
  try {
    return scenarioFamilyApplicability(family);
  } catch {
    return undefined;
  }
}

function buildReport(
  cases: readonly LocalQualityCaseReportV1[],
  meta: {
    generatedAt: string;
    modelMode: LocalQualityModelMode;
    transport: LocalQualityTransport;
    budget: { maxCases: number; deadlineMs: number; usedMs: number; exhausted: 'deadline' | 'abort' | null };
  },
): LocalQualityReportV1 {
  const byFamily = {} as Record<ScenarioFamilyCode, { total: number; passed: number; failed: number; notRun: number }>;
  for (const family of SCENARIO_FAMILY_CODES) byFamily[family] = { total: 0, passed: 0, failed: 0, notRun: 0 };
  for (const report of cases) {
    const entry = byFamily[report.family];
    if (entry === undefined) continue;
    entry.total += 1;
    if (report.verdict === 'passed') entry.passed += 1;
    else if (report.verdict === 'failed') entry.failed += 1;
    else entry.notRun += 1;
  }
  const passed = cases.filter((report) => report.verdict === 'passed').length;
  const failed = cases.filter((report) => report.verdict === 'failed').length;
  const notRun = cases.filter((report) => report.verdict === 'not_run').length;
  const dataset = cases.find((report) => report.datasetId !== 'unavailable');
  return Object.freeze({
    schemaVersion: LOCAL_QUALITY_REPORT_SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    modelMode: meta.modelMode,
    sourceMode: LOCAL_QUALITY_SOURCE_MODE,
    transport: meta.transport,
    datasetId: dataset?.datasetId ?? 'unavailable',
    datasetVersion: dataset?.datasetVersion ?? 'unavailable',
    datasetDigest: dataset?.datasetDigest ?? 'unavailable',
    windowSeconds: dataset === undefined ? 0 : windowSecondsOf(dataset),
    cases: Object.freeze(cases),
    summary: Object.freeze({
      total: cases.length,
      passed,
      failed,
      notRun,
      byFamily: Object.freeze(byFamily),
    }),
    budget: Object.freeze({ ...meta.budget }),
    verdict: cases.length > 0 && failed === 0 && notRun === 0 && meta.budget.exhausted === null ? 'passed' : 'failed',
  });
}

function windowSecondsOf(report: LocalQualityCaseReportV1): number {
  const window = report.requestedWindow;
  return window === null ? 0 : window.endUnixSeconds - window.startUnixSeconds;
}

function isDatasetWindowConsistent(fixture: LocalQualityFixtureV1): boolean {
  const window = fixture.requestedWindow;
  if (!Number.isSafeInteger(window.startUnixSeconds) || !Number.isSafeInteger(window.endUnixSeconds)
    || window.startUnixSeconds >= window.endUnixSeconds) return false;
  if (window.endUnixSeconds - window.startUnixSeconds !== fixture.windowSeconds) return false;
  if (window.endUnixSeconds !== fixture.evaluationTimeUnixSeconds) return false;
  if (fixture.datasetId.length === 0 || fixture.datasetVersion.length === 0 || fixture.datasetDigest.length === 0) {
    return false;
  }
  if (fixture.facts.length === 0) return false;
  return fixture.facts.every((fact) => {
    if (fact.family !== fixture.family) return false;
    if (fact.window === null) return fact.availability !== 'available';
    return fact.window.timestampUnit === 'unix_seconds'
      && fact.window.startUnixSeconds === window.startUnixSeconds
      && fact.window.endUnixSeconds === window.endUnixSeconds;
  });
}

function evidenceAttributed(expectation: LocalQualityExpectationV1, fixture: LocalQualityFixtureV1): boolean {
  const actual = [...new Set(fixture.facts.map((fact) => fact.sourceId))].sort();
  const expected = [...new Set(expectation.evidenceSources)].sort();
  return sameStrings(expected, actual);
}

function conclusionsBounded(
  expectation: LocalQualityExpectationV1,
  projected: LocalQualityAssessmentProjectionV1,
): boolean {
  const allowed = projected.allowedConclusions;
  const forbidden = projected.forbiddenConclusions;
  if (allowed.some((code) => forbidden.includes(code))) return false;
  if (!ALWAYS_FORBIDDEN_SCENARIO_CONCLUSIONS.every((code) => forbidden.includes(code))) return false;
  if (!expectation.allowedConclusions.every((code) => allowed.includes(code))) return false;
  return expectation.forbiddenConclusions.every((code) => forbidden.includes(code));
}

function fabricatesCompleteness(
  expectedStatus: string | undefined,
  projected: LocalQualityAssessmentProjectionV1,
): boolean {
  if (expectedStatus === undefined) return true;
  if (!LOCAL_QUALITY_LIMITING_STATUSES.includes(expectedStatus)) return false;
  if (!projected.allowedConclusions.some((code) => (LIMITATION_CONCLUSIONS as readonly string[]).includes(code))) {
    return true;
  }
  if (!LOCAL_QUALITY_NO_DETERMINATION_VALUE_STATUSES.includes(expectedStatus)) return false;
  if (Object.keys(projected.booleans).some((key) => DETERMINATION_BOOLEAN_KEYS.includes(key))) return true;
  return Object.keys(projected.numbers).some((key) => DETERMINATION_NUMBER_KEYS.includes(key));
}

function numbersMatch(expected: Readonly<Record<string, number>>, actual: Readonly<Record<string, number>>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const observed = actual[key];
    return observed !== undefined && Number.isFinite(value) && Math.abs(observed - value) <= LOCAL_QUALITY_NUMBER_TOLERANCE;
  });
}

function booleansMatch(expected: Readonly<Record<string, boolean>>, actual: Readonly<Record<string, boolean>>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function stringsMatch(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function sameStrings(expected: readonly string[], actual: readonly string[]): boolean {
  const left = [...expected].sort();
  const right = [...actual].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertConclusionList(codes: readonly ScenarioConclusionCode[], caseId: string): void {
  for (const code of codes) {
    if (!isScenarioConclusionCode(code)) throw new LocalQualityError('INVALID_CASE', caseId);
  }
}

function scenarioErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !SCENARIO_ERROR_NAMES.includes(error.name)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code.length === 0 || error.message !== code) return undefined;
  return code;
}

const projectionSchema = z.object({
  status: z.string().min(1),
  numbers: z.record(z.string(), z.number()),
  booleans: z.record(z.string(), z.boolean()),
  strings: z.record(z.string(), z.string()),
  missingEvidence: z.array(z.string().min(1)),
  allowedConclusions: z.array(z.string().min(1)),
  forbiddenConclusions: z.array(z.string().min(1)),
}).strict();

const caseReportSchema = z.object({
  caseId: z.string().min(1),
  title: z.string().min(1),
  family: z.enum(SCENARIO_FAMILY_CODES),
  fixtureId: z.string().min(1),
  scenarioId: z.string().min(1),
  scenarioVersion: z.string().min(1),
  implementationDigest: z.string().min(1),
  datasetId: z.string().min(1),
  datasetVersion: z.string().min(1),
  datasetDigest: z.string().min(1),
  requestedWindow: z.object({
    startUnixSeconds: z.number().int().nonnegative(),
    endUnixSeconds: z.number().int().nonnegative(),
  }).strict().nullable(),
  checks: z.array(z.object({
    code: z.enum([
      'SCENARIO_APPLICABILITY', 'FIXTURE_LOADABLE', 'DATASET_WINDOW_CONSISTENT', 'STATUS_MATCH', 'NUMERIC_MATCH',
      'BOOLEAN_MATCH', 'STRING_MATCH', 'MISSING_EVIDENCE_VISIBLE', 'CONCLUSION_BOUNDS', 'EVIDENCE_ATTRIBUTION',
      'NO_FABRICATED_COMPLETENESS', 'ERROR_INFORMATION_SAFE',
    ]),
    passed: z.boolean(),
  }).strict()).min(1),
  verdict: z.enum(['passed', 'failed', 'not_run']),
  errorCode: z.string().min(1).optional(),
  projection: projectionSchema.optional(),
}).strict();

const reportSchema = z.object({
  schemaVersion: z.literal(LOCAL_QUALITY_REPORT_SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  modelMode: z.enum(['offline_deterministic', 'online_opt_in']),
  sourceMode: z.literal(LOCAL_QUALITY_SOURCE_MODE),
  transport: z.enum(['injected', 'loopback_http']),
  datasetId: z.string().min(1),
  datasetVersion: z.string().min(1),
  datasetDigest: z.string().min(1),
  windowSeconds: z.number().int().nonnegative(),
  cases: z.array(caseReportSchema).min(1),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative(),
    byFamily: z.record(z.enum(SCENARIO_FAMILY_CODES), z.object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      notRun: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
  budget: z.object({
    maxCases: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    usedMs: z.number().int().nonnegative(),
    exhausted: z.enum(['deadline', 'abort']).nullable(),
  }).strict(),
  verdict: z.enum(['passed', 'failed']),
}).strict();

/**
 * Re-read a stored report and recompute every verdict from its checks. There is no
 * manual override field: an edited verdict or check fails here instead of turning green.
 */
export function parseLocalQualityReportV1(input: unknown): LocalQualityReportV1 {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) throw new LocalQualityError('REPORT_TAMPERED', 'schema');
  const report = parsed.data;
  for (const caseReport of report.cases) {
    const allPassed = caseReport.checks.every((check) => check.passed);
    // A case whose checks all passed must be stored as passed; any other case may
    // only be stored as failed or not_run, never as passed.
    const allowedVerdicts: readonly LocalQualityCaseVerdict[] = allPassed ? ['passed'] : ['failed', 'not_run'];
    if (!allowedVerdicts.includes(caseReport.verdict)) throw new LocalQualityError('REPORT_TAMPERED', caseReport.caseId);
  }
  const passed = report.cases.filter((entry) => entry.verdict === 'passed').length;
  const failed = report.cases.filter((entry) => entry.verdict === 'failed').length;
  const notRun = report.cases.filter((entry) => entry.verdict === 'not_run').length;
  if (report.summary.total !== report.cases.length || report.summary.passed !== passed
    || report.summary.failed !== failed || report.summary.notRun !== notRun) {
    throw new LocalQualityError('REPORT_TAMPERED', 'summary');
  }
  const recomputedVerdict: LocalQualityVerdict = passed === report.cases.length && failed === 0 && notRun === 0
    && report.budget.exhausted === null ? 'passed' : 'failed';
  if (report.verdict !== recomputedVerdict) throw new LocalQualityError('REPORT_TAMPERED', 'verdict');
  return report as unknown as LocalQualityReportV1;
}
