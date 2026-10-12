import { describe, expect, it } from 'vitest';
import { parseTargetCatalog } from '../src/profiles/target-catalog-schema.js';
import { WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST } from '../src/profiles/scenarios/window-failure-rate-v1.js';

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
      implementationDigest: WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST,
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
