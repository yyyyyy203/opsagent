import { describe, expect, it } from 'vitest';
import { parseTargetCatalog } from '../src/profiles/target-catalog-schema.js';
import { WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST } from '../src/profiles/scenarios/window-failure-rate-v1.js';

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'market-a-sim',
    projectId: 'market-a',
    projectName: 'Market A',
    deploymentId: 'lab',
    deploymentGeneration: 1,
    environment: 'simulation',
    dataClass: 'simulated',
    datasetId: 'dataset-a-v1',
    targetFingerprint: 'market-a-lab-dataset-a',
    profileId: 'market-a.lab.settlement',
    profileRevision: 'profile/v1',
    displayName: 'Market A settlement lab',
    description: 'Synthetic settlement telemetry.',
    enabled: true,
    scenario: {
      id: 'window_failure_rate.v1',
      version: '1.0.0',
      implementationDigest: WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST,
      serviceId: 'checkout',
      serviceName: 'Checkout',
      metricSemantics: 'integer_window_snapshot',
      metricMapping: {
        metricName: 'market_checkout_window_requests',
        outcomeLabel: 'outcome',
        successValue: 'success',
        failureValue: 'failed',
        serviceSelector: { label: 'service', value: 'checkout' },
        staticLabels: {},
      },
      threshold: 0.05,
      minSamples: 20,
    },
    sourceBindings: [{
      sourceId: 'market-a-metrics',
      version: 'connection/v1',
      kind: 'metrics',
      adapterId: 'prometheus-mcp.v1',
      required: true,
      allowedServiceIds: ['checkout'],
    }],
    knowledgeRefs: [{ id: 'settlement-runbook', version: '1.0.0', digest: 'a'.repeat(64), approval: 'approved' }],
    ...overrides,
  };
}

function catalog(targets: readonly unknown[]) {
  return { schemaVersion: 1, targets };
}

