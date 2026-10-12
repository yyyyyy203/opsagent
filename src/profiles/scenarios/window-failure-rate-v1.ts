import { checkpointChecksum } from '../../contracts/stable-json.js';

export const WINDOW_FAILURE_RATE_SCENARIO_ID = 'window_failure_rate.v1' as const;
export const WINDOW_FAILURE_RATE_SCENARIO_VERSION = '1.0.0' as const;

/*
 * This descriptor is the reviewed implementation identity. Update it whenever
 * the interpretation, boundary comparison, or required input semantics change.
 */
const implementationDescriptor = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  semantics: 'integer_window_snapshot',
  rate: 'failed_samples / total_samples',
  threshold: 'failure_rate >= configured_threshold',
  minimumSamples: 'total_samples >= configured_min_samples',
});

export const WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST =
  `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, scenario: implementationDescriptor })}`;

export const WINDOW_FAILURE_RATE_INSTALLATION = Object.freeze({
  id: WINDOW_FAILURE_RATE_SCENARIO_ID,
  version: WINDOW_FAILURE_RATE_SCENARIO_VERSION,
  implementationDigest: WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST,
});
