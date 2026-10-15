import { describe, expect, it } from 'vitest';
import { FetchWindowPrometheusQueryPort } from '../src/infrastructure/prometheus/http-window-query-port.js';

const nowMs = Date.parse('2026-10-15T00:00:00.000Z');
const request = {
  query: 'sum(rate(checkout_requests_total{service="checkout"}[5m]))',
  evaluationUnixSeconds: nowMs / 1_000,
  signal: new AbortController().signal,
};

describe('FetchWindowPrometheusQueryPort', () => {
  it('reads delta-seconds Retry-After from the actual HTTP response and returns only normalized metadata', async () => {
    let requestedUrl: URL | undefined;
    let authorization: string | null = null;
    const port = new FetchWindowPrometheusQueryPort({
      url: 'https://prometheus.example.test/',
      bearerToken: 'secret-test-token',
      now: () => nowMs,
      fetch: async (input, init) => {
        requestedUrl = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : new URL(input.url);
        authorization = new Headers(init?.headers).get('authorization');
        return new Response('private response body', { status: 429, headers: { 'retry-after': '1.5' } });
      },
    });

    const response = await port.query(request);
    expect(requestedUrl?.pathname).toBe('/api/v1/query');
    expect(requestedUrl?.searchParams.get('query')).toBe(request.query);
    expect(requestedUrl?.searchParams.get('time')).toBe(String(request.evaluationUnixSeconds));
    expect(authorization).toBe('Bearer secret-test-token');
    expect(response.status).toBe(429);
    expect(response.retryAfterMs).toBe(1_500);
    expect(Object.keys(response).sort()).toEqual(['body', 'retryAfterMs', 'status']);
    await response.body?.cancel();
  });

  it('uses the injected clock to normalize an HTTP-date Retry-After header', async () => {
    const port = new FetchWindowPrometheusQueryPort({
      url: 'https://prometheus.example.test/',
      now: () => nowMs,
      fetch: async () => new Response('private response body', {
        status: 503,
        headers: { 'retry-after': new Date(nowMs + 4_000).toUTCString() },
      }),
    });

    const response = await port.query(request);
    expect(response.retryAfterMs).toBe(4_000);
    await response.body?.cancel();
  });

  it('omits invalid or absent Retry-After metadata', async () => {
    const responses = [
      new Response('private response body', { status: 503, headers: { 'retry-after': '-1' } }),
      new Response('private response body', { status: 503 }),
    ];
    const port = new FetchWindowPrometheusQueryPort({
      url: 'https://prometheus.example.test/',
      now: () => nowMs,
      fetch: async () => responses.shift()!,
    });

    const invalid = await port.query(request);
    const absent = await port.query(request);
    expect(invalid.retryAfterMs).toBeUndefined();
    expect(absent.retryAfterMs).toBeUndefined();
    await invalid.body?.cancel();
    await absent.body?.cancel();
  });

  it.each([
    'https://user:password@prometheus.example.test/',
    'https://prometheus.example.test/private-path',
    'https://prometheus.example.test/?token=secret',
  ])('rejects non-origin Prometheus URLs: %s', url => {
    expect(() => new FetchWindowPrometheusQueryPort({ url, now: () => nowMs })).toThrow('INVALID_PROMETHEUS_URL');
  });
});
