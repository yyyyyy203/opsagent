/**
 * Deterministic conclusion vocabulary shared by the S3 scenario families.
 *
 * Scenarios never decide free text. They return stable conclusion codes that the
 * renderer, quality set and reviewers can assert on, plus the conclusions that the
 * evidence forbids. Root cause and whole-system health are always forbidden here:
 * a single frozen window cannot prove either.
 */
export const SCENARIO_CONCLUSION_CODES = Object.freeze([
  'baseline_comparison_valid',
  'baseline_unavailable_no_comparison',
  'correlation_not_root_cause',
  'dependency_association_corroborated',
  'dependency_not_implicated_in_window',
  'healthy_system_wide',
  'insufficient_samples_no_attribution',
  'metric_threshold_breached',
  'metric_within_threshold',
  'missing_evidence_partial_diagnosis',
  'resource_saturation_candidate',
  'resource_saturation_confirmed',
  'root_cause_established',
  'temporal_coincidence_only',
] as const);

export type ScenarioConclusionCode = (typeof SCENARIO_CONCLUSION_CODES)[number];

/** Conclusions that window-scoped deterministic scenarios may never authorize. */
export const ALWAYS_FORBIDDEN_SCENARIO_CONCLUSIONS: readonly ScenarioConclusionCode[] = Object.freeze([
  'healthy_system_wide',
  'root_cause_established',
]);

export interface ScenarioConclusionBounds {
  readonly allowed: readonly ScenarioConclusionCode[];
  readonly forbidden: readonly ScenarioConclusionCode[];
}

export function isScenarioConclusionCode(value: unknown): value is ScenarioConclusionCode {
  return typeof value === 'string'
    && (SCENARIO_CONCLUSION_CODES as readonly string[]).includes(value);
}

/**
 * Build frozen, sorted conclusion bounds. Overlapping or unknown codes are a
 * programming error and throw instead of silently weakening the bound.
 */
export function scenarioConclusionBounds(
  allowed: readonly ScenarioConclusionCode[],
  forbidden: readonly ScenarioConclusionCode[],
): ScenarioConclusionBounds {
  const allowedSet = normalize(allowed, 'allowed');
  const forbiddenSet = normalize(forbidden, 'forbidden');
  for (const code of ALWAYS_FORBIDDEN_SCENARIO_CONCLUSIONS) {
    forbiddenSet.add(code);
    allowedSet.delete(code);
  }
  for (const code of allowedSet) {
    if (forbiddenSet.has(code)) throw new TypeError(`SCENARIO_CONCLUSION_OVERLAP:${code}`);
  }
  return Object.freeze({
    allowed: Object.freeze([...allowedSet].sort()),
    forbidden: Object.freeze([...forbiddenSet].sort()),
  });
}

function normalize(codes: readonly ScenarioConclusionCode[], kind: 'allowed' | 'forbidden'): Set<ScenarioConclusionCode> {
  const result = new Set<ScenarioConclusionCode>();
  for (const code of codes) {
    if (!isScenarioConclusionCode(code)) throw new TypeError(`SCENARIO_CONCLUSION_UNKNOWN:${kind}`);
    result.add(code);
  }
  return result;
}
