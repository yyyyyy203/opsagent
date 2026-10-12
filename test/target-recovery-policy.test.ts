import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatModel, Clock, Tool } from '../src/contracts/index.js';
import type {
  ResolvedTargetSnapshotV2,
  TargetBindingStore,
  TargetIdentityCandidate,
  TargetOperationPermit,
  TargetOperationPolicy,
  TargetOperationRequest,
  TargetResolver,
  TargetRuntimeProvider,
  TargetRunBindingRecord,
} from '../src/contracts/target.js';
import { TargetConfigurationError } from '../src/contracts/target.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { TargetRecoveryService } from '../src/application/target-recovery-service.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';

const now = '2026-10-12T02:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };
const abort = () => new AbortController().signal;

describe('TargetRecoveryService', () => {
  it('denies a disabled or unresolved Target before acquiring runtime capabilities', async () => {
    const fixture = await createFixture();
    const resolver: TargetResolver = {
      listCatalog: () => fixture.resolver.listCatalog(),
      resolve: async () => { throw new TargetConfigurationError('TARGET_DISABLED'); },
    };
    const service = fixture.service({ resolver });

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'TARGET_DISABLED' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('denies changed deployment identity before resume', async () => {
    const fixture = await createFixture();
    const identitySnapshot = await fixture.identityRegistry.readSnapshot();
    const publication = await fixture.identityRegistry.publishCatalog({
      expectedVersion: identitySnapshot.version,
      presentTargetIds: [fixture.snapshot.targetId],
      candidates: [{
        targetId: fixture.snapshot.targetId,
        projectId: fixture.snapshot.projectId,
        deploymentId: fixture.snapshot.deploymentId,
        deploymentGeneration: fixture.snapshot.deploymentGeneration + 1,
        scenarioId: fixture.snapshot.scenario.id,
        primaryServiceId: fixture.snapshot.scenario.serviceId,
        profileId: fixture.snapshot.profile.profileId,
        targetFingerprint: `${fixture.snapshot.targetFingerprint}-next`,
        dataClass: fixture.snapshot.dataClass,
        ...(fixture.snapshot.datasetId === undefined ? {} : { datasetId: fixture.snapshot.datasetId }),
        sourceIdentities: fixture.snapshot.sourceIdentities,
      }],
      publishedAt: now,
    });
    expect(publication.acceptedTargetIds).toEqual([fixture.snapshot.targetId]);
    const service = fixture.service();

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'TARGET_GENERATION_CHANGED' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('denies a changed installed scenario digest before acquiring runtime capabilities', async () => {
    const fixture = await createFixture();
    const { digest, ...unsigned } = fixture.snapshot;
    void digest;
    const changedUnsigned = {
      ...unsigned,
      scenarioImplementationDigest: `sha256:v1:${'b'.repeat(64)}`,
    };
    const changedSnapshot: ResolvedTargetSnapshotV2 = {
      ...changedUnsigned,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: changedUnsigned })}`,
    };
    const resolver: TargetResolver = {
      listCatalog: () => fixture.resolver.listCatalog(),
      resolve: async () => changedSnapshot,
    };
    const service = fixture.service({ resolver });

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'SCENARIO_DIGEST_MISMATCH' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('denies recovery when the originally bound Scenario is no longer installed', async () => {
    const fixture = await createFixture();
    const resolver = await createStaticTargetResolver({
      ...fixture.ports,
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: now,
    });
    const service = fixture.service({ resolver });

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('denies a revoked source identity before acquiring runtime capabilities', async () => {
    const fixture = await createFixture();
    const identitySnapshot = await fixture.identityRegistry.readSnapshot();
    const sourceIdentity = fixture.snapshot.sourceIdentities[0];
    if (sourceIdentity === undefined) throw new Error('test Target has no source identity');
    const sourceIdentities = fixture.snapshot.sourceIdentities.map(identity => identity.sourceId === sourceIdentity.sourceId
      ? { ...identity, sourceGeneration: identity.sourceGeneration + 1, permissionScopeDigest: 'b'.repeat(64) }
      : identity);
    const candidate: TargetIdentityCandidate = {
      targetId: fixture.snapshot.targetId,
      projectId: fixture.snapshot.projectId,
      deploymentId: fixture.snapshot.deploymentId,
      deploymentGeneration: fixture.snapshot.deploymentGeneration,
      scenarioId: fixture.snapshot.scenario.id,
      primaryServiceId: fixture.snapshot.scenario.serviceId,
      profileId: fixture.snapshot.profile.profileId,
      targetFingerprint: `${fixture.snapshot.targetFingerprint}-source-revoked`,
      dataClass: fixture.snapshot.dataClass,
      ...(fixture.snapshot.datasetId === undefined ? {} : { datasetId: fixture.snapshot.datasetId }),
      sourceIdentities,
    };
    const publication = await fixture.identityRegistry.publishCatalog({
      expectedVersion: identitySnapshot.version,
      presentTargetIds: [fixture.snapshot.targetId],
      candidates: [candidate],
      publishedAt: now,
    });
    expect(publication.acceptedTargetIds).toEqual([fixture.snapshot.targetId]);
    const service = fixture.service();

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'SOURCE_MAPPING_INVALID' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('rebuilds from the persisted original snapshot rather than a newer catalog snapshot', async () => {
    const fixture = await createFixture();
    const currentSnapshot = await fixture.resolver.resolve({
      targetId: fixture.binding.targetId, capturedAt: '2026-10-12T02:01:00.000Z', signal: abort(),
    });
    const resolver: TargetResolver = {
      listCatalog: () => fixture.resolver.listCatalog(),
      resolve: async () => currentSnapshot,
    };
    const service = fixture.service({ resolver });

    const lease = await service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() });
    expect(fixture.acquire).toHaveBeenCalledWith(fixture.snapshot);
    expect(lease.operations).toBeDefined();
    await lease.release();
  });

  it('rejects Target runtime Tools without an implementation version and releases the acquired runtime', async () => {
    const fixture = await createFixture();
    const sourceId = fixture.snapshot.sourceBindings[0]?.sourceId;
    if (sourceId === undefined) throw new Error('test Target has no source binding');
    const release = vi.fn(async () => undefined);
    fixture.acquire.mockResolvedValue({
      model: fixture.model,
      tools: [{
        name: 'test.unversioned-source',
        description: 'Test-only source tool with no implementation identity.',
        kind: 'evidence',
        source: 'mcp',
        targetSourceId: sourceId,
        inputSchema: z.object({}).strict(),
        call: async () => ({ blocks: [{ type: 'text', text: 'test result' }] }),
      }],
      release,
    });
    const service = fixture.service();

    await expect(service.acquireForResume({
      runId: fixture.binding.runId,
      targetBindingId: fixture.binding.bindingId,
      signal: abort(),
    })).rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('allows benign endpoint and secret-reference rotation while rebuilding the original snapshot', async () => {
    const fixture = await createFixture();
    const rotatedConnections = {
      schemaVersion: multiProjectConnectionRegistry.schemaVersion,
      connections: multiProjectConnectionRegistry.connections.map(connection => connection.sourceId === 'market-a-metrics'
        ? { ...connection, endpoint: 'https://rotated-market-a.invalid/mcp', secretRef: 'secret.metrics.market-a.rotated' }
        : connection),
    };
    const resolver = await createStaticTargetResolver({
      ...fixture.ports,
      catalog: multiProjectTargetCatalog,
      connections: rotatedConnections,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: '2026-10-12T02:01:00.000Z',
    });
    const service = fixture.service({ resolver });

    const lease = await service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() });
    expect(fixture.acquire).toHaveBeenCalledWith(fixture.snapshot);
    await lease.release();
  });

  it('does not widen an existing Run when the current source permission scope expands', async () => {
    const fixture = await createFixture();
    const expandedConnections = {
      schemaVersion: multiProjectConnectionRegistry.schemaVersion,
      connections: multiProjectConnectionRegistry.connections.map(connection => connection.sourceId === 'market-a-metrics'
        ? {
          ...connection,
          allowedServiceIds: [...connection.allowedServiceIds, 'refund'],
          sourceGeneration: connection.sourceGeneration + 1,
          permissionScopeDigest: 'c'.repeat(64),
        }
        : connection),
    };
    const expandedCatalog = {
      ...multiProjectTargetCatalog,
      targets: multiProjectTargetCatalog.targets.map(target => target.targetId === fixture.snapshot.targetId
        ? { ...target, targetFingerprint: `${target.targetFingerprint}-permission-expanded` }
        : target),
    };
    const resolver = await createStaticTargetResolver({
      ...fixture.ports,
      catalog: expandedCatalog,
      connections: expandedConnections,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      validationTime: '2026-10-12T02:01:00.000Z',
    });
    const service = fixture.service({ resolver });

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'SOURCE_MAPPING_INVALID' });
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('rejects a child source scope not present in the original snapshot before runtime acquisition', async () => {
    const fixture = await createFixture();
    const service = fixture.service();

    await expect(service.acquireForStart({
      binding: fixture.binding,
      snapshot: fixture.snapshot,
      signal: abort(),
      sourceScopeId: 'unbound-source',
    })).rejects.toMatchObject({
      code: 'TARGET_OPERATION_DENIED',
    });
    expect(fixture.acquire).not.toHaveBeenCalled();
  });

  it('rejects a revoked operation epoch and releases a runtime acquired during the race', async () => {
    const fixture = await createFixture();
    const release = vi.fn(async () => undefined);
    fixture.acquire.mockResolvedValue({ model: fixture.model, tools: [], release });
    fixture.validate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TargetConfigurationError('TARGET_OPERATION_DENIED'));
    const service = fixture.service();

    await expect(service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() }))
      .rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not authorize model/source operations using a mismatched or stale permit', async () => {
    const fixture = await createFixture();
    const service = fixture.service();
    const lease = await service.acquireForResume({ runId: fixture.binding.runId, targetBindingId: fixture.binding.bindingId, signal: abort() });
    const permit = await lease.operations.authorize({ operation: 'source', capability: 'prometheus', signal: abort() });
    expect(fixture.authorize).toHaveBeenLastCalledWith(expect.objectContaining({
      runId: fixture.binding.runId,
      rootRunId: fixture.binding.rootRunId,
      binding: fixture.binding,
      snapshot: fixture.snapshot,
      operation: 'source',
      capability: 'prometheus',
    }));
    await expect(lease.operations.validate({ ...permit, bindingId: 'other-binding' }))
      .rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    fixture.validate.mockImplementation(async (currentPermit: TargetOperationPermit) => {
      if (currentPermit.policyEpoch !== 7) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    });
    await expect(lease.operations.validate({ ...permit, policyEpoch: permit.policyEpoch + 1 }))
      .rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    await lease.release();
  });
});

async function createFixture() {
  const ports = createTargetIdentityTestPorts();
  const resolver = await createStaticTargetResolver({
    ...ports,
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
  });
  const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt: now, signal: abort() });
  const binding: TargetRunBindingRecord = {
    bindingId: 'binding-recovery-test',
    targetId: snapshot.targetId,
    runId: 'run-recovery-test',
    rootRunId: 'run-recovery-test',
    snapshotDigest: snapshot.digest,
    createdAt: now,
    requestId: 'request-recovery-test',
    requestDigest: `sha256:v1:${'a'.repeat(64)}`,
  };
  const bindings: TargetBindingStore = {
    reserveRequest: vi.fn(),
    getRequest: vi.fn(async () => null),
    getBinding: vi.fn(async (runId: string) => runId === binding.runId ? binding : null),
    getSnapshot: vi.fn(async (bindingId: string) => bindingId === binding.bindingId ? snapshot : null),
    listByTarget: vi.fn(async () => ({ items: [] })),
  };
  const model: ChatModel = { async *stream() { return { text: '', toolCalls: [] }; } };
  const acquire = vi.fn(async () => ({ model, tools: [] as readonly Tool[], release: vi.fn(async () => undefined) }));
  const authorize = vi.fn(async (request: TargetOperationRequest): Promise<TargetOperationPermit> => ({
    bindingId: request.binding.bindingId,
    runId: request.runId,
    rootRunId: request.rootRunId,
    snapshotDigest: request.snapshot.digest,
    operation: request.operation,
    capability: request.capability,
    policyEpoch: 7,
    signal: request.signal,
  }));
  const validate = vi.fn<TargetOperationPolicy['validate']>(() => Promise.resolve());
  const operationPolicy: TargetOperationPolicy = { authorize, validate };
  const service = (overrides: { resolver?: TargetResolver } = {}) => new TargetRecoveryService({
    bindings,
    identityRegistry: ports.identityRegistry,
    resolver: overrides.resolver ?? resolver,
    operationPolicy,
    runtimeProvider: { acquire } satisfies TargetRuntimeProvider,
    clock,
  });
  return { resolver, snapshot, binding, bindings, identityRegistry: ports.identityRegistry, ports, model, acquire, authorize, validate, service };
}
