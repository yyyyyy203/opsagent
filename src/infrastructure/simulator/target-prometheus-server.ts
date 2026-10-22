import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const ALLOWED_METRIC_QUERIES = new Set([
  'settlement_window_start_seconds{service="checkout",environment="simulation"}',
  'settlement_window_end_seconds{service="checkout",environment="simulation"}',
  'settlement_window_requests{service="checkout",environment="simulation",outcome="success"}',
  'settlement_window_requests{service="checkout",environment="simulation",outcome="failure"}',
]);

export interface TargetPrometheusServerOptions {
  port?: number;
  successCount?: number;
  failureCount?: number;
  now?: () => number;
}

/** Local Prometheus HTTP API fixture whose synthetic window follows each trusted evaluation time. */
export async function startTargetPrometheusServer(options: TargetPrometheusServerOptions = {}): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const port = options.port ?? 19_390;
  const successCount = options.successCount ?? 96;
  const failureCount = options.failureCount ?? 4;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535
    || !Number.isSafeInteger(successCount) || successCount < 0
    || !Number.isSafeInteger(failureCount) || failureCount < 0 || successCount + failureCount <= 0) {
    throw new RangeError('INVALID_TARGET_PROMETHEUS_OPTIONS');
  }
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => respond(request, response, { successCount, failureCount, now }));
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TARGET_PROMETHEUS_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function respond(request: IncomingMessage, response: ServerResponse, input: {
  successCount: number; failureCount: number; now: () => number;
}): void {
  if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }).end(); return; }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/-/ready') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('ready');
    return;
  }
  if (url.pathname !== '/api/v1/query') { response.writeHead(404).end(); return; }
  const query = url.searchParams.get('query');
  const timeValue = url.searchParams.get('time');
  const evaluationTime = timeValue !== null && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(timeValue)
    ? Number(timeValue) : Number.NaN;
  const currentTime = Math.floor(input.now() / 1_000);
  if (query === null || url.searchParams.getAll('query').length !== 1 || url.searchParams.getAll('time').length !== 1
    || url.searchParams.size !== 2 || !ALLOWED_METRIC_QUERIES.has(query) || !Number.isFinite(evaluationTime)
    || evaluationTime < 0 || evaluationTime > currentTime + 30) {
    sendJson(response, 400, { status: 'error', errorType: 'bad_data', error: 'query or evaluation time is unsupported' });
    return;
  }
  const metricName = query.slice(0, query.indexOf('{'));
  const windowEnd = Math.floor(evaluationTime);
  const sampleValue = metricName === 'settlement_window_start_seconds' ? windowEnd - 300
    : metricName === 'settlement_window_end_seconds' ? windowEnd
      : query.endsWith('outcome="success"}') ? input.successCount : input.failureCount;
  const metric: Record<string, string> = {
    __name__: metricName,
    service: 'checkout',
    environment: 'simulation',
  };
  if (metricName === 'settlement_window_requests') {
    metric.outcome = query.endsWith('outcome="success"}') ? 'success' : 'failure';
  }
  sendJson(response, 200, { status: 'success', data: { resultType: 'vector', result: [{
    metric, value: [evaluationTime, String(sampleValue)],
  }] } });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
