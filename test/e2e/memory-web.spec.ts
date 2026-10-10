import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

const agentUrl = `http://127.0.0.1:${process.env.AGENTOPS_MEMORY_E2E_AGENT_PORT ?? '45400'}`;
const controlUrl = `http://127.0.0.1:${process.env.AGENTOPS_MEMORY_E2E_CONTROL_PORT ?? '45474'}`;

test('manual capture, review, explicit recall, revocation, and later no-recall are independent', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();
  await expect(page.getByLabel('本次沉淀')).toHaveValue('manual');
  await expect(page.getByLabel('使用已审核历史参考')).not.toBeChecked();

  const firstRunRequestPromise = page.waitForRequest(isRunStartRequest);
  const firstRunId = await startRun(page, '第一轮：手动沉淀且关闭历史参考。');
  expect((await firstRunRequestPromise).postDataJSON()).toMatchObject({
    memoryPreferences: { capture: 'manual', recall: 'disabled' },
  });
  await expect(page.getByText('已完成')).toBeVisible();
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('已保存候选')).toBeVisible();
  await expect(page.getByText('仅模拟环境可用，不可晋级')).toBeVisible();
  await page.getByRole('button', { name: '批准历史参考' }).click();
  await expect(page.getByRole('article').filter({ hasText: firstRunId }).getByText('已批准', { exact: true })).toBeVisible();
  expect(await runMemory(page, firstRunId)).toBeNull();

  await restartMemoryRuntime(page, true);
  await page.reload();
  await expect(page.getByRole('article').filter({ hasText: firstRunId }).getByText('已批准', { exact: true })).toBeVisible();
  expect(await runMemory(page, firstRunId)).toBeNull();

  await page.getByLabel('使用已审核历史参考').check();
  const secondRunRequestPromise = page.waitForRequest(isRunStartRequest);
  const secondRunId = await startRun(page, '第二轮：结算失败率升高，连接池等待增加；明确打开已审核历史参考。');
  expect((await secondRunRequestPromise).postDataJSON()).toMatchObject({
    memoryPreferences: { capture: 'manual', recall: 'enabled' },
  });
  await expect.poll(async () => runMemory(page, secondRunId)).toMatchObject({ selectionState: 'selected', availability: 'ready' });
  await expect(page.getByText('历史参考已载入')).toBeVisible();

  await page.getByRole('button', { name: '撤销历史参考' }).click();
  await expect(page.getByRole('article').filter({ hasText: firstRunId }).getByText('已拒绝', { exact: true })).toBeVisible();
  const thirdRunId = await startRun(page, '第三轮：结算失败率升高，连接池等待增加；撤销后不应召回已审核历史。');
  await expect.poll(async () => runMemory(page, thirdRunId)).toMatchObject({ selectionState: 'selected', availability: 'empty', hints: [] });
  await expect(page.getByText('没有可用的历史参考')).toBeVisible();
});

test('rejected candidates leave review and are not recalled', async ({ page }) => {
  await page.goto('/');
  const rejectedRunId = await startRun(page, '第一轮：结算失败率升高，连接池等待增加。');
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  const rejectedCase = page.getByRole('article').filter({ hasText: rejectedRunId });
  await expect(rejectedCase.getByText('待审核', { exact: true })).toBeVisible();
  await rejectedCase.getByRole('button', { name: '拒绝候选' }).click();
  await expect(rejectedCase.getByText('已拒绝', { exact: true })).toBeVisible();
  await expect(rejectedCase.getByRole('button', { name: '批准历史参考' })).toHaveCount(0);
  await expect(rejectedCase.getByRole('button', { name: '拒绝候选' })).toHaveCount(0);

  await page.getByLabel('使用已审核历史参考').check();
  const nextRunId = await startRun(page, '第二轮：结算失败率升高，连接池等待增加；只允许批准案例进入历史参考。');
  await expect.poll(async () => runMemory(page, nextRunId)).toMatchObject({
    selectionState: 'selected', availability: 'empty', hints: [],
  });
});

test('skip policy still allows explicit manual capture afterward', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('本次沉淀').selectOption('skip');
  const runRequest = page.waitForRequest(isRunStartRequest);
  const runId = await startRun(page, '跳过自动沉淀后仍可人工保存。');
  expect((await runRequest).postDataJSON()).toMatchObject({
    memoryPreferences: { capture: 'skip', recall: 'disabled' },
  });
  expect(await runCapture(page, runId)).toMatchObject({ state: 'not_saved' });

  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('已保存候选')).toBeVisible();
  expect(await runCapture(page, runId)).toMatchObject({ state: 'saved' });
});

