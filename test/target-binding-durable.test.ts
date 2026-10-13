import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext, Clock, PendingAgentEventV2 } from '../src/contracts/index.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { createInitialRunGovernanceState } from '../src/contracts/governance.js';
import type { ResolvedTargetSnapshot, ResolvedTargetSnapshotV2, TargetRunBindingRecord,
  TargetStartClaim, TargetStartStore, VersionedResolvedTargetSnapshot } from '../src/contracts/target.js';
import { parseResolvedTargetSnapshot, parseResolvedTargetSnapshotV2 } from '../src/contracts/target-schema.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/index.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { legacySnapshotUnsigned } from './helpers/legacy-target-snapshot.js';

const now = '2026-10-11T10:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function targetSnapshot(): Promise<ResolvedTargetSnapshotV2> {
  const resolver = await createStaticTargetResolver({
    ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
  });
  const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt: now,
    signal: new AbortController().signal });
  return snapshot;
}

async function legacyTargetSnapshot(): Promise<ResolvedTargetSnapshot> {
  const snapshot = await targetSnapshot();
  const unsigned = legacySnapshotUnsigned(snapshot);
  return parseResolvedTargetSnapshot({
    ...unsigned,
    digest: `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, target: unsigned })}`,
  });
}

function context(runId: string, targetBindingId: string, snapshot: VersionedResolvedTargetSnapshot): AgentContext {
  const governance = createInitialRunGovernanceState({ profileId: snapshot.profile.profileId, capturedAt: now });
  return {
    runId,
    status: 'running',
    stage: 'triage',
    profileId: 'market-a.lab.settlement',
    targetBindingId,
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: { startedAt: now, maxIterations: 8, iteration: 0, maxToolCalls: 12, toolCallsUsed: 0, maxDurationMs: 60_000 },
    contextVersion: 1,
    governance: { ...governance, profile: snapshot.profile },
  };
}

function binding(input: {
  bindingId: string;
  targetId: string;
  runId: string;
  rootRunId: string;
  snapshotDigest: string;
  requestId?: string;
  requestDigest?: string;
}) {
  return { ...input, createdAt: now };
}

function runStarted(runId: string): PendingAgentEventV2<'RUN_STARTED'> {
  return {
    schemaVersion: 2,
    eventId: `event-${runId}`,
    type: 'RUN_STARTED',
    payload: {
      profile: 'market-a.lab.settlement', trigger: 'manual',
      deadline: '2026-10-11T10:01:00.000Z', versionSnapshot: {},
    },
    runId,
    correlationId: `run:${runId}`,
    timestamp: now,
    visibility: 'audit',
    durability: 'durable',
  };
}

async function acquireStartClaim(starts: TargetStartStore, binding: TargetRunBindingRecord): Promise<TargetStartClaim> {
  const result = await starts.claimStart({ requestId: binding.requestId!, runId: binding.runId,
    targetId: binding.targetId, requestDigest: binding.requestDigest!, ownerId: `test-owner:${binding.runId}`,
    now, leaseUntil: '2026-10-11T10:01:00.000Z' });
  if (result.status !== 'claimed') throw new Error(`Could not claim Target start: ${result.status}`);
  return result.claim;
}

