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
  await sourceCase.getByRole('button', { name: '批准历史参考' }).click();
  await expect(sourceCase.getByText('已批准', { exact: true })).toBeVisible();

  await page.getByLabel('使用已审核历史参考').check();
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
  const fixtureState = await getFixtureState(page);
  expect(fixtureState).toMatchObject({
    runtimeReady: true,
    sourceMode: 'deterministic-local-simulation',
    externalRequestsSent: 0,
  });
  expect(fixtureState.metricQueries).toBe(2);
  expect(fixtureState.logPages).toBeGreaterThanOrEqual(8);
  expect(fixtureState.recalledRuns).toContain(recallRunId);
  expect(fixtureState.scriptedModelCalls.parent).toBeGreaterThan(0);
  expect(fixtureState.scriptedModelCalls.metrics).toBeGreaterThan(0);
  expect(fixtureState.scriptedModelCalls.logs).toBeGreaterThan(0);
  expect([...requestOrigins].sort()).toEqual([`http://127.0.0.1:${webPort}`, agentUrl].sort());
});

interface RunDetail {
  runId: string;
  status: string;
  childRunIds: string[];
  missingEvidence: string[];
}

interface EvidenceView { runId: string; source: string; evidenceId: string }
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
  logPages: number;
  externalRequestsSent: number;
  recalledRuns: string[];
  scriptedModelCalls: { parent: number; metrics: number; logs: number };
}

async function startRun(page: Page, message: string): Promise<string> {
  await page.getByLabel('巡检问题').fill(message);
  const requestPromise = page.waitForRequest(isRunStartRequest);
  await page.getByRole('button', { name: '开始巡检' }).click();
  const request = await requestPromise;
  const body = request.postDataJSON() as { runId?: unknown };
  if (typeof body.runId !== 'string') throw new Error('Run start request omitted its runId.');
  await expect.poll(async () => (await getRun(page, body.runId as string)).status).toBe('completed');
  await expect(page.locator('.run-card.selected code')).toHaveText(body.runId);
  await expect(page.locator('.status-hero strong')).toHaveText('已完成');
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