test('case evidence reference opens the source Run evidence summary', async ({ page }) => {
  await page.goto('/');
  const sourceRunId = await startRun(page, '来源 Run：结算失败率升高，连接池等待增加。');
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  const sourceCase = page.getByRole('article').filter({ hasText: sourceRunId });
  await expect(sourceCase.getByText('待审核', { exact: true })).toBeVisible();
  const evidenceId = `memory-evidence-${sourceRunId}`;
  await expect(sourceCase.getByRole('button', { name: new RegExp(evidenceId) })).toBeVisible();

  const otherRunId = await startRun(page, '切换到另一个 Run 后再打开来源证据。');
  expect(otherRunId).not.toBe(sourceRunId);
  await sourceCase.getByRole('button', { name: new RegExp(evidenceId) }).click();
  await expect(page.locator('.run-card.selected code')).toHaveText(sourceRunId);
  await expect(page.locator('.evidence-panel')).toContainText('证据摘要');
  await expect(page.locator('.evidence-panel')).toContainText(`Run ${sourceRunId}`);
  await expect(page.locator('.evidence-panel')).toContainText(evidenceId);
});

test('capture command conflict refreshes ticket state without resubmitting', async ({ page }) => {
  await page.goto('/');
  const runId = await startRun(page, '并发状态变化时仅提交一次沉淀命令。');
  let captureCommands = 0;
  let captureTicketReads = 0;
  await page.route('**/runs/*/memory/capture', async (route) => {
    if (route.request().method() === 'GET') {
      captureTicketReads += 1;
      await route.continue();
      return;
    }
    captureCommands += 1;
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
      error: 'MEMORY_REVISION_CONFLICT', message: 'The source Run changed after it was read.',
    }) });
  });

  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('本次巡检状态已更新，已刷新版本；请检查后再发起沉淀。')).toBeVisible();
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  expect(captureCommands).toBe(1);
  expect(captureTicketReads).toBeGreaterThanOrEqual(2);
  expect(await runCapture(page, runId)).toMatchObject({ state: 'not_saved' });
});

