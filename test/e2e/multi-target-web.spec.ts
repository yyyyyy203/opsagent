import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = `http://127.0.0.1:${process.env.AGENTOPS_MULTI_TARGET_AGENT_PORT ?? '45600'}`;

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

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Target Run card.');
  return value.trim();
}
