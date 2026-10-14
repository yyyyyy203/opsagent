import { describe, expect, it, vi } from 'vitest';
import { toAgentError } from '../src/contracts/errors.js';
import type { ResolvedTargetSnapshotV2 } from '../src/contracts/target.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseResolvedTargetSnapshotV2 } from '../src/contracts/target-schema.js';
import { SourceCircuitBreaker, SourceFailure, ResilientExecutor } from '../src/mcp/resilience.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';
import { TargetSourcePartitionRegistry, type TargetSourceExecutionOptions } from '../src/infrastructure/target-source-partition-registry.js';

const capturedAt = '2026-10-11T10:00:00.000Z';
const sourceId = 'market-a-metrics';

interface RegistryFixture {
  registry: TargetSourcePartitionRegistry;
  now: () => number;
  setNow: (value: number) => void;
}

describe('TargetSourcePartitionRegistry', () => {
  it('shares a breaker across Runs and scenarios with the same complete Target source identity', async () => {
    const snapshot = await resolveSnapshot();
    const otherScenario = mutateSnapshot(snapshot, draft => {
      object(draft.scenario).threshold = 0.02;
    });
    const { registry } = createRegistry();
    const first = registry.acquire(snapshot, sourceId);
    const second = registry.acquire(otherScenario, sourceId);
    let attempts = 0;

    for (let operation = 0; operation < 3; operation += 1) {
      await expect(first.execute(async () => {
        attempts += 1;
        throw new SourceFailure('MCP_SERVER_ERROR');
      }, executionOptions())).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }
    const bypass = vi.fn(async () => 'must not run');
    await expect(second.execute(bypass, executionOptions())).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });

    expect(attempts).toBe(9);
    expect(bypass).not.toHaveBeenCalled();
    first.release();
    second.release();
    registry.shutdown();
  });

  it.each([
    ['projectId', (draft: Record<string, unknown>) => { draft.projectId = 'another-project'; }],
    ['deploymentId', (draft: Record<string, unknown>) => { draft.deploymentId = 'another-deployment'; }],
    ['deploymentGeneration', (draft: Record<string, unknown>) => { draft.deploymentGeneration = 2; }],
    ['sourceId', (draft: Record<string, unknown>) => {
      firstObject(draft.sourceBindings).sourceId = 'market-a-metrics-next';
      firstObject(draft.sourceIdentities).sourceId = 'market-a-metrics-next';
    }],
    ['sourceGeneration', (draft: Record<string, unknown>) => { firstObject(draft.sourceIdentities).sourceGeneration = 2; }],
    ['dataDomainId', (draft: Record<string, unknown>) => { firstObject(draft.sourceIdentities).dataDomainId = 'market-a-metrics-domain-next'; }],
    ['permissionScopeDigest', (draft: Record<string, unknown>) => { firstObject(draft.sourceIdentities).permissionScopeDigest = 'b'.repeat(64); }],
  ])('isolates the partition when %s changes', async (_field, change) => {
    const snapshot = await resolveSnapshot();
    const changed = mutateSnapshot(snapshot, change);
    const changedSourceId = changed.sourceBindings[0]!.sourceId;
    const { registry } = createRegistry({ maxPartitions: 16 });
    const original = registry.acquire(snapshot, sourceId);
    const isolated = registry.acquire(changed, changedSourceId);

    for (let operation = 0; operation < 3; operation += 1) {
      await expect(original.execute(async () => { throw new SourceFailure('MCP_SERVER_ERROR'); }, executionOptions()))
        .rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }

    await expect(isolated.execute(async () => 'isolated', executionOptions())).resolves.toBe('isolated');
    original.release();
    isolated.release();
    registry.shutdown();
  });

  it('fails closed for an unselected, duplicate, or identity-less source before creating resources', async () => {
    const snapshot = await resolveSnapshot();
    let created = 0;
    const { registry } = createRegistry({ createResilience: now => {
      created += 1;
      return resilience(now);
    } });
    const duplicateDraft = structuredClone(snapshot) as unknown as Record<string, unknown>;
    object(duplicateDraft).sourceBindings = [...snapshot.sourceBindings, structuredClone(snapshot.sourceBindings[0]!)];
    const duplicate = withSnapshotDigest(duplicateDraft) as unknown as ResolvedTargetSnapshotV2;
    const withoutIdentity = mutateSnapshot(snapshot, draft => { draft.sourceIdentities = []; });

    expect(toAgentError(captureThrown(() => registry.acquire(snapshot, 'not-bound')))).toMatchObject({
      code: 'INVALID_INPUT', retryable: false, details: { reason: 'source_mapping_invalid' },
    });
    expect(() => registry.acquire(duplicate, sourceId))
      .toThrowError(/TARGET_SNAPSHOT_UNAVAILABLE/);
    expect(toAgentError(captureThrown(() => registry.acquire(withoutIdentity, sourceId))).details)
      .toMatchObject({ reason: 'source_mapping_invalid' });
    expect(created).toBe(0);
    registry.shutdown();
  });

  it('requires a valid V2 snapshot digest before partitioning', async () => {
    const snapshot = await resolveSnapshot();
    const registry = createRegistry().registry;
    const tampered = { ...snapshot, digest: 'sha256:v2:invalid' } as ResolvedTargetSnapshotV2;

    expect(() => registry.acquire(tampered, sourceId))
      .toThrowError(/TARGET_SNAPSHOT_UNAVAILABLE/);
    registry.shutdown();
  });

  it('counts one logical failure after retries and admits exactly one half-open probe after 30 seconds', async () => {
    const snapshot = await resolveSnapshot();
    const fixture = createRegistry();
    const lease = fixture.registry.acquire(snapshot, sourceId);
    let attempts = 0;
    const fail = async () => {
      attempts += 1;
      throw new SourceFailure('MCP_SERVER_ERROR');
    };

    for (let operation = 0; operation < 3; operation += 1) {
      await expect(lease.execute(fail, executionOptions())).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }
    expect(attempts).toBe(9);

    const premature = vi.fn(async () => 'must not run');
    fixture.setNow(30_999);
    await expect(lease.execute(premature, executionOptions())).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(premature).not.toHaveBeenCalled();

    fixture.setNow(31_000);
    let releaseProbe!: (value: string) => void;
    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => { probeStarted = resolve; });
    const probe = lease.execute(() => new Promise<string>(resolve => {
      releaseProbe = resolve;
      probeStarted();
    }), executionOptions());
    await started;
    await expect(lease.execute(async () => 'second probe', executionOptions())).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    releaseProbe('recovered');
    await expect(probe).resolves.toBe('recovered');
    await expect(lease.execute(async () => 'closed', executionOptions())).resolves.toBe('closed');

    lease.release();
    fixture.registry.shutdown();
  });

  it('does not count caller cancellation and fences stale success after a later open', async () => {
    const snapshot = await resolveSnapshot();
    const fixture = createRegistry({ maxConcurrentOperationsPerPartition: 5 });
    const lease = fixture.registry.acquire(snapshot, sourceId);
    const abortController = new AbortController();
    let operationStarted!: () => void;
    const started = new Promise<void>(resolve => { operationStarted = resolve; });
    const cancelled = lease.execute(signal => new Promise<string>((_resolve, reject) => {
      operationStarted();
      signal.addEventListener('abort', () => reject(new SourceFailure('ABORTED')), { once: true });
    }), executionOptions(abortController.signal));
    await started;
    abortController.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });

    let releaseStale!: (value: string) => void;
    let staleStarted!: () => void;
    const hasStarted = new Promise<void>(resolve => { staleStarted = resolve; });
    const stale = lease.execute(() => new Promise<string>(resolve => {
      releaseStale = resolve;
      staleStarted();
    }), executionOptions());
    await hasStarted;
    for (let operation = 0; operation < 3; operation += 1) {
      await expect(lease.execute(async () => { throw new SourceFailure('MCP_SERVER_ERROR'); }, executionOptions()))
        .rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }
    releaseStale('late success');
    await expect(stale).resolves.toBe('late success');
    await expect(lease.execute(async () => 'must remain open', executionOptions())).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });

    lease.release();
    fixture.registry.shutdown();
  });

  it('shares permits for the same identity but does not serialize a different partition', async () => {
    const snapshot = await resolveSnapshot();
    const other = mutateSnapshot(snapshot, draft => { draft.projectId = 'another-project'; });
    const { registry } = createRegistry({ maxConcurrentOperationsPerPartition: 1 });
    const first = registry.acquire(snapshot, sourceId);
    const second = registry.acquire(snapshot, sourceId);
    const otherPartition = registry.acquire(other, sourceId);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });

    const running = first.execute(async () => {
      order.push('first-start');
      firstStarted();
      await firstGate;
      order.push('first-end');
    }, executionOptions());
    await started;
    const queued = second.execute(async () => { order.push('second'); }, executionOptions());
    await expect(otherPartition.execute(async () => 'parallel', executionOptions())).resolves.toBe('parallel');
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([running, queued]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);

    first.release();
    second.release();
    otherPartition.release();
    registry.shutdown();
  });

  it('removes aborted waiters and releases permits after operation failure', async () => {
    const snapshot = await resolveSnapshot();
    const { registry } = createRegistry({ maxConcurrentOperationsPerPartition: 1 });
    const lease = registry.acquire(snapshot, sourceId);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const running = lease.execute(async () => {
      firstStarted();
      await firstGate;
      return 'first';
    }, executionOptions());
    await started;

    const aborted = new AbortController();
    const waiting = lease.execute(async () => 'must not start', executionOptions(aborted.signal));
    aborted.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
    releaseFirst();
    await expect(running).resolves.toBe('first');
    await expect(lease.execute(async () => { throw new SourceFailure('MCP_PROTOCOL_ERROR'); }, executionOptions()))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    await expect(lease.execute(async () => 'permit released', executionOptions())).resolves.toBe('permit released');

    lease.release();
    registry.shutdown();
  });

  it('bounds queued work and removes expired waiters using the injected deadline clock', async () => {
    const snapshot = await resolveSnapshot();
    const fixture = createRegistry({ maxConcurrentOperationsPerPartition: 1, maxQueuedOperationsPerPartition: 1 });
    const lease = fixture.registry.acquire(snapshot, sourceId);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const running = lease.execute(async () => {
      firstStarted();
      await firstGate;
      return 'active';
    }, executionOptions());
    await started;

    const expired = lease.execute(async () => 'must not run', executionOptions(new AbortController().signal, 1_100));
    const overflow = lease.execute(async () => 'must not queue', executionOptions());
    const overflowOutcome = await settleWithin(overflow);
    fixture.setNow(1_100);
    const expiryOutcome = await settleWithin(expired);

    const admittedAfterExpiry = lease.execute(async () => 'admitted', executionOptions(new AbortController().signal, 2_000));
    releaseFirst();
    await expect(running).resolves.toBe('active');
    await Promise.allSettled([overflow, expired]);
    expect(overflowOutcome).toEqual({
      status: 'rejected', code: 'BUDGET_EXCEEDED', retryable: false, reason: 'queue_capacity_exceeded',
    });
    expect(expiryOutcome).toEqual({
      status: 'rejected', code: 'BUDGET_EXCEEDED', retryable: false, reason: 'deadline_expired',
    });
    await expect(admittedAfterExpiry).resolves.toBe('admitted');
    lease.release();
    fixture.registry.shutdown();
  });

  it('uses the registry clock for resilience even if a caller supplies a conflicting runtime field', async () => {
    const snapshot = await resolveSnapshot();
    let observedNow: (() => number) | undefined;
    const fixture = createRegistry({ createResilience: now => {
      const delegate = resilience(now);
      return {
        get state() { return delegate.state; },
        execute: async (operation, options) => {
          observedNow = options.now;
          return delegate.execute(operation, options);
        },
      };
    } });
    const lease = fixture.registry.acquire(snapshot, sourceId);
    const hostileOptions = {
      ...executionOptions(),
      now: () => 9_999_999,
    } as unknown as TargetSourceExecutionOptions;

    await expect(lease.execute(async () => 'ok', hostileOptions)).resolves.toBe('ok');
    expect(observedNow).toBe(fixture.now);
    lease.release();
    fixture.registry.shutdown();
  });

  it('uses reference-counted releases and evicts only idle closed entries at capacity', async () => {
    const snapshot = await resolveSnapshot();
    const other = mutateSnapshot(snapshot, draft => { draft.projectId = 'another-project'; });
    const { registry } = createRegistry({ maxPartitions: 1 });
    const first = registry.acquire(snapshot, sourceId);
    const shared = registry.acquire(snapshot, sourceId);
    first.release();
    first.release();
    expect(toAgentError(captureThrown(() => registry.acquire(other, sourceId)))).toMatchObject({
      code: 'BUDGET_EXCEEDED', retryable: false, details: { reason: 'partition_capacity_exceeded' },
    });
    shared.release();

    const otherLease = registry.acquire(other, sourceId);
    await expect(otherLease.execute(async () => 'after safe eviction', executionOptions())).resolves.toBe('after safe eviction');
    otherLease.release();
    registry.shutdown();
  });

  it('never evicts an open partition or an operation whose final lease was released', async () => {
    const snapshot = await resolveSnapshot();
    const other = mutateSnapshot(snapshot, draft => { draft.projectId = 'another-project'; });
    const openFixture = createRegistry({ maxPartitions: 1 });
    const openLease = openFixture.registry.acquire(snapshot, sourceId);
    for (let operation = 0; operation < 3; operation += 1) {
      await expect(openLease.execute(async () => { throw new SourceFailure('MCP_SERVER_ERROR'); }, executionOptions()))
        .rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }
    openLease.release();
    expect(toAgentError(captureThrown(() => openFixture.registry.acquire(other, sourceId))).details)
      .toMatchObject({ reason: 'partition_capacity_exceeded' });
    openFixture.registry.shutdown();

    const activeFixture = createRegistry({ maxPartitions: 1 });
    const activeLease = activeFixture.registry.acquire(snapshot, sourceId);
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const hasStarted = new Promise<void>(resolve => { started = resolve; });
    const activeOperation = activeLease.execute(async () => {
      started();
      await gate;
      return 'done';
    }, executionOptions());
    await hasStarted;
    activeLease.release();
    expect(toAgentError(captureThrown(() => activeFixture.registry.acquire(other, sourceId))).details)
      .toMatchObject({ reason: 'partition_capacity_exceeded' });
    finish();
    await expect(activeOperation).resolves.toBe('done');
    const evictedLease = activeFixture.registry.acquire(other, sourceId);
    evictedLease.release();
    activeFixture.registry.shutdown();
  });

  it('shutdown aborts active work, rejects waiters and future leases without hanging', async () => {
    const snapshot = await resolveSnapshot();
    const { registry } = createRegistry({ maxConcurrentOperationsPerPartition: 1 });
    const lease = registry.acquire(snapshot, sourceId);
    let activeSignal: AbortSignal | undefined;
    let started!: () => void;
    const hasStarted = new Promise<void>(resolve => { started = resolve; });
    const active = lease.execute(signal => new Promise<string>(() => {
      activeSignal = signal;
      started();
    }), executionOptions());
    await hasStarted;
    const waiter = lease.execute(async () => 'must not run', executionOptions());
    const activeRejection = expect(active).rejects.toMatchObject({ code: 'ABORTED' });
    const waiterRejection = expect(waiter).rejects.toMatchObject({ code: 'ABORTED', details: { reason: 'registry_closed' } });

    registry.shutdown();
    expect(activeSignal?.aborted).toBe(true);
    await Promise.all([activeRejection, waiterRejection]);
    await expect(lease.execute(async () => 'closed', executionOptions()))
      .rejects.toMatchObject({ code: 'ABORTED', details: { reason: 'registry_closed' } });
    expect(toAgentError(captureThrown(() => registry.acquire(snapshot, sourceId))).details)
      .toMatchObject({ reason: 'registry_closed' });
    lease.release();
    registry.shutdown();
  });
});

