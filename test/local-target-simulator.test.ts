import { afterEach, describe, expect, it } from 'vitest';
import { startTargetPrometheusServer } from '../src/infrastructure/simulator/target-prometheus-server.js';

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('local Target Prometheus simulator', () => {
  it('serves an exact rolling window for allowlisted queries and rejects arbitrary selectors', async () => {
    let nowSeconds = 1_800_000_000;
    const server = await startTargetPrometheusServer({ port: 0, successCount: 96, failureCount: 4,
      now: () => nowSeconds * 1_000 });
    servers.push(server);

    for (const evaluationTime of [nowSeconds + 0.75, nowSeconds + 60 + 0.75]) {
      nowSeconds = Math.floor(evaluationTime);
      const windowEnd = Math.floor(evaluationTime);
      const queries = [
        ['settlement_window_start_seconds{service="checkout",environment="simulation"}', String(windowEnd - 300)],
        ['settlement_window_end_seconds{service="checkout",environment="simulation"}', String(windowEnd)],
        ['settlement_window_requests{service="checkout",environment="simulation",outcome="success"}', '96'],
        ['settlement_window_requests{service="checkout",environment="simulation",outcome="failure"}', '4'],
      ] as const;
      for (const [query, expectedValue] of queries) {
        const url = new URL('/api/v1/query', server.url);
        url.searchParams.set('query', query);
        url.searchParams.set('time', String(evaluationTime));
        const response = await fetch(url);
        expect(response.status).toBe(200);
        const body = await response.json() as { data: { result: Array<{ value: [number, string] }> } };
        expect(body.data.result[0]?.value).toEqual([evaluationTime, expectedValue]);
      }
    }

    const invalid = new URL('/api/v1/query', server.url);
    invalid.searchParams.set('query', 'up');
    invalid.searchParams.set('time', String(nowSeconds));
    expect((await fetch(invalid)).status).toBe(400);
    expect((await fetch(`${server.url}/-/ready`)).status).toBe(200);
  });
});
