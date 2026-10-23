import { describe, expect, it } from 'vitest';
import {
  LOCAL_QUALITY_LIMITING_STATUSES,
  LOCAL_QUALITY_NUMBER_TOLERANCE,
  LocalQualityError,
  assessLocalQualityCase,
  evaluateLocalQualityCase,
  parseLocalQualityReportV1,
  runLocalQualitySet,
  validateLocalQualityCases,
  type LocalQualityCaseV1,
  type LocalQualityExpectationV1,
  type LocalQualityFixtureV1,
} from '../src/acceptance/local-quality.js';
import { scenarioFamilyApplicability } from '../src/profiles/scenarios/index.js';
import {
  assessDependencyCorrelationV1,
  assessResourceSaturationV1,
  assessWindowLatencyV1,
  assessWindowTrafficBaselineV1,
  DependencyCorrelationScenarioError,
  ResourceSaturationScenarioError,
  WindowFailureRateScenarioError,
  WindowLatencyScenarioError,
  WindowTrafficScenarioError,
} from '../src/profiles/scenarios/index.js';
import { startScenarioQualityLab } from '../src/bootstrap/scenario-quality-lab.js';
import {
  LOCAL_INSPECTION_QUALITY_CASES,
  LOCAL_QUALITY_MINIMUM_CASES_PER_FAMILY,
  LOCAL_QUALITY_MINIMUM_CASE_COUNT,
  SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
  SCENARIO_FIXTURE_WINDOW_SECONDS,
  SCENARIO_WINDOW_DATASET_DIGEST,
  SCENARIO_WINDOW_DATASET_ID,
  listScenarioWindowFixtureIds,
  loadScenarioWindowFixture,
  mutateReport,
  qualityCase,
  qualityCasesWith,
  qualityFixtureLoader,
  roundTripReport,
} from './fixtures/local-inspection-quality-cases.js';

const WINDOW = {
  timestampUnit: 'unix_seconds',
  startUnixSeconds: SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS - SCENARIO_FIXTURE_WINDOW_SECONDS,
  endUnixSeconds: SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
} as const;

const BASELINE_WINDOW = {
  timestampUnit: 'unix_seconds',
  startUnixSeconds: WINDOW.startUnixSeconds - SCENARIO_FIXTURE_WINDOW_SECONDS,
  endUnixSeconds: WINDOW.startUnixSeconds,
} as const;

const RESOURCE_THRESHOLDS = { cpu: 0.85, memory: 0.9, disk: 0.85, thread_pool: 0.85 } as const;

function runSet(overrides: Partial<Parameters<typeof runLocalQualitySet>[0]> = {}, cases?: readonly LocalQualityCaseV1[]) {
  return runLocalQualitySet({
    cases: cases ?? LOCAL_INSPECTION_QUALITY_CASES,
    loadFixture: qualityFixtureLoader,
    ...overrides,
  });
}

