import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const agentPort = process.env.AGENTOPS_LOCAL_INSPECTION_AGENT_PORT ?? '45700';
const webPort = process.env.AGENTOPS_LOCAL_INSPECTION_WEB_PORT ?? '45773';
const env = { ...process.env, AGENTOPS_LOCAL_INSPECTION_AGENT_PORT: agentPort,
  AGENTOPS_LOCAL_INSPECTION_WEB_PORT: webPort };
const quote = (value: string) => `"${value}"`;
const systemChrome = process.env.AGENTOPS_LOCAL_INSPECTION_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = existsSync(systemChrome) ? { executablePath: systemChrome } : undefined;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /local-inspection-web\.spec\.ts/u,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results/local-inspection-web',
  use: { ...(launchOptions === undefined ? {} : { launchOptions }), baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: `${quote(process.execPath)} ${quote(resolve(root, 'test/e2e/local-inspection-fixture-server.mjs'))}`,
      url: `http://127.0.0.1:${agentPort}/targets`, env, timeout: 120_000, reuseExistingServer: false },
    { command: `${quote(process.execPath)} ${quote(resolve(root, 'apps/agent-web/node_modules/vite/bin/vite.js'))} ${quote(resolve(root, 'apps/agent-web'))} --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`, env: { ...env, VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}` },
      timeout: 120_000, reuseExistingServer: false },
  ],
});
