import type { AgentContext, AgentEvent, CheckpointStore } from '../contracts/index.js';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../contracts/common.js';
import type { TargetStartClaim, TargetStartRequestIdentity, TargetStartStore } from '../contracts/target.js';
import { USER_RUN_CANCELLATION_REASON } from '../agent/types.js';
import type { DiagnosisAgent, ReplyOptions } from '../agent/types.js';

export type RunExecutionErrorCode = 'RUN_ID_REQUIRED' | 'RUN_NOT_FOUND' | 'RUN_CONFLICT' | 'RUN_START_STATE_UNKNOWN';

export interface RunExecutionCoordinatorOptions {
  prepareStart?: (options: ReplyOptions) => ReplyOptions;
  afterTerminal?: (runId: string) => Promise<void>;
  targetStarts?: TargetStartStore;
  clock?: Clock;
  ids?: IdGenerator;
  targetStartLeaseMs?: number;
}

/** Stable command error exposed by the local HTTP adapter. */
export class RunExecutionError extends Error {
  public constructor(
    public readonly code: RunExecutionErrorCode,
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'RunExecutionError';
  }
}

/** Coordinates one in-process execution per Run ID and owns generator draining. */
export class RunExecutionCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly startedRuns = new Set<string>();
  private readonly startAcceptance = new Map<string, Promise<void>>();
  /** Retained after completion so an uncertain accepted request cannot be replayed by another tab. */
  private readonly accepted = new Set<string>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private ownerId: string | undefined;
  private readonly targetStartLeaseMs: number;
  private closing = false;

  public constructor(
    private readonly agent: DiagnosisAgent,
    private readonly checkpoints: Pick<CheckpointStore, 'load'>,
    private readonly options: RunExecutionCoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
    this.targetStartLeaseMs = options.targetStartLeaseMs ?? 60_000;
  }

  public start(options: ReplyOptions): Promise<void> {
    if (options.trustedTargetBinding !== undefined) {
      return Promise.reject(new RunExecutionError(
        'RUN_START_STATE_UNKNOWN',
        'Target-bound Runs must use the durable accepted-start path.',
        409,
      ));
    }
    return this.startInternal(options);
  }

  /** Starts a Run and resolves only after its first RUN_STARTED event is yielded. */
  public startAccepted(options: ReplyOptions): Promise<void> {
    if (this.closing) return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Runtime is shutting down.', 409));
    const runId = options.runId;
    if (runId === undefined || runId.length === 0) {
      return Promise.reject(new RunExecutionError('RUN_ID_REQUIRED', 'runId is required.', 400));
    }
    if (this.startedRuns.has(runId)) return Promise.resolve();
    const pendingAcceptance = this.startAcceptance.get(runId);
    if (pendingAcceptance !== undefined) return pendingAcceptance;
    if (this.active.has(runId) || this.accepted.has(runId)) {
      return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Run acceptance is already in progress or uncertain.', 409));
    }
    if (options.trustedTargetBinding !== undefined) return this.startAcceptedTarget(options, runId);

    let resolveAcceptance!: () => void;
    let rejectAcceptance!: (error: unknown) => void;
    let settled = false;
    const acceptance = new Promise<void>((resolve, reject) => {
      resolveAcceptance = resolve;
      rejectAcceptance = reject;
    });
    this.startAcceptance.set(runId, acceptance);
    const completion = this.startInternal(options, (event) => {
      if (event.type !== 'RUN_STARTED') throw new RunExecutionError('RUN_CONFLICT', 'Run failed before its initial transition.', 409);
      settled = true;
      rememberBounded(this.startedRuns, runId);
      resolveAcceptance();
    });
    void completion.then(() => {
      if (!settled) {
        settled = true;
        rejectAcceptance(new RunExecutionError('RUN_CONFLICT', 'Run ended before its initial transition.', 409));
      }
    }, async (error: unknown) => {
      if (!settled) {
        let checkpoint: AgentContext | null = null;
        let checkpointReadConfirmed = false;
        try {
          checkpoint = await this.checkpoints.load(runId);
          checkpointReadConfirmed = true;
        } catch {
          // Keep the Run ID reserved if the durable state cannot establish that no transition committed.
        }
        if (checkpointReadConfirmed && checkpoint === null) this.accepted.delete(runId);
        settled = true;
        if (this.startAcceptance.get(runId) === acceptance) this.startAcceptance.delete(runId);
        rejectAcceptance(error);
      }
    }).finally(() => {
      if (this.startAcceptance.get(runId) === acceptance) this.startAcceptance.delete(runId);
    }).catch(() => undefined);
    return acceptance;
  }

  private startAcceptedTarget(options: ReplyOptions, runId: string): Promise<void> {
    const starts = this.options.targetStarts;
    const binding = options.trustedTargetBinding?.binding;
    if (starts === undefined || binding === undefined || binding.runId !== runId || binding.rootRunId !== runId
      || binding.requestId === undefined || binding.requestDigest === undefined) {
      return Promise.reject(new RunExecutionError('RUN_START_STATE_UNKNOWN', 'Target Run start state is unavailable.', 409));
    }
    const identity: TargetStartRequestIdentity = { requestId: binding.requestId, runId,
      targetId: binding.targetId, requestDigest: binding.requestDigest };
    let resolveAcceptance!: () => void;
    let rejectAcceptance!: (error: unknown) => void;
    let settled = false;
    let claim: TargetStartClaim | undefined;
    const acceptance = new Promise<void>((resolve, reject) => {
      resolveAcceptance = resolve;
      rejectAcceptance = reject;
    });
    this.startAcceptance.set(runId, acceptance);

    const work = (async (): Promise<void> => {
      try {
        const now = this.clock.now();
        if (!Number.isSafeInteger(this.targetStartLeaseMs) || this.targetStartLeaseMs <= 0) {
          throw new RunExecutionError('RUN_START_STATE_UNKNOWN', 'Target Run start state is unavailable.', 409);
        }
        let result;
        try {
          this.ownerId ??= this.ids.next('target_start_owner');
          result = await starts.claimStart({ ...identity, ownerId: this.ownerId,
            now: now.toISOString(), leaseUntil: new Date(now.getTime() + this.targetStartLeaseMs).toISOString() });
        } catch {
          throw new RunExecutionError('RUN_START_STATE_UNKNOWN', 'Target Run start state is unavailable.', 409);
        }
        if (result.status === 'busy') throw new RunExecutionError('RUN_CONFLICT', 'Target Run is being started by another owner.', 409);
        if (result.status === 'unknown') throw new RunExecutionError('RUN_START_STATE_UNKNOWN', 'Target Run start state is unavailable.', 409);
        if (result.status === 'already_started') {
          rememberBounded(this.accepted, runId);
          rememberBounded(this.startedRuns, runId);
          settled = true;
          resolveAcceptance();
          return;
        }
        claim = result.claim;
        const trustedTargetBinding = { ...options.trustedTargetBinding!, startClaim: claim };
        await this.startInternal({ ...options, trustedTargetBinding }, (event) => {
          if (event.type !== 'RUN_STARTED') {
            throw new RunExecutionError('RUN_CONFLICT', 'Run failed before its initial transition.', 409);
          }
          settled = true;
          rememberBounded(this.startedRuns, runId);
          resolveAcceptance();
        });
        if (!settled) await this.rejectAfterTargetStartFailure(identity, claim, runId, resolveAcceptance, rejectAcceptance);
      } catch (error) {
        if (!settled) {
          if (claim !== undefined) {
            await this.rejectAfterTargetStartFailure(identity, claim, runId, resolveAcceptance, rejectAcceptance);
          } else {
            settled = true;
            rejectAcceptance(error);
          }
        }
      } finally {
        if (this.startAcceptance.get(runId) === acceptance) this.startAcceptance.delete(runId);
      }
    })();
    void work.catch(() => undefined);
    return acceptance;
  }

  private async rejectAfterTargetStartFailure(
    identity: TargetStartRequestIdentity,
    claim: TargetStartClaim,
    runId: string,
    resolveAcceptance: () => void,
    rejectAcceptance: (error: unknown) => void,
  ): Promise<void> {
    const starts = this.options.targetStarts;
    let released = false;
    try {
      released = await starts?.releaseStartClaim({ claim, now: this.clock.now().toISOString() }) ?? false;
    } catch {
      // A failed release cannot establish absence; continue to explicit reconciliation.
    }
    let status: 'confirmed_absent' | 'confirmed_present' | 'unknown' = released ? 'confirmed_absent' : 'unknown';
    if (!released) {
      try {
        status = (await starts?.reconcileStart(identity))?.status ?? 'unknown';
      } catch {
        status = 'unknown';
      }
    }
    if (status === 'confirmed_present') {
      rememberBounded(this.accepted, runId);
      rememberBounded(this.startedRuns, runId);
      resolveAcceptance();
      return;
    }
    if (status === 'confirmed_absent') {
      this.accepted.delete(runId);
      rejectAcceptance(new RunExecutionError('RUN_CONFLICT',
        'Run did not commit its initial transition. Retry with the same request ID only while the resolved Target snapshot is unchanged; if it changed, submit a new request ID.', 409));
      return;
    }
    rememberBounded(this.accepted, runId);
    rejectAcceptance(new RunExecutionError('RUN_START_STATE_UNKNOWN', 'Target Run start state is unknown; do not retry with a new request ID.', 409));
  }

  private startInternal(options: ReplyOptions, onFirstEvent?: (event: AgentEvent) => void): Promise<void> {
    if (this.closing) return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Runtime is shutting down.', 409));
    const runId = options.runId;
    if (runId === undefined || runId.length === 0) {
      return Promise.reject(new RunExecutionError('RUN_ID_REQUIRED', 'runId is required.', 400));
    }
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing;
    if (this.accepted.has(runId)) {
      return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Run ID has already been accepted.', 409));
    }
    rememberBounded(this.accepted, runId);
    return this.claim(runId, async (signal) => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint !== null) {
        throw new RunExecutionError('RUN_CONFLICT', 'Run already exists and cannot be started again.', 409);
      }
      const preparedOptions = this.prepareStart(options);
      await this.drain(this.agent.replyStream({ ...preparedOptions, signal }), onFirstEvent);
      await this.afterTerminal(runId);
    }, options.signal);
  }

  public resume(runId: string, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Runtime is shutting down.', 409));
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing;
    return this.claim(runId, async (runSignal) => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint === null) throw new RunExecutionError('RUN_NOT_FOUND', 'Run not found.', 404);
      if (isTerminal(checkpoint.status)) {
        throw new RunExecutionError('RUN_CONFLICT', 'Terminal Runs cannot be resumed.', 409);
      }
      if (checkpoint.status === 'awaiting_confirmation') {
        throw new RunExecutionError('RUN_CONFLICT', 'Resolve the pending confirmation before resuming.', 409);
      }
      await this.drain(this.agent.resumeStream(runId, runSignal));
      await this.afterTerminal(runId);
    }, signal);
  }

  /** Abort only work currently owned by this in-process coordinator. */
  public async cancel(runId: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (controller !== undefined) {
      controller.abort(USER_RUN_CANCELLATION_REASON);
      return;
    }
    const checkpoint = await this.checkpoints.load(runId);
    if (checkpoint === null) throw new RunExecutionError('RUN_NOT_FOUND', 'Run not found.', 404);
    throw new RunExecutionError('RUN_CONFLICT', 'Run is not actively executing and cannot be cancelled.', 409);
  }

  public isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Stop accepting new work and wait until accepted Runs have reached a checkpoint or terminal state. */
  public async close(): Promise<void> {
    this.closing = true;
    while (this.active.size > 0 || this.startAcceptance.size > 0) {
      await Promise.allSettled([...this.active.values(), ...this.startAcceptance.values()]);
    }
  }

  private prepareStart(options: ReplyOptions): ReplyOptions {
    if (this.options.prepareStart === undefined) return options;
    const prepared = this.options.prepareStart({
      ...options,
      ...(options.toolCallBudget === undefined ? {} : { toolCallBudget: { ...options.toolCallBudget } }),
      ...(options.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: { ...options.networkAttemptBudget } }),
    });
    if (prepared.runId !== options.runId
      || prepared.profileId !== options.profileId
      || prepared.message !== options.message
      || prepared.sessionId !== options.sessionId
      || prepared.replyId !== options.replyId) {
      throw new RunExecutionError('RUN_CONFLICT', 'prepareStart cannot change Run identity.', 409);
    }
    return prepared;
  }

  private claim(runId: string, action: (signal: AbortSignal) => Promise<void>, upstreamSignal?: AbortSignal): Promise<void> {
    const current = this.active.get(runId);
    if (current !== undefined) return current;
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) relayAbort();
    else upstreamSignal?.addEventListener('abort', relayAbort, { once: true });
    const taskRef: { value?: Promise<void> } = {};
    const task = (async () => {
      try {
        await action(controller.signal);
      } finally {
        upstreamSignal?.removeEventListener('abort', relayAbort);
        if (this.active.get(runId) === taskRef.value) {
          this.active.delete(runId);
          this.controllers.delete(runId);
        }
      }
    })();
    taskRef.value = task;
    this.active.set(runId, task);
    this.controllers.set(runId, controller);
    return task;
  }

  private async drain(stream: AsyncGenerator<AgentEvent, unknown>, onFirstEvent?: (event: AgentEvent) => void): Promise<void> {
    let first = true;
    let completed = false;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          completed = true;
          return;
        }
        if (first) {
          first = false;
          onFirstEvent?.(item.value);
        }
      }
    } finally {
      if (!completed) await stream.return(undefined as never).catch(() => undefined);
    }
  }

  private async afterTerminal(runId: string): Promise<void> {
    if (this.options.afterTerminal === undefined) return;
    const checkpoint = await this.checkpoints.load(runId);
    if (checkpoint !== null && isTerminal(checkpoint.status)) await this.options.afterTerminal(runId);
  }
}

function isTerminal(status: AgentContext['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function rememberBounded(values: Set<string>, value: string, limit = 10_000): void {
  if (values.has(value)) values.delete(value);
  else if (values.size >= limit) {
    const oldest = values.values().next().value;
    if (oldest !== undefined) values.delete(oldest);
  }
  values.add(value);
}
