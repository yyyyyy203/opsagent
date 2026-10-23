import { checkpointChecksum } from '../../contracts/stable-json.js';
import type {
  DependencyLogRecordV1,
  DependencyWindowSnapshotV1,
  ResourceSignalKindV1,
  WindowCountSnapshotV1,
  WindowLatencySnapshotV1,
  WindowResourceSnapshotV1,
  WindowTrafficSnapshotV1,
} from '../../profiles/scenarios/index.js';
import {
  DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
  WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
  WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
  WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
  WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
} from '../../profiles/scenarios/index.js';
import type { ScenarioFamilyCode } from '../../profiles/scenarios/index.js';
import type { HostAuthorizedWindowV1 } from '../../profiles/scenarios/scenario-window.js';

/** Simulated dataset identity; bump when any seed value or window rule changes. */
export const SCENARIO_WINDOW_DATASET_ID = 'local-scenario-windows-v1' as const;
export const SCENARIO_WINDOW_DATASET_VERSION = '1.0.0' as const;
export const SCENARIO_FIXTURE_WINDOW_SECONDS = 300;
/** Frozen evaluation time so every fixture reproduces the same window offline. */
export const SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS = 1_760_000_000;

export type ScenarioFixtureSourceIdV1 = 'metrics-sim' | 'logs-sim';

export interface ScenarioWindowBoundaryV1 {
  readonly timestampUnit: 'unix_seconds';
  readonly startUnixSeconds: number;
  readonly endUnixSeconds: number;
}

export interface ScenarioWindowFactV1 {
  readonly factId: string;
  readonly sourceId: ScenarioFixtureSourceIdV1;
  readonly family: ScenarioFamilyCode;
  readonly availability: 'available' | 'unavailable' | 'missing';
  readonly schemaVersion: string;
  /** `null` when the fact itself reports the window boundary as missing evidence. */
  readonly window: ScenarioWindowBoundaryV1 | null;
  /** Small safe attribution summary; never raw logs, credentials, or connection data. */
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
}

export type ScenarioWindowSnapshotV1 =
  | WindowCountSnapshotV1
  | WindowLatencySnapshotV1
  | WindowTrafficSnapshotV1
  | DependencyWindowSnapshotV1
  | WindowResourceSnapshotV1;

export interface ScenarioWindowFixtureV1 {
  readonly fixtureId: string;
  readonly family: ScenarioFamilyCode;
  readonly datasetId: typeof SCENARIO_WINDOW_DATASET_ID;
  readonly datasetVersion: typeof SCENARIO_WINDOW_DATASET_VERSION;
  readonly datasetDigest: string;
  readonly windowSeconds: number;
  readonly evaluationTimeUnixSeconds: number;
  readonly requestedWindow: HostAuthorizedWindowV1;
  readonly facts: readonly ScenarioWindowFactV1[];
  readonly snapshot: ScenarioWindowSnapshotV1;
}

export class ScenarioFixtureError extends Error {
  constructor(readonly code: 'UNKNOWN_FIXTURE' | 'INVALID_EVALUATION_TIME' | 'DUPLICATE_FACT') {
    super(code);
    this.name = 'ScenarioFixtureError';
  }
}

interface FixtureWindowContext {
  readonly evaluationTimeUnixSeconds: number;
  readonly windowSeconds: number;
  readonly start: number;
  readonly end: number;
  readonly baselineStart: number;
  readonly baselineEnd: number;
  readonly window: HostAuthorizedWindowV1;
  readonly baselineWindow: HostAuthorizedWindowV1;
  readonly boundaryWindow: { startUnixSeconds: number; endUnixSeconds: number };
  readonly baselineBoundaryWindow: { startUnixSeconds: number; endUnixSeconds: number };
}

interface FixtureSeedV1 {
  readonly fixtureId: string;
  readonly family: ScenarioFamilyCode;
  build(ctx: FixtureWindowContext): { facts: readonly ScenarioWindowFactV1[]; snapshot: ScenarioWindowSnapshotV1 };
}

