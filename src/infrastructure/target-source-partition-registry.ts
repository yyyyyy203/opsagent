import type { AgentError, AgentErrorCode } from '../contracts/errors.js';
import { type ResolvedTargetSnapshotV2, type TargetOperationGuard } from '../contracts/target.js';
import { parseResolvedTargetSnapshotV2 } from '../contracts/target-schema.js';

export type TargetSourceCircuitState = 'closed' | 'open' | 'half_open';

export type TargetSourceCircuitEvent =
  | { type: 'opened'; openUntil: number; failureWindow: { failures: number; windowMs: number } }
  | { type: 'half_opened' }
  | { type: 'closed' };

export interface TargetSourceRetryEvent {
  type: 'attempt' | 'retry' | 'success' | 'failure';
  attempt: number;
  code?: AgentErrorCode;
  delayMs?: number;
}

/** Run-scoped inputs accepted by one logical source operation; identity is never caller supplied here. */
export interface TargetSourceExecutionOptions {
  signal: AbortSignal;
  deadline: number;
  attemptBudget?: { remaining: number };
  onEvent?: (event: TargetSourceRetryEvent) => void;
  onCircuitEvent?: (event: TargetSourceCircuitEvent) => void;
  targetOperations?: TargetOperationGuard;
}

export interface TargetSourceResilienceOptions extends TargetSourceExecutionOptions {
  now: () => number;
  targetCapability: string;
}

/** Bootstrap adapts the existing resilience implementation to this infrastructure-owned seam. */
export interface TargetSourceResilienceExecutor {
  readonly state: TargetSourceCircuitState;
  execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: TargetSourceResilienceOptions,
  ): Promise<T>;
}

export type TargetSourceTimeoutScheduler = (callback: () => void, delayMs: number) => () => void;

export type TargetSourcePartitionRegistryErrorCode = 'INVALID_INPUT' | 'BUDGET_EXCEEDED' | 'ABORTED';
export type TargetSourcePartitionRegistryErrorReason =
  | 'source_mapping_invalid'
  | 'partition_capacity_exceeded'
  | 'queue_capacity_exceeded'
  | 'registry_closed'
  | 'lease_released'
  | 'caller_aborted'
  | 'deadline_expired';

export class TargetSourcePartitionRegistryError extends Error implements AgentError {
  public readonly retryable = false;
  public readonly details: Record<string, unknown>;

  public constructor(
    public readonly code: TargetSourcePartitionRegistryErrorCode,
    reason: TargetSourcePartitionRegistryErrorReason,
  ) {
    super(`Target source partition operation failed (${code}).`);
    this.name = 'TargetSourcePartitionRegistryError';
    this.details = { reason };
  }
}

export interface TargetSourcePartitionLease {
  execute<T>(operation: (signal: AbortSignal) => Promise<T>, options: TargetSourceExecutionOptions): Promise<T>;
  release(): void;
}

export interface TargetSourcePartitionRegistryPort {
  acquire(snapshot: ResolvedTargetSnapshotV2, sourceId: string): TargetSourcePartitionLease;
  shutdown(): void;
}

export interface TargetSourcePartitionRegistryOptions {
  maxPartitions: number;
  maxConcurrentOperationsPerPartition: number;
  maxQueuedOperationsPerPartition: number;
  now: () => number;
  scheduleTimeout: TargetSourceTimeoutScheduler;
  createResilience: (now: () => number) => TargetSourceResilienceExecutor;
}

interface Partition {
  readonly key: string;
  readonly sourceId: string;
  readonly resilience: TargetSourceResilienceExecutor;
  readonly semaphore: AsyncSemaphore;
  references: number;
  activeOperations: number;
  lastUsedAt: number;
  lastUsedOrder: number;
}

