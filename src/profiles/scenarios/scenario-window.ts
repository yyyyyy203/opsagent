/**
 * Shared, dependency-free input helpers for the versioned scenario families.
 *
 * Every scenario module keeps its own error class and code union; these helpers
 * only report which stable code applies so callers can throw their own error.
 */

export interface HostAuthorizedWindowV1 {
  readonly timestampUnit: 'unix_seconds';
  readonly startUnixSeconds: number;
  readonly endUnixSeconds: number;
}

export type ScenarioWindowErrorCode =
  | 'INVALID_REQUESTED_WINDOW'
  | 'INVALID_TIMESTAMP_UNIT'
  | 'INVALID_BOUNDARY_WINDOW'
  | 'INVALID_BOUNDARY_TIMESTAMP';

/** Read a host-authorized window; model or tool arguments are never authoritative here. */
export function readHostAuthorizedWindowV1(
  input: unknown,
  fail: (code: ScenarioWindowErrorCode) => never,
): HostAuthorizedWindowV1 {
  const record = readExactRecord(input, ['timestampUnit', 'startUnixSeconds', 'endUnixSeconds'], () => fail('INVALID_REQUESTED_WINDOW'));
  if (record.timestampUnit !== 'unix_seconds') fail('INVALID_TIMESTAMP_UNIT');
  const startUnixSeconds = readBoundary(record.startUnixSeconds, () => fail('INVALID_BOUNDARY_TIMESTAMP'));
  const endUnixSeconds = readBoundary(record.endUnixSeconds, () => fail('INVALID_BOUNDARY_TIMESTAMP'));
  if (startUnixSeconds >= endUnixSeconds) fail('INVALID_REQUESTED_WINDOW');
  return Object.freeze({ timestampUnit: 'unix_seconds', startUnixSeconds, endUnixSeconds });
}

export function readExactRecord(
  value: unknown,
  keys: readonly string[],
  fail: () => never,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) fail();
  return record;
}

export function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isFiniteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Narrow an unknown value to a readonly array without leaking `any` into callers. */
export function asReadonlyArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

export function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function readBoundary(value: unknown, fail: () => never): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