const SEEDS: readonly FixtureSeedV1[] = Object.freeze([
  {
    fixtureId: 'failure_rate.normal',
    family: 'failure_rate',
    build: (ctx) => failureRateFixture(ctx, { successCount: 96, failureCount: 4 }),
  },
  {
    fixtureId: 'failure_rate.breached',
    family: 'failure_rate',
    build: (ctx) => failureRateFixture(ctx, { successCount: 85, failureCount: 15 }),
  },
  {
    fixtureId: 'failure_rate.low_sample',
    family: 'failure_rate',
    build: (ctx) => failureRateFixture(ctx, { successCount: 2, failureCount: 8 }),
  },
  {
    fixtureId: 'failure_rate.contradictory_total',
    family: 'failure_rate',
    build: (ctx) => ({
      facts: [countFact(ctx, 'unavailable', { note: 'counts_do_not_sum_to_total' })],
      snapshot: {
        schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
        availability: 'available',
        timestampUnit: 'unix_seconds',
        window: ctx.boundaryWindow,
        successCount: 90,
        failureCount: 20,
        totalCount: 100,
      } satisfies WindowCountSnapshotV1,
    }),
  },
  {
    fixtureId: 'failure_rate.missing_window',
    family: 'failure_rate',
    build: (ctx) => ({
      facts: [countFact(ctx, 'unavailable', { note: 'end_boundary_missing' })],
      snapshot: {
        schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
        availability: 'unavailable',
        reason: 'missing_window_evidence',
        missingEvidence: ['end_boundary'],
      } satisfies WindowCountSnapshotV1,
    }),
  },
  {
    fixtureId: 'latency.normal',
    family: 'latency',
    build: (ctx) => latencyFixture(ctx, { sampleCount: 1_200, p50Ms: 42, p95Ms: 180, p99Ms: 320 }),
  },
  {
    fixtureId: 'latency.p95_breached',
    family: 'latency',
    build: (ctx) => latencyFixture(ctx, { sampleCount: 1_180, p50Ms: 55, p95Ms: 480, p99Ms: 910 }),
  },
  {
    fixtureId: 'latency.low_sample',
    family: 'latency',
    build: (ctx) => latencyFixture(ctx, { sampleCount: 8, p50Ms: 40, p95Ms: 900, p99Ms: 1_200 }),
  },
  {
    fixtureId: 'traffic.normal',
    family: 'traffic',
    build: (ctx) => trafficFixture(ctx, { requestCount: 1_000, baselineRequestCount: 1_020 }),
  },
  {
    fixtureId: 'traffic.drop',
    family: 'traffic',
    build: (ctx) => trafficFixture(ctx, { requestCount: 620, baselineRequestCount: 1_000 }),
  },
  {
    fixtureId: 'traffic.baseline_missing',
    family: 'traffic',
    build: (ctx) => ({
      facts: [trafficFact(ctx, 'missing', { note: 'baseline_window_unavailable' })],
      snapshot: {
        schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
        availability: 'available',
        timestampUnit: 'unix_seconds',
        window: ctx.window,
        requestCount: 640,
        baseline: { availability: 'missing', missingEvidence: ['baseline_window', 'baseline_count'] },
      } satisfies WindowTrafficSnapshotV1,
    }),
  },
  {
    fixtureId: 'dependency.corroborated',
    family: 'dependency',
    build: (ctx) => dependencyFixture(ctx, {
      dependencyId: 'payment-gateway',
      errorCount: 42,
      callCount: 1_200,
      records: [
        { offsetSeconds: 60, level: 'ERROR', dependencyId: 'payment-gateway' },
        { offsetSeconds: 120, level: 'ERROR', dependencyId: 'payment-gateway' },
        { offsetSeconds: 200, level: 'WARN', dependencyId: 'payment-gateway' },
      ],
    }),
  },
  {
    fixtureId: 'dependency.time_overlap_only',
    family: 'dependency',
    build: (ctx) => dependencyFixture(ctx, {
      dependencyId: 'payment-gateway',
      errorCount: 42,
      callCount: 1_200,
      records: [
        { offsetSeconds: 90, level: 'WARN', dependencyId: null },
        { offsetSeconds: 150, level: 'WARN', dependencyId: 'inventory-service' },
      ],
    }),
  },
  {
    fixtureId: 'dependency.log_source_missing',
    family: 'dependency',
    build: (ctx) => ({
      facts: [
        upstreamFact(ctx, 'available', { dependencyId: 'payment-gateway', errorCount: 42, callCount: 1_200 }),
        logFact(ctx, 'unavailable', { note: 'log_source_unavailable' }),
      ],
      snapshot: {
        schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
        upstreamErrors: {
          availability: 'available',
          timestampUnit: 'unix_seconds',
          window: ctx.window,
          dependencyId: 'payment-gateway',
          errorCount: 42,
          callCount: 1_200,
        },
        dependencyLogs: {
          availability: 'unavailable',
          reason: 'missing_log_evidence',
          missingEvidence: ['log_source', 'log_records'],
        },
      } satisfies DependencyWindowSnapshotV1,
    }),
  },
  {
    fixtureId: 'dependency.record_outside_window',
    family: 'dependency',
    build: (ctx) => ({
      facts: [
        upstreamFact(ctx, 'available', { dependencyId: 'payment-gateway', errorCount: 42, callCount: 1_200 }),
        logFact(ctx, 'available', { note: 'record_timestamp_outside_window' }),
      ],
      snapshot: {
        schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
        upstreamErrors: {
          availability: 'available',
          timestampUnit: 'unix_seconds',
          window: ctx.window,
          dependencyId: 'payment-gateway',
          errorCount: 42,
          callCount: 1_200,
        },
        dependencyLogs: {
          availability: 'available',
          timestampUnit: 'unix_seconds',
          window: ctx.window,
          records: Object.freeze([
            Object.freeze({ timestampUnixSeconds: ctx.end + 90, level: 'ERROR', dependencyId: 'payment-gateway' }),
          ]),
        },
      } satisfies DependencyWindowSnapshotV1,
    }),
  },
  {
    fixtureId: 'resource.saturated_multi_signal',
    family: 'resource',
    build: (ctx) => resourceFixture(ctx, [
      { kind: 'cpu', utilizationRatio: 0.93, computation: 'gauge_window_avg' },
      { kind: 'memory', utilizationRatio: 0.94, computation: 'gauge_window_max' },
    ]),
  },
  {
    fixtureId: 'resource.single_signal_candidate',
    family: 'resource',
    build: (ctx) => resourceFixture(ctx, [
      { kind: 'cpu', utilizationRatio: 0.93, computation: 'gauge_window_avg' },
    ]),
  },
  {
    fixtureId: 'resource.within_threshold',
    family: 'resource',
    build: (ctx) => resourceFixture(ctx, [
      { kind: 'cpu', utilizationRatio: 0.31, computation: 'gauge_window_avg' },
      { kind: 'memory', utilizationRatio: 0.44, computation: 'gauge_window_max' },
    ]),
  },
  {
    fixtureId: 'resource.series_missing',
    family: 'resource',
    build: (ctx) => ({
      facts: [resourceFact(ctx, 'unavailable', { note: 'resource_series_missing' })],
      snapshot: {
        schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
        availability: 'unavailable',
        reason: 'missing_window_evidence',
        missingEvidence: ['resource_series'],
      } satisfies WindowResourceSnapshotV1,
    }),
  },
]);

