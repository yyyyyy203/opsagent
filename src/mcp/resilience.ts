import type { AgentErrorCode } from '../contracts/errors.js';
import type { TargetOperationGuard, TargetOperationPermit } from '../contracts/target.js';
import { TargetConfigurationError } from '../contracts/target.js';

const transient = new Set<AgentErrorCode>(['MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED', 'MCP_SERVER_ERROR']);

export class SourceFailure extends Error {
  public readonly retryable: boolean;
  public constructor(public readonly code: AgentErrorCode, public readonly retryAfterMs?: number) {
    super(`Source operation failed: ${code}`);
    this.name = 'SourceFailure';
    this.retryable = transient.has(code);
  }
}

type Permit = { epoch: number; probe: boolean; onEvent?: (event: CircuitStateEvent) => void };
export type CircuitStateEvent =
  | { type: 'opened'; openUntil: number; failureWindow: { failures: number; windowMs: number } }
  | { type: 'half_opened' }
  | { type: 'closed' };
export class SourceCircuitBreaker {
  private failures = 0;
  private failureWindowStartedAt: number | undefined;
  private openedAt = 0;
  private epoch = 0;
  private status: 'closed' | 'open' | 'half_open' = 'closed';
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  public constructor(options: { threshold?: number; cooldownMs?: number; now?: () => number; onEvent?: (event: CircuitStateEvent) => void } = {}) {
    this.threshold = options.threshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || !Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) throw new Error('Invalid circuit configuration.');
  }
  private readonly onEvent: ((event: CircuitStateEvent) => void) | undefined;
  public get state() { return this.status; }

  public acquire(onEvent?: (event: CircuitStateEvent) => void): Permit {
    if (this.status === 'half_open') throw new SourceFailure('CIRCUIT_OPEN');
    if (this.status === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) throw new SourceFailure('CIRCUIT_OPEN');
      this.status = 'half_open';
      this.emit({ type: 'half_opened' }, onEvent);
    }
    return { epoch: this.epoch, probe: this.status === 'half_open', ...(onEvent === undefined ? {} : { onEvent }) };
  }

  public finish(permit: Permit, outcome: 'success' | 'failure' | 'cancelled'): void {
    // A stale parallel success must not close a circuit opened by another operation.
    if (permit.epoch !== this.epoch) return;
    if (outcome === 'success') {
      this.failures = 0;
      this.failureWindowStartedAt = undefined;
      if (permit.probe) { this.status = 'closed'; this.epoch += 1; this.emit({ type: 'closed' }, permit.onEvent); }
    } else if (outcome === 'failure') {
      const failedAt = this.now();
      if (this.failureWindowStartedAt === undefined) this.failureWindowStartedAt = failedAt;
      if (!permit.probe) this.failures += 1;
      if (permit.probe || this.failures >= this.threshold) {
        this.status = 'open'; this.openedAt = failedAt; this.epoch += 1;
        this.emit({
          type: 'opened',
          openUntil: this.openedAt + this.cooldownMs,
          failureWindow: { failures: this.failures, windowMs: Math.max(0, failedAt - this.failureWindowStartedAt) },
        }, permit.onEvent);
      }
    } else if (permit.probe) {
      // Release the single-probe lease without treating caller cancellation as
      // a source failure or leaving the circuit permanently half-open.
      this.status = 'open';
      this.openedAt = this.now() - this.cooldownMs;
      this.epoch += 1;
    }
  }

  private emit(event: CircuitStateEvent, onEvent?: (event: CircuitStateEvent) => void): void {
    this.onEvent?.(event);
    onEvent?.(event);
  }
}

export interface RetryEvent {
  type: 'attempt' | 'retry' | 'success' | 'failure';
  attempt: number;
  code?: AgentErrorCode;
  delayMs?: number;
}

export interface ResilienceOptions {
  maxRetries?: number;
  timeoutMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ExecutionDeadline {
  signal: AbortSignal;
  deadline: number;
  /** Optional per-call clock for injected runtimes and deterministic tests. */
  now?: () => number;
  attemptBudget?: { remaining: number };
  onEvent?: (event: RetryEvent) => void;
  /** Run-scoped observer; never stored on the shared source executor. */
  onCircuitEvent?: (event: CircuitStateEvent) => void;
  /** Optional Target gate, checked for each external attempt including retries and probes. */
  targetOperations?: TargetOperationGuard;
  /** Exact host-bound source ID from the immutable Target snapshot. */
  targetCapability?: string;
}

export class ResilientExecutor {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  public constructor(private readonly circuit: SourceCircuitBreaker, options: ResilienceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? delay;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 2 || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid retry configuration.');
  }

