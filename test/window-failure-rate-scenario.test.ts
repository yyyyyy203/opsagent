import { describe, expect, it } from 'vitest';
import {
  WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION,
  assessWindowFailureRateV1,
  parseWindowCountSnapshotV1,
  type HostAuthorizedRequestedWindowV1,
  type WindowCountSnapshotV1,
} from '../src/profiles/index.js';

const requestedWindow: HostAuthorizedRequestedWindowV1 = {
  timestampUnit: 'unix_seconds',
  startUnixSeconds: 10_000,
  endUnixSeconds: 10_601,
};

type AvailableSnapshot = Extract<WindowCountSnapshotV1, { availability: 'available' }>;

function availableSnapshot(overrides: Partial<AvailableSnapshot> = {}): AvailableSnapshot {
  return {
    schemaVersion: 'window_count_snapshot.v1',
    availability: 'available',
    timestampUnit: 'unix_seconds',
    window: {
      startUnixSeconds: requestedWindow.startUnixSeconds,
      endUnixSeconds: requestedWindow.endUnixSeconds,
    },
    successCount: 96,
    failureCount: 4,
    totalCount: 100,
    ...overrides,
  };
}

function expectScenarioError(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  expect(caught).toMatchObject({ code });
}

describe('window failure rate scenario 1.1.0', () => {
  it('parses the versioned integer window-count snapshot as a typed fact', () => {
    expect(WINDOW_COUNT_SNAPSHOT_V1_SCHEMA_VERSION).toBe('window_count_snapshot.v1');
    expect(parseWindowCountSnapshotV1(availableSnapshot())).toEqual(availableSnapshot());
  });

  it('computes a 4% rate below a 5% threshold deterministically', () => {
    const assessment = assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow,
      threshold: 0.05,
      minSamples: 20,
    });

    expect(assessment).toMatchObject({
      status: 'complete',
      successCount: 96,
      failureCount: 4,
      totalCount: 100,
      failureRate: 0.04,
      threshold: 0.05,
      thresholdReached: false,
    });
  });

  it('computes the same 4% fact as reaching a 2% threshold', () => {
    const assessment = assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow,
      threshold: 0.02,
      minSamples: 20,
    });

    expect(assessment).toMatchObject({ status: 'complete', failureRate: 0.04, thresholdReached: true });
  });

  it('treats a rate equal to the configured threshold as reached', () => {
    const assessment = assessWindowFailureRateV1({
      snapshot: availableSnapshot({ successCount: 98, failureCount: 2 }),
      requestedWindow,
      threshold: 0.02,
      minSamples: 20,
    });

    expect(assessment).toMatchObject({ status: 'complete', failureRate: 0.02, thresholdReached: true });
  });

  it('returns insufficient_samples below the configured minimum', () => {
    const assessment = assessWindowFailureRateV1({
      snapshot: availableSnapshot({ successCount: 3, failureCount: 1, totalCount: 4 }),
      requestedWindow,
      threshold: 0.05,
      minSamples: 20,
    });

    expect(assessment).toMatchObject({ status: 'insufficient_samples', sampleCount: 4, minimumSamples: 20 });
  });

  it('returns unavailable with explicit missing-window evidence', () => {
    const assessment = assessWindowFailureRateV1({
      snapshot: {
        schemaVersion: 'window_count_snapshot.v1',
        availability: 'unavailable',
        reason: 'missing_window_evidence',
        missingEvidence: ['start_boundary', 'end_boundary'],
      },
      requestedWindow,
      threshold: 0.05,
      minSamples: 20,
    });

    expect(assessment).toEqual({
      status: 'unavailable',
      reason: 'missing_window_evidence',
      missingEvidence: ['start_boundary', 'end_boundary'],
    });
  });

  it('accepts any finite host-authorized window duration when both fact boundaries match', () => {
    const historicalRequest: HostAuthorizedRequestedWindowV1 = {
      timestampUnit: 'unix_seconds',
      startUnixSeconds: 1_000,
      endUnixSeconds: 1_601,
    };
    const snapshot = availableSnapshot({
      window: { startUnixSeconds: 1_000, endUnixSeconds: 1_601 },
    });

    expect(assessWindowFailureRateV1({
      snapshot,
      requestedWindow: historicalRequest,
      threshold: 0.05,
      minSamples: 20,
    }).status).toBe('complete');
  });

  it.each([
    ['earlier stale boundaries', { startUnixSeconds: 9_999, endUnixSeconds: 10_600 }],
    ['later future boundaries', { startUnixSeconds: 10_001, endUnixSeconds: 10_602 }],
  ])('rejects %s that differ from the requested window', (
    _label: string,
    window: { startUnixSeconds: number; endUnixSeconds: number },
  ) => {
    expectScenarioError(() => assessWindowFailureRateV1({
      snapshot: availableSnapshot({ window }),
      requestedWindow,
      threshold: 0.05,
      minSamples: 20,
    }), 'WINDOW_MISMATCH');
  });

  it('rejects a snapshot with the wrong timestamp unit', () => {
    expectScenarioError(() => parseWindowCountSnapshotV1({
      ...availableSnapshot(),
      timestampUnit: 'unix_milliseconds',
    }), 'INVALID_TIMESTAMP_UNIT');
  });

  it('rejects a host-authorized requested window with the wrong timestamp unit', () => {
    const wrongUnitWindow = {
      ...requestedWindow,
      timestampUnit: 'unix_milliseconds',
    } as unknown as HostAuthorizedRequestedWindowV1;

    expectScenarioError(() => assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow: wrongUnitWindow,
      threshold: 0.05,
      minSamples: 20,
    }), 'INVALID_TIMESTAMP_UNIT');
  });

  it.each([
    ['non-finite start timestamp', { startUnixSeconds: Number.NaN, endUnixSeconds: 10_601 }],
    ['infinite end timestamp', { startUnixSeconds: 10_000, endUnixSeconds: Number.POSITIVE_INFINITY }],
  ])('rejects a %s', (
    _label: string,
    window: { startUnixSeconds: number; endUnixSeconds: number },
  ) => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot({ window })), 'INVALID_BOUNDARY_TIMESTAMP');
  });

  it('rejects a snapshot from another schema version', () => {
    expectScenarioError(() => parseWindowCountSnapshotV1({
      ...availableSnapshot(),
      schemaVersion: 'window_count_snapshot.v2',
    }), 'INVALID_SNAPSHOT_SCHEMA');
  });

  it.each([
    ['negative success count', { successCount: -1 }],
    ['negative failure count', { failureCount: -1 }],
    ['fractional success count', { successCount: 0.5 }],
    ['fractional failure count', { failureCount: 0.5 }],
    ['unsafe success count', { successCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe failure count', { failureCount: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects a %s', (_label: string, counts: Partial<AvailableSnapshot>) => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot(counts)), 'INVALID_COUNT');
  });

  it('rejects zero total samples', () => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot({
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
    })), 'INVALID_TOTAL');
  });

  it.each([
    ['negative total', -1],
    ['fractional total', 4.5],
    ['unsafe total', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s', (_label: string, totalCount: number) => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot({ totalCount })), 'INVALID_TOTAL');
  });

  it('rejects failures greater than total samples', () => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot({
      successCount: 0,
      failureCount: 5,
      totalCount: 4,
    })), 'FAILURE_COUNT_EXCEEDS_TOTAL');
  });

  it('rejects a total that differs from success plus failure counts', () => {
    expectScenarioError(() => parseWindowCountSnapshotV1(availableSnapshot({
      successCount: 95,
      failureCount: 4,
      totalCount: 100,
    })), 'INCONSISTENT_TOTAL');
  });

  it.each([
    ['non-finite boundary', { ...requestedWindow, endUnixSeconds: Number.NaN }],
    ['non-increasing boundaries', { ...requestedWindow, endUnixSeconds: requestedWindow.startUnixSeconds }],
  ])('rejects a requested window with %s', (
    _label: string,
    invalidWindow: HostAuthorizedRequestedWindowV1,
  ) => {
    expectScenarioError(() => assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow: invalidWindow,
      threshold: 0.05,
      minSamples: 20,
    }), 'INVALID_REQUESTED_WINDOW');
  });

  it('rejects an invalid configured threshold', () => {
    expectScenarioError(() => assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow,
      threshold: 1.01,
      minSamples: 20,
    }), 'INVALID_THRESHOLD');
  });

  it('rejects a non-positive minimum sample count', () => {
    expectScenarioError(() => assessWindowFailureRateV1({
      snapshot: availableSnapshot(),
      requestedWindow,
      threshold: 0.05,
      minSamples: 0,
    }), 'INVALID_MIN_SAMPLES');
  });
});
