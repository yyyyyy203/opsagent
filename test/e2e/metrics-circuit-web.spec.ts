import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = `http://127.0.0.1:${process.env.AGENTOPS_CIRCUIT_E2E_AGENT_PORT ?? '45300'}`;
const controlUrl = `http://127.0.0.1:${process.env.AGENTOPS_CIRCUIT_E2E_CONTROL_PORT ?? '45301'}`;

test('reopens the source circuit after a failed probe and recovers only after a new cooldown', async ({ page }) => {
  const initialState = await readControlState(page);
  if (process.env.AGENTOPS_CIRCUIT_E2E_EXPECT_PROMETHEUS === '1') {
    expect(initialState.sourceMode).toBe('prometheus');
  }
  await page.clock.install({ time: new Date(initialState.clockNow) });

  const prematureAdvance = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 29_999 } });
  expect(prematureAdvance.status()).toBe(409);

  const fault = await page.request.put(`${controlUrl}/__fault`, { data: { failures: 9 } });
  expect(fault.status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  const firstParent = await startRun(page, '验证模拟结算数据源故障时的重试和熔断。');
  const firstChild = await waitForChildRun(page, firstParent);
  await openChildRun(page, firstChild);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源重试中' })).toHaveCount(6);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源熔断已打开' })).toHaveCount(1);

  const afterOpen = await readControlState(page);
  expect(afterOpen.remainingFailures).toBe(0);
  expect(afterOpen.sourceQueries).toBe(0);

  const secondParent = await startRun(page, '确认熔断打开期间新 Run 不再访问指标来源。');
  const secondChild = await waitForChildRun(page, secondParent);
  await openChildRun(page, secondChild);
  const whileOpen = await readControlState(page);
  expect(whileOpen.remainingFailures).toBe(0);
  expect(whileOpen.sourceQueries).toBe(0);
  expect(whileOpen.circuitOpenResultsObserved).toBe(1);

  const cooldownBoundary = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 29_999 } });
  expect(cooldownBoundary.status()).toBe(200);
  await page.clock.pauseAt(new Date(initialState.clockNow + 29_999));
  await openChildRun(page, firstChild);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源熔断已打开' })).toHaveCount(1);
  await expect(page.getByText('恢复探测待触发')).toHaveCount(0);

  const thirdParent = await startRun(page, '确认冷却还差 1 毫秒时熔断仍会阻止指标来源查询。');
  const thirdChild = await waitForChildRun(page, thirdParent);
  await openChildRun(page, thirdChild);
  const beforeCooldownEnd = await readControlState(page);
  expect(beforeCooldownEnd.sourceQueries).toBe(0);
  expect(beforeCooldownEnd.circuitOpenResultsObserved).toBe(2);

  const finalMillisecond = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 1 } });
  expect(finalMillisecond.status()).toBe(200);
  await page.clock.pauseAt(new Date(initialState.clockNow + 30_000));
  await openChildRun(page, firstChild);
  await expect(page.getByText('恢复探测待触发')).toBeVisible();

  const prematureSecondCooldown = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 29_999 } });
  expect(prematureSecondCooldown.status()).toBe(409);
  const probeFault = await page.request.put(`${controlUrl}/__fault`, { data: { failures: 1 } });
  expect(probeFault.status()).toBe(200);
  const duplicateProbeFault = await page.request.put(`${controlUrl}/__fault`, { data: { failures: 1 } });
  expect(duplicateProbeFault.status()).toBe(409);
  expect((await readControlState(page)).remainingFailures).toBe(1);

  const failedProbeParent = await startRun(page, '验证半开探测失败后重新熔断且不追加重试。');
  const failedProbeChild = await waitForChildRun(page, failedProbeParent);
  await openChildRun(page, failedProbeChild);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源熔断已打开' })).toHaveCount(1);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源重试中' })).toHaveCount(0);
  await expect(page.getByText('数据源已恢复')).toHaveCount(0);
  await expect(page.getByText('恢复探测待触发')).toHaveCount(0);
  const afterFailedProbe = await readControlState(page);
  // Only one failure is injected: an accidental retry would succeed and increment sourceQueries.
  expect(afterFailedProbe.remainingFailures).toBe(0);
  expect(afterFailedProbe.sourceQueries).toBe(0);
  await expectNoEvidence(page, failedProbeParent);
  await expectNoEvidence(page, failedProbeChild);

  const reopenedParent = await startRun(page, '确认探测失败后的新 Run 被重新打开的熔断器阻止。');
  const reopenedChild = await waitForChildRun(page, reopenedParent);
  await openChildRun(page, reopenedChild);
  const afterReopen = await readControlState(page);
  expect(afterReopen.sourceQueries).toBe(0);
  expect(afterReopen.circuitOpenResultsObserved).toBe(3);

  const secondBoundary = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 29_999 } });
  expect(secondBoundary.status()).toBe(200);
  await page.clock.pauseAt(new Date(initialState.clockNow + 59_999));
  await openChildRun(page, failedProbeChild);
  await expect(page.locator('.datasource-block').filter({ hasText: '数据源熔断已打开' })).toHaveCount(1);
  await expect(page.getByText('恢复探测待触发')).toHaveCount(0);
  await expect(page.getByText('数据源已恢复')).toHaveCount(0);

  const stillCoolingParent = await startRun(page, '确认重新熔断冷却还差 1 毫秒时仍不访问来源。');
  const stillCoolingChild = await waitForChildRun(page, stillCoolingParent);
  await openChildRun(page, stillCoolingChild);
  const beforeSecondCooldownEnd = await readControlState(page);
  expect(beforeSecondCooldownEnd.sourceQueries).toBe(0);
  expect(beforeSecondCooldownEnd.circuitOpenResultsObserved).toBe(4);

  const secondFinalMillisecond = await page.request.post(`${controlUrl}/__advance-time`, { data: { milliseconds: 1 } });
  expect(secondFinalMillisecond.status()).toBe(200);
  await page.clock.pauseAt(new Date(initialState.clockNow + 60_000));
  await openChildRun(page, failedProbeChild);
  await expect(page.getByText('恢复探测待触发')).toBeVisible();
  await expect(page.getByText('数据源已恢复')).toHaveCount(0);
  expect((await readControlState(page)).sourceQueries).toBe(0);

  const recoveryParent = await startRun(page, '验证第二次冷却后只进行一次成功探测并采集证据。');
  const recoveryChild = await waitForChildRun(page, recoveryParent);
  await openChildRun(page, recoveryChild);
  await expect(page.getByText('数据源已恢复')).toBeVisible();
  await expect(page.getByText(/status: breached/)).toBeVisible();

  const recovered = await readControlState(page);
  expect(recovered.remainingFailures).toBe(0);
  expect(recovered.sourceQueries).toBe(1);
  expect(recovered.scriptedModelCalls).toBeGreaterThan(0);
  if (process.env.AGENTOPS_CIRCUIT_E2E_EXPECT_PROMETHEUS === '1') {
    expect(recovered.latestSnapshot).toEqual({ status: 'available', total: 100, failed: 15 });
  }

  const child = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(recoveryChild)}`) as { evidenceIds?: unknown };
  const childEvidenceIds = child.evidenceIds;
  if (!Array.isArray(childEvidenceIds) || typeof childEvidenceIds[0] !== 'string') {
    throw new Error('Recovered Metrics child did not persist exactly one evidence reference.');
  }
  expect(childEvidenceIds).toHaveLength(1);
  const evidenceId = childEvidenceIds[0];
  const evidencePage = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(recoveryChild)}/evidence`);
  expect(JSON.stringify(evidencePage)).toContain(evidenceId);
  expect(JSON.stringify(evidencePage)).not.toContain('CIRCUIT_E2E_PRIVATE_RAW');
  if (process.env.AGENTOPS_CIRCUIT_E2E_EXPECT_PROMETHEUS === '1') {
    expect(JSON.stringify(evidencePage)).not.toContain('settlement_window_requests');
  }
  await expect(page.getByText('CIRCUIT_E2E_PRIVATE_RAW')).toHaveCount(0);

  const parent = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(recoveryParent)}`) as { evidenceIds?: unknown };
  expect(parent.evidenceIds).toContain(evidenceId);
});

async function expectNoEvidence(page: Page, runId: string): Promise<void> {
  const run = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(runId)}`) as { evidenceIds?: unknown };
  expect(run.evidenceIds).toEqual([]);
  const evidence = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(runId)}/evidence`) as { items?: unknown };
  expect(evidence.items).toEqual([]);
}

async function startRun(page: Page, message: string): Promise<string> {
  await page.getByLabel('巡检问题').fill(message);
  await page.getByRole('button', { name: '开始巡检' }).click();
  const runId = await selectedRunId(page);
  await expect.poll(async () => {
    const run = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(runId)}`) as { status?: unknown };
    return run.status;
  }).toBe('completed');
  return runId;
}

