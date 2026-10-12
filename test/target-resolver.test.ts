import { describe, expect, it } from 'vitest';
import type { ImpactPolicy } from '../src/contracts/index.js';
import { StaticProfileResolver, type ProfileDefinition } from '../src/profiles/profile-resolver.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import type { KnowledgeScope, TargetKnowledgePublication } from '../src/contracts/knowledge-memory.js';
import { multiProjectTargetCatalog, multiProjectConnectionRegistry, multiProjectProfiles } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const capturedAt = '2026-10-11T10:00:00.000Z';
const installedScenarios = [WINDOW_FAILURE_RATE_INSTALLATION];
const installedAdapters = [{ id: 'prometheus-mcp.v1', kind: 'metrics' as const }];

async function publishedReferenceResolver(references: TargetKnowledgePublication['references']) {
  const scope: KnowledgeScope = {
    targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
    targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
    scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
    faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
  };
  return createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles), installedScenarios, installedAdapters,
    validationTime: capturedAt,
    knowledgePublications: { inspectBinding: async () => ({ scopeKey: checkpointChecksum(scope), publication: {
      targetId: scope.targetId, publicationVersion: 1, references, publishedAt: capturedAt,
      policy: { schemaVersion: 1, targetId: scope.targetId, policyVersion: 'policy/v1', policyEpoch: 1,
        defaultRequiredness: 'optional', requirements: [] },
    } }) },
  });
}

