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
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { legacySnapshotUnsigned } from './helpers/legacy-target-snapshot.js';

const capturedAt = '2026-10-11T10:00:00.000Z';

describe('versioned Target snapshots', () => {
  it('resolves new Target bindings to V2 with trusted implementation, source, and knowledge policy identity', async () => {
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
      knowledgePolicy: {
        defaultRequiredness: 'optional',
        requirements: [{
          id: 'settlement-runbook',
          version: '1.0.0',
          digest: 'a'.repeat(64),
          requiredness: 'optional',
        }],
      },
    });

    expect(snapshot.scenarioImplementationDigest).toMatch(/^sha256:v1:[a-f0-9]{64}$/u);
    expect(snapshot.digest).toMatch(/^sha256:v2:[a-f0-9]{64}$/u);
    expect(parseResolvedTargetSnapshotV2(snapshot)).toEqual(snapshot);
    expect(parseExecutableTargetSnapshot(snapshot)).toEqual(snapshot);
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
