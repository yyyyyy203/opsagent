import {
  LOCAL_INSPECTION_QUALITY_CASES,
  LOCAL_QUALITY_MINIMUM_CASES_PER_FAMILY,
  LOCAL_QUALITY_MINIMUM_CASE_COUNT,
} from '../../src/acceptance/local-quality-cases.js';
import type { LocalQualityCaseV1, LocalQualityExpectationV1, LocalQualityReportV1 } from '../../src/acceptance/local-quality.js';
import { createInProcessScenarioFixtureLoader } from '../../src/bootstrap/scenario-quality-lab.js';
import {
  SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
  SCENARIO_FIXTURE_WINDOW_SECONDS,
  SCENARIO_WINDOW_DATASET_DIGEST,
  SCENARIO_WINDOW_DATASET_ID,
  listScenarioWindowFixtureIds,
  loadScenarioWindowFixture,
} from '../../src/infrastructure/simulator/scenario-window-fixtures.js';

export {
  LOCAL_INSPECTION_QUALITY_CASES,
  LOCAL_QUALITY_MINIMUM_CASES_PER_FAMILY,
  LOCAL_QUALITY_MINIMUM_CASE_COUNT,
  SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
  SCENARIO_FIXTURE_WINDOW_SECONDS,
  SCENARIO_WINDOW_DATASET_DIGEST,
  SCENARIO_WINDOW_DATASET_ID,
  listScenarioWindowFixtureIds,
  loadScenarioWindowFixture,
};

/** Deterministic loader shared by the offline tests. */
export const qualityFixtureLoader = createInProcessScenarioFixtureLoader();

export function qualityCase(caseId: string): LocalQualityCaseV1 {
  const found = LOCAL_INSPECTION_QUALITY_CASES.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new RangeError(`UNKNOWN_QUALITY_CASE:${caseId}`);
  return found;
}

/** Replace one case expectation to prove a wrong expectation fails instead of passing. */
export function qualityCasesWith(
  caseId: string,
  expectation: (current: LocalQualityExpectationV1) => LocalQualityExpectationV1,
): readonly LocalQualityCaseV1[] {
  return LOCAL_INSPECTION_QUALITY_CASES.map((entry) => entry.caseId === caseId
    ? { ...entry, expectation: expectation(entry.expectation) }
    : entry);
}

/** Simulate writing and re-reading a report artifact. */
export function roundTripReport(report: LocalQualityReportV1): unknown {
  return JSON.parse(JSON.stringify(report)) as unknown;
}

export function mutateReport(
  report: LocalQualityReportV1,
  mutate: (draft: Record<string, unknown>) => void,
): unknown {
  const draft = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  mutate(draft);
  return draft;
}
