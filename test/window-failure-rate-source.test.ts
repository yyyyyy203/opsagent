import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as prometheus from '../src/infrastructure/prometheus/index.js';
import { multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { parseTargetCatalog } from '../src/profiles/target-catalog-schema.js';
import type { WindowFreshnessPolicy } from '../src/infrastructure/prometheus/window-failure-rate-source.js';

const window = { timestampUnit: 'unix_seconds' as const, startUnixSeconds: 10_000, endUnixSeconds: 10_601 };
const scenario = parseTargetCatalog(multiProjectTargetCatalog).targets[0]!.scenario;
const names = ['market_checkout_window_start_timestamp_seconds', 'market_checkout_window_end_timestamp_seconds',
  'market_checkout_window_requests', 'market_checkout_window_requests'];
const values = ['10000', '10601', '96', '4'];
function payload(index: number): Record<string, unknown> {
  return { status: 'success', data: { resultType: 'vector', result: [{
    metric: { __name__: names[index], service: 'checkout', instance: 'exporter-a',
      ...(index >= 2 ? { outcome: index === 2 ? 'success' : 'failed' } : {}) }, value: [10_602, values[index]],
  }] } };
}
function body(raw: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(raw))); controller.close();
  } });
}
type Options = ConstructorParameters<typeof prometheus.PrometheusWindowFailureRateSource>[0];
// Explicit test-host policy; these limits are not adapter defaults.
function hostPolicy(maxAgeSeconds: number, maxSpreadSeconds: number): WindowFreshnessPolicy {
  return {
    authorize: () => 'authorized',
    authorizeObservations: ({ observations, nowUnixSeconds }) => {
      if (observations.some(observation => observation.sampleUnixSeconds > nowUnixSeconds)) return 'denied';
      if (observations.some(observation => nowUnixSeconds - observation.sampleUnixSeconds > maxAgeSeconds)) return 'stale';
      const times = observations.map(observation => observation.sampleUnixSeconds);
      if (times.length && Math.max(...times) - Math.min(...times) > maxSpreadSeconds) return 'denied';
      return 'authorized';
    },
  };
}
const defaultHostPolicy = hostPolicy(10, 2);
function observationsAt(times: readonly number[]): Record<string, unknown>[] {
  return times.map((time, index) => ({ status: 'success', data: { resultType: 'vector', result: [{
    metric: { __name__: names[index], service: 'checkout', instance: 'exporter-a',
      ...(index >= 2 ? { outcome: index === 2 ? 'success' : 'failed' } : {}) }, value: [time, values[index]],
  }] } }));
}
function setup(overrides: Partial<Options> = {}, raws = names.map((_, i) => payload(i))) {
  const requests: { query: string; evaluationUnixSeconds: number; signal: AbortSignal }[] = [];
  const source = new prometheus.PrometheusWindowFailureRateSource({
    scenario, nowUnixSeconds: () => 10_602,
    windowPolicy: defaultHostPolicy, maxResponseBytes: 4096, timeoutMs: 1000,
    queryPort: { async query(request) {
      requests.push(request); return { status: 200, body: body(raws[requests.length - 1]) };
    } }, ...overrides,
  });
  return { source, requests };
}
const signal = () => new AbortController().signal;