describe.each(['memory', 'sqlite'] as const)('%s Target binding persistence', (kind: 'memory' | 'sqlite') => {
  async function openStore() {
    if (kind === 'memory') {
      const state = new InMemoryDurableState(clock, undefined, () => 1);
      return { state, close: () => Promise.resolve() };
    }
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-binding-'));
    roots.push(root);
    const bundle = createSqlitePersistence({ path: join(root, 'target.sqlite'), clock });
    await createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
      catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION], installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      identityRegistry: bundle.targetIdentityRegistry, knowledgePolicies: bundle.targetKnowledgePolicies, validationTime: now });
    return { state: bundle, close: () => { bundle.close(); return Promise.resolve(); } };
  }

  it('rejects a new root snapshot with a stale publicationVersion before committing any Run state', async () => {
    const store = await openStore();
    const captured = await targetSnapshot();
    const target: Record<string, unknown> = { ...captured, publicationVersion: 1 };
    delete target.digest;
    const snapshot = parseResolvedTargetSnapshotV2({ ...target,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target })}` });
    const rootBinding = binding({ bindingId: 'stale-publication-binding', targetId: snapshot.targetId,
      runId: 'stale-publication-run', rootRunId: 'stale-publication-run', snapshotDigest: snapshot.digest,
      requestId: 'stale-publication-request', requestDigest: `sha256:v1:${'1'.repeat(64)}` });
    try {
      await store.state.targetBindings.reserveRequest({ requestId: rootBinding.requestId!, targetId: snapshot.targetId,
        requestDigest: rootBinding.requestDigest!, runId: rootBinding.runId, createdAt: now });
      await expect(store.state.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot), outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot, startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) },
      })).rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 })).toEqual([]);
    } finally { await store.close(); }
  });

  it('rejects an unfenced V2 snapshot when creating a new root Run', async () => {
    const store = await openStore();
    const resolved = await targetSnapshot();
    const { identityRegistryVersion: _identityRegistryVersion, digest: _digest, ...unsigned } = resolved;
    void _identityRegistryVersion;
    void _digest;
    const snapshot = parseResolvedTargetSnapshotV2({ ...unsigned,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsigned })}` });
    const rootBinding = binding({ bindingId: 'unfenced-registry-binding', targetId: snapshot.targetId,
      runId: 'unfenced-registry-run', rootRunId: 'unfenced-registry-run', snapshotDigest: snapshot.digest,
      requestId: 'unfenced-registry-request', requestDigest: `sha256:v1:${'7'.repeat(64)}` });
    try {
      await store.state.targetBindings.reserveRequest({ requestId: rootBinding.requestId!, targetId: snapshot.targetId,
        requestDigest: rootBinding.requestDigest!, runId: rootBinding.runId, createdAt: now });
      await expect(store.state.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot), outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot,
          startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) },
      })).rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 })).toEqual([]);
    } finally { await store.close(); }
  });

  it('commits root snapshot, binding, initial checkpoint and RUN_STARTED outbox event together', async () => {
    const store = await openStore();
    const snapshot = await targetSnapshot();
    const rootBinding = binding({
      bindingId: 'binding-root-1', targetId: snapshot.targetId, runId: 'target-run-1',
      rootRunId: 'target-run-1', snapshotDigest: snapshot.digest,
      requestId: 'request-1', requestDigest: `sha256:v1:${'1'.repeat(64)}`,
    });
    const request = {
      requestId: 'request-1', targetId: snapshot.targetId, requestDigest: `sha256:v1:${'1'.repeat(64)}`,
      runId: 'target-run-1', createdAt: now,
    };

    try {
      await store.state.targetBindings.reserveRequest(request);
      await store.state.transitions.commit({
        expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot, startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) },
      });

      expect(await store.state.checkpoints.load(rootBinding.runId)).toMatchObject({ context: {
        runId: rootBinding.runId, targetBindingId: rootBinding.bindingId,
      } });
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toEqual(rootBinding);
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toEqual(snapshot);
      expect((await store.state.targetBindings.getSnapshot(rootBinding.bindingId))?.schemaVersion).toBe(2);
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 }))
        .toMatchObject([{ event: { type: 'RUN_STARTED', runId: rootBinding.runId } }]);
      const identity = { requestId: rootBinding.requestId!, runId: rootBinding.runId,
        targetId: rootBinding.targetId, requestDigest: rootBinding.requestDigest! };
      expect(await store.state.targetStarts.reconcileStart(identity)).toEqual({ status: 'confirmed_present' });
      expect(await store.state.targetStarts.claimStart({ ...identity, ownerId: 'second-owner', now,
        leaseUntil: '2026-10-11T10:01:00.000Z' })).toEqual({ status: 'already_started' });
    } finally {
      await store.close();
    }
  });

  it('rolls back snapshot, binding and checkpoint if the initial event is invalid', async () => {
    const store = await openStore();
    const snapshot = await targetSnapshot();
    const rootBinding = binding({
      bindingId: 'binding-rollback', targetId: snapshot.targetId, runId: 'target-run-rollback',
      rootRunId: 'target-run-rollback', snapshotDigest: snapshot.digest,
      requestId: 'request-rollback', requestDigest: `sha256:v1:${'2'.repeat(64)}`,
    });
    const malformedEvent = { ...runStarted(rootBinding.runId), payload: { profile: 'wrong' } } as unknown as PendingAgentEventV2;

    try {
      await store.state.targetBindings.reserveRequest({
        requestId: 'request-rollback', targetId: snapshot.targetId,
        requestDigest: `sha256:v1:${'2'.repeat(64)}`, runId: rootBinding.runId, createdAt: now,
      });
      await expect(store.state.transitions.commit({
        expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [malformedEvent],
        targetBinding: { binding: rootBinding, snapshot, startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) },
      })).rejects.toThrow();

      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toBeNull();
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 })).toEqual([]);
      const claim = await acquireStartClaim(store.state.targetStarts, rootBinding);
      expect(await store.state.targetStarts.releaseStartClaim({ claim, now })).toBe(true);
      expect(await store.state.targetStarts.reconcileStart({ requestId: claim.requestId, runId: claim.runId,
        targetId: claim.targetId, requestDigest: claim.requestDigest })).toEqual({ status: 'confirmed_absent' });
    } finally {
      await store.close();
    }
  });

  it('keeps V1 readable but cannot create an executable Target binding from it', async () => {
    const store = await openStore();
    const snapshot = await legacyTargetSnapshot();
    const rootBinding = binding({
      bindingId: 'binding-v1-unproven', targetId: snapshot.targetId, runId: 'target-run-v1-unproven',
      rootRunId: 'target-run-v1-unproven', snapshotDigest: snapshot.digest,
      requestId: 'request-v1-unproven', requestDigest: `sha256:v1:${'7'.repeat(64)}`,
    });
    try {
      await store.state.targetBindings.reserveRequest({
        requestId: 'request-v1-unproven', targetId: snapshot.targetId,
        requestDigest: `sha256:v1:${'7'.repeat(64)}`, runId: rootBinding.runId, createdAt: now,
      });
      await expect(store.state.transitions.commit({
        expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot, startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) },
      })).rejects.toMatchObject({ code: 'TARGET_IDENTITY_UNPROVEN' });
      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('reuses a request reservation only for the same Target and payload digest', async () => {
    const store = await openStore();
    const reservation = {
      requestId: 'request-idempotent', targetId: 'market-a-sim', requestDigest: `sha256:v1:${'3'.repeat(64)}`,
      runId: 'reserved-run', createdAt: now,
    };

    try {
      expect(await store.state.targetBindings.reserveRequest(reservation)).toEqual({ record: reservation, created: true });
      expect(await store.state.targetBindings.reserveRequest({
        ...reservation, runId: 'new-proposed-run', createdAt: '2026-10-11T11:00:00.000Z',
      })).toEqual({ record: reservation, created: false });
      await expect(store.state.targetBindings.reserveRequest({
        ...reservation, targetId: 'market-b-sim', requestDigest: `sha256:v1:${'4'.repeat(64)}`, runId: 'other-run',
      })).rejects.toMatchObject({ code: 'TARGET_REQUEST_CONFLICT' });
      expect(await store.state.targetBindings.getRequest(reservation.requestId)).toEqual(reservation);
    } finally {
      await store.close();
    }
  });

  it('fences an expired owner before allowing its delayed initial commit', async () => {
    const store = await openStore();
    const snapshot = await targetSnapshot();
    const rootBinding = binding({ bindingId: 'binding-fenced', targetId: snapshot.targetId,
      runId: 'target-run-fenced', rootRunId: 'target-run-fenced', snapshotDigest: snapshot.digest,
      requestId: 'request-fenced', requestDigest: `sha256:v1:${'8'.repeat(64)}` });
    const identity = { requestId: rootBinding.requestId!, runId: rootBinding.runId,
      targetId: rootBinding.targetId, requestDigest: rootBinding.requestDigest! };
    try {
      await store.state.targetBindings.reserveRequest({ ...identity, createdAt: now });
      const first = await store.state.targetStarts.claimStart({ ...identity, ownerId: 'owner-a', now,
        leaseUntil: '2026-10-11T10:00:01.000Z' });
      expect(first.status).toBe('claimed');
      if (first.status !== 'claimed') throw new Error('expected first start claim');
      expect(await store.state.targetStarts.claimStart({ ...identity, ownerId: 'owner-b', now,
        leaseUntil: '2026-10-11T10:01:00.000Z' })).toEqual({ status: 'busy' });
      expect(await store.state.targetStarts.reconcileStart(identity)).toEqual({ status: 'unknown' });

      const takeover = await store.state.targetStarts.claimStart({ ...identity, ownerId: 'owner-b',
        now: '2026-10-11T10:00:02.000Z', leaseUntil: '2026-10-11T10:01:00.000Z' });
      expect(takeover.status).toBe('claimed');
      if (takeover.status !== 'claimed') throw new Error('expected takeover claim');
      expect(takeover.claim.epoch).toBe(first.claim.epoch + 1);

      await expect(store.state.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot, startClaim: first.claim },
      })).rejects.toMatchObject({ code: 'TARGET_START_STATE_UNKNOWN' });
      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();

      expect(await store.state.targetStarts.releaseStartClaim({ claim: first.claim, now })).toBe(false);
      expect(await store.state.targetStarts.releaseStartClaim({ claim: takeover.claim, now })).toBe(true);
      expect(await store.state.targetStarts.reconcileStart(identity)).toEqual({ status: 'confirmed_absent' });
    } finally {
      await store.close();
    }
  });

  it('binds a child to its root Run and the original shared snapshot', async () => {
    const store = await openStore();
    const snapshot = await targetSnapshot();
    const rootBinding = binding({
      bindingId: 'binding-tree', targetId: snapshot.targetId, runId: 'root-run',
      rootRunId: 'root-run', snapshotDigest: snapshot.digest,
      requestId: 'request-tree', requestDigest: `sha256:v1:${'5'.repeat(64)}`,
    });
    const childBinding = binding({
      bindingId: rootBinding.bindingId, targetId: rootBinding.targetId, runId: 'child-run',
      rootRunId: rootBinding.rootRunId, snapshotDigest: rootBinding.snapshotDigest,
    });

    try {
      await store.state.targetBindings.reserveRequest({ requestId: 'request-tree', targetId: snapshot.targetId,
        requestDigest: `sha256:v1:${'5'.repeat(64)}`, runId: 'root-run', createdAt: now });
      await store.state.transitions.commit({ expectedRevision: null, context: context('root-run', rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted('root-run')], targetBinding: { binding: rootBinding, snapshot,
          startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) } });
      await store.state.transitions.commit({ expectedRevision: null, context: context('child-run', childBinding.bindingId, snapshot),
        outboxEvents: [runStarted('child-run')], targetBinding: { binding: childBinding } });

      expect(await store.state.targetBindings.getBinding('child-run')).toEqual(childBinding);
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toEqual(snapshot);
    } finally {
      await store.close();
    }
  });

  it('rejects a Target checkpoint with no matching durable binding and leaves legacy Runs unbound', async () => {
    const store = await openStore();
    try {
      await expect(store.state.transitions.commit({ expectedRevision: null,
        context: context('missing-binding-run', 'missing-binding', await targetSnapshot()), outboxEvents: [] })).rejects.toMatchObject({
          code: 'TARGET_BINDING_INVALID',
        });
      const snapshot = await targetSnapshot();
      const legacy = context('legacy-run', 'unused', snapshot);
      Reflect.deleteProperty(legacy, 'targetBindingId');
      await store.state.transitions.commit({ expectedRevision: null, context: legacy, outboxEvents: [] });
      expect((await store.state.checkpoints.load('legacy-run'))?.context.targetBindingId).toBeUndefined();
      expect(await store.state.targetBindings.getBinding('legacy-run')).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('does not allow a later checkpoint transition to strip an existing Target binding', async () => {
    const store = await openStore();
    const snapshot = await targetSnapshot();
    const rootBinding = binding({ bindingId: 'binding-no-strip', targetId: snapshot.targetId,
      runId: 'target-run-no-strip', rootRunId: 'target-run-no-strip', snapshotDigest: snapshot.digest,
      requestId: 'request-no-strip', requestDigest: `sha256:v1:${'6'.repeat(64)}` });
    try {
      await store.state.targetBindings.reserveRequest({ requestId: 'request-no-strip', targetId: snapshot.targetId,
        requestDigest: `sha256:v1:${'6'.repeat(64)}`, runId: rootBinding.runId, createdAt: now });
      const initial = await store.state.transitions.commit({ expectedRevision: null, context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)], targetBinding: { binding: rootBinding, snapshot,
          startClaim: await acquireStartClaim(store.state.targetStarts, rootBinding) } });

      const strippedContext = context(rootBinding.runId, rootBinding.bindingId, snapshot);
      delete strippedContext.targetBindingId;
      await expect(store.state.transitions.commit({ expectedRevision: initial.revision, context: strippedContext, outboxEvents: [] }))
        .rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      expect((await store.state.checkpoints.load(rootBinding.runId))?.context.targetBindingId).toBe(rootBinding.bindingId);
    } finally {
      await store.close();
    }
  });

  it('restores the original Target snapshot, request and Run binding after reopening SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-restart-'));
    roots.push(root);
    const path = join(root, 'target.sqlite');
    const beforeRestart = createSqlitePersistence({ path, clock });
    const resolver = await createStaticTargetResolver({
      catalog: multiProjectTargetCatalog,
      connections: multiProjectConnectionRegistry,
      profileResolver: new StaticProfileResolver(multiProjectProfiles),
      installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
      installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
      identityRegistry: beforeRestart.targetIdentityRegistry,
      knowledgePolicies: beforeRestart.targetKnowledgePolicies,
      validationTime: now,
    });
    const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt: now,
      signal: new AbortController().signal });
    const rootBinding = binding({ bindingId: 'binding-restart', targetId: snapshot.targetId,
      runId: 'target-run-restart', rootRunId: 'target-run-restart', snapshotDigest: snapshot.digest,
      requestId: 'request-restart', requestDigest: `sha256:v1:${'7'.repeat(64)}` });
    const request = { requestId: 'request-restart', targetId: snapshot.targetId,
      requestDigest: `sha256:v1:${'7'.repeat(64)}`, runId: rootBinding.runId, createdAt: now };

    try {
      await beforeRestart.targetBindings.reserveRequest(request);
      await beforeRestart.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)], targetBinding: { binding: rootBinding, snapshot,
          startClaim: await acquireStartClaim(beforeRestart.targetStarts, rootBinding) } });
    } finally {
      beforeRestart.close();
    }

    const afterRestart = createSqlitePersistence({ path, clock });
    try {
      expect(await afterRestart.targetBindings.getRequest(request.requestId)).toEqual(request);
      expect(await afterRestart.targetBindings.getBinding(rootBinding.runId)).toEqual(rootBinding);
      expect(await afterRestart.targetBindings.getSnapshot(rootBinding.bindingId)).toEqual(snapshot);
      expect((await afterRestart.checkpoints.load(rootBinding.runId))?.context.targetBindingId).toBe(rootBinding.bindingId);
      const identity = { requestId: request.requestId, runId: request.runId, targetId: request.targetId,
        requestDigest: request.requestDigest };
      expect(await afterRestart.targetStarts.reconcileStart(identity)).toEqual({ status: 'confirmed_present' });
      expect(await afterRestart.targetStarts.claimStart({ ...identity, ownerId: 'restarted-owner', now,
        leaseUntil: '2026-10-11T10:01:00.000Z' })).toEqual({ status: 'already_started' });
    } finally {
      afterRestart.close();
    }
  });
});

