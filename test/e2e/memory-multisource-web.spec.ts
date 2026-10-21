import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

const agentPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_AGENT_PORT ?? '45700';
const controlPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_CONTROL_PORT ?? '45701';
const webPort = process.env.AGENTOPS_MEMORY_MULTI_E2E_WEB_PORT ?? '45773';
const agentUrl = `http://127.0.0.1:${agentPort}`;
const controlUrl = `http://127.0.0.1:${controlPort}`;

test('simulated Metrics+Logs memory capture, review, recall, and Trace limitation work through the browser', async ({ page }) => {
  const requestOrigins = new Set<string>();
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') requestOrigins.add(url.origin);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();
  await expect(page.getByLabel('本次沉淀')).toHaveValue('manual');
  await expect(page.getByLabel('使用已审核历史参考')).not.toBeChecked();

  const firstRunRequest = page.waitForRequest(isRunStartRequest);
  const repeatedQuestion = 'SETTLEMENT_FAILURE_HIGH：模拟结算失败率升高，连接池等待增加；核验当前指标与日志。';
  const sourceRunId = await startRun(page, repeatedQuestion);
  expect((await firstRunRequest).postDataJSON()).toMatchObject({
    memoryPreferences: { capture: 'manual', recall: 'disabled' },
  });

  const sourceRun = await getRun(page, sourceRunId);
  expect(sourceRun.status).toBe('completed');
  expect(sourceRun.childRunIds).toHaveLength(2);
  expect(sourceRun.missingEvidence).toContain('traces');
  const children = await Promise.all(sourceRun.childRunIds.map(async (runId) => ({
    detail: await getRun(page, runId), evidence: await getEvidence(page, runId),
  })));
  expect(children.every(({ detail }) => detail.status === 'completed')).toBe(true);
  const evidence = children.flatMap((child) => child.evidence);
  expect(evidence.map((item) => item.source).sort()).toEqual(['log', 'metric']);
  expect(new Set(evidence.map((item) => item.runId)).size).toBe(2);
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  await expect(page.locator('.missing-box')).toContainText('traces');

  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('已保存候选')).toBeVisible();
  const candidateResponse = await page.request.get(`${agentUrl}/memory/cases?profileId=simulation&limit=50`);
  expect(candidateResponse.ok()).toBe(true);
  const cases = await candidateResponse.json() as MemoryCase[];
  const candidate = cases.find((item) => item.sourceRunId === sourceRunId);
  expect(candidate).toBeDefined();
  expect(candidate).toMatchObject({ quality: 'sufficient', status: 'observation', eligibleForPromotion: false });
  expect(candidate!.evidenceRefs.map((item) => item.source).sort()).toEqual(['log', 'metric']);
  expect(candidate!.limitations).toContain('TRACES');
  expect(candidate!.limitations).not.toContain('REQUIRED_EVIDENCE_INCOMPLETE');

  const sourceCase = page.getByRole('article').filter({ hasText: sourceRunId });
  await expect(sourceCase.getByText('仅模拟环境可用，不可晋级')).toBeVisible();

  await page.getByLabel('使用已审核历史参考').check();
  const unreviewedRunId = await startRun(page, repeatedQuestion);
  await expect.poll(async () => getRunMemory(page, unreviewedRunId)).toMatchObject({
    selectionState: 'selected', hints: [],
  });
  expect((await getFixtureState(page)).recalledRuns).not.toContain(unreviewedRunId);

  await sourceCase.getByRole('button', { name: '批准历史参考' }).click();
  await expect(sourceCase.getByText('已批准', { exact: true })).toBeVisible();

  const recallRunRequest = page.waitForRequest(isRunStartRequest);
  const recallRunId = await startRun(page, repeatedQuestion);
  expect((await recallRunRequest).postDataJSON()).toMatchObject({
    memoryPreferences: { capture: 'manual', recall: 'enabled' },
  });
  await expect.poll(async () => getRunMemory(page, recallRunId)).toMatchObject({
    selectionState: 'selected', availability: 'ready', hints: [{ memoryId: candidate!.id, sourceRunId }],
  });
  await expect(page.getByText('历史参考已载入')).toBeVisible();
  await expect(page.locator('.memory-hints')).toContainText('Trace 来源未配置');

  const recallRun = await getRun(page, recallRunId);
  expect(recallRun.status).toBe('completed');
  expect(recallRun.childRunIds).toHaveLength(2);
  expect(recallRun.missingEvidence).toContain('traces');

  await sourceCase.getByRole('button', { name: '撤销历史参考' }).click();
  await expect(sourceCase.getByText('已拒绝', { exact: true })).toBeVisible();
  const revokedRunId = await startRun(page, repeatedQuestion);
  await expect.poll(async () => getRunMemory(page, revokedRunId)).toMatchObject({
    selectionState: 'selected', hints: [],
  });
  expect((await getFixtureState(page)).recalledRuns).not.toContain(revokedRunId);

  const fixtureState = await getFixtureState(page);
  expect(fixtureState).toMatchObject({
    runtimeReady: true,
    sourceMode: 'deterministic-local-simulation',
    blockedExternalRequests: 1,
  });
  expect(fixtureState.metricQueries).toBe(4);
  expect(fixtureState.logPages).toBeGreaterThanOrEqual(16);
  expect(fixtureState.recalledRuns).toContain(recallRunId);
  expect(fixtureState.scriptedModelCalls.parent).toBeGreaterThan(0);
  expect(fixtureState.scriptedModelCalls.metrics).toBeGreaterThan(0);
  expect(fixtureState.scriptedModelCalls.logs).toBeGreaterThan(0);
  expect(new Set(fixtureState.backendRequests.map(({ origin }) => origin)))
    .toEqual(new Set(fixtureState.allowedBackendOrigins));
  expect([...requestOrigins].sort()).toEqual([`http://127.0.0.1:${webPort}`, agentUrl].sort());
});

