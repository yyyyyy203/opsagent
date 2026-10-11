import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext, Clock, PendingAgentEventV2 } from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/governance.js';
import type { ResolvedTargetSnapshot } from '../src/contracts/target.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/index.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';

const now = '2026-10-11T10:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function targetSnapshot(): Promise<ResolvedTargetSnapshot> {
  const resolver = await createStaticTargetResolver({
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [{ id: 'window_failure_rate.v1', version: '1.0.0' }],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
  });
  return resolver.resolve({ targetId: 'market-a-sim', capturedAt: now, signal: new AbortController().signal });
}

function context(runId: string, targetBindingId: string, snapshot: ResolvedTargetSnapshot): AgentContext {
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

describe.each(['memory', 'sqlite'] as const)('%s Target binding persistence', kind => {
  async function openStore() {
    if (kind === 'memory') {
      const state = new InMemoryDurableState(clock);
      return { state, close: () => Promise.resolve() };
    }
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-binding-'));
    roots.push(root);
    const bundle = createSqlitePersistence({ path: join(root, 'target.sqlite'), clock });
    return { state: bundle, close: () => { bundle.close(); return Promise.resolve(); } };
  }

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
        targetBinding: { binding: rootBinding, snapshot },
      });

      expect(await store.state.checkpoints.load(rootBinding.runId)).toMatchObject({ context: {
        runId: rootBinding.runId, targetBindingId: rootBinding.bindingId,
      } });
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toEqual(rootBinding);
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toEqual(snapshot);
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 }))
        .toMatchObject([{ event: { type: 'RUN_STARTED', runId: rootBinding.runId } }]);
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
        targetBinding: { binding: rootBinding, snapshot },
      })).rejects.toThrow();

      expect(await store.state.checkpoints.load(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getBinding(rootBinding.runId)).toBeNull();
      expect(await store.state.targetBindings.getSnapshot(rootBinding.bindingId)).toBeNull();
      expect(await store.state.outbox.listPending({ runId: rootBinding.runId, limit: 10 })).toEqual([]);
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
        outboxEvents: [runStarted('root-run')], targetBinding: { binding: rootBinding, snapshot } });
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
        outboxEvents: [runStarted(rootBinding.runId)], targetBinding: { binding: rootBinding, snapshot } });

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
    const snapshot = await targetSnapshot();
    const rootBinding = binding({ bindingId: 'binding-restart', targetId: snapshot.targetId,
      runId: 'target-run-restart', rootRunId: 'target-run-restart', snapshotDigest: snapshot.digest,
      requestId: 'request-restart', requestDigest: `sha256:v1:${'7'.repeat(64)}` });
    const request = { requestId: 'request-restart', targetId: snapshot.targetId,
      requestDigest: `sha256:v1:${'7'.repeat(64)}`, runId: rootBinding.runId, createdAt: now };

    const beforeRestart = createSqlitePersistence({ path, clock });
    try {
      await beforeRestart.targetBindings.reserveRequest(request);
      await beforeRestart.transitions.commit({ expectedRevision: null,
        context: context(rootBinding.runId, rootBinding.bindingId, snapshot),
        outboxEvents: [runStarted(rootBinding.runId)], targetBinding: { binding: rootBinding, snapshot } });
    } finally {
      beforeRestart.close();
    }

    const afterRestart = createSqlitePersistence({ path, clock });
    try {
      expect(await afterRestart.targetBindings.getRequest(request.requestId)).toEqual(request);
      expect(await afterRestart.targetBindings.getBinding(rootBinding.runId)).toEqual(rootBinding);
      expect(await afterRestart.targetBindings.getSnapshot(rootBinding.bindingId)).toEqual(snapshot);
      expect((await afterRestart.checkpoints.load(rootBinding.runId))?.context.targetBindingId).toBe(rootBinding.bindingId);
    } finally {
      afterRestart.close();
    }
  });
});
