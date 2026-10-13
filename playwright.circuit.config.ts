import { createServer } from 'node:net';
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const agentPort = 45300;
const controlPort = 45301;
const webPort = 45373;
if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const port of [agentPort, controlPort, webPort]) await assertFreePort(port);
}

const fixtureEnv = {
  ...process.env,
  AGENTOPS_CIRCUIT_E2E_AGENT_PORT: String(agentPort),
  AGENTOPS_CIRCUIT_E2E_CONTROL_PORT: String(controlPort),
  AGENTOPS_CIRCUIT_E2E_WEB_PORT: String(webPort),
  AGENTOPS_MODEL_BASE_URL: '',
  AGENTOPS_MODEL_API_KEY: '',
  LANGSMITH_API_KEY: '',
  LANGSMITH_TRACING: 'false',
};

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /metrics-circuit-web\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results/metrics-circuit-web',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `${quote(process.execPath)} ${quote(resolve(projectRoot, 'test/e2e/metrics-circuit-fixture-server.mjs'))}`,
      url: `http://127.0.0.1:${agentPort}/health`,
      env: fixtureEnv,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `${quote(process.execPath)} ${quote(resolve(projectRoot, 'apps/agent-web/node_modules/vite/bin/vite.js'))} ${quote(resolve(projectRoot, 'apps/agent-web'))} --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: { ...fixtureEnv, VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}` },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});

async function assertFreePort(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolvePromise);
    });
  } catch {
    throw new Error(`Circuit E2E requires free loopback port ${port}.`);
  } finally {
    if (server.listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

function quote(value: string): string {
  return `"${value}"`;
}
