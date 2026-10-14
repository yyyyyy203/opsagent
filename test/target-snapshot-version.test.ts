import { describe, expect, it } from 'vitest';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseExecutableTargetSnapshot, parseResolvedTargetSnapshot, parseResolvedTargetSnapshotV2,
  parseVersionedResolvedTargetSnapshot } from '../src/contracts/target-schema.js';
import {
  multiProjectConnectionRegistry,
  multiProjectProfiles,
  multiProjectTargetCatalog,
} from '../src/profiles/target-samples.js';
import {
  WINDOW_FAILURE_RATE_INSTALLATION,
  WINDOW_FAILURE_RATE_INSTALLATIONS,
  WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST,
  WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST,
} from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { legacySnapshotUnsigned } from './helpers/legacy-target-snapshot.js';

const capturedAt = '2026-10-11T10:00:00.000Z';

describe('versioned Target snapshots', () => {
  it('pins the existing 1.0.0 implementation and snapshot digests', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: legacyV1Catalog(),
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: WINDOW_FAILURE_RATE_INSTALLATIONS,
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt,
      signal: new AbortController().signal });
    const unsigned = legacySnapshotUnsigned(snapshot);
    const legacy = parseResolvedTargetSnapshot({
      ...unsigned,
      digest: `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, target: unsigned })}`,
    });

    expect({
      implementation: WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST,
      implementationV1_1: WINDOW_FAILURE_RATE_V1_1_0_IMPLEMENTATION_DIGEST,
      snapshotV1: legacy.digest,
      snapshotV2: snapshot.digest,
    }).toEqual({
      implementation: 'sha256:v1:597ce39d12e68048fdce6b4180194d11785b35e3d288f0ae56aadf3a0dc8670f',
      implementationV1_1: 'sha256:v1:4443ba59139f2bd42bcb9e2f3907bc2bd674af2a5103ffad2f26a510e77379e6',
      snapshotV1: 'sha256:v1:2af0af6d57adcbefa19ef224b37fb32db71193210dc313e0906cdbef0774dbd4',
      snapshotV2: 'sha256:v2:29939b0076d7ddcd4e5b91ca55e32a83b3e01b705e3a3efd6cf892c9695670a4',
    });
    expect(parseResolvedTargetSnapshotV2(snapshot)).toEqual(snapshot);
  });

  it('accepts a V2 snapshot with a versioned Unix-seconds boundary mapping', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const resolved = await resolver.resolve({ targetId: 'market-a-sim', capturedAt,
      signal: new AbortController().signal });
    const candidate = structuredClone(resolved) as unknown as Record<string, unknown>;
    const scenario = candidate.scenario as Record<string, unknown>;
    const metricMapping = scenario.metricMapping as Record<string, unknown>;
    scenario.version = '1.1.0';
    scenario.metricMapping = {
      ...metricMapping,
      windowBoundaryMapping: {
        startMetricName: 'market_checkout_window_start_timestamp_seconds',
        endMetricName: 'market_checkout_window_end_timestamp_seconds',
        timestampUnit: 'unix_seconds',
      },
    };
    candidate.scenarioImplementationDigest = `sha256:v1:${'b'.repeat(64)}`;
    const { digest: _digest, ...unsigned } = candidate;
    void _digest;
    const snapshot = {
      ...unsigned,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsigned })}`,
    };

    expect(parseResolvedTargetSnapshotV2(snapshot)).toEqual(snapshot);
  });

  it('resolves new Target bindings to V2 and refuses catalog-only knowledge activation', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });

    const snapshot = await resolver.resolve({
      targetId: 'market-a-sim',
      capturedAt,
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      targetId: 'market-a-sim',
      sourceIdentities: [{
        sourceId: 'market-a-metrics',
        dataDomainId: 'market-a-metrics-domain',
        sourceGeneration: 1,
        permissionScopeDigest: 'a'.repeat(64),
      }],
      knowledgeRefs: [],
      knowledgePolicy: {
        defaultRequiredness: 'optional',
        requirements: [],
      },
      publicationVersion: 0,
      identityRegistryVersion: 1,
    });

    expect(snapshot.scenarioImplementationDigest).toMatch(/^sha256:v1:[a-f0-9]{64}$/u);
    expect(snapshot.digest).toMatch(/^sha256:v2:[a-f0-9]{64}$/u);
    expect(parseResolvedTargetSnapshotV2(snapshot)).toEqual(snapshot);
    expect(parseExecutableTargetSnapshot(snapshot)).toEqual(snapshot);

    const { publicationVersion: _publicationVersion, digest: _digest, ...preT3Unsigned } = snapshot;
    void _publicationVersion;
    void _digest;
    const preT3 = { ...preT3Unsigned,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: preT3Unsigned })}` };
    expect(parseResolvedTargetSnapshotV2(preT3)).toEqual(preT3);
  });

  it('keeps V1 snapshots readable with the old digest while refusing to execute them', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: capturedAt,
    });
    const v2 = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const unsigned = legacySnapshotUnsigned(v2);
    const legacy = parseResolvedTargetSnapshot({
      ...unsigned,
      digest: `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, target: unsigned })}`,
    });

    expect(parseVersionedResolvedTargetSnapshot(legacy)).toEqual(legacy);
    let executionError: unknown;
    try {
      parseExecutableTargetSnapshot(legacy);
    } catch (error) {
      executionError = error;
    }
    expect(executionError).toBeInstanceOf(Error);
    expect(executionError).toMatchObject({ code: 'TARGET_IDENTITY_UNPROVEN' });
  });
});

function legacyV1Catalog() {
  const catalog = structuredClone(multiProjectTargetCatalog) as {
    schemaVersion: 1;
    targets: Record<string, unknown>[];
  };
  const target = catalog.targets.find(item => item.targetId === 'market-a-sim');
  if (target === undefined) throw new Error('Legacy Target fixture is missing.');
  const scenario = target.scenario as Record<string, unknown>;
  scenario.version = '1.0.0';
  scenario.implementationDigest = WINDOW_FAILURE_RATE_V1_0_0_IMPLEMENTATION_DIGEST;
  const metricMapping = scenario.metricMapping as Record<string, unknown>;
  delete metricMapping.windowBoundaryMapping;
  return catalog;
}