export const SCENARIO_WINDOW_DATASET_DIGEST =
  `sha256:v1:${checkpointChecksum({
    algorithm: 'sha256',
    version: 1,
    datasetId: SCENARIO_WINDOW_DATASET_ID,
    datasetVersion: SCENARIO_WINDOW_DATASET_VERSION,
    windowSeconds: SCENARIO_FIXTURE_WINDOW_SECONDS,
    fixtureIds: SEEDS.map((seed) => seed.fixtureId),
  })}`;

/** Stable fixture identifiers in dataset order. */
export function listScenarioWindowFixtureIds(): readonly string[] {
  return Object.freeze(SEEDS.map((seed) => seed.fixtureId));
}

/**
 * Build one frozen fixture. All facts in a fixture share the same window, so a
 * case can never compare evidence captured from different time ranges.
 */
export function loadScenarioWindowFixture(
  fixtureId: string,
  options: { evaluationTimeUnixSeconds?: number } = {},
): ScenarioWindowFixtureV1 {
  const seed = SEEDS.find((entry) => entry.fixtureId === fixtureId);
  if (seed === undefined) throw new ScenarioFixtureError('UNKNOWN_FIXTURE');
  const evaluationTimeUnixSeconds = options.evaluationTimeUnixSeconds ?? SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS;
  if (!Number.isSafeInteger(evaluationTimeUnixSeconds) || evaluationTimeUnixSeconds <= SCENARIO_FIXTURE_WINDOW_SECONDS * 2) {
    throw new ScenarioFixtureError('INVALID_EVALUATION_TIME');
  }
  const end = evaluationTimeUnixSeconds;
  const start = end - SCENARIO_FIXTURE_WINDOW_SECONDS;
  const baselineEnd = start;
  const baselineStart = baselineEnd - SCENARIO_FIXTURE_WINDOW_SECONDS;
  const ctx: FixtureWindowContext = {
    evaluationTimeUnixSeconds,
    windowSeconds: SCENARIO_FIXTURE_WINDOW_SECONDS,
    start,
    end,
    baselineStart,
    baselineEnd,
    window: Object.freeze({ timestampUnit: 'unix_seconds', startUnixSeconds: start, endUnixSeconds: end }),
    baselineWindow: Object.freeze({ timestampUnit: 'unix_seconds', startUnixSeconds: baselineStart, endUnixSeconds: baselineEnd }),
    boundaryWindow: Object.freeze({ startUnixSeconds: start, endUnixSeconds: end }),
    baselineBoundaryWindow: Object.freeze({ startUnixSeconds: baselineStart, endUnixSeconds: baselineEnd }),
  };
  const built = seed.build(ctx);
  const factIds = new Set(built.facts.map((fact) => fact.factId));
  if (factIds.size !== built.facts.length) throw new ScenarioFixtureError('DUPLICATE_FACT');
  return Object.freeze({
    fixtureId: seed.fixtureId,
    family: seed.family,
    datasetId: SCENARIO_WINDOW_DATASET_ID,
    datasetVersion: SCENARIO_WINDOW_DATASET_VERSION,
    datasetDigest: SCENARIO_WINDOW_DATASET_DIGEST,
    windowSeconds: SCENARIO_FIXTURE_WINDOW_SECONDS,
    evaluationTimeUnixSeconds,
    requestedWindow: ctx.window,
    facts: Object.freeze(built.facts),
    snapshot: built.snapshot,
  });
}