describe('S3 offline diagnostic quality set', () => {
  it('covers all five families with at least eleven named samples', () => {
    expect(LOCAL_INSPECTION_QUALITY_CASES.length).toBeGreaterThanOrEqual(LOCAL_QUALITY_MINIMUM_CASE_COUNT);
    expect(() => validateLocalQualityCases(LOCAL_INSPECTION_QUALITY_CASES)).not.toThrow();
    const knownFixtures = new Set(listScenarioWindowFixtureIds());
    for (const definition of LOCAL_INSPECTION_QUALITY_CASES) {
      expect(knownFixtures.has(definition.fixtureId)).toBe(true);
    }
    for (const [family, minimum] of Object.entries(LOCAL_QUALITY_MINIMUM_CASES_PER_FAMILY)) {
      const count = LOCAL_INSPECTION_QUALITY_CASES.filter((entry) => entry.family === family).length;
      expect(count, `family ${family}`).toBeGreaterThanOrEqual(minimum);
    }
    // No fixture may stay unasserted, otherwise the dataset could drift silently.
    const used = new Set(LOCAL_INSPECTION_QUALITY_CASES.map((entry) => entry.fixtureId));
    for (const fixtureId of knownFixtures) expect(used.has(fixtureId), `fixture ${fixtureId}`).toBe(true);
  });

  it('passes deterministically and records simulated provenance', () => {
    const report = runSet();
    expect(report.verdict).toBe('passed');
    expect(report.summary.total).toBe(LOCAL_INSPECTION_QUALITY_CASES.length);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.notRun).toBe(0);
    expect(report.modelMode).toBe('offline_deterministic');
    expect(report.sourceMode).toBe('simulated');
    expect(report.datasetId).toBe(SCENARIO_WINDOW_DATASET_ID);
    expect(report.datasetDigest).toBe(SCENARIO_WINDOW_DATASET_DIGEST);
    expect(report.windowSeconds).toBe(SCENARIO_FIXTURE_WINDOW_SECONDS);
    expect(report.budget.exhausted).toBeNull();
    for (const caseReport of report.cases) {
      const installed = scenarioFamilyApplicability(caseReport.family);
      expect(caseReport.scenarioId).toBe(installed.scenarioId);
      expect(caseReport.scenarioVersion).toBe(installed.scenarioVersion);
      expect(caseReport.implementationDigest).toBe(installed.implementationDigest);
      expect(caseReport.checks.every((check) => check.passed)).toBe(true);
    }
    // Re-running with a frozen clock is byte-identical.
    const frozen = { now: () => new Date('2026-10-22T00:00:00.000Z') };
    const first = runSet({ clock: frozen });
    const again = runSet({ clock: frozen });
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(JSON.stringify(stripTime(again))).toBe(JSON.stringify(stripTime(report)));
  });

  it('keeps every fact inside one frozen window', () => {
    for (const fixtureId of listScenarioWindowFixtureIds()) {
      const fixture = loadScenarioWindowFixture(fixtureId);
      expect(fixture.requestedWindow.endUnixSeconds).toBe(fixture.evaluationTimeUnixSeconds);
      expect(fixture.requestedWindow.endUnixSeconds - fixture.requestedWindow.startUnixSeconds)
        .toBe(fixture.windowSeconds);
      for (const fact of fixture.facts) {
        expect(fact.family).toBe(fixture.family);
        if (fact.window === null) {
          expect(fact.availability).not.toBe('available');
          continue;
        }
        expect(fact.window.startUnixSeconds).toBe(fixture.requestedWindow.startUnixSeconds);
        expect(fact.window.endUnixSeconds).toBe(fixture.requestedWindow.endUnixSeconds);
      }
      expect(JSON.parse(JSON.stringify(loadScenarioWindowFixture(fixtureId))))
        .toEqual(JSON.parse(JSON.stringify(fixture)));
    }
  });

  it('applies inclusive threshold comparisons per family', () => {
    const atLatencyThreshold = assessWindowLatencyV1({
      snapshot: latencySnapshot({ sampleCount: 100, p50Ms: 100, p95Ms: 250, p99Ms: 300 }),
      requestedWindow: WINDOW,
      p95ThresholdMs: 250,
      minSamples: 50,
    });
    expect(atLatencyThreshold.status).toBe('complete');
    if (atLatencyThreshold.status === 'complete') expect(atLatencyThreshold.thresholdReached).toBe(true);

    const belowLatencyThreshold = assessWindowLatencyV1({
      snapshot: latencySnapshot({ sampleCount: 100, p50Ms: 100, p95Ms: 249.999, p99Ms: 300 }),
      requestedWindow: WINDOW,
      p95ThresholdMs: 250,
      minSamples: 50,
    });
    if (belowLatencyThreshold.status === 'complete') expect(belowLatencyThreshold.thresholdReached).toBe(false);

    const atDropThreshold = assessWindowTrafficBaselineV1({
      snapshot: trafficSnapshot({ requestCount: 700, baselineRequestCount: 1_000 }),
      requestedWindow: WINDOW,
      dropThresholdRatio: 0.3,
      minSamples: 100,
    });
    expect(atDropThreshold.status).toBe('complete');
    if (atDropThreshold.status === 'complete') {
      expect(Math.abs(atDropThreshold.dropRatio - 0.3)).toBeLessThanOrEqual(LOCAL_QUALITY_NUMBER_TOLERANCE);
      expect(atDropThreshold.dropThresholdReached).toBe(true);
    }

    const atResourceThreshold = assessResourceSaturationV1({
      snapshot: resourceSnapshot([
        { kind: 'cpu', utilizationRatio: 0.85, computation: 'gauge_window_avg' },
        { kind: 'memory', utilizationRatio: 0.5, computation: 'gauge_window_avg' },
      ]),
      requestedWindow: WINDOW,
      thresholds: RESOURCE_THRESHOLDS,
      minSignalsForConfirmation: 2,
    });
    expect(atResourceThreshold.status).toBe('saturated');

    const atMinimumErrors = assessDependencyCorrelationV1({
      snapshot: dependencySnapshot({ errorCount: 5, callCount: 100 }, [
        { timestampUnixSeconds: WINDOW.startUnixSeconds + 10, level: 'ERROR', dependencyId: 'payment-gateway' },
      ]),
      requestedWindow: WINDOW,
      minErrorCount: 5,
      minCorroboratingRecords: 1,
    });
    expect(atMinimumErrors.status).toBe('corroborated');

    const belowMinimumErrors = assessDependencyCorrelationV1({
      snapshot: dependencySnapshot({ errorCount: 4, callCount: 100 }, [
        { timestampUnixSeconds: WINDOW.startUnixSeconds + 10, level: 'ERROR', dependencyId: 'payment-gateway' },
      ]),
      requestedWindow: WINDOW,
      minErrorCount: 5,
      minCorroboratingRecords: 1,
    });
    expect(belowMinimumErrors.status).toBe('no_correlation');
  });

  it('rejects malformed and contradictory input with stable codes only', () => {
    const cases: readonly (() => unknown)[] = [
      () => assessWindowLatencyV1({
        snapshot: latencySnapshot({ sampleCount: 100, p50Ms: 300, p95Ms: 200, p99Ms: 400 }),
        requestedWindow: WINDOW, p95ThresholdMs: 250, minSamples: 50,
      }),
      () => assessWindowLatencyV1({
        snapshot: latencySnapshot({ sampleCount: 100, p50Ms: 10, p95Ms: 20, p99Ms: 30 },
          { timestampUnit: 'unix_seconds', startUnixSeconds: WINDOW.startUnixSeconds + 1,
            endUnixSeconds: WINDOW.endUnixSeconds }),
        requestedWindow: WINDOW, p95ThresholdMs: 250, minSamples: 50,
      }),
      () => assessWindowTrafficBaselineV1({
        snapshot: trafficSnapshot({ requestCount: 700, baselineRequestCount: 1_000 },
          { timestampUnit: 'unix_seconds', startUnixSeconds: WINDOW.startUnixSeconds - 100,
            endUnixSeconds: WINDOW.startUnixSeconds + 200 }),
        requestedWindow: WINDOW, dropThresholdRatio: 0.3, minSamples: 100,
      }),
      () => assessWindowTrafficBaselineV1({
        snapshot: trafficSnapshot({ requestCount: 700, baselineRequestCount: 1_000 },
          { timestampUnit: 'unix_seconds', startUnixSeconds: BASELINE_WINDOW.startUnixSeconds,
            endUnixSeconds: BASELINE_WINDOW.startUnixSeconds + 60 }),
        requestedWindow: WINDOW, dropThresholdRatio: 0.3, minSamples: 100,
      }),
      () => assessDependencyCorrelationV1({
        snapshot: dependencySnapshot({ errorCount: 120, callCount: 100 }, []),
        requestedWindow: WINDOW, minErrorCount: 5, minCorroboratingRecords: 1,
      }),
      () => assessDependencyCorrelationV1({
        snapshot: dependencySnapshot({ errorCount: 10, callCount: 100 }, [
          { timestampUnixSeconds: WINDOW.endUnixSeconds + 5, level: 'ERROR', dependencyId: 'payment-gateway' },
        ]),
        requestedWindow: WINDOW, minErrorCount: 5, minCorroboratingRecords: 1,
      }),
      () => assessResourceSaturationV1({
        snapshot: resourceSnapshot([
          { kind: 'cpu', utilizationRatio: 0.9, computation: 'gauge_window_avg' },
          { kind: 'cpu', utilizationRatio: 0.2, computation: 'gauge_window_avg' },
        ]),
        requestedWindow: WINDOW, thresholds: RESOURCE_THRESHOLDS, minSignalsForConfirmation: 2,
      }),
      () => assessResourceSaturationV1({
        snapshot: resourceSnapshot([]),
        requestedWindow: WINDOW, thresholds: RESOURCE_THRESHOLDS, minSignalsForConfirmation: 2,
      }),
      () => assessResourceSaturationV1({
        snapshot: resourceSnapshot([{ kind: 'cpu', utilizationRatio: 1.5, computation: 'gauge_window_avg' }]),
        requestedWindow: WINDOW, thresholds: RESOURCE_THRESHOLDS, minSignalsForConfirmation: 2,
      }),
    ];
    const expectedCodes = [
      'NON_MONOTONIC_QUANTILES', 'WINDOW_MISMATCH', 'BASELINE_OVERLAPS_CURRENT', 'BASELINE_WINDOW_MISALIGNED',
      'ERROR_COUNT_EXCEEDS_CALLS', 'RECORD_OUTSIDE_WINDOW', 'DUPLICATE_SIGNAL_KIND', 'SIGNALS_EMPTY',
      'INVALID_UTILIZATION',
    ];
    cases.forEach((run, index) => {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `case ${index}`).toBeInstanceOf(Error);
      const error = thrown as Error & { code?: string };
      expect(error.code, `case ${index}`).toBe(expectedCodes[index]);
      // Stable code only: no interpolated values, no free text, no evidence content.
      expect(error.message, `case ${index}`).toBe(error.code);
    });

    const contradictory = assessLocalQualityCase(qualityCase('fr-contradictory-total'),
      loadScenarioWindowFixture('failure_rate.contradictory_total'));
    expect(contradictory.errorCode).toBe('INCONSISTENT_TOTAL');
    expect(contradictory.projection).toBeUndefined();
  });

  it('keeps limiting results from fabricating completeness', () => {
    const report = runSet();
    const limiting = report.cases.filter((entry) => entry.projection !== undefined
      && LOCAL_QUALITY_LIMITING_STATUSES.includes(entry.projection.status));
    expect(limiting.length).toBeGreaterThanOrEqual(5);
    for (const caseReport of limiting) {
      const projection = caseReport.projection;
      if (projection === undefined) continue;
      expect(projection.forbiddenConclusions).toContain('root_cause_established');
      expect(projection.forbiddenConclusions).toContain('healthy_system_wide');
      expect(projection.allowedConclusions).not.toContain('root_cause_established');
      expect(projection.allowedConclusions.some((code) => code === 'missing_evidence_partial_diagnosis'
        || code === 'insufficient_samples_no_attribution' || code === 'baseline_unavailable_no_comparison'
        || code === 'resource_saturation_candidate' || code === 'temporal_coincidence_only')).toBe(true);
    }
  });

  it('exposes missing evidence instead of inferred values', () => {
    const report = runSet();
    const expected: Record<string, readonly string[]> = {
      'fr-missing-window': ['end_boundary'],
      'traffic-baseline-missing': ['baseline_count', 'baseline_window'],
      'dep-log-source-missing': ['log_records', 'log_source'],
      'res-series-missing': ['resource_series'],
    };
    for (const [caseId, missing] of Object.entries(expected)) {
      const projection = report.cases.find((entry) => entry.caseId === caseId)?.projection;
      expect(projection?.missingEvidence, caseId).toEqual(missing);
    }
  });

  it('fails a case whose expectation was edited', () => {
    const wrongNumber = runSet({}, qualityCasesWith('fr-breached', (current) => ({
      ...current,
      numbers: { ...current.numbers, failureRate: 0.04 },
    })));
    expect(wrongNumber.verdict).toBe('failed');
    const failedCase = wrongNumber.cases.find((entry) => entry.caseId === 'fr-breached');
    expect(failedCase?.verdict).toBe('failed');
    expect(failedCase?.checks.find((check) => check.code === 'NUMERIC_MATCH')?.passed).toBe(false);

    const forbiddenClaim = runSet({}, qualityCasesWith('dep-time-overlap-only', (current) => ({
      ...current,
      allowedConclusions: [...current.allowedConclusions, 'root_cause_established'],
      forbiddenConclusions: current.forbiddenConclusions.filter((code) => code !== 'root_cause_established'),
    })));
    expect(forbiddenClaim.verdict).toBe('failed');
    expect(forbiddenClaim.cases.find((entry) => entry.caseId === 'dep-time-overlap-only')
      ?.checks.find((check) => check.code === 'CONCLUSION_BOUNDS')?.passed).toBe(false);
  });

  it('fails when a fixture cannot be loaded', () => {
    const report = runLocalQualitySet({
      cases: [qualityCase('lat-normal')],
      loadFixture: () => { throw new Error('SCENARIO_FIXTURE_HTTP_500'); },
    });
    expect(report.verdict).toBe('failed');
    expect(report.cases[0]?.checks.every((check) => !check.passed)).toBe(true);
    expect(report.cases[0]?.datasetId).toBe('unavailable');
  });

  it('enforces the batch budget and case-table integrity', () => {
    expect(() => runSet({ maxCases: 2 })).toThrow(LocalQualityError);
    try {
      runSet({ maxCases: 2 });
    } catch (error) {
      expect((error as LocalQualityError).code).toBe('BUDGET_EXCEEDED');
    }
    expect(() => validateLocalQualityCases([])).toThrowError(/EMPTY_CASE_SET/u);
    expect(() => validateLocalQualityCases([qualityCase('lat-normal'), qualityCase('lat-normal')]))
      .toThrowError(/DUPLICATE_CASE/u);
    expect(() => validateLocalQualityCases([{
      ...qualityCase('lat-normal'),
      expectation: { ...qualityCase('lat-normal').expectation, status: 'saturated' },
    }])).toThrowError(/INVALID_CASE/u);
    const withoutStatus = { ...qualityCase('lat-normal').expectation } as Record<string, unknown>;
    delete withoutStatus.status;
    expect(() => validateLocalQualityCases([{
      ...qualityCase('lat-normal'),
      expectation: withoutStatus as unknown as LocalQualityExpectationV1,
    }])).toThrowError(/INVALID_CASE/u);
  });

  it('stops at the deadline and records the remaining cases as not_run', () => {
    const startedAt = Date.parse('2026-10-22T00:00:00.000Z');
    let calls = 0;
    const clock = {
      now: () => {
        calls += 1;
        return new Date(startedAt + (calls <= 2 ? 0 : 60_000));
      },
    };
    const report = runSet({ clock, deadlineMs: 30_000 });
    expect(report.budget.exhausted).toBe('deadline');
    expect(report.budget.usedMs).toBe(60_000);
    expect(report.verdict).toBe('failed');
    expect(report.cases[0]?.verdict).toBe('passed');
    expect(report.summary.notRun).toBe(LOCAL_INSPECTION_QUALITY_CASES.length - 1);
    for (const caseReport of report.cases.slice(1)) {
      expect(caseReport.verdict).toBe('not_run');
      expect(caseReport.checks.every((check) => !check.passed)).toBe(true);
    }
  });

  it('marks every case not_run after an explicit abort', () => {
    const controller = new AbortController();
    controller.abort();
    const report = runSet({ signal: controller.signal });
    expect(report.budget.exhausted).toBe('abort');
    expect(report.verdict).toBe('failed');
    expect(report.summary.notRun).toBe(LOCAL_INSPECTION_QUALITY_CASES.length);
    expect(report.summary.passed).toBe(0);
  });

  it('refuses stored reports edited into a pass', () => {
    const passing = runSet();
    expect(parseLocalQualityReportV1(roundTripReport(passing)).verdict).toBe('passed');

    const failing = runSet({}, qualityCasesWith('fr-breached', (current) => ({
      ...current, status: 'insufficient_samples', numbers: { sampleCount: 10, minimumSamples: 20 },
    })));
    expect(failing.verdict).toBe('failed');
    const failingJson = roundTripReport(failing);
    expect(parseLocalQualityReportV1(failingJson).verdict).toBe('failed');

    // Editing the verdict, a check, the summary, or adding a review override all fail re-validation.
    expect(() => parseLocalQualityReportV1(mutateReport(failing, (draft) => {
      draft.verdict = 'passed';
    }))).toThrowError(/REPORT_TAMPERED/u);
    expect(() => parseLocalQualityReportV1(mutateReport(failing, (draft) => {
      const cases = draft.cases as { caseId: string; checks: { code: string; passed: boolean }[] }[];
      const target = cases.find((entry) => entry.caseId === 'fr-breached');
      for (const check of target?.checks ?? []) check.passed = true;
    }))).toThrowError(/REPORT_TAMPERED/u);
    expect(() => parseLocalQualityReportV1(mutateReport(failing, (draft) => {
      const summary = draft.summary as Record<string, unknown>;
      summary.failed = 0;
      summary.passed = (summary.passed as number) + 1;
    }))).toThrowError(/REPORT_TAMPERED/u);
    expect(() => parseLocalQualityReportV1(mutateReport(failing, (draft) => {
      draft.manualReview = { status: 'approved', unsupportedClaimCount: 0 };
    }))).toThrowError(/REPORT_TAMPERED/u);
    expect(() => parseLocalQualityReportV1(mutateReport(failing, (draft) => {
      draft.sourceMode = 'production';
    }))).toThrowError(/REPORT_TAMPERED/u);
  });

  it('keeps evaluation pure for a case that cannot be assessed', () => {
    const definition = qualityCase('lat-normal');
    const fixture: LocalQualityFixtureV1 = loadScenarioWindowFixture('latency.normal');
    const report = evaluateLocalQualityCase(definition, fixture, { unexpectedError: 'UNEXPECTED_ERROR' });
    expect(report.verdict).toBe('failed');
    expect(report.checks.find((check) => check.code === 'ERROR_INFORMATION_SAFE')?.passed).toBe(false);
    expect(report.checks.find((check) => check.code === 'STATUS_MATCH')?.passed).toBe(false);
  });

  it('runs the same frozen dataset over the loopback simulator transport', async (ctx) => {
    let lab: Awaited<ReturnType<typeof startScenarioQualityLab>> | undefined;
    try {
      lab = await startScenarioQualityLab();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
        return;
      }
      throw error;
    }
    try {
      expect(lab.datasetDigest).toBe(SCENARIO_WINDOW_DATASET_DIGEST);
      const report = runLocalQualitySet({
        cases: LOCAL_INSPECTION_QUALITY_CASES,
        loadFixture: lab.createFixtureLoader(),
        transport: 'loopback_http',
      });
      expect(report.transport).toBe('loopback_http');
      expect(report.verdict).toBe('passed');
      expect(report.summary.total).toBe(LOCAL_INSPECTION_QUALITY_CASES.length);
    } finally {
      await lab.close();
    }
  });
});