describe('SQLite Target registry version commit fence', () => {
  it('rejects a resolved Target snapshot if the registry advances before the initial Run commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-registry-fence-'));
    roots.push(root);
    const store = createSqlitePersistence({ path: join(root, 'target.sqlite'), clock });
    try {
      const resolver = await createStaticTargetResolver({
        catalog: multiProjectTargetCatalog,
        connections: multiProjectConnectionRegistry,
        profileResolver: new StaticProfileResolver(multiProjectProfiles),
        installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
        installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
        identityRegistry: store.targetIdentityRegistry,
        knowledgePolicies: store.targetKnowledgePolicies,
        validationTime: now,
      });
      const snapshot = await resolver.resolve({ targetId: 'market-a-sim', capturedAt: now,
        signal: new AbortController().signal });
      const before = await store.targetIdentityRegistry.readSnapshot();
      expect(snapshot).toMatchObject({ identityRegistryVersion: before.version });

      const currentBinding = binding({ bindingId: 'current-registry-binding', targetId: snapshot.targetId,
        runId: 'current-registry-run', rootRunId: 'current-registry-run', snapshotDigest: snapshot.digest,
        requestId: 'current-registry-request', requestDigest: `sha256:v1:${'8'.repeat(64)}` });
      await store.targetBindings.reserveRequest({ requestId: currentBinding.requestId!, targetId: snapshot.targetId,
        requestDigest: currentBinding.requestDigest!, runId: currentBinding.runId, createdAt: now });
      await store.transitions.commit({ expectedRevision: null,
        context: context(currentBinding.runId, currentBinding.bindingId, snapshot), outboxEvents: [runStarted(currentBinding.runId)],
        targetBinding: { binding: currentBinding, snapshot,
          startClaim: await acquireStartClaim(store.targetStarts, currentBinding) },
      });
      expect(await store.targetBindings.getBinding(currentBinding.runId)).toEqual(currentBinding);

      await store.targetIdentityRegistry.publishCatalog({ expectedVersion: before.version,
        presentTargetIds: [], candidates: [], publishedAt: now });
      expect((await store.targetIdentityRegistry.readSnapshot()).version).toBeGreaterThan(before.version);

      const rootBinding = binding({ bindingId: 'stale-registry-binding', targetId: snapshot.targetId,
        runId: 'stale-registry-run', rootRunId: 'stale-registry-run', snapshotDigest: snapshot.digest,
        requestId: 'stale-registry-request', requestDigest: `sha256:v1:${'9'.repeat(64)}` });
      await store.targetBindings.reserveRequest({ requestId: rootBinding.requestId!, targetId: snapshot.targetId,
        requestDigest: rootBinding.requestDigest!, runId: rootBinding.runId, createdAt: now });

      await expect(store.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot), outboxEvents: [runStarted(rootBinding.runId)],
        targetBinding: { binding: rootBinding, snapshot,
          startClaim: await acquireStartClaim(store.targetStarts, rootBinding) },
      })).rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      expect(await store.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.outbox.listPending({ runId: rootBinding.runId, limit: 10 })).toEqual([]);
    } finally {
      store.close();
    }
  });
});
