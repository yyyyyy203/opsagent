import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
  SCENARIO_FIXTURE_WINDOW_SECONDS,
  SCENARIO_WINDOW_DATASET_DIGEST,
  SCENARIO_WINDOW_DATASET_ID,
  SCENARIO_WINDOW_DATASET_VERSION,
  ScenarioFixtureError,
  listScenarioWindowFixtureIds,
  loadScenarioWindowFixture,
} from './scenario-window-fixtures.js';

export interface ScenarioWindowServerOptions {
  /** Loopback only; the fixture dataset is simulated and must never be published. */
  port?: number;
}

/**
 * Loopback HTTP fixture source for the S3 offline quality set. It serves the same
 * frozen dataset the in-process loader uses, so a quality run can prove the
 * simulator transport without depending on any business system.
 */
export async function startScenarioWindowServer(options: ScenarioWindowServerOptions = {}): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('INVALID_SCENARIO_WINDOW_SERVER_PORT');
  }
  const server = createServer((request, response) => respond(request, response));
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('SCENARIO_WINDOW_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function respond(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/-/ready') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('ready');
    return;
  }
  if (url.pathname === '/api/v1/scenarios' && url.searchParams.size === 0) {
    sendJson(response, 200, {
      datasetId: SCENARIO_WINDOW_DATASET_ID,
      datasetVersion: SCENARIO_WINDOW_DATASET_VERSION,
      datasetDigest: SCENARIO_WINDOW_DATASET_DIGEST,
      windowSeconds: SCENARIO_FIXTURE_WINDOW_SECONDS,
      evaluationTimeUnixSeconds: SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS,
      fixtureIds: listScenarioWindowFixtureIds(),
    });
    return;
  }
  const match = /^\/api\/v1\/scenarios\/([a-z0-9_.]+)\/window$/u.exec(url.pathname);
  if (match === null || url.searchParams.size !== 0) {
    sendJson(response, 404, { status: 'error', code: 'UNKNOWN_FIXTURE' });
    return;
  }
  const fixtureId = match[1];
  if (fixtureId === undefined) {
    sendJson(response, 404, { status: 'error', code: 'UNKNOWN_FIXTURE' });
    return;
  }
  try {
    sendJson(response, 200, { status: 'success', fixture: loadScenarioWindowFixture(fixtureId) });
  } catch (error) {
    const code = error instanceof ScenarioFixtureError ? error.code : 'UNKNOWN_FIXTURE';
    sendJson(response, code === 'UNKNOWN_FIXTURE' ? 404 : 400, { status: 'error', code });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