describe('Target-bound Prometheus window source', () => {
  it('queries both mapped boundaries and outcomes and derives the reviewed typed fact', async () => {
    const { source, requests } = setup();
    const result = await source.collect(window, signal());
    expect(requests.map(r => r.query)).toEqual([
      'market_checkout_window_start_timestamp_seconds{service="checkout"}',
      'market_checkout_window_end_timestamp_seconds{service="checkout"}',
      'market_checkout_window_requests{service="checkout",outcome="success"}',
      'market_checkout_window_requests{service="checkout",outcome="failed"}',
    ]);
    expect(requests.every(r => r.evaluationUnixSeconds === 10_602)).toBe(true);
    expect(result.fact).toEqual({ schemaVersion: 'window_count_snapshot.v1', availability: 'available',
      timestampUnit: 'unix_seconds', window: { startUnixSeconds: 10_000, endUnixSeconds: 10_601 },
      successCount: 96, failureCount: 4, totalCount: 100 });
    expect(result.assessment).toMatchObject({ status: 'complete', failureRate: 0.04, thresholdReached: false });
    expect(result.rawCapture).toHaveLength(4);
    expect(result.rawCapture[0]!.payload).toEqual(payload(0));
    expect(JSON.stringify(result.fact)).not.toContain('exporter-a');
    expect(JSON.stringify(result.assessment)).not.toContain('exporter-a');
  });
  it('binds different Target names, labels and threshold without a global duration', async () => {
    const other = parseTargetCatalog(multiProjectTargetCatalog).targets[1]!.scenario;
    const raws = names.map((_, i) => ({ status: 'success', data: { resultType: 'vector', result: [{
      metric: { __name__: i === 0 ? 'orders_submit_window_start_timestamp_seconds'
        : i === 1 ? 'orders_submit_window_end_timestamp_seconds' : 'orders_submit_window_count',
      application: 'checkout-api', ...(i >= 2 ? { result: i === 2 ? 'ok' : 'error' } : {}) },
      value: [10_602, values[i]],
    }] } }));
    const { source, requests } = setup({ scenario: other }, raws);
    expect((await source.collect(window, signal())).assessment).toMatchObject({ thresholdReached: true });
    expect(requests[3]!.query).toBe('orders_submit_window_count{application="checkout-api",result="error"}');
  });
  it('escapes trusted selector values and applies static labels to every query', async () => {
    const mapped = { ...scenario, metricMapping: { ...scenario.metricMapping,
      serviceSelector: { label: 'service', value: 'check"out\\\n' }, staticLabels: { environment: 'sim"\\\n' } } };
    const raws = names.map((_, i) => ({ status: 'success', data: { resultType: 'vector', result: [{
      metric: { __name__: names[i], service: 'check"out\\\n', environment: 'sim"\\\n',
        ...(i >= 2 ? { outcome: i === 2 ? 'success' : 'failed' } : {}) }, value: [10_602, values[i]],
    }] } }));
    const { source, requests } = setup({ scenario: mapped }, raws);
    await source.collect(window, signal());
    expect(requests[0]!.query).toBe('market_checkout_window_start_timestamp_seconds{service="check\\"out\\\\\\n",environment="sim\\"\\\\\\n"}');
    expect(requests.every(r => r.query.includes('environment="sim\\"\\\\\\n"'))).toBe(true);
  });
  it.each(['stale', 'denied'] as const)('rejects host policy decision %s before querying', async decision => {
    const { source, requests } = setup({ windowPolicy: { ...defaultHostPolicy, authorize: () => decision } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: decision === 'stale' ? 'STALE_WINDOW' : 'WINDOW_NOT_AUTHORIZED' });
    expect(requests).toHaveLength(0);
  });
  it.each(['windowPolicy', 'nowUnixSeconds'] as const)('fails closed with missing %s', key => {
    expect(() => setup({ [key]: undefined })).toThrow('WINDOW_AUTHORITY_REQUIRED');
  });
  it('uses the injected clock and immutable request for policy authorization', async () => {
    const seen: number[] = [];
    const { source } = setup({ windowPolicy: { ...defaultHostPolicy, authorize: (requested, now) => {
      expect(Object.isFrozen(requested)).toBe(true); expect(requested).toEqual(window); seen.push(now); return 'authorized';
    } } });
    await source.collect(window, signal()); expect(seen.every(now => now === 10_602)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
  it('rechecks freshness before returning evidence', async () => {
    let checks = 0;
    const { source } = setup({ windowPolicy: { ...defaultHostPolicy, authorize: () => ++checks === 1 ? 'authorized' : 'stale' } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'STALE_WINDOW' });
  });
  it.each([
    { ...window, endUnixSeconds: NaN }, { ...window, startUnixSeconds: 10_601 },
    { ...window, endpoint: 'untrusted' }, { ...window, promql: 'up' },
  ])('rejects malformed or authority-expanding request %#', async request => {
    const { source, requests } = setup();
    await expect(source.collect(request, signal())).rejects.toMatchObject({ code: 'INVALID_REQUESTED_WINDOW' });
    expect(requests).toHaveLength(0);
  });
  it.each(['1.0.0', '2.0.0'])('refuses unsupported scenario %s', version => {
    expect(() => setup({ scenario: { ...scenario, version } })).toThrow('INVALID_MAPPING');
  });
  it('rejects unsafe identifiers before generating PromQL', () => {
    expect(() => setup({ scenario: { ...scenario, metricMapping: { ...scenario.metricMapping, metricName: 'up} or up' } } })).toThrow('INVALID_MAPPING');
  });
  it('returns explicit unavailable boundary evidence', async () => {
    const raws = names.map((_, i) => payload(i));
    raws[0] = { status: 'success', data: { resultType: 'vector', result: [] } };
    const result = await setup({}, raws).source.collect(window, signal());
    expect(result.assessment).toEqual({ status: 'unavailable', reason: 'missing_window_evidence', missingEvidence: ['start_boundary'] });
  });
  it.each([0, 1, 2, 3])('rejects multiple series for mapped query %s rather than summing', async index => {
    const raws = names.map((_, i) => payload(i));
    const original = payload(index) as { data: { result: unknown[] } };
    raws[index] = { status: 'success', data: { resultType: 'vector', result: [...original.data.result, ...original.data.result] } };
    await expect(setup({}, raws).source.collect(window, signal())).rejects.toMatchObject({ code: 'AMBIGUOUS_SERIES' });
  });
  it('rejects missing outcome counts', async () => {
    const raws = names.map((_, i) => payload(i)); raws[3] = { status: 'success', data: { resultType: 'vector', result: [] } };
    await expect(setup({}, raws).source.collect(window, signal())).rejects.toMatchObject({ code: 'MISSING_SERIES' });
  });
  it.each([
    ['wrong scope', { __name__: names[0], service: 'other' }, [10_602, '10000'], 'SCOPE_MISMATCH'],
    ['wrong name', { __name__: 'other', service: 'checkout' }, [10_602, '10000'], 'SCOPE_MISMATCH'],
    ['nonfinite boundary', { __name__: names[0], service: 'checkout' }, [10_602, 'NaN'], 'INVALID_RESPONSE'],
    ['empty value', { __name__: names[0], service: 'checkout' }, [10_602, ''], 'INVALID_RESPONSE'],
    ['future sample', { __name__: names[0], service: 'checkout' }, [10_603, '10000'], 'INVALID_RESPONSE'],
    ['mismatched business window', { __name__: names[0], service: 'checkout', instance: 'exporter-a' }, [10_602, '9999'], 'WINDOW_MISMATCH'],
  ])('rejects %s', async (_name, metric, value, code) => {
    const raws = names.map((_, i) => payload(i)); raws[0] = { status: 'success', data: { resultType: 'vector', result: [{ metric, value }] } };
    await expect(setup({}, raws).source.collect(window, signal())).rejects.toMatchObject({ code });
  });
  it('rejects inconsistent exporter identities across queries', async () => {
    const raws = names.map((_, i) => payload(i)); raws[1] = { status: 'success', data: { resultType: 'vector', result: [{
      metric: { __name__: names[1], service: 'checkout', instance: 'exporter-b' }, value: [10_602, '10601'],
    }] } };
    await expect(setup({}, raws).source.collect(window, signal())).rejects.toMatchObject({ code: 'AMBIGUOUS_SERIES' });
  });
  it.each([{}, { status: 'error', error: 'private detail' }, { ...payload(0), warnings: ['partial'] }])('rejects malformed/partial envelope %#', async raw => {
    await expect(setup({}, [raw]).source.collect(window, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['-1', '0.5', '9007199254740992'])('delegates invalid count %s to the reviewed parser', async value => {
    const raws = names.map((_, i) => payload(i)); raws[2] = { status: 'success', data: { resultType: 'vector', result: [{
      metric: { __name__: names[2], service: 'checkout', instance: 'exporter-a', outcome: 'success' }, value: [10_602, value],
    }] } };
    await expect(setup({}, raws).source.collect(window, signal())).rejects.toMatchObject({ code: 'INVALID_COUNT' });
  });
  it('cancels a chunked response as soon as the byte bound is exceeded', async () => {
    let cancelled = false;
    const source = setup({ maxResponseBytes: 10, queryPort: { async query() {
      return { status: 200, body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); },
        cancel() { cancelled = true; },
      }) };
    } } }).source;
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
  it('terminates an endless microtask-ready empty stream before timeout and cancels its reader', async () => {
    // Isolate the genuine endless stream: the unfixed reader starves timers in its own worker.
    // The parent watchdog can still terminate it and report an assertion failure for RED.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { registerHooks } = require('node:module');
      const { readFileSync } = require('node:fs');
      const ts = require('typescript');
      // Test-only, in-memory source loader. Keep hooks local to this worker and source root.
      // This handles the source's .js specifiers and parameter properties without dist.
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (context.parentURL?.startsWith(workerData.sourceRootUrl)
            && specifier.startsWith('.') && specifier.endsWith('.js')) {
            return nextResolve(specifier.slice(0, -3) + '.ts', context);
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url.startsWith(workerData.sourceRootUrl) && url.endsWith('.ts')) {
            const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
              fileName: new URL(url).pathname,
              compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
            }).outputText;
            return { format: 'module', source, shortCircuit: true };
          }
          return nextLoad(url, context);
        }
      });
      (async () => {
        const { PrometheusWindowFailureRateSource } = await import(workerData.moduleUrl);
        let cancelled = false, pulls = 0, requestSignal;
        const source = new PrometheusWindowFailureRateSource({
          scenario: workerData.scenario, nowUnixSeconds: () => 10602,
          windowPolicy: { authorize: () => 'authorized', authorizeObservations: () => 'authorized' },
          maxResponseBytes: 4096, timeoutMs: 10000,
          queryPort: { async query(request) {
            requestSignal = request.signal;
            return { status: 200, body: new ReadableStream({
              pull(controller) { pulls++; controller.enqueue(new Uint8Array(0)); },
              cancel() { cancelled = true; }
            }) };
          } }
        });
        parentPort.postMessage({ ready: true });
        try { await source.collect(workerData.window, new AbortController().signal); parentPort.postMessage({ complete: true }); }
        catch (error) { parentPort.postMessage({ code: error.code, message: error.message, cancelled, pulls, aborted: requestSignal.aborted }); }
      })().catch(error => parentPort.postMessage({ unexpected: String(error) }));
    `, { eval: true, execArgv: [], workerData: {
      moduleUrl: new URL('../src/infrastructure/prometheus/window-failure-rate-source.ts', import.meta.url).href,
      sourceRootUrl: new URL('../src/', import.meta.url).href,
      scenario, window,
    } });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.on('message', (message: unknown) => {
          if (typeof message === 'object' && message !== null && 'ready' in message) {
            clearTimeout(watchdog); watchdog = setTimeout(() => resolve({ watchdog: true }), 1500);
          } else { resolve(message); }
        });
        worker.once('error', reject);
        watchdog = setTimeout(() => resolve({ startupWatchdog: true }), 5000);
      });
      expect(result).toMatchObject({ code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE', cancelled: true, aborted: false });
      expect((result as { pulls: number }).pulls).toBeLessThanOrEqual(2);
    } finally {
      clearTimeout(watchdog); await worker.terminate();
    }
  });
  it('enforces timeout even when the query port ignores cancellation', async () => {
    const { source } = setup({ timeoutMs: 10, queryPort: { query: () => new Promise(() => {}) } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
  });
  it('cancels a stalled response reader on timeout', async () => {
    let cancelled = false;
    const { source } = setup({ timeoutMs: 10, queryPort: { async query() {
      return { status: 200, body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
    } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(cancelled).toBe(true);
  });
  it('aborts in-flight requests and never accepts late evidence', async () => {
    const controller = new AbortController();
    const { source } = setup({ queryPort: { query: () => new Promise(() => {}) } });
    const collecting = source.collect(window, controller.signal); controller.abort('private abort reason');
    await expect(collecting).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('rejects an already aborted call without a query', async () => {
    const { source, requests } = setup(); const controller = new AbortController(); controller.abort();
    await expect(source.collect(window, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(requests).toHaveLength(0);
  });
  it('sanitizes transport errors instead of exposing private details', async () => {
    const { source } = setup({ queryPort: { async query() { throw new Error('private credential'); } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'QUERY_FAILED', message: 'QUERY_FAILED' });
  });
  it('cancels HTTP error bodies without reading private diagnostics', async () => {
    let cancelled = false;
    const { source } = setup({ queryPort: { async query() {
      return {
        status: 503,
        body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
        retryAfterMs: 375,
      };
    } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({
      code: 'HTTP_ERROR', httpStatus: 503, retryAfterMs: 375,
    });
    expect(cancelled).toBe(true);
  });
  it('rejects a missing response body', async () => {
    const { source } = setup({ queryPort: { async query() { return { status: 200, body: null }; } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects invalid JSON bytes', async () => {
    const { source } = setup({ queryPort: { async query() {
      return { status: 200, body: new ReadableStream<Uint8Array>({ start(c) {
        c.enqueue(new TextEncoder().encode('{')); c.close();
      } }) };
    } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([NaN, Infinity])('rejects nonfinite clock %# before querying', async now => {
    const { source, requests } = setup({ nowUnixSeconds: () => now });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'WINDOW_NOT_AUTHORIZED' });
    expect(requests).toHaveLength(0);
  });
  it('fails closed on policy exceptions without exposing their detail', async () => {
    const { source, requests } = setup({ windowPolicy: { ...defaultHostPolicy, authorize() { throw new Error('private policy'); } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'WINDOW_NOT_AUTHORIZED', message: 'WINDOW_NOT_AUTHORIZED' });
    expect(requests).toHaveLength(0);
  });
  it('freezes the acquired scenario against caller mutation', async () => {
    const mutable = structuredClone(scenario);
    const { source, requests } = setup({ scenario: mutable });
    mutable.metricMapping.metricName = 'other'; mutable.threshold = 0.02;
    const result = await source.collect(window, signal());
    expect(result.assessment).toMatchObject({ threshold: 0.05, thresholdReached: false });
    expect(requests[2]!.query).toBe('market_checkout_window_requests{service="checkout",outcome="success"}');
  });
  it('routes sample insufficiency through the reviewed analyzer', async () => {
    const { source } = setup({ scenario: { ...scenario, minSamples: 101 } });
    expect((await source.collect(window, signal())).assessment).toEqual({ status: 'insufficient_samples', sampleCount: 100, minimumSamples: 101 });
  });
  it('requires observation authorization even when window authorization exists', () => {
    expect(() => setup({ windowPolicy: { authorize: defaultHostPolicy.authorize } as WindowFreshnessPolicy }))
      .toThrow('WINDOW_AUTHORITY_REQUIRED');
  });
  it('preserves earlier fresh sample observations and passes immutable roles/times to the host', async () => {
    let authorized = false;
    const { source } = setup({ windowPolicy: { ...defaultHostPolicy, authorizeObservations: input => {
      expect(input.requestedWindow).toEqual(window); expect(input.nowUnixSeconds).toBe(10_602);
      expect(Object.isFrozen(input.observations)).toBe(true);
      expect(input.observations.every(Object.isFrozen)).toBe(true);
      expect(input.observations).toEqual([
        { role: 'start_boundary', metricName: names[0], evaluationUnixSeconds: 10_602, sampleUnixSeconds: 10_600 },
        { role: 'end_boundary', metricName: names[1], evaluationUnixSeconds: 10_602, sampleUnixSeconds: 10_600 },
        { role: 'success_count', metricName: names[2], outcomeValue: 'success', evaluationUnixSeconds: 10_602, sampleUnixSeconds: 10_600 },
        { role: 'failure_count', metricName: names[3], outcomeValue: 'failed', evaluationUnixSeconds: 10_602, sampleUnixSeconds: 10_600 },
      ]);
      authorized = true; return defaultHostPolicy.authorizeObservations(input);
    } } }, observationsAt([10_600, 10_600, 10_600, 10_600]));
    const result = await source.collect(window, signal());
    expect(authorized).toBe(true);
    expect(result.assessment).toMatchObject({ status: 'complete', failureRate: 0.04 });
    expect(result.rawCapture.map(capture => capture.observation?.sampleUnixSeconds)).toEqual([10_600, 10_600, 10_600, 10_600]);
    expect(result.fact).not.toHaveProperty('observations');
  });
  it('rejects samples older than the explicitly configured host age without producing a fact', async () => {
    const { source } = setup({ windowPolicy: hostPolicy(1, 2) }, observationsAt([10_600, 10_600, 10_600, 10_600]));
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  });
  it('rejects mixed query sample times under the explicit host coherence limit', async () => {
    const { source } = setup({ windowPolicy: hostPolicy(10, 1) }, observationsAt([10_598, 10_600, 10_601, 10_601]));
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'OBSERVATIONS_NOT_AUTHORIZED' });
  });
  it('allows mixed query sample times when the host explicitly authorizes that spread', async () => {
    const { source } = setup({ windowPolicy: hostPolicy(10, 3) }, observationsAt([10_598, 10_600, 10_601, 10_601]));
    expect((await source.collect(window, signal())).assessment.status).toBe('complete');
  });
  it('rejects a future observation without producing a complete fact', async () => {
    const { source } = setup({}, observationsAt([10_603, 10_602, 10_602, 10_602]));
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['denied', 'stale', undefined] as const)('fails closed on observation policy decision %s', async decision => {
    const policy = { ...defaultHostPolicy, authorizeObservations: () => decision } as WindowFreshnessPolicy;
    await expect(setup({ windowPolicy: policy }).source.collect(window, signal())).rejects.toMatchObject({
      code: decision === 'stale' ? 'STALE_OBSERVATION' : 'OBSERVATIONS_NOT_AUTHORIZED',
    });
  });
  it('sanitizes observation policy exceptions', async () => {
    const { source } = setup({ windowPolicy: { ...defaultHostPolicy, authorizeObservations() { throw new Error('private policy'); } } });
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'OBSERVATIONS_NOT_AUTHORIZED', message: 'OBSERVATIONS_NOT_AUTHORIZED' });
  });
  it('passes the final injected clock to observation freshness authorization', async () => {
    let clockReads = 0;
    const { source } = setup({ nowUnixSeconds: () => ++clockReads === 1 ? 10_602 : 10_604,
      windowPolicy: hostPolicy(3, 2) }, observationsAt([10_600, 10_600, 10_600, 10_600]));
    await expect(source.collect(window, signal())).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  });
});
