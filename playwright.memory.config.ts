import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const quote = (value: string) => `"${value}"`;
const agentPort = process.env.AGENTOPS_MEMORY_E2E_AGENT_PORT ?? '45400';
const webPort = process.env.AGENTOPS_MEMORY_E2E_WEB_PORT ?? '45473';
const controlPort = process.env.AGENTOPS_MEMORY_E2E_CONTROL_PORT ?? '45474';
const disabled = process.env.AGENTOPS_MEMORY_E2E_DISABLED === '1';
const environment = { ...process.env, AGENTOPS_MEMORY_E2E_AGENT_PORT: agentPort, AGENTOPS_MEMORY_E2E_WEB_PORT: webPort,
  AGENTOPS_MEMORY_E2E_CONTROL_PORT: controlPort } as Record<string, string>;

export default defineConfig({
  testDir: './test/e2e', testMatch: /memory-web\.spec\.ts/u, timeout: 45_000,
  expect: { timeout: 10_000 }, fullyParallel: false, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: `${quote(process.execPath)} ${quote(resolve(projectRoot, 'test/e2e/memory-fixture-server.mjs'))}`,
      url: `http://127.0.0.1:${agentPort}/health`, env: environment, timeout: 120_000, reuseExistingServer: false },
    { command: `${quote(process.execPath)} ${quote(resolve(projectRoot, 'apps/agent-web/node_modules/vite/bin/vite.js'))} ${quote(resolve(projectRoot, 'apps/agent-web'))} --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`, env: { ...environment, VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}` },
      timeout: 120_000, reuseExistingServer: false },
  ],
  ...(disabled ? { workers: 1 } : {}),
});
