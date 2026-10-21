import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = `http://127.0.0.1:${process.env.AGENTOPS_MULTI_TARGET_AGENT_PORT ?? '45600'}`;
const controlUrl = `http://127.0.0.1:${process.env.AGENTOPS_MULTI_TARGET_CONTROL_PORT ?? '45674'}`;

test('isolates Target workspaces, displays frozen scope, and preserves simulation mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目巡检' })).toBeVisible();
  const targetPicker = page.getByLabel('选择巡检 Target');
  await expect(targetPicker).toHaveValue('market-a-sim');

  await page.getByLabel('巡检问题').fill('检查 market-a-sim 的模拟结算数据。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText(/market-a · lab#1：模拟样本失败率 4\.00%，低于 5% 阈值/u)).toBeVisible();
  const runA = await selectedRunId(page);
  await expect(page.locator('.target-frozen-scope')).toContainText('market-a');
  await expect(page.locator('.target-frozen-scope')).toContainText('window_failure_rate.v1@1.1.0');

  await targetPicker.selectOption('market-b-sim');
  await expect(page.locator('.run-card')).toHaveCount(0);
  await page.getByLabel('巡检问题').fill('检查 market-b-sim 的模拟结算数据。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText(/market-b · lab#3：模拟样本失败率 4\.00%，达到或超过 2% 阈值/u)).toBeVisible();
  const runB = await selectedRunId(page);
  expect(runB).not.toBe(runA);
  await expect(page.locator('.target-frozen-scope')).toContainText('market-b');

  const crossTargetDetail = await page.request.get(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(runA)}`);
  expect(crossTargetDetail.status()).toBe(404);
  const crossTargetMessages = await page.request.get(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(runA)}/messages`);
  expect(crossTargetMessages.status()).toBe(404);
  expect((await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runA)}`)).status()).toBe(404);

  // A slow A response completes after the browser has switched to B. It must not mutate B's view.
  await targetPicker.selectOption('market-a-sim');
  await page.getByLabel('巡检问题').fill('slow-market-a：延迟完成后不能覆盖另一个 Target。');
  const startResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/targets/market-a-sim/runs');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const startResponse = await startResponsePromise;
  expect(startResponse.status()).toBe(202);
  const slowRunId = (await startResponse.json() as { runId: string }).runId;
  await targetPicker.selectOption('market-b-sim');
  await expect.poll(async () => {
    const response = await page.request.get(`${agentUrl}/targets/market-a-sim/runs/${encodeURIComponent(slowRunId)}`);
    return response.ok() ? (await response.json() as { status: string }).status : 'missing';
  }).toBe('completed');
  await expect(targetPicker).toHaveValue('market-b-sim');
  await expect(page.locator('.target-selection-summary')).toContainText('market-b');
  await expect(page.locator('.message-panel')).not.toContainText('slow-market-a');
  await expect(page.locator('.run-card')).toHaveCount(1);

  await targetPicker.selectOption('market-a-sim');
  await expect(page.locator('.run-card')).toHaveCount(2);
  await page.locator('.run-card').filter({ hasText: slowRunId }).click();
  await expect(page.locator('.message-panel')).toContainText('slow-market-a');

  await page.getByRole('button', { name: '模拟巡检' }).click();
  await expect(page.getByLabel('巡检问题')).toBeVisible();
  await page.getByLabel('巡检问题').fill('确认旧 simulation 入口仍能工作。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText('M5 模拟 Profile 兼容巡检完成。')).toBeVisible();
});

test('Target memory capture, approval, and recall follow the selected Target scope', async ({ page }) => {
  await page.goto('/');
  const targetPicker = page.getByLabel('选择巡检 Target');
  await expect(targetPicker).toHaveValue('market-a-sim');

  const question = '检查本 Target 的模拟结算失败率并保留可审核证据。';
  await page.getByLabel('巡检问题').fill(question);
  const sourceStart = waitForTargetStart(page, 'market-a-sim');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const sourceRunId = await sourceStart;
  await expect(page.getByText(/market-a · lab#1：模拟样本失败率/u)).toBeVisible();
  await expect.poll(() => selectedRunId(page)).toBe(sourceRunId);
  await waitForTargetRun(page, 'market-a-sim', sourceRunId);
  await expect(page.getByLabel('使用已审核历史参考')).not.toBeChecked();

  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('已保存候选')).toBeVisible();
  const casesResponse = await page.request.get(`${agentUrl}/targets/market-a-sim/memory/cases?limit=50`);
  expect(casesResponse.ok()).toBe(true);
  const cases = await casesResponse.json() as Array<{ id: string; sourceRunId: string; quality: string;
    status: string; eligibleForPromotion: boolean; validUntil: string;
    evidenceRefs: Array<{ evidenceId: string; ownerRunId: string }> }>;
  const candidate = cases.find(item => item.sourceRunId === sourceRunId);
  expect(candidate).toMatchObject({ quality: 'sufficient', status: 'observation', eligibleForPromotion: false });
  expect(candidate?.evidenceRefs).toHaveLength(1);
  const evidenceRef = candidate!.evidenceRefs[0]!;

  const sourceCase = page.getByRole('article').filter({ hasText: sourceRunId });
  await sourceCase.getByRole('button', { name: '批准历史参考' }).click();
  await expect(sourceCase.getByText('已批准', { exact: true })).toBeVisible();

  await page.getByLabel('使用已审核历史参考').check();
  await page.getByLabel('巡检问题').fill(question);
  const recallRequest = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/targets/market-a-sim/runs');
  const recallStart = waitForTargetStart(page, 'market-a-sim');
  await page.getByRole('button', { name: '开始巡检' }).click();
  expect((await recallRequest).postDataJSON()).toMatchObject({ memoryPreferences: { capture: 'manual', recall: 'enabled' } });
  const recallRunA = await recallStart;
  await expect(page.getByText(/market-a · lab#1：模拟样本失败率/u).last()).toBeVisible();
  await expect.poll(() => selectedRunId(page)).toBe(recallRunA);
  await waitForTargetRun(page, 'market-a-sim', recallRunA);
  await expect(page.getByText('历史参考已载入')).toBeVisible();
  await expect(page.locator('.memory-hints')).toContainText('TARGET_A_MEMORY_CASE_MARKER');

  await page.clock.install({ time: new Date(candidate!.validUntil) });
  const clockResponse = await page.request.post(`${controlUrl}/__clock?now=${encodeURIComponent(candidate!.validUntil)}`);
  expect(clockResponse.ok()).toBe(true);
  await page.getByRole('button', { name: '刷新案例' }).click();
  await expect(sourceCase.getByText('已过期，不能作为历史参考')).toBeVisible();
  await expect(sourceCase.getByText('已批准', { exact: true })).toBeVisible();
  await page.getByLabel('巡检问题').fill(question);
  const expiredRun = waitForTargetStart(page, 'market-a-sim');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const expiredRunId = await expiredRun;
  await waitForTargetRun(page, 'market-a-sim', expiredRunId);
  const afterExpiry = new Date(Date.parse(candidate!.validUntil) + 1);
  await page.clock.setFixedTime(afterExpiry);
  const afterExpiryClock = await page.request.post(
    `${controlUrl}/__clock?now=${encodeURIComponent(afterExpiry.toISOString())}`);
  expect(afterExpiryClock.ok()).toBe(true);
  await page.getByLabel('巡检问题').fill(question);
  const afterExpiryStart = waitForTargetStart(page, 'market-a-sim');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const afterExpiryRunId = await afterExpiryStart;
  await waitForTargetRun(page, 'market-a-sim', afterExpiryRunId);

  await targetPicker.selectOption('market-b-sim');
  await expect(page.getByLabel('使用已审核历史参考')).not.toBeChecked();
  await expect(page.locator('.run-card').filter({ hasText: sourceRunId })).toHaveCount(0);
  await page.getByLabel('使用已审核历史参考').check();
  await page.getByLabel('巡检问题').fill(question);
  const runBStart = waitForTargetStart(page, 'market-b-sim');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const runB = await runBStart;
  await expect(page.getByText(/market-b · lab#3：模拟样本失败率/u)).toBeVisible();
  await expect.poll(() => selectedRunId(page)).toBe(runB);
  await waitForTargetRun(page, 'market-b-sim', runB);
  await expect(page.locator('.memory-hints')).toHaveCount(0);
  const casesB = await page.request.get(`${agentUrl}/targets/market-b-sim/memory/cases?limit=50`);
  expect(casesB.ok()).toBe(true);
  expect(await casesB.json()).toEqual([]);

  const fixtureStateResponse = await page.request.get(`${controlUrl}/__state`);
  expect(fixtureStateResponse.ok()).toBe(true);
  const fixtureState = await fixtureStateResponse.json() as { modelInputs: Array<{ targetId: string; runId: string; text: string }> };
  const inputsA = fixtureState.modelInputs.filter(input => input.runId === recallRunA);
  const inputsExpired = fixtureState.modelInputs.filter(input => input.runId === expiredRunId);
  const inputsAfterExpiry = fixtureState.modelInputs.filter(input => input.runId === afterExpiryRunId);
  const inputsB = fixtureState.modelInputs.filter(input => input.runId === runB);
  expect(inputsA.length).toBeGreaterThan(0);
  expect(inputsExpired.length).toBeGreaterThan(0);
  expect(inputsAfterExpiry.length).toBeGreaterThan(0);
  expect(inputsB.length).toBeGreaterThan(0);
  expect(inputsA.some(input => input.text.includes('TARGET_A_MEMORY_CASE_MARKER'))).toBe(true);
  expect(inputsExpired.every(input => !input.text.includes('TARGET_A_MEMORY_CASE_MARKER'))).toBe(true);
  expect(inputsAfterExpiry.every(input => !input.text.includes('TARGET_A_MEMORY_CASE_MARKER'))).toBe(true);
  expect(inputsB.every(input => !input.text.includes('TARGET_A_MEMORY_CASE_MARKER'))).toBe(true);

  expect((await page.request.get(`${agentUrl}/targets/market-b-sim/memory/cases/${encodeURIComponent(candidate!.id)}`)).status()).toBe(404);
  expect((await page.request.post(`${agentUrl}/targets/market-b-sim/memory/cases/${encodeURIComponent(candidate!.id)}/review`, {
    data: { requestId: 'cross-target-review-denied', expectedRevision: 1, decision: 'rejected', claimCheck: 'supported' },
  })).status()).toBe(404);
  expect((await page.request.get(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(sourceRunId)}/evidence/${encodeURIComponent(evidenceRef.evidenceId)}`)).status()).toBe(404);
});

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Target Run card.');
  return value.trim();
}

async function waitForTargetRun(page: Page, targetId: string, runId: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`${agentUrl}/targets/${targetId}/runs/${encodeURIComponent(runId)}`);
    if (!response.ok()) return 'missing';
    return (await response.json() as { status: string }).status;
  }).toBe('completed');
}

function waitForTargetStart(page: Page, targetId: string): Promise<string> {
  return page.waitForResponse(async response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/targets/${targetId}/runs` && response.status() === 202)
    .then(async response => (await response.json() as { runId: string }).runId);
}
