import {
  DEPENDENCY_CORRELATION_INSTALLATIONS,
  DEPENDENCY_CORRELATION_SCENARIO_ID,
  DEPENDENCY_CORRELATION_SCENARIO_VERSION,
} from './dependency-correlation-v1.js';
import {
  RESOURCE_SATURATION_INSTALLATIONS,
  RESOURCE_SATURATION_SCENARIO_ID,
  RESOURCE_SATURATION_SCENARIO_VERSION,
} from './resource-saturation-v1.js';
import {
  WINDOW_FAILURE_RATE_INSTALLATIONS,
  WINDOW_FAILURE_RATE_SCENARIO_ID,
  WINDOW_FAILURE_RATE_SCENARIO_VERSION,
} from './window-failure-rate-v1.js';
import {
  WINDOW_LATENCY_INSTALLATIONS,
  WINDOW_LATENCY_SCENARIO_ID,
  WINDOW_LATENCY_SCENARIO_VERSION,
} from './window-latency-v1.js';
import {
  WINDOW_TRAFFIC_BASELINE_INSTALLATIONS,
  WINDOW_TRAFFIC_BASELINE_SCENARIO_ID,
  WINDOW_TRAFFIC_BASELINE_SCENARIO_VERSION,
} from './window-traffic-baseline-v1.js';

export * from './scenario-conclusions.js';
export type { HostAuthorizedWindowV1, ScenarioWindowErrorCode } from './scenario-window.js';
export * from './window-failure-rate-v1.js';
export * from './window-latency-v1.js';
export * from './window-traffic-baseline-v1.js';
export * from './dependency-correlation-v1.js';
export * from './resource-saturation-v1.js';

/** The five S3 diagnostic scenario families. Order is stable for reports. */
export const SCENARIO_FAMILY_CODES = Object.freeze([
  'failure_rate',
  'latency',
  'traffic',
  'dependency',
  'resource',
] as const);

export type ScenarioFamilyCode = (typeof SCENARIO_FAMILY_CODES)[number];

export interface ScenarioFamilyInstallationV1 {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: string;
}

export interface ScenarioFamilyDescriptorV1 {
  readonly family: ScenarioFamilyCode;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly installations: readonly ScenarioFamilyInstallationV1[];
}

/** Registry of installed deterministic scenario implementations, keyed by family. */
export const SCENARIO_FAMILY_REGISTRY: readonly ScenarioFamilyDescriptorV1[] = Object.freeze([
  Object.freeze({
    family: 'failure_rate',
    scenarioId: WINDOW_FAILURE_RATE_SCENARIO_ID,
    scenarioVersion: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
    installations: WINDOW_FAILURE_RATE_INSTALLATIONS,
  }),
  Object.freeze({
    family: 'latency',
    scenarioId: WINDOW_LATENCY_SCENARIO_ID,
    scenarioVersion: WINDOW_LATENCY_SCENARIO_VERSION,
    installations: WINDOW_LATENCY_INSTALLATIONS,
  }),
  Object.freeze({
    family: 'traffic',
    scenarioId: WINDOW_TRAFFIC_BASELINE_SCENARIO_ID,
    scenarioVersion: WINDOW_TRAFFIC_BASELINE_SCENARIO_VERSION,
    installations: WINDOW_TRAFFIC_BASELINE_INSTALLATIONS,
  }),
  Object.freeze({
    family: 'dependency',
    scenarioId: DEPENDENCY_CORRELATION_SCENARIO_ID,
    scenarioVersion: DEPENDENCY_CORRELATION_SCENARIO_VERSION,
    installations: DEPENDENCY_CORRELATION_INSTALLATIONS,
  }),
  Object.freeze({
    family: 'resource',
    scenarioId: RESOURCE_SATURATION_SCENARIO_ID,
    scenarioVersion: RESOURCE_SATURATION_SCENARIO_VERSION,
    installations: RESOURCE_SATURATION_INSTALLATIONS,
  }),
]);

export function isScenarioFamilyCode(value: unknown): value is ScenarioFamilyCode {
  return typeof value === 'string' && (SCENARIO_FAMILY_CODES as readonly string[]).includes(value);
}

export function findScenarioFamily(family: ScenarioFamilyCode): ScenarioFamilyDescriptorV1 {
  const descriptor = SCENARIO_FAMILY_REGISTRY.find((entry) => entry.family === family);
  if (descriptor === undefined) throw new RangeError(`UNKNOWN_SCENARIO_FAMILY:${family}`);
  return descriptor;
}

/**
 * Applicability gate used by acceptance reporting: a case may only claim a family
 * when the installed implementation identity matches exactly.
 */
export function scenarioFamilyApplicability(family: ScenarioFamilyCode): {
  applicable: boolean;
  scenarioId: string;
  scenarioVersion: string;
  implementationDigest: string;
} {
  const descriptor = findScenarioFamily(family);
  const installation = descriptor.installations.find((entry) => entry.version === descriptor.scenarioVersion);
  if (installation === undefined) throw new RangeError(`MISSING_SCENARIO_INSTALLATION:${family}`);
  return {
    applicable: true,
    scenarioId: installation.id,
    scenarioVersion: installation.version,
    implementationDigest: installation.implementationDigest,
  };
}
