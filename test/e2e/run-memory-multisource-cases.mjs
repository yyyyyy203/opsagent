import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const playwrightCli = join(root, 'node_modules/@playwright/test/cli.js');
const fixedNow = '2026-10-21T12:00:00.000Z';
const ports = [
  Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT ?? 45700),
  Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT ?? 45773),
  Number(process.env.AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT ?? 45701),
];
const allCases = ['normal', 'metrics_failure', 'metrics_timeout', 'logs_failure', 'metrics_deadline', 'logs_partial', 'metrics_hang'];
const cases = process.env.AGENTOPS_MEMORY_MULTI_E2E_CASES?.split(',').map((value) => value.trim()).filter(Boolean) ?? allCases;
if (cases.length === 0 || cases.some((scenario) => !allCases.includes(scenario))) {
  throw new Error('AGENTOPS_MEMORY_MULTI_E2E_CASES must be a comma-separated subset of the named acceptance cases.');
}

for (const scenario of cases) {
  const dataDirectory = await mkdtemp(join(tmpdir(), `agentops-memory-multisource-${scenario}-`));
  const environment = {
    ...process.env,
    AGENTOPS_MEMORY_MULTI_E2E_DATA_DIR: dataDirectory,
    AGENTOPS_MEMORY_MULTI_E2E_SCENARIO: scenario,
    AGENTOPS_MEMORY_MULTI_E2E_NOW: fixedNow,
  };
  process.stdout.write(`\n=== Isolated multi-source case: ${scenario} ===\n`);
  let result;
  try {
    result = await run(process.execPath, [playwrightCli, 'test', '--config=playwright.memory-multisource.config.ts',
      '--grep', `\\[case:${scenario}\\]`], { cwd: root, env: environment });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
  const dataDirectoryRemoved = await waitForRemoval(dataDirectory, 1_000);
  if (!dataDirectoryRemoved) throw new Error(`Isolated data directory remained after cleanup for ${scenario}: ${dataDirectory}`);
  await Promise.all(ports.map(assertPortFree));
  if (result.code !== 0) {
    throw new Error(`Playwright case ${scenario} failed with ${result.code ?? result.signal ?? 'unknown exit'}.`);
  }
}

async function waitForRemoval(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await stat(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function assertPortFree(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    throw new Error(`Local test port ${port} remained active after an isolated case.`);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