/** Host-scoped, bounded resilience state keyed only by a validated Target source identity. */
export class TargetSourcePartitionRegistry implements TargetSourcePartitionRegistryPort {
  private readonly partitions = new Map<string, Partition>();
  private readonly shutdownController = new AbortController();
  private readonly maxPartitions: number;
  private readonly maxConcurrentOperationsPerPartition: number;
  private readonly maxQueuedOperationsPerPartition: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: TargetSourceTimeoutScheduler;
  private readonly createResilience: (now: () => number) => TargetSourceResilienceExecutor;
  private closed = false;
  private useOrder = 0;

  public constructor(options: TargetSourcePartitionRegistryOptions) {
    if (!Number.isSafeInteger(options.maxPartitions) || options.maxPartitions < 1
      || !Number.isSafeInteger(options.maxConcurrentOperationsPerPartition) || options.maxConcurrentOperationsPerPartition < 1
      || !Number.isSafeInteger(options.maxQueuedOperationsPerPartition) || options.maxQueuedOperationsPerPartition < 0) {
      throw new Error('Invalid Target source partition limits.');
    }
    this.maxPartitions = options.maxPartitions;
    this.maxConcurrentOperationsPerPartition = options.maxConcurrentOperationsPerPartition;
    this.maxQueuedOperationsPerPartition = options.maxQueuedOperationsPerPartition;
    this.now = options.now;
    this.scheduleTimeout = options.scheduleTimeout;
    this.createResilience = options.createResilience;
  }

  public acquire(snapshotInput: ResolvedTargetSnapshotV2, sourceId: string): TargetSourcePartitionLease {
    if (this.closed) throw new TargetSourcePartitionRegistryError('ABORTED', 'registry_closed');
    const snapshot = parseResolvedTargetSnapshotV2(snapshotInput);
    const bindingMatches = snapshot.sourceBindings.filter(binding => binding.sourceId === sourceId);
    const identityMatches = snapshot.sourceIdentities.filter(identity => identity.sourceId === sourceId);
    if (bindingMatches.length !== 1 || identityMatches.length !== 1 || sourceId.length === 0) {
      throw new TargetSourcePartitionRegistryError('INVALID_INPUT', 'source_mapping_invalid');
    }

    const binding = bindingMatches[0]!;
    const identity = identityMatches[0]!;
    const key = JSON.stringify([
      snapshot.projectId,
      snapshot.deploymentId,
      snapshot.deploymentGeneration,
      binding.sourceId,
      identity.sourceGeneration,
      identity.dataDomainId,
      identity.permissionScopeDigest,
    ]);

    let partition = this.partitions.get(key);
    if (partition === undefined) {
      this.makeRoomIfNeeded();
      partition = {
        key,
        sourceId: binding.sourceId,
        resilience: this.createResilience(this.now),
        semaphore: new AsyncSemaphore(this.maxConcurrentOperationsPerPartition,
          this.maxQueuedOperationsPerPartition, this.now, this.scheduleTimeout),
        references: 0,
        activeOperations: 0,
        lastUsedAt: this.now(),
        lastUsedOrder: ++this.useOrder,
      };
      this.partitions.set(key, partition);
    }

    partition.references += 1;
    this.touch(partition);
    let released = false;
    return {
      execute: async <T>(operation: (signal: AbortSignal) => Promise<T>, options: TargetSourceExecutionOptions): Promise<T> => {
        if (this.closed) throw new TargetSourcePartitionRegistryError('ABORTED', 'registry_closed');
        if (released) throw new TargetSourcePartitionRegistryError('INVALID_INPUT', 'lease_released');
        if (options.signal.aborted) throw new TargetSourcePartitionRegistryError('ABORTED', 'caller_aborted');
        if (!Number.isFinite(options.deadline) || this.now() >= options.deadline) {
          throw new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'deadline_expired');
        }

        partition.activeOperations += 1;
        this.touch(partition);
        let releasePermit: (() => void) | undefined;
        const signal = AbortSignal.any([options.signal, this.shutdownController.signal]);
        try {
          releasePermit = await partition.semaphore.acquire(signal, options.deadline);
          if (this.closed) throw new TargetSourcePartitionRegistryError('ABORTED', 'registry_closed');
          return await partition.resilience.execute(operation, {
            ...options,
            signal,
            now: this.now,
            targetCapability: partition.sourceId,
          });
        } finally {
          releasePermit?.();
          partition.activeOperations -= 1;
          this.touch(partition);
        }
      },
      release: (): void => {
        if (released) return;
        released = true;
        partition.references -= 1;
        this.touch(partition);
      },
    };
  }

  public shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const partition of this.partitions.values()) partition.semaphore.shutdown();
    this.shutdownController.abort();
    this.partitions.clear();
  }

  private makeRoomIfNeeded(): void {
    if (this.partitions.size < this.maxPartitions) return;
    const safe = [...this.partitions.values()]
      .filter(partition => partition.references === 0
        && partition.activeOperations === 0
        && partition.semaphore.isIdle
        && partition.resilience.state === 'closed')
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.lastUsedOrder - right.lastUsedOrder)[0];
    if (safe === undefined) throw new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'partition_capacity_exceeded');
    this.partitions.delete(safe.key);
    safe.semaphore.shutdown();
  }

  private touch(partition: Partition): void {
    partition.lastUsedAt = this.now();
    partition.lastUsedOrder = ++this.useOrder;
  }
}

