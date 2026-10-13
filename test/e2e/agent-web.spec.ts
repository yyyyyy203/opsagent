import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = process.env.AGENTOPS_E2E_AGENT_URL ?? `http://127.0.0.1:${process.env.AGENTOPS_E2E_AGENT_PORT ?? '45100'}`;

test('creates a Run, handles guarded confirmation, resumes explicitly, and reloads history', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  await page.getByLabel('巡检问题').fill('检查结算失败率，并收集一份可审计的模拟指标证据。');
  await page.getByRole('button', { name: '开始巡检' }).click();

  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  await expect(page.getByText('等待确认')).toBeVisible();
  await page.getByRole('button', { name: '批准' }).click();
  await expect(page.getByRole('button', { name: '继续调查' })).toBeVisible();

  await page.getByRole('button', { name: '继续调查' }).click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
  await expect(page.getByText('工具结果')).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
  await expect(page.getByText('未提供知识资格信息')).toBeVisible();
  await expect(page.locator('.run-card')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.run-card')).toHaveCount(1);
  await page.locator('.run-card').click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
});

test('rejects a guarded call, then requires an explicit resume before finishing', async ({ page }) => {
  await startPendingRun(page, '拒绝一次模拟指标查询并验证恢复状态。');

  await page.getByRole('button', { name: '拒绝' }).click();
  await expect(page.getByRole('button', { name: '继续调查' })).toBeVisible();

  await page.getByRole('button', { name: '继续调查' }).click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
});

test('keeps two pending Runs isolated when switching the selected Run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  const firstRunId = await startPendingRun(page, '隔离 Run 一：等待指标确认。');
  await page.getByLabel('巡检问题').fill('隔离 Run 二：等待另一份指标确认。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  const secondRunId = await selectedRunId(page);

  expect(secondRunId).not.toBe(firstRunId);
  await expect.poll(async () => page.locator('.run-card').count()).toBeGreaterThanOrEqual(2);
  await page.locator('.run-card').filter({ hasText: firstRunId }).click();
  await expect(page.locator('.confirmation-copy code')).toContainText(firstRunId);
  await page.locator('.run-card').filter({ hasText: secondRunId }).click();
  await expect(page.locator('.confirmation-copy code')).toContainText(secondRunId);
});

test('serializes duplicate confirmation commands with a revision conflict', async ({ page }) => {
  await startPendingRun(page, '验证同一确认请求的重复提交。');
  const runId = await selectedRunId(page);
  const confirmationResponse = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/confirmation`);
  expect(confirmationResponse.ok()).toBe(true);
  const confirmation = readConfirmation(await confirmationResponse.json() as unknown);

  const decide = () => page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/confirmation`, {
    data: { toolCallId: confirmation.toolCallId, confirmed: true, expectedRevision: confirmation.expectedRevision },
  });
  const [first, second] = await Promise.all([decide(), decide()]);
  expect([first.status(), second.status()].sort()).toEqual([200, 409]);

  const resume = await page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/resume`);
  expect(resume.status()).toBe(202);
  await expect.poll(async () => {
    const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}`);
    return readRunStatus(await response.json() as unknown);
  }).toBe('completed');
});

test('shows retry, open circuit, probe waiting, and recovered source states', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('巡检问题').fill('熔断恢复演练：验证模拟数据源重试、熔断和恢复。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  await page.getByRole('button', { name: '批准' }).click();
  await page.getByRole('button', { name: '继续调查' }).click();

  await expect(page.getByText('数据源重试中')).toBeVisible();
  await expect(page.getByText('数据源熔断已打开')).toBeVisible();
  await expect(page.getByText('恢复探测待触发')).toBeVisible();
  await expect(page.getByText('数据源已恢复')).toBeVisible();
});