test('source failures and partial logs retain the available evidence and cannot become recallable cases', async ({ page }) => {
  await page.goto('/');
  const scenarios = [
    { name: 'metrics_failure', missing: 'metrics' },
    { name: 'metrics_timeout', missing: 'metrics' },
    { name: 'logs_failure', missing: 'logs' },
    { name: 'logs_partial', missing: 'logs' },
  ] as const;

  for (const scenario of scenarios) {
    const before = await getFixtureState(page);
    const runId = await startRun(page,
      `E2E_SCENARIO=${scenario.name} SETTLEMENT_FAILURE_HIGH：模拟结算失败率升高；核验当前指标与日志。`);
    const run = await getRun(page, runId);
    if (scenario.name !== 'logs_partial') {
      expect(run.missingEvidence.some((item) => item.includes(scenario.missing)),
        `${scenario.name}: ${JSON.stringify(run.missingEvidence)}`).toBe(true);
    }
    const evidence = (await Promise.all(run.childRunIds.map((childRunId) => getEvidence(page, childRunId))))
      .flat();
    expect(evidence.some((item) => item.source === (scenario.missing === 'metrics' ? 'log' : 'metric'))).toBe(true);
    if (scenario.name === 'logs_partial') {
      expect(evidence.find((item) => item.source === 'log')).toMatchObject({ state: 'partial' });
    }

    await page.getByRole('button', { name: '沉淀本次巡检' }).click();
    await expect(page.getByText('已保存候选')).toBeVisible();
    const response = await page.request.get(`${agentUrl}/memory/cases?profileId=simulation&limit=50`);
    expect(response.ok()).toBe(true);
    const cases = await response.json() as MemoryCase[];
    const candidate = cases.find((item) => item.sourceRunId === runId);
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({ quality: 'insufficient', status: 'observation', eligibleForPromotion: false });
    await expect(page.getByRole('article').filter({ hasText: runId })
      .getByRole('button', { name: '批准历史参考' })).toBeDisabled();

    const after = await getFixtureState(page);
    const metricAttempts = after.metricQueries - before.metricQueries;
    expect(metricAttempts).toBeGreaterThan(0);
    expect(metricAttempts).toBeLessThanOrEqual(3);
    expect(after.logPages).toBeGreaterThan(before.logPages);
  }
});

test('cancelling an active source request aborts the local Metrics query', async ({ page }) => {
  await page.goto('/');
  const before = await getFixtureState(page);
  const runId = await startUnfinishedRun(page,
    'E2E_SCENARIO=metrics_hang SETTLEMENT_FAILURE_HIGH：等待模拟指标响应以验证取消传播。');
  await expect.poll(async () => (await getFixtureState(page)).metricQueries).toBeGreaterThan(before.metricQueries);

  const cancel = await page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/cancel`);
  expect(cancel.status()).toBe(202);
  await expect.poll(async () => (await getRun(page, runId)).status).toBe('cancelled');
  await expect.poll(async () => (await getFixtureState(page)).metricAborts).toBeGreaterThan(before.metricAborts);
});

interface RunDetail {
  runId: string;
  status: string;
  childRunIds: string[];
  missingEvidence: string[];
}

interface EvidenceView { runId: string; source: string; evidenceId: string; state?: string }
interface MemoryCase {
  id: string;
  sourceRunId: string;
  quality: string;
  status: string;
  eligibleForPromotion: boolean;
  limitations: string[];
  evidenceRefs: { source: string }[];
}
interface FixtureState {
  runtimeReady: boolean;
  sourceMode: string;
  metricQueries: number;
  metricAborts: number;
  logPages: number;
  recalledRuns: string[];
  scriptedModelCalls: { parent: number; metrics: number; logs: number };
  backendRequests: { origin: string; method: string }[];
  allowedBackendOrigins: string[];
  blockedExternalRequests: number;
}

async function startRun(page: Page, message: string): Promise<string> {
  const runId = await startUnfinishedRun(page, message);
  await expect.poll(async () => (await getRun(page, runId)).status).toBe('completed');
  await expect(page.locator('.run-card.selected code')).toHaveText(runId);
  await expect(page.locator('.status-hero strong')).toHaveText('已完成');
  return runId;
}

async function startUnfinishedRun(page: Page, message: string): Promise<string> {
  await page.getByLabel('巡检问题').fill(message);
  const requestPromise = page.waitForRequest(isRunStartRequest);
  await page.getByRole('button', { name: '开始巡检' }).click();
  const request = await requestPromise;
  const body = request.postDataJSON() as { runId?: unknown };
  if (typeof body.runId !== 'string') throw new Error('Run start request omitted its runId.');
  return body.runId;
}

async function getRun(page: Page, runId: string): Promise<RunDetail> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<RunDetail>;
}

async function getEvidence(page: Page, runId: string): Promise<EvidenceView[]> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/evidence`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { items: EvidenceView[] }).items;
}

async function getRunMemory(page: Page, runId: string): Promise<Record<string, unknown> | null> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/memory`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Record<string, unknown> | null>;
}

async function getFixtureState(page: Page): Promise<FixtureState> {
  const response = await page.request.get(`${controlUrl}/__state`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<FixtureState>;
}

function isRunStartRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/runs';
}