  public async execute<T>(operation: (signal: AbortSignal) => Promise<T>, options: ExecutionDeadline): Promise<T> {
    const now = options.now ?? this.now;
    this.check(options, now);
    const circuitPermit = this.circuit.acquire(options.onCircuitEvent);
    let sawSourceFailure = false;
    try {
      for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
        this.check(options, now);
        let operationPermit: TargetOperationPermit | undefined;
        if (options.targetOperations !== undefined) {
          try {
            operationPermit = await options.targetOperations.authorize({
              operation: 'source',
              capability: options.targetCapability ?? 'source',
              signal: options.signal,
            });
          } catch (error) {
            throw targetDenied(error);
          }
        }
        if (options.attemptBudget) {
          if (options.attemptBudget.remaining <= 0) throw new SourceFailure('BUDGET_EXCEEDED');
          options.attemptBudget.remaining -= 1;
        }
        options.onEvent?.({ type: 'attempt', attempt });
        const operationSignal = operationPermit === undefined
          ? options.signal
          : AbortSignal.any([options.signal, operationPermit.signal]);
        try {
          const result = await bounded(operation, operationSignal, Math.min(this.timeoutMs, options.deadline - now()));
          if (operationPermit !== undefined) {
            try {
              await options.targetOperations!.validate(operationPermit, options.signal);
            } catch (error) {
              throw targetDenied(error);
            }
          }
          this.circuit.finish(circuitPermit, 'success');
          options.onEvent?.({ type: 'success', attempt });
          return result;
        } catch (error) {
          if (isTargetOperationDenied(error) || operationPermit?.signal.aborted === true) {
            throw targetDenied(error);
          }
          const failure = options.signal.aborted ? new SourceFailure('ABORTED') : error instanceof SourceFailure ? error : new SourceFailure('MCP_PROTOCOL_ERROR');
          sawSourceFailure ||= failure.retryable;
          if (!failure.retryable || attempt > this.maxRetries || circuitPermit.probe) {
            options.onEvent?.({ type: 'failure', attempt, code: failure.code });
            throw failure;
          }
          const jitter = Math.max(0, Math.min(1, this.random()));
          // Do not truncate a server's lower bound and retry earlier than requested.
          if ((failure.retryAfterMs ?? 0) > 2_000) throw failure;
          const delayMs = Math.ceil(Math.min(2_000, Math.max(200 * 2 ** (attempt - 1) * jitter, failure.retryAfterMs ?? 0)));
          if (now() + delayMs >= options.deadline) throw new SourceFailure('BUDGET_EXCEEDED');
          options.onEvent?.({ type: 'retry', attempt, code: failure.code, delayMs });
          await this.sleep(delayMs, operationSignal);
        }
      }
      throw new SourceFailure('BUDGET_EXCEEDED');
    } catch (error) {
      const targetDeniedByPolicy = isTargetOperationDenied(error);
      const cancelled = targetDeniedByPolicy || (error instanceof SourceFailure
        && (error.code === 'ABORTED' || (error.code === 'BUDGET_EXCEEDED' && !sawSourceFailure)));
      this.circuit.finish(circuitPermit, cancelled ? 'cancelled' : sawSourceFailure ? 'failure' : 'success');
      throw error;
    }
  }

  private check(options: ExecutionDeadline, now: () => number): void {
    if (options.signal.aborted) throw new SourceFailure('ABORTED');
    if (!Number.isFinite(options.deadline) || now() >= options.deadline) throw new SourceFailure('BUDGET_EXCEEDED');
  }
}

function targetDenied(error: unknown): TargetConfigurationError {
  return error instanceof TargetConfigurationError && error.code === 'TARGET_OPERATION_DENIED'
    ? error
    : new TargetConfigurationError('TARGET_OPERATION_DENIED');
}

function isTargetOperationDenied(error: unknown): boolean {
  return error instanceof TargetConfigurationError && error.code === 'TARGET_OPERATION_DENIED';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SourceFailure('ABORTED')); return; }
    const abort = () => { clearTimeout(timer); reject(new SourceFailure('ABORTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  const child = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const result = new Promise<T>((resolve, reject) => {
    abort = () => { reject(new SourceFailure('ABORTED')); child.abort(); };
    if (parent.aborted) { abort(); return; }
    parent.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { reject(new SourceFailure('MCP_TIMEOUT')); child.abort(); }, timeoutMs);
    try { operation(child.signal).then(resolve, reject); }
    catch (error) { reject(error instanceof Error ? error : new SourceFailure('MCP_PROTOCOL_ERROR')); }
  });
  return result.finally(() => { clearTimeout(timer); parent.removeEventListener('abort', abort); });
}