test('keeps approved knowledge separate from Target publication and renders qualification limits', async ({ page }) => {
  let publicationVersion = 0;
  let readinessBlocked = false;
  let publishedReferences: Array<{ id: string; version: string; digest: string; approval: 'approved' }> = [];
  const knowledge = {
    schemaVersion: 1, id: 'metric-checkout-failures', kind: 'semantic', contentRevision: 1, governanceVersion: 2,
    sourceEpoch: 1, status: 'approved', createdAt: '2026-10-10T00:00:00.000Z', contentDigest: 'a'.repeat(64),
    content: { type: 'metric_definition', metricName: 'checkout_failures_total', businessMeaning: '结算失败次数',
      unit: 'count', labels: [], allowedAggregations: ['sum'], windowSemantics: ['fixed_window'],
      sourceReferences: [{ sourceId: 'prometheus-lab', sourceVersion: 'v1', digest: 'b'.repeat(64) }] },
    applicability: { profileRevision: '1', scenarioId: 'window_failure_rate.v1', scenarioVersion: '1',
      serviceIds: ['checkout'], faultTypes: ['settlement_failure'], environment: 'simulation', dataClass: 'simulated', datasetId: 'lab-a' },
    source: { type: 'controlled_runbook', id: 'runbook-settlement', version: 'v1', digest: 'b'.repeat(64), importedAt: '2026-10-10T00:00:00.000Z' },
    review: { reviewedAt: '2026-10-10T00:00:00.000Z', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } },
  };
  await page.route('**/targets', async (route) => route.fulfill({ json: [{ targetId: 'market-a-sim', projectId: 'group-buy-market',
    projectName: '团购系统', deploymentId: 'sim-a', environment: 'simulation', displayName: '模拟 Target',
    description: '本地模拟数据', scenario: { id: 'window_failure_rate.v1', version: '1', serviceId: 'checkout', serviceName: '结算服务' },
    sourceKinds: ['metrics'], readOnly: true, enabled: true, canStart: true }] }));
  await page.route('**/targets/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/readiness')) return route.fulfill({ json: { targetId: 'market-a-sim',
      status: readinessBlocked ? 'blocked' : 'ready', canStart: !readinessBlocked,
      ...(readinessBlocked ? { reasonCode: 'KNOWLEDGE_REQUIRED_DISABLED' } : {}) } });
    if (url.pathname.endsWith('/knowledge/status')) return route.fulfill({ json: { targetId: 'market-a-sim',
      capabilities: { semanticEnabled: !readinessBlocked, proceduralEnabled: true },
      requiredKnowledge: readinessBlocked ? [{ id: 'metric-checkout-failures', version: '1', knowledgeClass: 'semantic' }] : [], publicationVersion,
      publicationState: publicationVersion === 0 ? 'empty' : 'active', references: publishedReferences } });
    if (url.pathname.endsWith('/knowledge') && request.method() === 'GET') {
      return route.fulfill({ json: { items: url.searchParams.get('kind') === 'semantic' ? [knowledge] : [] } });
    }
    if (url.pathname.endsWith('/knowledge/publication') && request.method() === 'POST') {
      const body = request.postDataJSON() as { expectedPublicationVersion: number; references: typeof publishedReferences };
      publicationVersion += 1;
      publishedReferences = body.references;
      return route.fulfill({ json: { targetId: 'market-a-sim', publicationVersion, references: publishedReferences,
        policy: { schemaVersion: 1, targetId: 'market-a-sim', policyVersion: 'default/v1', policyEpoch: 0,
          defaultRequiredness: 'optional', requirements: [] }, publishedAt: '2026-10-13T00:00:00.000Z' } });
    }
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: '系统知识' }).click();
  await expect(page.getByLabel('目标系统')).toHaveValue('market-a-sim');
  await expect(page.getByText('批准不等于启用')).toBeVisible();
  await expect(page.getByText('已批准 · 尚未发布到当前 Target')).toBeVisible();
  await page.getByRole('button', { name: '选入下一次发布' }).click();
  await expect(page.getByRole('button', { name: '独立发布到此 Target' })).toBeEnabled();
  await page.getByRole('button', { name: '独立发布到此 Target' }).click();
  await expect(page.getByText('已发布到当前 Target')).toBeVisible();
  await expect(page.getByRole('button', { name: /执行.*模板/u })).toHaveCount(0);

  readinessBlocked = true;
  await page.getByRole('button', { name: '刷新知识' }).click();
  await expect(page.getByText('必需知识能力未启用，当前不能启动巡检')).toBeVisible();
  await expect(page.getByText('系统知识能力未启用')).toBeVisible();
  await expect(page.getByText('必需知识：metric-checkout-failures@1')).toBeVisible();
});

async function startPendingRun(page: Page, message: string): Promise<string> {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.getByLabel('巡检问题').fill(message);
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  return selectedRunId(page);
}

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Run card.');
  return value.trim();
}

function readConfirmation(value: unknown): { toolCallId: string; expectedRevision: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid confirmation response.');
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId !== 'string' || typeof record.expectedRevision !== 'number') throw new Error('Invalid confirmation response.');
  return { toolCallId: record.toolCallId, expectedRevision: record.expectedRevision };
}

function readRunStatus(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Run response.');
  const status = (value as Record<string, unknown>).status;
  if (typeof status !== 'string') throw new Error('Invalid Run status.');
  return status;
}