function failureRateFixture(
  ctx: FixtureWindowContext,
  counts: { successCount: number; failureCount: number },
): { facts: readonly ScenarioWindowFactV1[]; snapshot: WindowCountSnapshotV1 } {
  const totalCount = counts.successCount + counts.failureCount;
  return {
    facts: [countFact(ctx, 'available', {
      successCount: counts.successCount, failureCount: counts.failureCount, totalCount,
    })],
    snapshot: {
      schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: ctx.boundaryWindow,
      successCount: counts.successCount,
      failureCount: counts.failureCount,
      totalCount,
    },
  };
}

function latencyFixture(
  ctx: FixtureWindowContext,
  quantiles: { sampleCount: number; p50Ms: number; p95Ms: number; p99Ms: number },
): { facts: readonly ScenarioWindowFactV1[]; snapshot: WindowLatencySnapshotV1 } {
  return {
    facts: [{
      factId: `${ctx.start}.latency.metrics`,
      sourceId: 'metrics-sim',
      family: 'latency',
      availability: 'available',
      schemaVersion: WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
      window: ctx.window,
      summary: Object.freeze({
        sampleCount: quantiles.sampleCount, p50Ms: quantiles.p50Ms, p95Ms: quantiles.p95Ms,
        p99Ms: quantiles.p99Ms, computation: 'source_histogram_bucket',
      }),
    }],
    snapshot: {
      schemaVersion: WINDOW_LATENCY_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: ctx.window,
      sampleCount: quantiles.sampleCount,
      p50Ms: quantiles.p50Ms,
      p95Ms: quantiles.p95Ms,
      p99Ms: quantiles.p99Ms,
      computation: 'source_histogram_bucket',
    },
  };
}

function trafficFixture(
  ctx: FixtureWindowContext,
  counts: { requestCount: number; baselineRequestCount: number },
): { facts: readonly ScenarioWindowFactV1[]; snapshot: WindowTrafficSnapshotV1 } {
  return {
    facts: [trafficFact(ctx, 'available', {
      requestCount: counts.requestCount,
      baselineRequestCount: counts.baselineRequestCount,
      baselineStart: ctx.baselineStart,
      baselineEnd: ctx.baselineEnd,
    })],
    snapshot: {
      schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: ctx.window,
      requestCount: counts.requestCount,
      baseline: {
        availability: 'available',
        timestampUnit: 'unix_seconds',
        window: ctx.baselineWindow,
        requestCount: counts.baselineRequestCount,
      },
    },
  };
}

