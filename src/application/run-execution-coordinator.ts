import type { AgentContext, AgentEvent, CheckpointStore } from '../contracts/index.js';
import { USER_RUN_CANCELLATION_REASON } from '../agent/types.js';
import type { DiagnosisAgent, ReplyOptions } from '../agent/types.js';

export type RunExecutionErrorCode = 'RUN_ID_REQUIRED' | 'RUN_NOT_FOUND' | 'RUN_CONFLICT';

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
  private closing = false;

  public constructor(
    private readonly agent: DiagnosisAgent,
    private readonly checkpoints: Pick<CheckpointStore, 'load'>,
    private readonly options: { prepareStart?: (options: ReplyOptions) => ReplyOptions;
      afterTerminal?: (runId: string) => Promise<void> } = {},
  ) {}

  public start(options: ReplyOptions): Promise<void> {
    return this.startInternal(options);
  }

  /** Starts a Run and resolves only after its first RUN_STARTED event is yielded. */
  public startAccepted(options: ReplyOptions): Promise<void> {
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
      this.startedRuns.add(runId);
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
        try {
          checkpoint = await this.checkpoints.load(runId);
        } catch {
          // Keep the Run ID reserved if the durable state cannot establish that no transition committed.
        }
        if (checkpoint === null) this.accepted.delete(runId);
        settled = true;
        if (this.startAcceptance.get(runId) === acceptance) this.startAcceptance.delete(runId);
        rejectAcceptance(error);
      }
    }).finally(() => {
      if (this.startAcceptance.get(runId) === acceptance) this.startAcceptance.delete(runId);
    }).catch(() => undefined);
    return acceptance;
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
    this.accepted.add(runId);
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
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
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