describe('parseTargetCatalog', () => {
  it('preserves the exact 1.0.0 catalog binding shape', () => {
    const parsed = parseTargetCatalog(catalog([target()]));

    expect(parsed.targets[0]?.scenario.version).toBe('1.0.0');
    expect(parsed.targets[0]?.scenario.metricMapping).toEqual({
      metricName: 'market_checkout_window_requests',
      outcomeLabel: 'outcome',
      successValue: 'success',
      failureValue: 'failed',
      serviceSelector: { label: 'service', value: 'checkout' },
      staticLabels: {},
    });
    expect(parsed.targets[0]?.scenario.implementationDigest)
      .toBe(WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST);
  });

  it('accepts 1.1.0 only with explicit valid boundary metrics and fixed Unix-seconds units', () => {
    const parsed = parseTargetCatalog(catalog([targetV1_1()]));

    expect(parsed.rejected).toEqual([]);
    expect(parsed.targets[0]?.scenario.metricMapping).toMatchObject({
      metricName: 'market_checkout_window_requests',
      serviceSelector: { label: 'service', value: 'checkout' },
      staticLabels: {},
      windowBoundaryMapping: {
        startMetricName: 'market_checkout_window_start_timestamp_seconds',
        endMetricName: 'market_checkout_window_end_timestamp_seconds',
        timestampUnit: 'unix_seconds',
      },
    });
  });

  it.each([
    ['invalid metric name', {
      startMetricName: 'market checkout start',
      endMetricName: 'market_checkout_window_end_timestamp_seconds',
      timestampUnit: 'unix_seconds',
    }],
    ['same boundary metric', {
      startMetricName: 'market_checkout_window_boundary_timestamp_seconds',
      endMetricName: 'market_checkout_window_boundary_timestamp_seconds',
      timestampUnit: 'unix_seconds',
    }],
    ['count metric reused as a boundary', {
      startMetricName: 'market_checkout_window_requests',
      endMetricName: 'market_checkout_window_end_timestamp_seconds',
      timestampUnit: 'unix_seconds',
    }],
    ['non-Unix timestamp unit', {
      startMetricName: 'market_checkout_window_start_timestamp_seconds',
      endMetricName: 'market_checkout_window_end_timestamp_seconds',
      timestampUnit: 'milliseconds',
    }],
  ])('fails closed for %s in a 1.1.0 boundary mapping', (_caseName, mapping) => {
    const parsed = parseTargetCatalog(catalog([targetV1_1(mapping)]));

    expect(parsed.targets).toEqual([]);
    expect(parsed.rejected).toEqual([{ index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' }]);
  });

  it('fails closed when a 1.1.0 binding omits its boundary mapping', () => {
    const incomplete = targetV1_1();
    const scenario = incomplete.scenario as unknown as Record<string, unknown>;
    const metricMapping = scenario.metricMapping as Record<string, unknown>;
    delete metricMapping.windowBoundaryMapping;
    const parsed = parseTargetCatalog(catalog([incomplete]));

    expect(parsed.targets).toEqual([]);
    expect(parsed.rejected).toEqual([{ index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' }]);
  });

  it('rejects a boundary mapping on the legacy 1.0.0 binding', () => {
    const scenario = target().scenario as unknown as Record<string, unknown>;
    const metricMapping = scenario.metricMapping as Record<string, unknown>;
    const legacyWithBoundary = target({ scenario: {
      ...scenario,
      metricMapping: { ...metricMapping, windowBoundaryMapping: validBoundaryMapping() },
    } });
    const parsed = parseTargetCatalog(catalog([legacyWithBoundary]));

    expect(parsed.targets).toEqual([]);
    expect(parsed.rejected[0]?.reasonCode).toBe('TARGET_BINDING_INVALID');
  });

  it('accepts two strict, distinct project targets for the same installed scenario', () => {
    const marketB = target({
      targetId: 'market-b-sim',
      projectId: 'market-b',
      projectName: 'Market B',
      datasetId: 'dataset-b-v1',
      targetFingerprint: 'market-b-lab-dataset-b',
      profileId: 'market-b.lab.settlement',
      scenario: {
        ...target().scenario as object,
        metricMapping: {
          metricName: 'orders_submit_window_count',
          outcomeLabel: 'result',
          successValue: 'ok',
          failureValue: 'error',
          serviceSelector: { label: 'application', value: 'checkout-api' },
          staticLabels: { service: 'checkout' },
        },
        threshold: 0.02,
      },
      sourceBindings: [{
        sourceId: 'market-b-metrics', version: 'connection/v3', kind: 'metrics',
        adapterId: 'prometheus-mcp.v1', required: true, allowedServiceIds: ['checkout'],
      }],
    });

    const parsed = parseTargetCatalog(catalog([target(), marketB]));

    expect(parsed.targets.map((item) => item.targetId)).toEqual(['market-a-sim', 'market-b-sim']);
    expect(parsed.rejected).toEqual([]);
  });

  it('isolates a malformed Target entry without discarding its valid sibling', () => {
    const malformed = target({ profileRevision: undefined });

    const parsed = parseTargetCatalog(catalog([malformed, target({
      targetId: 'market-b-sim', projectId: 'market-b', projectName: 'Market B',
      datasetId: 'dataset-b-v1', targetFingerprint: 'market-b-lab-dataset-b',
      profileId: 'market-b.lab.settlement',
    })]));

    expect(parsed.targets.map((item) => item.targetId)).toEqual(['market-b-sim']);
    expect(parsed.targetIndices).toEqual([1]);
    expect(parsed.rejected).toEqual([{ index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' }]);
  });

  it('quarantines every entry involved in a duplicate Target or Profile identity', () => {
    const parsed = parseTargetCatalog(catalog([
      target(),
      target({ projectId: 'market-b', projectName: 'Market B', targetFingerprint: 'market-b-domain' }),
      target({ targetId: 'market-c-sim', projectId: 'market-c', projectName: 'Market C',
        profileId: 'market-c.lab.settlement', targetFingerprint: 'market-c-domain' }),
    ]));

    expect(parsed.targets.map((item) => item.targetId)).toEqual(['market-c-sim']);
    expect(parsed.rejected).toEqual([
      { index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' },
      { index: 1, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' },
    ]);
  });

  it('rejects a malformed envelope instead of publishing a partial catalog', () => {
    expect(captureError(() => parseTargetCatalog({ ...catalog([target()]), unexpected: true })))
      .toMatchObject({ code: 'TARGET_CATALOG_INVALID' });
  });

  it('rejects catalogs above the host-controlled registration bound', () => {
    expect(captureError(() => parseTargetCatalog(catalog([target(), target({
      targetId: 'market-b-sim', projectId: 'market-b', projectName: 'Market B',
      datasetId: 'dataset-b-v1', targetFingerprint: 'market-b-domain', profileId: 'market-b.profile',
    })]), { maxRegisteredTargets: 1 })))
      .toMatchObject({ code: 'TARGET_CATALOG_LIMIT_EXCEEDED' });
  });

  it('does not echo secrets or malformed raw config in per-entry diagnostics', () => {
    const parsed = parseTargetCatalog(catalog([target({ apiKey: 'do-not-leak-this', endpoint: 'https://private.invalid' })]));

    expect(parsed.rejected).toEqual([{ index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' }]);
    expect(JSON.stringify(parsed.rejected)).not.toContain('do-not-leak-this');
    expect(JSON.stringify(parsed.rejected)).not.toContain('private.invalid');
  });
});

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function validBoundaryMapping() {
  return {
    startMetricName: 'market_checkout_window_start_timestamp_seconds',
    endMetricName: 'market_checkout_window_end_timestamp_seconds',
    timestampUnit: 'unix_seconds',
  };
}

function targetV1_1(mapping: unknown = validBoundaryMapping()) {
  const scenario = target().scenario as unknown as Record<string, unknown>;
  const metricMapping = scenario.metricMapping as Record<string, unknown>;
  return target({ scenario: {
    ...scenario,
    version: '1.1.0',
    metricMapping: { ...metricMapping, windowBoundaryMapping: mapping },
  } });
}