describe('StaticTargetResolver', () => {
  it.each([
    { path: 'C:/private/runbook.md' },
    { url: 'https://private.invalid/source' },
    { secret: 'Bearer test-secret' },
    { id: ' ' },
    { id: 'C:/private/runbook.md' },
    { id: 'https://private.invalid/source' },
    { id: 'k'.repeat(129) },
    { version: '0' },
  ])('rejects unsafe published reference fields %j at resolution', async change => {
    const reference = { id: 'knowledge-one', version: '1', digest: 'a'.repeat(64), approval: 'approved' as const, ...change };
    const resolver = await publishedReferenceResolver([reference]);
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
  });

  it('rejects more than twenty published references', async () => {
    const resolver = await publishedReferenceResolver(Array.from({ length: 21 }, (_, index) => ({
      id: `knowledge-${index}`, version: '1', digest: 'a'.repeat(64), approval: 'approved' as const,
    })));
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
  });

  it('validates the completed snapshot against extra fields from a Profile port', async () => {
    const profiles = new StaticProfileResolver(multiProjectProfiles);
    const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
      profileResolver: { resolve: async input => ({ ...await profiles.resolve(input), path: 'C:/private/profile.json' }) },
      installedScenarios, installedAdapters, validationTime: capturedAt,
    });
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_SNAPSHOT_UNAVAILABLE' });
  });

  it.each([
    ['semantic', 'absent'], ['procedural', 'absent'],
    ['semantic', 'unreachable'], ['procedural', 'unreachable'],
  ] as const)('rejects disabled required %s with publication %s', async (knowledgeClass, publicationState) => {
    const ports = createTargetIdentityTestPorts();
    const resolver = await createStaticTargetResolver({ ...ports,
      catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles), installedScenarios, installedAdapters,
      validationTime: capturedAt,
      knowledgePolicies: { get: async targetId => ({ schemaVersion: 1, targetId, policyVersion: 'policy/v1', policyEpoch: 1,
        defaultRequiredness: 'optional', requirements: [{ id: 'unpublished-required', version: '1', digest: 'a'.repeat(64),
          requiredness: 'required', knowledgeClass }] }),
        compareAndSet: input => ports.knowledgePolicies.compareAndSet(input) },
      knowledgePublications: { inspectBinding: async () => {
        if (publicationState === 'unreachable') throw new Error('Publication must not be queried before the capability gate.');
        return { publication: null, scopeKey: null };
      } },
      knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: false, proceduralEnabled: false }) },
    });
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUIRED_DISABLED' });
  });
  it.each([
    ['semantic', false, 'optional', undefined],
    ['semantic', true, 'optional', undefined],
    ['semantic', false, 'required', 'KNOWLEDGE_REQUIRED_DISABLED'],
    ['semantic', true, 'required', undefined],
    ['procedural', false, 'optional', undefined],
    ['procedural', true, 'optional', undefined],
    ['procedural', false, 'required', 'KNOWLEDGE_REQUIRED_DISABLED'],
    ['procedural', true, 'required', undefined],
  ] as const)('captures %s enabled=%s requiredness=%s without querying runtime knowledge', async (kind, enabled, requiredness, errorCode) => {
    const scope: KnowledgeScope = {
      targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
      targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
      scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
      faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
    };
    const reference = { id: 'unavailable-knowledge', version: '1', digest: 'a'.repeat(64), approval: 'approved' as const };
    const policy = { schemaVersion: 1 as const, targetId: scope.targetId, policyVersion: 'policy/v1', policyEpoch: 1,
      defaultRequiredness: 'optional' as const, requirements: [] };
    const requirement = { id: reference.id, version: reference.version, digest: reference.digest, requiredness, knowledgeClass: kind };
    const publication: TargetKnowledgePublication = { targetId: scope.targetId, publicationVersion: 1,
      references: [reference], policy: { ...policy, requirements: [requirement] }, publishedAt: capturedAt };
    const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles), installedScenarios, installedAdapters,
      validationTime: capturedAt,
      knowledgePublications: { inspectBinding: async () => ({ publication, scopeKey: checkpointChecksum(scope) }) },
      knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: kind === 'semantic' && enabled,
        proceduralEnabled: kind === 'procedural' && enabled }) },
    });
    const result = resolver.resolve({ targetId: scope.targetId, capturedAt, signal: new AbortController().signal });
    if (errorCode !== undefined) await expect(result).rejects.toMatchObject({ code: errorCode });
    else {
      const snapshot = await result;
      expect(snapshot.knowledgeRefs).toEqual([reference]);
      expect(snapshot.knowledgePolicy.requirements).toEqual([requirement]);
      expect(snapshot.scenario.metricMapping).toEqual(multiProjectTargetCatalog.targets[0]!.scenario.metricMapping);
      expect(snapshot.scenario.threshold).toBe(multiProjectTargetCatalog.targets[0]!.scenario.threshold);
    }
  });

  it.each(['target', 'scope'] as const)('rejects publication %s mismatch', async mismatch => {
    const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles), installedScenarios, installedAdapters,
      validationTime: capturedAt,
      knowledgePublications: { inspectBinding: async () => ({ scopeKey: mismatch === 'scope' ? 'b'.repeat(64) : checkpointChecksum({
        targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
        targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
        scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
        faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
      }), publication: { targetId: mismatch === 'target' ? 'market-b-sim' : 'market-a-sim', publicationVersion: 1,
        references: [], policy: { schemaVersion: 1, targetId: 'market-a-sim', policyVersion: 'policy/v1',
          policyEpoch: 1, defaultRequiredness: 'optional', requirements: [] }, publishedAt: capturedAt } }) },
    });
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
  });
  it('does not activate catalog knowledge refs without an explicit publication', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });

    expect(snapshot.knowledgeRefs).toEqual([]);
    expect(snapshot.knowledgePolicy.requirements).toEqual([]);
    expect(snapshot.publicationVersion).toBe(0);
  });

  it('captures only the published binding after checking the Target-derived scope and host capability', async () => {
    const scope: KnowledgeScope = {
      targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
      targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
      scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
      faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
    };
    const reference = { id: 'settlement-runbook', version: '1', digest: 'a'.repeat(64), approval: 'approved' as const };
    const policy = { schemaVersion: 1 as const, targetId: 'market-a-sim', policyVersion: 'policy/v1', policyEpoch: 1,
      defaultRequiredness: 'optional' as const, requirements: [{ id: reference.id, version: reference.version,
        digest: reference.digest, requiredness: 'required' as const, knowledgeClass: 'semantic' as const }] };
    const publication: TargetKnowledgePublication = {
      targetId: 'market-a-sim', publicationVersion: 3, references: [reference], policy,
      publishedAt: '2026-10-11T09:00:00.000Z',
    };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
      knowledgePublications: { inspectBinding: async () => ({ publication, scopeKey: checkpointChecksum(scope) }) },
      knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: true, proceduralEnabled: false }) },
    });

    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });

    expect(snapshot.knowledgeRefs).toEqual([reference]);
    expect(snapshot.knowledgePolicy.requirements).toEqual(policy.requirements);
    expect(snapshot.publicationVersion).toBe(3);
  });

  it('rejects a required knowledge type whose host capability is disabled', async () => {
    const scope: KnowledgeScope = {
      targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
      targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
      scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
      faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
    };
    const reference = { id: 'settlement-runbook', version: '1', digest: 'a'.repeat(64), approval: 'approved' as const };
    const policy = { schemaVersion: 1 as const, targetId: 'market-a-sim', policyVersion: 'policy/v1', policyEpoch: 1,
      defaultRequiredness: 'optional' as const, requirements: [{ id: reference.id, version: reference.version,
        digest: reference.digest, requiredness: 'required' as const, knowledgeClass: 'semantic' as const }] };
    const publication: TargetKnowledgePublication = { targetId: 'market-a-sim', publicationVersion: 1,
      references: [reference], policy, publishedAt: '2026-10-11T09:00:00.000Z' };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
      knowledgePublications: { inspectBinding: async () => ({ publication, scopeKey: checkpointChecksum(scope) }) },
      knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: false, proceduralEnabled: false }) },
    });

    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUIRED_DISABLED' });
  });

  it('resolves each project to a separate immutable snapshot and exact memory scope', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    const marketA = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const marketB = await resolver.resolve({ targetId: 'market-b-sim', capturedAt, signal: new AbortController().signal });

    expect(marketA).toMatchObject({
      targetId: 'market-a-sim', projectId: 'market-a', deploymentGeneration: 1,
      profile: { profileId: 'market-a.lab.settlement', revision: 'profile/v1' },
      scenario: { id: 'window_failure_rate.v1', threshold: 0.05,
        metricMapping: { metricName: 'market_checkout_window_requests', outcomeLabel: 'outcome' } },
      memoryScope: { profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
        targetFingerprint: 'market-a-lab-dataset-a', serviceId: 'checkout', faultType: 'window_failure_rate.v1',
        environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1' },
    });
    expect(marketB).toMatchObject({
      targetId: 'market-b-sim', projectId: 'market-b',
      scenario: { threshold: 0.02, metricMapping: { metricName: 'orders_submit_window_count', outcomeLabel: 'result' } },
      memoryScope: { profileId: 'market-b.lab.settlement', targetFingerprint: 'market-b-lab-dataset-b', datasetId: 'dataset-b-v1' },
    });
    expect(marketA.digest).toMatch(/^sha256:v2:[a-f0-9]{64}$/u);
    expect(marketA.digest).not.toBe(marketB.digest);
    expect(Object.isFrozen(marketA)).toBe(true);
    expect(Object.isFrozen(marketA.scenario.metricMapping.staticLabels)).toBe(true);
    expect(() => (marketA.scenario.metricMapping.staticLabels as Record<string, string>).service = 'other').toThrow();
  });

  it('keeps endpoint and secret references out of resolved snapshots and catalog DTOs', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    const serialized = JSON.stringify({ snapshot: await resolver.resolve({
      targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal,
    }), catalog: resolver.listCatalog() });

    expect(serialized).not.toContain('https://private-market-a.invalid/mcp');
    expect(serialized).not.toContain('secret.metrics.market-a');
    expect(serialized).not.toContain('secret.metrics.market-b');
    expect(serialized).not.toContain('apiKey');
    expect(resolver.listCatalog()).toEqual(expect.arrayContaining([expect.objectContaining({
      targetId: 'market-a-sim', readOnly: true, canStart: true,
    })]));
  });

  it('isolates a Target whose required source is missing while retaining a valid sibling', async () => {
    const connections = structuredClone(multiProjectConnectionRegistry) as { schemaVersion: 2; connections: Record<string, unknown>[] };
    connections.connections = connections.connections.filter(connection => connection.sourceId !== 'market-a-metrics');
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.listCatalog().map(item => item.targetId)).toEqual(['market-b-sim']);
    expect(resolver.rejected).toContainEqual({ index: 0, targetId: 'market-a-sim', reasonCode: 'SOURCE_MAPPING_INVALID' });
    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
  });

  it('marks an unavailable optional source without leaking it as an available capability', async () => {
    const catalog = structuredClone(multiProjectTargetCatalog) as { schemaVersion: 1; targets: Record<string, unknown>[] };
    const first = catalog.targets[0];
    if (first === undefined) throw new Error('Target fixture is missing.');
    first.sourceBindings = [...first.sourceBindings as Record<string, unknown>[], {
      sourceId: 'market-a-logs', version: 'connection/v1', kind: 'logs', adapterId: 'elasticsearch-mcp.v1',
      required: false, allowedServiceIds: ['checkout'],
    }];
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters: [...installedAdapters, { id: 'elasticsearch-mcp.v1', kind: 'logs' }],
      validationTime: capturedAt,
    });

    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
    const dto = resolver.listCatalog().find(item => item.targetId === 'market-a-sim');
    expect(snapshot.unavailableOptionalSourceIds).toEqual(['market-a-logs']);
    expect(dto?.sourceKinds).toEqual(['metrics']);
  });

  it('rejects a source registry entry with unrecognized private fields only for its referencing Target', async () => {
    const connections = structuredClone(multiProjectConnectionRegistry) as { schemaVersion: 2; connections: Record<string, unknown>[] };
    connections.connections[0] = { ...connections.connections[0], apiKey: 'never-accepted' };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.listCatalog().map(item => item.targetId)).toEqual(['market-b-sim']);
    expect(resolver.rejected).toContainEqual({ index: 0, targetId: 'market-a-sim', reasonCode: 'SOURCE_MAPPING_INVALID' });
    expect(JSON.stringify(resolver.listCatalog())).not.toContain('never-accepted');
  });

  it('rejects unknown scenario versions and unavailable adapters without enabling that Target', async () => {
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [{ ...WINDOW_FAILURE_RATE_INSTALLATION, version: '9.9.9' }],
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.listCatalog()).toEqual([]);
    expect(resolver.rejected).toEqual([
      { index: 0, targetId: 'market-a-sim', reasonCode: 'SCENARIO_VERSION_UNSUPPORTED' },
      { index: 1, targetId: 'market-b-sim', reasonCode: 'SCENARIO_VERSION_UNSUPPORTED' },
    ]);
  });

  it('reports original catalog indices when an earlier malformed Target is isolated', async () => {
    const catalog = structuredClone(multiProjectTargetCatalog) as { schemaVersion: 1; targets: Record<string, unknown>[] };
    catalog.targets[0] = { ...catalog.targets[0], profileRevision: undefined };
    catalog.targets[1] = { ...catalog.targets[1], scenario: {
      ...(catalog.targets[1]?.scenario as Record<string, unknown>), version: '9.9.9',
    } };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.rejected).toEqual([
      { index: 0, targetId: 'market-a-sim', reasonCode: 'TARGET_BINDING_INVALID' },
      { index: 1, targetId: 'market-b-sim', reasonCode: 'SCENARIO_VERSION_UNSUPPORTED' },
    ]);
  });

  it('fails closed on a reused fingerprint that points to a different deployment generation', async () => {
    const catalog = structuredClone(multiProjectTargetCatalog) as { schemaVersion: 1; targets: Record<string, unknown>[] };
    catalog.targets[1] = { ...catalog.targets[1], targetFingerprint: 'market-a-lab-dataset-a' };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.listCatalog()).toEqual([]);
    expect(resolver.rejected).toHaveLength(2);
    expect(resolver.rejected.every(item => item.reasonCode === 'TARGET_IDENTITY_CONFLICT')).toBe(true);
  });

  it('registers and resolves the full host-configured 200-Target bound', async () => {
    const targets: Record<string, unknown>[] = [];
    const connections: Record<string, unknown>[] = [];
    const profiles: ProfileDefinition[] = [];
    for (let index = 0; index < 200; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const targetId = `target-${suffix}`;
      const sourceId = `metrics-${suffix}`;
      const profileId = `project-${suffix}.profile`;
      targets.push(sampleTarget({ targetId, projectId: `project-${suffix}`, projectName: `Project ${suffix}`,
        targetFingerprint: `fingerprint-${suffix}`, profileId, datasetId: `dataset-${suffix}`,
        sourceId, metricName: `requests_${suffix}` }));
      connections.push(sampleConnection(sourceId));
      profiles.push(profileDefinition(profileId));
    }
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: { schemaVersion: 1, targets },
      connections: { schemaVersion: 2, connections },
      profileResolver: new StaticProfileResolver(profiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    expect(resolver.listCatalog()).toHaveLength(200);
    const last = await resolver.resolve({ targetId: 'target-199', capturedAt, signal: new AbortController().signal });
    expect(last.memoryScope).toMatchObject({ profileId: 'project-199.profile', datasetId: 'dataset-199' });
  });

  it('refuses disabled, unknown and aborted selections', async () => {
    const disabled = structuredClone(multiProjectTargetCatalog) as { schemaVersion: 1; targets: Record<string, unknown>[] };
    disabled.targets[0] = { ...disabled.targets[0], enabled: false };
    const resolver = await createStaticTargetResolver({
      ...createTargetIdentityTestPorts(),
      catalog: disabled,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios,
      installedAdapters,
      validationTime: capturedAt,
    });

    await expect(resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_DISABLED' });
    await expect(resolver.resolve({ targetId: 'missing', capturedAt, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    await expect(resolver.resolve({ targetId: 'market-b-sim', capturedAt, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });
});

function sampleTarget(input: { targetId: string; projectId: string; projectName: string; targetFingerprint: string;
  profileId: string; datasetId: string; sourceId: string; metricName: string }) {
  return {
    targetId: input.targetId,
    projectId: input.projectId,
    projectName: input.projectName,
    deploymentId: 'lab',
    deploymentGeneration: 1,
    environment: 'simulation',
    dataClass: 'simulated',
    datasetId: input.datasetId,
    targetFingerprint: input.targetFingerprint,
    profileId: input.profileId,
    profileRevision: 'profile/v1',
    displayName: input.projectName,
    description: 'Generated target for capacity acceptance.',
    enabled: true,
    scenario: { id: 'window_failure_rate.v1', version: '1.0.0',
      implementationDigest: WINDOW_FAILURE_RATE_INSTALLATION.implementationDigest, serviceId: 'checkout', serviceName: 'Checkout',
      metricSemantics: 'integer_window_snapshot', metricMapping: { metricName: input.metricName,
        outcomeLabel: 'outcome', successValue: 'success', failureValue: 'failed',
        serviceSelector: { label: 'service', value: 'checkout' }, staticLabels: {} },
      threshold: 0.05, minSamples: 20 },
    sourceBindings: [{ sourceId: input.sourceId, version: 'connection/v1', kind: 'metrics',
      adapterId: 'prometheus-mcp.v1', required: true, allowedServiceIds: ['checkout'] }],
    knowledgeRefs: [],
  };
}

function sampleConnection(sourceId: string) {
  return { sourceId, version: 'connection/v1', kind: 'metrics', adapterId: 'prometheus-mcp.v1', enabled: true,
    endpoint: `https://${sourceId}.invalid/mcp`, secretRef: `secret.${sourceId}`, allowedServiceIds: ['checkout'],
    dataDomainId: `${sourceId}-domain`, sourceGeneration: 1, permissionScopeDigest: 'c'.repeat(64) };
}

function profileDefinition(profileId: string): ProfileDefinition {
  const impactPolicy: ImpactPolicy = { unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' } };
  return { profileId, revision: 'profile/v1', serviceName: 'Checkout', serviceLevel: 'S1', timezone: 'Asia/Shanghai',
    allowedActions: [], forbiddenActions: [], changeFreezePeriods: [], impactPolicy, policyVersion: 'risk/v1' };
}
