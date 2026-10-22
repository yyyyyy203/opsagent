import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = `http://127.0.0.1:${process.env.AGENTOPS_LOCAL_INSPECTION_AGENT_PORT ?? '45700'}`;

test('ordinary Target workspace completes dual-source inspections for A and B with isolated evidence', async ({ page }) => {
  const evidenceResponses: string[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname.includes('/evidence')) evidenceResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目巡检' })).toBeVisible();
  const targetPicker = page.getByLabel('选择巡检 Target');
  await expect(targetPicker).toHaveValue('market-a-sim');

  await page.getByLabel('巡检问题').fill('检查 Market A 模拟结算失败率和对应日志。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.locator('.status-hero')).toContainText('已完成');
  const runA = await selectedRunId(page);
  const detailResponse = await page.request.get(`${agentUrl}/targets/market-a-sim/runs/${encodeURIComponent(runA)}`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json() as { childRunIds: string[] };
  expect(detail.childRunIds).toHaveLength(2);
  for (const childRunId of detail.childRunIds) {
    const childDetailResponse = await page.request.get(`${agentUrl}/targets/market-a-sim/runs/${encodeURIComponent(childRunId)}`);
    expect(childDetailResponse.status()).toBe(200);
    const childDetail = await childDetailResponse.json() as { status: string; evidenceIds: string[]; failure?: unknown };
    const childEvidence = await page.request.get(`${agentUrl}/targets/market-a-sim/runs/${encodeURIComponent(childRunId)}/evidence`);
    expect(childEvidence.status(), await childEvidence.text()).toBe(200);
    const pageBody = await childEvidence.json() as { items: unknown[] };
    expect(pageBody.items, `${childRunId} detail=${JSON.stringify(childDetail)}`).toHaveLength(1);
  }
  await expect(page.locator('.evidence-card'), JSON.stringify(evidenceResponses)).toHaveCount(2);
  const evidenceA = page.locator('.evidence-card');
  const metricA = evidenceA.filter({ has: page.getByText('metric', { exact: true }) });
  await expect(metricA).toContainText('"threshold":0.05');
  await expect(metricA).toContainText('"thresholdReached":false');
  await expect(evidenceA.filter({ has: page.getByText('log', { exact: true }) })).toContainText('recordCount: 1');
  await targetPicker.selectOption('market-b-sim');
  await expect(page.locator('.evidence-card')).toHaveCount(0);
  await page.getByLabel('巡检问题').fill('检查 Market B 模拟结算失败率和对应日志。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.locator('.status-hero')).toContainText('已完成');
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  const evidenceB = page.locator('.evidence-card');
  const metricB = evidenceB.filter({ has: page.getByText('metric', { exact: true }) });
  await expect(metricB).toContainText('"threshold":0.02');
  await expect(metricB).toContainText('"thresholdReached":true');
  await expect(evidenceB.filter({ has: page.getByText('log', { exact: true }) })).toContainText('recordCount: 1');
  const runB = await selectedRunId(page);
  expect(runB).not.toBe(runA);

  expect((await page.request.get(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(runA)}`)).status()).toBe(404);
  expect((await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runA)}`)).status()).toBe(404);
  expect((await page.request.get(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(detail.childRunIds[0]!)}/evidence`)).status()).toBe(404);
  expect((await page.request.post(`${agentUrl}/targets/market-b-sim/runs/${encodeURIComponent(runA)}/cancel`)).status()).toBe(404);
  await targetPicker.selectOption('market-a-sim');
  await expect(page.locator('.run-card').filter({ hasText: runA })).toBeVisible();
  await expect(page.locator('.run-card').filter({ hasText: runB })).toHaveCount(0);
  await page.locator('.run-card').filter({ hasText: runA }).click();
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  await expect(page.locator('.evidence-card').filter({ has: page.getByText('metric', { exact: true }) }))
    .toContainText('"threshold":0.05');
});

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Target Run card.');
  return value.trim();
}
