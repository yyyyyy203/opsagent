import { checkpointChecksum } from '../../contracts/stable-json.js';

export const WINDOW_FAILURE_RATE_SCENARIO_ID = 'window_failure_rate.v1' as const;
export const WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0 = '1.0.0' as const;
export const WINDOW_FAILURE_RATE_SCENARIO_VERSION = '1.1.0' as const;

/*
 * This descriptor is the reviewed implementation identity. Update it whenever
 * the interpretation, boundary comparison, or required input semantics change.
 */
const implementationDescriptor = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0,
  semantics: 'integer_window_snapshot',
  rate: 'failed_samples / total_samples',
  threshold: 'failure_rate >= configured_threshold',
  minimumSamples: 'total_samples >= configured_min_samples',
});

export const WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

const implementationDescriptorV1_1_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  input: Object.freeze({
    countSemantics: 'integer_window_snapshot',
    startBoundary: 'single_finite_unix_seconds_timestamp',
    endBoundary: 'single_finite_unix_seconds_timestamp',
    boundaryWindow: 'both_boundaries_match_the_requested_window_and_start_precedes_end',
    selectors: 'trusted_service_selector_and_static_labels',
  }),
  output: Object.freeze({
    assessment: 'window_count_snapshot.v1',
    rate: 'failed_samples / total_samples',
    threshold: 'failure_rate >= configured_threshold',
    minimumSamples: 'total_samples >= configured_min_samples',
  }),
});

export const WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptorV1_1_0 })}`;

/** Current implementation alias; historical 1.0.0 snapshots use the explicit legacy identity below. */
export const WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST = WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST;

export const WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION_V1_0_0,
  implementationDigest: WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST,
});

export const WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0 = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  implementationDigest: WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST,
});

export const WINDOW_FAILURE_RATE_INSTALLATION = WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0;

/** Both immutable implementations remain installable for old snapshots and new Target bindings. */
export const WINDOW_FAILURE_RATE_INSTALLATIONS = Object.freeze([
  WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0,
  WINDOW_FAILURE_RATE_INSTALLATION_V1_1_0,
]);