test('自动沉淀保存一次且刷新只读', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('本次沉淀').selectOption('automatic');
  const runId = await startRun(page, '自动沉淀与手动保存去重。');
  await expect(page.getByText('已保存候选')).toBeVisible();
  await expect(page.getByRole('button', { name: '沉淀本次巡检' })).toBeDisabled();
  const savedTicket = await runCapture(page, runId) as {
    state: string; memoryId?: string; sourceCheckpointRevision?: number;
  };
  expect(savedTicket).toMatchObject({ state: 'saved' });
  expect(savedTicket.memoryId).toBeTruthy();
  expect(savedTicket.sourceCheckpointRevision).toBeGreaterThan(0);

  const manualCapture = await page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/memory/capture`, {
    data: { requestId: `manual-after-auto-${runId}`, expectedCheckpointRevision: savedTicket.sourceCheckpointRevision },
  });
  expect(manualCapture.ok()).toBe(true);
  expect(await manualCapture.json()).toMatchObject({ state: 'saved', memoryId: savedTicket.memoryId });
  const before = await page.request.get(`${agentUrl}/memory/cases?profileId=simulation&limit=50`);
  const listBefore = await before.json() as Array<{ id: string }>;
  expect(listBefore.filter((item) => item.id === savedTicket.memoryId)).toHaveLength(1);
  await page.reload();
  await page.locator('.run-card').filter({ hasText: runId }).click();
  await expect(page.getByText('已保存候选')).toBeVisible();
  await expect(page.getByRole('button', { name: '沉淀本次巡检' })).toBeDisabled();
  expect(await runCapture(page, runId)).toMatchObject({ state: 'saved' });
  const after = await page.request.get(`${agentUrl}/memory/cases?profileId=simulation&limit=50`);
  expect(await after.json()).toHaveLength(listBefore.length);
});

test('review conflict refreshes the candidate and never resubmits automatically', async ({ page }) => {
  await page.goto('/');
  const runId = await startRun(page, '审核并发变化时只提交一次。');
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  const candidate = page.getByRole('article').filter({ hasText: runId });
  await expect(candidate.getByText('待审核', { exact: true })).toBeVisible();
  let reviewCommands = 0;
  await page.route('**/memory/cases/*/review', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    reviewCommands += 1;
    if (reviewCommands === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        error: 'MEMORY_REVISION_CONFLICT', message: 'The memory case changed after it was read.',
      }) });
      return;
    }
    await route.continue();
  });

  await candidate.getByRole('button', { name: '批准历史参考' }).click();
  await expect(page.getByText('案例版本已变化，已刷新最新状态；请确认后重新操作。')).toBeVisible();
  await expect(candidate.getByText('待审核', { exact: true })).toBeVisible();
  expect(reviewCommands).toBe(1);

  await candidate.getByRole('button', { name: '批准历史参考' }).click();
  await expect(candidate.getByText('已批准', { exact: true })).toBeVisible();
  expect(reviewCommands).toBe(2);
});

test('memory controls recover after disabled capabilities become available', async ({ page }) => {
  await page.goto('/');
  const sourceRunId = await startRun(page, '关闭记忆服务前保存一个已审核案例：结算失败率升高，连接池等待增加。');
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  const sourceCase = page.getByRole('article').filter({ hasText: sourceRunId });
  await sourceCase.getByRole('button', { name: '批准历史参考' }).click();
  await expect(sourceCase.getByText('已批准', { exact: true })).toBeVisible();

  await restartMemoryRuntime(page, false);
  await page.reload();
  await expect(page.getByLabel('本次沉淀')).toBeDisabled();
  await expect(page.getByText('记忆服务未启用；请管理员一次性启用后使用。')).toBeVisible();
  await page.getByLabel('巡检问题').fill('服务未启用时仍可继续巡检。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText('已完成')).toBeVisible();

  await restartMemoryRuntime(page, true);
  await page.reload();
  await expect(page.getByLabel('本次沉淀')).toBeEnabled();
  const preservedCase = page.getByRole('article').filter({ hasText: sourceRunId });
  await expect(preservedCase.getByText('已批准', { exact: true })).toBeVisible();
  await page.getByLabel('使用已审核历史参考').check();
  const recoveredRunId = await startRun(page, '记忆服务恢复后核对结算失败率升高、连接池等待增加。');
  await expect.poll(async () => runMemory(page, recoveredRunId)).toMatchObject({
    selectionState: 'selected', availability: 'ready',
  });
  await expect(page.getByText('历史参考已载入')).toBeVisible();
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByRole('article').filter({ hasText: recoveredRunId }).getByText('待审核', { exact: true })).toBeVisible();
});

test('capacity errors are shown without automatically resubmitting capture', async ({ page }) => {
  await page.goto('/');
  const runId = await startRun(page, '记忆容量达到上限时应提示且不重试。');
  let captureCommands = 0;
  await page.route('**/runs/*/memory/capture', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    captureCommands += 1;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
      error: 'MEMORY_CAPACITY_EXCEEDED', message: 'Memory capacity is exceeded.',
    }) });
  });

  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  await expect(page.getByText('记忆存储容量已满，请清理旧案例后重试。')).toBeVisible();
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  expect(captureCommands).toBe(1);
  expect(await runCapture(page, runId)).toMatchObject({ state: 'not_saved' });
});

test('failed investigations are listed for archive and cannot be approved', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('巡检问题').fill('模拟失败调查：仅供归档。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.locator('.status-hero strong')).toHaveText('失败');
  const failedRunId = await selectedRunId(page);
  await page.getByRole('button', { name: '沉淀本次巡检' }).click();
  const failedCase = page.getByRole('article').filter({ hasText: failedRunId });
  await expect(failedCase.getByText('失败调查，仅供归档，不可批准召回')).toBeVisible();
  await expect(failedCase.getByRole('button', { name: '批准历史参考' })).toBeDisabled();
});

test('disabled memory keeps existing inspection usable and explains the one-time setup', async ({ page }) => {
  test.skip(process.env.AGENTOPS_MEMORY_E2E_DISABLED !== '1', 'requires the isolated disabled-memory fixture');
  await page.goto('/');
  await expect(page.getByLabel('本次沉淀')).toBeDisabled();
  await expect(page.getByText('记忆服务未启用；请管理员一次性启用后使用。')).toBeVisible();
  await page.getByLabel('巡检问题').fill('记忆服务关闭时仍可巡检。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
});

async function startRun(page: Page, message: string): Promise<string> {
  await page.getByLabel('巡检问题').fill(message);
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  return selectedRunId(page);
}

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Run card.');
  return value.trim();
}

async function runMemory(page: Page, runId: string): Promise<Record<string, unknown> | null> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/memory`);
  expect(response.ok()).toBe(true);
  return await response.json() as Record<string, unknown> | null;
}

async function runCapture(page: Page, runId: string): Promise<unknown> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/memory/capture`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function restartMemoryRuntime(page: Page, enabled: boolean): Promise<void> {
  const response = await page.request.post(`${controlUrl}/restart`, { data: { memoryEnabled: enabled } });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ status: 'ready', memoryEnabled: enabled });
}

function isRunStartRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/runs';
}
