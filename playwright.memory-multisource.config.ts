import { createServer } from 'node:net';
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const agentPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT ?? '45700';
const webPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT ?? '45773';
const controlPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT ?? '45701';
const systemChrome = process.env.AGENTOPS_MEMORY_MULTI_E2E_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = existsSync(systemChrome) ? { executablePath: systemChrome } : undefined;
const environment = { ...process.env, AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT: agentPort,
  AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT: webPort, AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT: controlPort } as Record<string, string>;
const quote = (value: string) => `"${value}"`;

if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const port of [Number(agentPort), Number(webPort), Number(controlPort)]) await assertFreePort(port);
}

export default defineConfig({
  testDir: './test/e2e', testMatch: /memory-multisource-web\.spec\.ts/u,
  timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, fullyParallel: false, reporter: 'list',
  outputDir: 'test-results/memory-multisource-web',
  use: { ...(launchOptions === undefined ? {} : { launchOptions }), baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: `${quote(process.execPath)} ${quote(resolve(root, 'test/e2e/memory-multisource-fixture-server.mjs'))}`,
      url: `http://127.0.0.1:${agentPort}/health`, env: environment, timeout: 120_000, reuseExistingServer: false },
    { command: `${quote(process.execPath)} ${quote(resolve(root, 'apps/agent-web/node_modules/vite/bin/vite.js'))} ${quote(resolve(root, 'apps/agent-web'))} --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`, env: { ...environment, VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}` },
      timeout: 120_000, reuseExistingServer: false },
  ],
});

async function assertFreePort(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    throw new Error(`Memory multi-source E2E needs free local port ${port}.`);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