class AsyncSemaphore {
  private active = 0;
  private closed = false;
  private readonly waiters: SemaphoreWaiter[] = [];

  public constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
    private readonly now: () => number,
    private readonly scheduleTimeout: TargetSourceTimeoutScheduler,
  ) {}

  public get isIdle(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  public acquire(signal: AbortSignal, deadline: number): Promise<() => void> {
    if (this.closed) return Promise.reject(new TargetSourcePartitionRegistryError('ABORTED', 'registry_closed'));
    if (signal.aborted) return Promise.reject(new TargetSourcePartitionRegistryError('ABORTED', 'caller_aborted'));
    if (!Number.isFinite(deadline) || this.now() >= deadline) {
      return Promise.reject(new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'deadline_expired'));
    }
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'queue_capacity_exceeded'));
    }

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal, deadline, resolve, reject, onAbort: () => undefined, cancelTimeout: undefined,
      };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        this.cleanup(waiter);
        reject(new TargetSourcePartitionRegistryError('ABORTED', 'caller_aborted'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      try {
        this.scheduleExpiry(waiter);
        this.drain();
      } catch (error) {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.cleanup(waiter);
        reject(error instanceof Error ? error : new Error('Target source deadline scheduler failed.'));
      }
    });
  }

  public shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(new TargetSourcePartitionRegistryError('ABORTED', 'registry_closed'));
    }
  }

  private drain(): void {
    while (!this.closed && this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.cleanup(waiter);
      if (waiter.signal.aborted) {
        waiter.reject(new TargetSourcePartitionRegistryError('ABORTED', 'caller_aborted'));
        continue;
      }
      if (this.now() >= waiter.deadline) {
        waiter.reject(new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'deadline_expired'));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }

  private scheduleExpiry(waiter: SemaphoreWaiter): void {
    const delayMs = Math.min(2_147_483_647, Math.max(0, waiter.deadline - this.now()));
    waiter.cancelTimeout = this.scheduleTimeout(() => {
      waiter.cancelTimeout = undefined;
      const index = this.waiters.indexOf(waiter);
      if (index < 0) return;
      if (this.now() < waiter.deadline) {
        this.scheduleExpiry(waiter);
        return;
      }
      this.waiters.splice(index, 1);
      this.cleanup(waiter);
      waiter.reject(new TargetSourcePartitionRegistryError('BUDGET_EXCEEDED', 'deadline_expired'));
      this.drain();
    }, delayMs);
  }

  private cleanup(waiter: SemaphoreWaiter): void {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.cancelTimeout?.();
    waiter.cancelTimeout = undefined;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }
}

interface SemaphoreWaiter {
  signal: AbortSignal;
  deadline: number;
  resolve: (release: () => void) => void;
  reject: (error: TargetSourcePartitionRegistryError) => void;
  onAbort: () => void;
  cancelTimeout: (() => void) | undefined;
}