function stripTime(report: { generatedAt: string; budget: { usedMs: number } }): unknown {
  return { ...report, generatedAt: 'redacted', budget: { ...report.budget, usedMs: 0 } };
}

function latencySnapshot(
  quantiles: { sampleCount: number; p50Ms: number; p95Ms: number; p99Ms: number },
  window: { timestampUnit: 'unix_seconds'; startUnixSeconds: number; endUnixSeconds: number } = WINDOW,
) {
  return {
    schemaVersion: 'window_latency_snapshot.v1',
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window,
    computation: 'source_histogram_bucket',
    ...quantiles,
  } as never;
}

function trafficSnapshot(
  counts: { requestCount: number; baselineRequestCount: number },
  baselineWindow: { timestampUnit: 'unix_seconds'; startUnixSeconds: number; endUnixSeconds: number } = BASELINE_WINDOW,
) {
  return {
    schemaVersion: 'window_traffic_snapshot.v1',
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window: WINDOW,
    requestCount: counts.requestCount,
    baseline: {
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: baselineWindow,
      requestCount: counts.baselineRequestCount,
    },
  } as never;
}

function dependencySnapshot(
  upstream: { errorCount: number; callCount: number },
  records: readonly { timestampUnixSeconds: number; level: 'ERROR' | 'WARN' | 'INFO'; dependencyId: string | null }[],
) {
  return {
    schemaVersion: 'dependency_window_snapshot.v1',
    upstreamErrors: {
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: WINDOW,
      dependencyId: 'payment-gateway',
      errorCount: upstream.errorCount,
      callCount: upstream.callCount,
    },
    dependencyLogs: {
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: WINDOW,
      records,
    },
  } as never;
}

function resourceSnapshot(
  signals: readonly { kind: 'cpu' | 'memory' | 'disk' | 'thread_pool'; utilizationRatio: number; computation: 'gauge_window_avg' | 'gauge_window_max' }[],
) {
  return {
    schemaVersion: 'window_resource_snapshot.v1',
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window: WINDOW,
    signals,
  } as never;
}

// Keep the scenario error classes referenced for reviewers inspecting stable codes.
export const SCENARIO_ERROR_CLASSES = [
  WindowFailureRateScenarioError, WindowLatencyScenarioError, WindowTrafficScenarioError,
  DependencyCorrelationScenarioError, ResourceSaturationScenarioError,
];