async function waitForChildRun(page: Page, parentRunId: string): Promise<string> {
  const parent = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(parentRunId)}`) as { childRunIds?: unknown };
  if (!Array.isArray(parent.childRunIds) || typeof parent.childRunIds[0] !== 'string') {
    throw new Error(`Parent Run ${parentRunId} has no source child.`);
  }
  return parent.childRunIds[0];
}

async function openChildRun(page: Page, childRunId: string): Promise<void> {
  const childButton = page.locator('.child-list button').filter({ hasText: childRunId });
  if (await childButton.count() === 0) {
    const parent = await readJson(page, `${agentUrl}/runs/${encodeURIComponent(childRunId)}`) as { parentRunId?: unknown };
    if (typeof parent.parentRunId !== 'string') throw new Error('Child Run omitted its parent identity.');
    await page.locator('.run-card').filter({ hasText: parent.parentRunId }).click();
  }
  await page.locator('.child-list button').filter({ hasText: childRunId }).click();
  await expect(page.locator('.status-panel .detail-list code').first()).toHaveText(childRunId);
}

async function selectedRunId(page: Page): Promise<string> {
  await expect(page.locator('.run-card.selected code')).toBeVisible();
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Run card.');
  return value.trim();
}

async function readControlState(page: Page): Promise<{
  clockNow: number;
  remainingFailures: number;
  sourceQueries: number;
  scriptedModelCalls: number;
  circuitOpenResultsObserved: number;
  sourceMode?: string;
  latestSnapshot?: { status: string; total?: number; failed?: number };
}> {
  const value = await readJson(page, `${controlUrl}/__state`) as Record<string, unknown>;
  if (typeof value.clockNow !== 'number' || typeof value.remainingFailures !== 'number'
    || typeof value.sourceQueries !== 'number' || typeof value.scriptedModelCalls !== 'number'
    || typeof value.circuitOpenResultsObserved !== 'number') {
    throw new Error('Invalid deterministic circuit E2E control state.');
  }
  return {
    clockNow: value.clockNow,
    remainingFailures: value.remainingFailures,
    sourceQueries: value.sourceQueries,
    scriptedModelCalls: value.scriptedModelCalls,
    circuitOpenResultsObserved: value.circuitOpenResultsObserved,
    ...(typeof value.sourceMode === 'string' ? { sourceMode: value.sourceMode } : {}),
    ...(isSnapshotSummary(value.latestSnapshot) ? { latestSnapshot: value.latestSnapshot } : {}),
  };
}

function isSnapshotSummary(value: unknown): value is { status: string; total?: number; failed?: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.status === 'string'
    && (summary.total === undefined || typeof summary.total === 'number')
    && (summary.failed === undefined || typeof summary.failed === 'number');
}

async function readJson(page: Page, url: string): Promise<unknown> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<unknown>;
}
