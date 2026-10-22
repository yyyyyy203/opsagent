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

test('Target knowledge can be reviewed, published, recalled by A, and stays isolated from B', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目巡检' })).toBeVisible();
  await page.getByRole('tab', { name: '系统知识' }).click();
  const manager = page.getByRole('tabpanel', { name: '系统知识' });
  await expect(manager.getByText('当前 Target 尚无已发布知识')).toBeVisible();

  await manager.getByLabel('来源 ID').fill('local-settlement-runbook');
  await manager.getByLabel('来源版本').fill('v1');
  await manager.getByLabel('来源 SHA-256').fill('c'.repeat(64));
  await manager.getByLabel('系统知识内容 JSON').fill(JSON.stringify({
    type: 'metric_definition', metricName: 'settlement_window_requests',
    businessMeaning: 'BROWSER_KNOWLEDGE_CANARY: local synthetic settlement request count.',
    unit: 'requests per fixed window', labels: [], allowedAggregations: ['count'],
    windowSemantics: ['fixed_window'], sourceReferences: [{ sourceId: 'local-settlement-runbook',
      sourceVersion: 'v1', digest: 'c'.repeat(64) }],
  }));
  await manager.getByRole('button', { name: '创建草稿' }).click();
  const revision = manager.locator('.knowledge-revision').filter({ hasText: 'BROWSER_KNOWLEDGE_CANARY' });
  await expect(revision).toBeVisible();
  await revision.getByRole('button', { name: '提交审核' }).click();
  await expect(revision).toContainText('审核中');
  await revision.getByRole('button', { name: '批准' }).click();
  await expect(revision).toContainText('已批准');
  await revision.getByRole('button', { name: '选入下一次发布' }).click();
  await manager.getByRole('button', { name: '独立发布到此 Target' }).click();
  await expect(manager.getByText('Target 已有独立发布的知识绑定')).toBeVisible();

  await page.getByLabel('巡检问题').fill('Inspect settlement metric definition and failure rate.');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.locator('.status-hero')).toContainText('已完成');
  await expect(page.locator('.message-text').filter({ hasText: '模型输入已包含 BROWSER_KNOWLEDGE_CANARY' })).toBeVisible();

  await page.getByLabel('选择巡检 Target').selectOption('market-b-sim');
  await page.getByRole('tab', { name: '系统知识' }).click();
  const targetBManager = page.getByRole('tabpanel', { name: '系统知识' });
  await expect(targetBManager.locator('.knowledge-revision').filter({ hasText: 'BROWSER_KNOWLEDGE_CANARY' })).toHaveCount(0);
  await expect(targetBManager.getByText('当前 Target 尚无已发布知识')).toBeVisible();
});

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Target Run card.');
  return value.trim();
}