function dependencyFixture(
  ctx: FixtureWindowContext,
  input: {
    dependencyId: string;
    errorCount: number;
    callCount: number;
    records: readonly { offsetSeconds: number; level: DependencyLogRecordV1['level']; dependencyId: string | null }[];
  },
): { facts: readonly ScenarioWindowFactV1[]; snapshot: DependencyWindowSnapshotV1 } {
  const records: DependencyLogRecordV1[] = input.records.map((record) => Object.freeze({
    timestampUnixSeconds: ctx.start + record.offsetSeconds,
    level: record.level,
    dependencyId: record.dependencyId,
  }));
  return {
    facts: [
      upstreamFact(ctx, 'available', {
        dependencyId: input.dependencyId, errorCount: input.errorCount, callCount: input.callCount,
      }),
      logFact(ctx, 'available', {
        recordCount: records.length,
        errorRecordCount: records.filter((record) => record.level === 'ERROR').length,
      }),
    ],
    snapshot: {
      schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
      upstreamErrors: {
        availability: 'available',
        timestampUnit: 'unix_seconds',
        window: ctx.window,
        dependencyId: input.dependencyId,
        errorCount: input.errorCount,
        callCount: input.callCount,
      },
      dependencyLogs: {
        availability: 'available',
        timestampUnit: 'unix_seconds',
        window: ctx.window,
        records: Object.freeze(records),
      },
    },
  };
}

function resourceFixture(
  ctx: FixtureWindowContext,
  signals: readonly { kind: ResourceSignalKindV1; utilizationRatio: number; computation: 'gauge_window_avg' | 'gauge_window_max' }[],
): { facts: readonly ScenarioWindowFactV1[]; snapshot: WindowResourceSnapshotV1 } {
  return {
    facts: [{
      factId: `${ctx.start}.resource.metrics`,
      sourceId: 'metrics-sim',
      family: 'resource',
      availability: 'available',
      schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
      window: ctx.window,
      summary: Object.freeze({
        signalCount: signals.length,
        kinds: signals.map((signal) => signal.kind).sort().join(','),
      }),
    }],
    snapshot: {
      schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
      availability: 'available',
      timestampUnit: 'unix_seconds',
      window: ctx.window,
      signals: Object.freeze(signals.map((signal) => Object.freeze({ ...signal }))),
    },
  };
}

function countFact(
  ctx: FixtureWindowContext,
  availability: ScenarioWindowFactV1['availability'],
  summary: Readonly<Record<string, string | number | boolean | null>>,
): ScenarioWindowFactV1 {
  return {
    factId: `${ctx.start}.failure_rate.metrics`,
    sourceId: 'metrics-sim',
    family: 'failure_rate',
    availability,
    schemaVersion: WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
    window: availability === 'available' ? ctx.window : null,
    summary,
  };
}

function trafficFact(
  ctx: FixtureWindowContext,
  availability: ScenarioWindowFactV1['availability'],
  summary: Readonly<Record<string, string | number | boolean | null>>,
): ScenarioWindowFactV1 {
  return {
    factId: `${ctx.start}.traffic.metrics`,
    sourceId: 'metrics-sim',
    family: 'traffic',
    availability,
    schemaVersion: WINDOW_TRAFFIC_SNAPSHOT_V1_SCHEMA_VERSION,
    window: ctx.window,
    summary,
  };
}

function upstreamFact(
  ctx: FixtureWindowContext,
  availability: ScenarioWindowFactV1['availability'],
  summary: Readonly<Record<string, string | number | boolean | null>>,
): ScenarioWindowFactV1 {
  return {
    factId: `${ctx.start}.dependency_upstream.metrics`,
    sourceId: 'metrics-sim',
    family: 'dependency',
    availability,
    schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
    window: ctx.window,
    summary,
  };
}

function logFact(
  ctx: FixtureWindowContext,
  availability: ScenarioWindowFactV1['availability'],
  summary: Readonly<Record<string, string | number | boolean | null>>,
): ScenarioWindowFactV1 {
  return {
    factId: `${ctx.start}.dependency_logs.logs`,
    sourceId: 'logs-sim',
    family: 'dependency',
    availability,
    schemaVersion: DEPENDENCY_WINDOW_SNAPSHOT_V1_SCHEMA_VERSION,
    window: availability === 'available' ? ctx.window : null,
    summary,
  };
}

function resourceFact(
  ctx: FixtureWindowContext,
  availability: ScenarioWindowFactV1['availability'],
  summary: Readonly<Record<string, string | number | boolean | null>>,
): ScenarioWindowFactV1 {
  return {
    factId: `${ctx.start}.resource.metrics`,
    sourceId: 'metrics-sim',
    family: 'resource',
    availability,
    schemaVersion: WINDOW_RESOURCE_SNAPSHOT_V1_SCHEMA_VERSION,
    window: availability === 'available' ? ctx.window : null,
    summary,
  };
}
