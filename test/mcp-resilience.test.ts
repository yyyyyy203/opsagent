import { describe, expect, it } from 'vitest';
import { TargetConfigurationError } from '../src/contracts/target.js';
import type { TargetOperationGuard, TargetOperationPermit } from '../src/contracts/target.js';
import { SourceCircuitBreaker, ResilientExecutor, SourceFailure } from '../src/mcp/resilience.js';

const options = () => ({ signal: new AbortController().signal, deadline: Date.now() + 5_000 });

describe('source retry and circuit policies', () => {
  it('opens after three failed logical operations using the default threshold', async () => {
    const now = 0;
    const clock = () => now;
    const breaker = new SourceCircuitBreaker({ now: clock });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0, now: clock });
    const failOperation = () => executor.execute(
      () => Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')),
      { signal: new AbortController().signal, deadline: 60_000, now: clock },
    );

    await expect(failOperation()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    expect(breaker.state).toBe('closed');
    await expect(failOperation()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    expect(breaker.state).toBe('closed');
    await expect(failOperation()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    expect(breaker.state).toBe('open');
  });

  it('keeps the default circuit open for 30 seconds then admits only one recovery probe', async () => {
    let now = 0;
    const clock = () => now;
    const breaker = new SourceCircuitBreaker({ now: clock });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0, now: clock });
    const failOperation = () => executor.execute(
      () => Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')),
      { signal: new AbortController().signal, deadline: 60_000, now: clock },
    );
    for (let failure = 0; failure < 3; failure += 1) await expect(failOperation()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });

    now = 29_999;
    let calls = 0;
    await expect(executor.execute(
      () => { calls += 1; return Promise.resolve('too early'); },
      { signal: new AbortController().signal, deadline: 60_000, now: clock },
    )).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(calls).toBe(0);

    now = 30_000;
    let releaseProbe: (value: string) => void = () => { throw new Error('probe was not started'); };
    const probe = executor.execute(
      () => new Promise<string>((resolve) => { releaseProbe = resolve; }),
      { signal: new AbortController().signal, deadline: 60_000, now: clock },
    );
    await expect(executor.execute(
      () => { calls += 1; return Promise.resolve('second probe'); },
      { signal: new AbortController().signal, deadline: 60_000, now: clock },
    )).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(calls).toBe(0);

    releaseProbe('recovered');
    await expect(probe).resolves.toBe('recovered');
    expect(breaker.state).toBe('closed');
  });

  it('does not retry a failed probe and restarts the full cooldown when that probe finishes', async () => {
    let now = 0;
    let calls = 0;
    const clock = () => now;
    const breaker = new SourceCircuitBreaker({ now: clock });
    const executor = new ResilientExecutor(breaker, { now: clock, sleep: () => Promise.resolve() });
    const executionOptions = { signal: new AbortController().signal, deadline: 90_000, now: clock };
    const fail = () => {
      calls += 1;
      return Promise.reject(new SourceFailure('MCP_SERVER_ERROR'));
    };
    for (let failure = 0; failure < 3; failure += 1) {
      await expect(executor.execute(fail, executionOptions)).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    }
    expect(calls).toBe(9);

    now = 30_000;
    const probeEvents: unknown[] = [];
    const probeAttempts: unknown[] = [];
    await expect(executor.execute(() => {
      now += 500;
      return fail();
    }, {
      ...executionOptions,
      onCircuitEvent: (event) => probeEvents.push(event),
      onEvent: (event) => probeAttempts.push(event),
    })).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    expect(calls).toBe(10);
    expect(breaker.state).toBe('open');
    expect(probeAttempts).toEqual([
      { type: 'attempt', attempt: 1 },
      { type: 'failure', attempt: 1, code: 'MCP_SERVER_ERROR' },
    ]);
    expect(probeEvents).toEqual([
      { type: 'half_opened' },
      { type: 'opened', openUntil: 60_500, failureWindow: { failures: 3, windowMs: 30_500 } },
    ]);

    const recover = () => { calls += 1; return Promise.resolve('recovered evidence'); };
    now = 60_499;
    await expect(executor.execute(recover, executionOptions)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(calls).toBe(10);
    now = 60_500;
    const recoveryEvents: unknown[] = [];
    await expect(executor.execute(recover, {
      ...executionOptions, onCircuitEvent: (event) => recoveryEvents.push(event),
    })).resolves.toBe('recovered evidence');
    expect(calls).toBe(11);
    expect(breaker.state).toBe('closed');
    expect(recoveryEvents).toEqual([{ type: 'half_opened' }, { type: 'closed' }]);
  });

  it('reports retry and circuit transitions to the operation that caused them', async () => {
    let now = 1_000;
    const clock = () => now;
    const breaker = new SourceCircuitBreaker({ now: clock });
    const executor = new ResilientExecutor(breaker, {
      maxRetries: 0,
      now: clock,
    });
    const firstOperationEvents: unknown[] = [];
    const fail = () => executor.execute(
      () => {
        now += 10;
        return Promise.reject(new SourceFailure('MCP_SERVER_ERROR'));
      },
      {
        signal: new AbortController().signal,
        deadline: 60_000,
        now: clock,
        onCircuitEvent: (event) => firstOperationEvents.push(event),
      },
    );

    await expect(fail()).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    await expect(fail()).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    await expect(fail()).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    expect(firstOperationEvents).toEqual([
      { type: 'opened', failureWindow: { failures: 3, windowMs: 20 }, openUntil: 31_030 },
    ]);

    now = 31_030;
    const recoveryEvents: unknown[] = [];
    await executor.execute(() => Promise.resolve('recovered'), {
      signal: new AbortController().signal,
      deadline: 60_000,
      now: clock,
      onCircuitEvent: (event) => recoveryEvents.push(event),
    });
    expect(recoveryEvents).toEqual([{ type: 'half_opened' }, { type: 'closed' }]);
    expect(firstOperationEvents).toHaveLength(1);
  });

  it('does not retry before a Retry-After interval exceeding the configured wait cap', async () => {
    let calls = 0;
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() });
    await expect(executor.execute(() => { calls += 1; return Promise.reject(new SourceFailure('MCP_RATE_LIMITED', 10_000)); }, options())).rejects.toMatchObject({ code: 'MCP_RATE_LIMITED' });
    expect(calls).toBe(1);
  });

  it('uses a shared attempt budget without refilling it for another logical call', async () => {
    let calls = 0;
    const budget = { remaining: 1 };
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() });
    await expect(executor.execute(() => { calls += 1; return Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')); }, { ...options(), attemptBudget: budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(executor.execute(() => { calls += 1; return Promise.resolve('bad'); }, { ...options(), attemptBudget: budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(calls).toBe(1);
  });

  it('does not let an older parallel success close a newly opened circuit', async () => {
    const breaker = new SourceCircuitBreaker({ threshold: 1 });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0 });
    let release: (value: string) => void = () => {};
    const old = executor.execute(() => new Promise<string>((resolve) => { release = resolve; }), options());
    await expect(executor.execute(() => Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')), options())).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    release('late success');
    await old;
    expect(breaker.state).toBe('open');
  });

  it('retries transient failures twice and records attempts without retrying business failures', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { random: () => 1, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    const result = await executor.execute(() => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new SourceFailure('MCP_NETWORK_ERROR'));
      return Promise.resolve('evidence');
    }, options());
    expect(result).toBe('evidence');
    expect(attempts).toBe(3);
    expect(waits).toEqual([200, 400]);
    attempts = 0;
    await expect(executor.execute(() => { attempts += 1; return Promise.reject(new SourceFailure('MCP_AUTH_ERROR')); }, options())).rejects.toMatchObject({ code: 'MCP_AUTH_ERROR' });
    expect(attempts).toBe(1);
  });

  it('publishes integer retry delays even when jitter produces fractional milliseconds', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retryEvents: Array<{ attempt: number; delayMs?: number }> = [];
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), {
      random: () => 1 / 3,
      sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
    });
    await executor.execute(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new SourceFailure('MCP_NETWORK_ERROR'))
        : Promise.resolve('recovered');
    }, { ...options(), onEvent: (event) => { if (event.type === 'retry') retryEvents.push(event); } });

    expect(delays).toEqual([67]);
    expect(retryEvents).toEqual([{ type: 'retry', attempt: 1, code: 'MCP_NETWORK_ERROR', delayMs: 67 }]);
  });

  it('opens after source failures and admits only one half-open probe', async () => {
    let now = 0;
    const breaker = new SourceCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0, now: () => now });
    await expect(executor.execute(() => Promise.reject(new SourceFailure('MCP_SERVER_ERROR')), { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    expect(breaker.state).toBe('open');
    let calls = 0;
    await expect(executor.execute(() => { calls += 1; return Promise.resolve('bad'); }, { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(calls).toBe(0);
    now = 11;
    let release: (value: string) => void = () => { throw new Error('probe not started'); };
    const probe = executor.execute(() => new Promise<string>((resolve) => { release = resolve; }), { ...options(), deadline: 100 });
    await expect(executor.execute(() => Promise.resolve('second'), { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    release('healthy');
    expect(await probe).toBe('healthy');
    expect(breaker.state).toBe('closed');
  });

  it('cancels a hung attempt and never starts a retry after parent cancellation', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let attempts = 0;
    const executor = new ResilientExecutor(new SourceCircuitBreaker());
    const result = executor.execute((signal) => { attempts += 1; childSignal = signal; return new Promise<string>(() => {}); }, { ...options(), signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    expect(childSignal?.aborted).toBe(true);
    expect(attempts).toBe(1);
  });

  it('enforces attempt timeout even when the operation ignores AbortSignal', async () => {
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { timeoutMs: 10, maxRetries: 0 });
    await expect(executor.execute(() => new Promise<string>(() => {}), options())).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
  });

  it('rejects exhausted deadlines before opening a network operation', async () => {
    let called = false;
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { now: () => 100 });
    await expect(executor.execute(() => { called = true; return Promise.resolve('bad'); }, { ...options(), deadline: 99 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(called).toBe(false);
  });

  it('cancels a source retry delay when its Target permit is revoked without counting a source failure', async () => {
    const permitController = new AbortController();
    const callerController = new AbortController();
    const permit: TargetOperationPermit = {
      bindingId: 'binding-1', runId: 'run-1', rootRunId: 'run-1', snapshotDigest: 'snapshot-1',
      operation: 'source', capability: 'metrics-source', policyEpoch: 1, signal: permitController.signal,
    };
    const targetOperations: TargetOperationGuard = { authorize: async () => permit, validate: async () => {} };
    let calls = 0;
    let resolveSleepStarted: () => void = () => {};
    const sleepStarted = new Promise<void>(resolve => { resolveSleepStarted = resolve; });
    const breaker = new SourceCircuitBreaker();
    const executor = new ResilientExecutor(breaker, {
      maxRetries: 1,
      sleep: (_delay, signal) => new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason instanceof Error ? signal.reason : new SourceFailure('ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        resolveSleepStarted();
      }),
    });
    const execution = executor.execute(() => {
      calls += 1;
      return Promise.reject(new SourceFailure('MCP_NETWORK_ERROR'));
    }, {
      signal: callerController.signal,
      deadline: Date.now() + 5_000,
      targetOperations,
      targetCapability: 'metrics-source',
    });
    await sleepStarted;
    permitController.abort(new TargetConfigurationError('TARGET_OPERATION_DENIED'));
    const outcome = await Promise.race([
      execution.then(() => 'settled', () => 'rejected'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);
    if (outcome === 'pending') callerController.abort(new TargetConfigurationError('TARGET_OPERATION_DENIED'));
    await expect(execution).rejects.toMatchObject({ code: 'TARGET_OPERATION_DENIED' });
    expect(outcome).toBe('rejected');
    expect(calls).toBe(1);
    expect(breaker.state).toBe('closed');
  });
});
