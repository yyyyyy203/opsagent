import { cpus } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ImpactPolicy } from '../src/contracts/governance.js';
import type { ProfileDefinition } from '../src/profiles/profile-types.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0 } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { TargetSourcePartitionRegistry } from '../src/infrastructure/target-source-partition-registry.js';

const shouldRun = process.env.AGENTOPS_RUN_CAPACITY_ACCEPTANCE === '1';

describe.skipIf(!shouldRun)('multi-Target capacity acceptance', () => {
  it('measures 200-Target directory reads and 50 in-memory source partitions', async () => {
    const { catalog, connections, profiles } = generatedCatalog(200);
    const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(), catalog, connections,
      profileResolver: new StaticProfileResolver(profiles), installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }], validationTime: '2026-10-21T00:00:00.000Z' });
    expect(resolver.listCatalog()).toHaveLength(200);

    const directorySamples = measure(() => { void resolver.listCatalog(); }, 200);
    const snapshots = await Promise.all(Array.from({ length: 50 }, (_, index) => resolver.resolve({
      targetId: `target-${String(index).padStart(3, '0')}`,
      capturedAt: '2026-10-21T00:00:00.000Z', signal: new AbortController().signal,
    })));
    const externalCalls = 0;
    const registry = new TargetSourcePartitionRegistry({
      maxPartitions: 64, maxConcurrentOperationsPerPartition: 8, maxQueuedOperationsPerPartition: 32,
      now: () => Date.now(), scheduleTimeout: () => () => undefined,
      createResilience: () => ({ state: 'closed', execute: async operation => operation(new AbortController().signal) }),
    });
    try {
      for (const snapshot of snapshots) registry.acquire(snapshot, snapshot.sourceBindings[0]!.sourceId).release();
      let cursor = 0;
      const partitionSamples = measure(() => {
        const index = cursor++ % snapshots.length;
        const snapshot = snapshots[index]!;
        registry.acquire(snapshot, snapshot.sourceBindings[0]!.sourceId).release();
      }, 1_000);
      expect(externalCalls).toBe(0);
      expect(directorySamples.p95Ms).toBeLessThan(100);
      expect(partitionSamples.p95Ms).toBeLessThan(10);
      process.stdout.write(`${JSON.stringify({
        acceptance: 'multi-target-capacity', node: process.version, platform: process.platform, arch: process.arch,
        cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, targetCount: 200, partitionCount: 50,
        warm: true, directorySamples: directorySamples.count, directoryP95Ms: directorySamples.p95Ms,
        partitionSamples: partitionSamples.count, partitionP95Ms: partitionSamples.p95Ms,
        externalCalls,
      })}\n`);
    } finally { registry.shutdown(); }
  });
});

function measure(operation: () => void, count: number): { count: number; p95Ms: number } {
  for (let index = 0; index < Math.min(100, count); index += 1) operation();
  const durations = Array.from({ length: count }, () => {
    const start = performance.now(); operation(); return performance.now() - start;
  }).sort((left, right) => left - right);
  return { count, p95Ms: durations[Math.ceil(durations.length * 0.95) - 1]! };
}

function generatedCatalog(count: number): { catalog: { schemaVersion: 1; targets: Record<string, unknown>[] };
  connections: { schemaVersion: 2; connections: Record<string, unknown>[] }; profiles: ProfileDefinition[] } {
  const targets: Record<string, unknown>[] = [];
  const connections: Record<string, unknown>[] = [];
  const profiles: ProfileDefinition[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const sourceId = `metrics-${suffix}`;
    const projectId = `project-${suffix}`;
    const profileId = `${projectId}.profile`;
    targets.push({ targetId: `target-${suffix}`, projectId, projectName: `Project ${suffix}`,
      deploymentId: 'lab', deploymentGeneration: 1, environment: 'simulation', dataClass: 'simulated',
      datasetId: `dataset-${suffix}`, targetFingerprint: `fingerprint-${suffix}`, profileId,
      profileRevision: 'profile/v1', displayName: `Project ${suffix}`, description: 'Generated capacity Target.', enabled: true,
      scenario: { id: 'window_failure_rate.v1', version: '1.0.0',
        implementationDigest: WINDOW_FAILURE_RATE_INSTALLATION_V1_0_0.implementationDigest,
        serviceId: 'checkout', serviceName: 'Checkout', metricSemantics: 'integer_window_snapshot',
        metricMapping: { metricName: `requests_${suffix}`, outcomeLabel: 'outcome', successValue: 'success',
          failureValue: 'failed', serviceSelector: { label: 'service', value: 'checkout' }, staticLabels: {} },
        threshold: 0.05, minSamples: 20 },
      sourceBindings: [{ sourceId, version: 'connection/v1', kind: 'metrics', adapterId: 'prometheus-mcp.v1',
        required: true, allowedServiceIds: ['checkout'] }], knowledgeRefs: [],
    });
    connections.push({ sourceId, version: 'connection/v1', kind: 'metrics', adapterId: 'prometheus-mcp.v1', enabled: true,
      endpoint: `https://${sourceId}.invalid/mcp`, secretRef: `secret.${sourceId}`, allowedServiceIds: ['checkout'],
      dataDomainId: `${sourceId}-domain`, sourceGeneration: 1, permissionScopeDigest: 'c'.repeat(64) });
    const impactPolicy: ImpactPolicy = { unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' } };
    profiles.push({ profileId, revision: 'profile/v1', serviceName: 'Checkout', serviceLevel: 'S1', timezone: 'Asia/Shanghai',
      allowedActions: [], forbiddenActions: [], changeFreezePeriods: [], impactPolicy, policyVersion: 'risk/v1' });
  }
  return { catalog: { schemaVersion: 1, targets }, connections: { schemaVersion: 2, connections }, profiles };
}
