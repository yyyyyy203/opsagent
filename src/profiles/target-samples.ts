import type { ImpactPolicy } from '../contracts/governance.js';
import type { ProfileDefinition } from './profile-types.js';
import { WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST } from './scenarios/window-failure-rate-v1.js';

const impactPolicy: ImpactPolicy = {
  unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' },
};

export const multiProjectTargetCatalog = Object.freeze({
  schemaVersion: 1,
  targets: [
    {
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
      description: 'Synthetic settlement telemetry for project A.',
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
    },
    {
      targetId: 'market-b-sim',
      projectId: 'market-b',
      projectName: 'Market B',
      deploymentId: 'lab',
      deploymentGeneration: 3,
      environment: 'simulation',
      dataClass: 'simulated',
      datasetId: 'dataset-b-v1',
      targetFingerprint: 'market-b-lab-dataset-b',
      profileId: 'market-b.lab.settlement',
      profileRevision: 'profile/v1',
      displayName: 'Market B settlement lab',
      description: 'Synthetic settlement telemetry for project B.',
      enabled: true,
      scenario: {
        id: 'window_failure_rate.v1',
        version: '1.0.0',
        implementationDigest: WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST,
        serviceId: 'checkout',
        serviceName: 'Checkout',
        metricSemantics: 'integer_window_snapshot',
        metricMapping: {
          metricName: 'orders_submit_window_count',
          outcomeLabel: 'result',
          successValue: 'ok',
          failureValue: 'error',
          serviceSelector: { label: 'application', value: 'checkout-api' },
          staticLabels: {},
        },
        threshold: 0.02,
        minSamples: 20,
      },
      sourceBindings: [{
        sourceId: 'market-b-metrics',
        version: 'connection/v3',
        kind: 'metrics',
        adapterId: 'prometheus-mcp.v1',
        required: true,
        allowedServiceIds: ['checkout'],
      }],
      knowledgeRefs: [],
    },
  ],
});

/** Private connection metadata fixture; never use as a production credential source. */
export const multiProjectConnectionRegistry = Object.freeze({
  schemaVersion: 2,
  connections: [
    {
      sourceId: 'market-a-metrics', version: 'connection/v1', kind: 'metrics', adapterId: 'prometheus-mcp.v1',
      enabled: true, endpoint: 'https://private-market-a.invalid/mcp', secretRef: 'secret.metrics.market-a',
      allowedServiceIds: ['checkout'], dataDomainId: 'market-a-metrics-domain', sourceGeneration: 1,
      permissionScopeDigest: 'a'.repeat(64),
    },
    {
      sourceId: 'market-b-metrics', version: 'connection/v3', kind: 'metrics', adapterId: 'prometheus-mcp.v1',
      enabled: true, endpoint: 'https://private-market-b.invalid/mcp', secretRef: 'secret.metrics.market-b',
      allowedServiceIds: ['checkout'], dataDomainId: 'market-b-metrics-domain', sourceGeneration: 3,
      permissionScopeDigest: 'b'.repeat(64),
    },
  ],
});

export const multiProjectProfiles: readonly ProfileDefinition[] = Object.freeze([
  profile('market-a.lab.settlement'),
  profile('market-b.lab.settlement'),
]);

function profile(profileId: string): ProfileDefinition {
  return {
    profileId,
    revision: 'profile/v1',
    serviceName: 'Checkout',
    serviceLevel: 'S1',
    timezone: 'Asia/Shanghai',
    allowedActions: [],
    forbiddenActions: [],
    changeFreezePeriods: [],
    impactPolicy,
    policyVersion: 'risk/v1',
  };
}