async function resolveSnapshot(): Promise<ResolvedTargetSnapshotV2> {
  const resolver = await createStaticTargetResolver({
    ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: capturedAt,
  });
  return resolver.resolve({ targetId: 'market-a-sim', capturedAt, signal: new AbortController().signal });
}

function createRegistry(input: {
  maxPartitions?: number;
  maxConcurrentOperationsPerPartition?: number;
  maxQueuedOperationsPerPartition?: number;
  createResilience?: (now: () => number) => ReturnType<typeof resilience>;
} = {}): RegistryFixture {
  let currentTime = 1_000;
  const timers: Array<{ dueAt: number; callback: () => void; cancelled: boolean }> = [];
  const now = () => currentTime;
  const registry = new TargetSourcePartitionRegistry({
    maxPartitions: input.maxPartitions ?? 64,
    maxConcurrentOperationsPerPartition: input.maxConcurrentOperationsPerPartition ?? 8,
    maxQueuedOperationsPerPartition: input.maxQueuedOperationsPerPartition ?? 32,
    now,
    scheduleTimeout: (callback, delayMs) => {
      const timer = { dueAt: currentTime + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    createResilience: input.createResilience ?? resilience,
  });
  return {
    registry,
    now,
    setNow: value => {
      currentTime = value;
      const due = timers.filter(timer => !timer.cancelled && timer.dueAt <= value);
      for (let index = timers.length - 1; index >= 0; index -= 1) {
        if (timers[index]!.cancelled || timers[index]!.dueAt <= value) timers.splice(index, 1);
      }
      for (const timer of due) timer.callback();
    },
  };
}

function resilience(now: () => number) {
  const breaker = new SourceCircuitBreaker({ now });
  const executor = new ResilientExecutor(breaker, { now, random: () => 1, sleep: async () => undefined });
  return {
    get state() { return breaker.state; },
    execute: <T>(operation: (signal: AbortSignal) => Promise<T>, options: Parameters<typeof executor.execute<T>>[1]) =>
      executor.execute(operation, options),
  };
}

function executionOptions(signal = new AbortController().signal, deadline = 60_000) {
  return { signal, deadline };
}

async function settleWithin<T>(promise: Promise<T>): Promise<
  | { status: 'resolved' }
  | { status: 'rejected'; code: string; retryable: boolean; reason: string | undefined }
  | { status: 'pending' }
> {
  return Promise.race([
    promise.then(() => ({ status: 'resolved' as const }), (error: unknown) => {
      const normalized = toAgentError(error);
      return {
        status: 'rejected' as const,
        code: normalized.code,
        retryable: normalized.retryable,
        reason: typeof normalized.details?.reason === 'string' ? normalized.details.reason : undefined,
      };
    }),
    new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
  ]);
}

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

function mutateSnapshot(
  snapshot: ResolvedTargetSnapshotV2,
  change: (draft: Record<string, unknown>) => void,
): ResolvedTargetSnapshotV2 {
  const draft = structuredClone(snapshot) as unknown as Record<string, unknown>;
  change(draft);
  return parseResolvedTargetSnapshotV2(withSnapshotDigest(draft));
}

function withSnapshotDigest(draft: Record<string, unknown>): Record<string, unknown> {
  const unsigned = structuredClone(draft);
  delete unsigned.digest;
  const digest = `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsigned })}`;
  return { ...unsigned, digest };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object fixture.');
  return value as Record<string, unknown>;
}

function firstObject(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Expected non-empty object array fixture.');
  return object(value[0]);
}
