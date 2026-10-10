import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import { createSqlitePersistence } from '../../dist/infrastructure/sqlite/persistence-bundle.js';
import { SqliteDatabase } from '../../dist/infrastructure/sqlite/database.js';
import { createSqliteDiagnosticMemoryRepository, SqliteDiagnosticMemoryStore } from '../../dist/infrastructure/sqlite/diagnostic-memory-store.js';
import { EventFactoryV2 } from '../../dist/event/v2/event-factory.js';
import { ScriptedModel } from '../../dist/model/scripted-model.js';
import { checkpointChecksum, parseAgentContext } from '../../dist/storage/durable-codec.js';

const NOW = '2026-10-11T12:00:00.000Z';
const RAW_MARKER = 'PRIVATE_RAW_MEMORY_FIXTURE_DO_NOT_EXPOSE';
const ORACLE_MARKER = 'ORACLE_EXPECTED_ROOT_CAUSE_MUST_NOT_ENTER_AGENT_CONTEXT';
const CAPTURED_MEMORY_MARKER = 'CAPTURED_EPISODIC_RESULT_UNIQUE_91';
const SAFE_ACCEPTANCE_FAILURE_CODES = new Set([
  'ERR_ASSERTION',
  'ERR_DLOPEN_FAILED',
  'MEMORY_ACCEPTANCE_CAPTURE_TIMEOUT',
  'MEMORY_ACCEPTANCE_EXTERNAL_REQUEST_FORBIDDEN',
  'MEMORY_ACCEPTANCE_INTERNAL_ERROR',
  'MEMORY_ACCEPTANCE_RUN_CANCELLED',
  'MEMORY_ACCEPTANCE_RUN_FAILED',
  'MEMORY_ACCEPTANCE_RUN_TIMEOUT',
]);
const CHECK_NAMES = [
  'captureOnce', 'manualCaptureWithoutRecall', 'captureRecallMatrix', 'sourceRunUnchanged',
  'failedArchiveNeverRecalled', 'approvedOnly', 'scopeIsolation', 'resumeRevalidation',
  'noRawPublicData', 'transactionRollback', 'staleWorkerRejected', 'noOracleLeak', 'disabledBaseline',
];

const clock = { now: () => new Date(NOW) };
const scopeA = simulatedScope('simulation', 'memory-lab-a');
const scopeB = simulatedScope('simulation-alt', 'memory-lab-b');
const liveScope = {
  profileId: 'group-buy-market', profileRevision: 'gbm-v1', serviceId: 'settlement',
  faultType: 'settlement_failure', targetFingerprint: 'c'.repeat(64), environment: 'production', dataClass: 'live',
};
const scopes = [scopeA, scopeB, liveScope];
const memoryConfig = {
  enabled: true,
  profiles: scopes.map(scope => ({ scope, profilePolicyRevision: 'policy-v1', captureDefault: 'manual',
    recallDefault: false, allowAutomaticCapture: true, allowRecall: true })),
  requiredSources: ['metric'], modelWindowTokens: 32_768, reservedOutputTokens: 4_096,
};

class RecordingScriptedModel extends ScriptedModel {
  requests = [];

  async *stream(messages, tools, options) {
    this.requests.push(globalThis.structuredClone(messages));
    const stream = super.stream(messages, tools, options);
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
      yield next.value;
    }
  }
}

export async function runMemoryAcceptance({ request = globalThis.fetch } = {}) {
  const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, false]));
  const originalGlobalFetch = globalThis.fetch;
  const boundary = createOfflineFetchBoundary(request);
  const offlineRequest = boundary.fetch;
  request = offlineRequest;
  globalThis.fetch = offlineRequest;
  let root;
  let runtime;
  let disabledRuntime;
  let strategyMatrix = [];
  try {
    root = await mkdtemp(join(tmpdir(), 'agentops-memory-acceptance-'));
    const dataDirectory = join(root, 'agent-data');
    const databasePath = join(dataDirectory, 'agent.sqlite');
    await seedNonterminalSources(databasePath);

    const sourceModel = new RecordingScriptedModel([
      { toolCalls: [{ id: 'memory-evidence-call', name: 'fixture.metrics', input: { metric: 'settlement_failure_rate' } }] },
      { text: `结算失败率升高，连接池等待增加。症状码：SETTLEMENT_FAILURE_HIGH；复核标签：${CAPTURED_MEMORY_MARKER}`, toolCalls: [] },
    ]);
    runtime = await startRuntime({ dataDirectory, model: sourceModel, memoryEnabled: true });

    const sourceRunId = 'memory-acceptance-source';
    await startRun(request, runtime.url, { runId: sourceRunId, profileId: scopeA.profileId,
      message: '离线模拟巡检：结算失败率与连接池等待', memoryPreferences: { capture: 'manual', recall: 'disabled' } });
    const completedSource = await waitForRun(request, runtime.url, sourceRunId, 'completed');
    const sourceBefore = await getJson(request, `${runtime.url}/runs/${sourceRunId}`);
    const checkpointBefore = await loadCheckpoint(databasePath, sourceRunId);
    assert.equal(checkpointBefore.context.memoryControl?.capture, 'manual');
    assert.equal(checkpointBefore.context.memoryControl?.recall, false);

    const captureCommand = { requestId: 'memory-acceptance-capture-once', expectedCheckpointRevision: completedSource.revision };
    const firstCapture = await sendJson(request, `${runtime.url}/runs/${sourceRunId}/memory/capture`, captureCommand);
    assert.ok(firstCapture.status === 200 || firstCapture.status === 202);
    const savedTicket = await waitForCapture(request, runtime.url, sourceRunId);
    assert.equal(savedTicket.state, 'saved');
    assert.ok(savedTicket.memoryId);
    const replayCapture = await sendJson(request, `${runtime.url}/runs/${sourceRunId}/memory/capture`, captureCommand);
    assert.equal(replayCapture.status, 200);
    const replayTicket = await getJson(request, `${runtime.url}/runs/${sourceRunId}/memory/capture`);
    assert.equal(replayTicket.memoryId, savedTicket.memoryId);
    const afterCaptureSource = await getJson(request, `${runtime.url}/runs/${sourceRunId}`);
    assert.deepEqual(afterCaptureSource, sourceBefore);
    const observations = await getJson(request, `${runtime.url}/memory/cases?profileId=${scopeA.profileId}&status=observation`);
    assert.ok(observations.some(value => value.id === savedTicket.memoryId));
    assert.ok(JSON.stringify(observations).includes(CAPTURED_MEMORY_MARKER));

    assert.equal(await verifyAutomaticManualCompetition(join(root, 'capture-race.sqlite')), true);
    const beforeApprovalSearch = await searchMainDatabase(databasePath, scopeA, '连接池等待', []);
    assert.equal(beforeApprovalSearch.some(value => value.id === savedTicket.memoryId), false);
    const approved = await sendJson(request, `${runtime.url}/memory/cases/${encodeURIComponent(savedTicket.memoryId)}/review`, {
      profileId: scopeA.profileId, requestId: 'memory-acceptance-approve', expectedRevision: 1,
      decision: 'approved', claimCheck: 'supported',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.eligibleForPromotion, false);
    const afterApprovalSearch = await searchMainDatabase(databasePath, scopeA, '连接池等待', []);
    assert.ok(afterApprovalSearch.some(value => value.id === savedTicket.memoryId));
    await seedOracleCase(databasePath);
    const oracleInOtherScope = await searchMainDatabase(databasePath, scopeB, ORACLE_MARKER, []);
    const oracleInTargetScope = await searchMainDatabase(databasePath, scopeA, ORACLE_MARKER, []);
    assert.ok(oracleInOtherScope.some(value => value.id === 'acceptance-oracle-other-scope'));
    assert.ok(!oracleInTargetScope.some(value => value.id === 'acceptance-oracle-other-scope'));
    checks.captureOnce = true;
    checks.manualCaptureWithoutRecall = true;
    checks.approvedOnly = true;

    const failedCaptureResponse = await sendJson(request, `${runtime.url}/runs/memory-acceptance-failed/memory/capture`, {
      requestId: 'memory-acceptance-failed-capture', expectedCheckpointRevision: 1,
    });
    assert.ok(failedCaptureResponse.status === 200 || failedCaptureResponse.status === 202);
    const failedTicket = await waitForCapture(request, runtime.url, 'memory-acceptance-failed');
    assert.equal(failedTicket.state, 'saved');
    const failedReview = await sendJson(request, `${runtime.url}/memory/cases/${encodeURIComponent(failedTicket.memoryId)}/review`, {
      profileId: scopeA.profileId, requestId: 'memory-acceptance-failed-approval', expectedRevision: 1,
      decision: 'approved', claimCheck: 'supported',
    });
    assert.equal(failedReview.status, 422);
    const approvedAfterFailure = await getJson(request, `${runtime.url}/memory/cases?profileId=${scopeA.profileId}&status=approved`);
    assert.ok(!approvedAfterFailure.some(value => value.id === failedTicket.memoryId));
    const runningCapture = await sendJson(request, `${runtime.url}/runs/memory-acceptance-running/memory/capture`, {
      requestId: 'memory-acceptance-running-capture', expectedCheckpointRevision: 1,
    });
    assert.equal(runningCapture.status, 422);
    checks.failedArchiveNeverRecalled = true;

    await runtime.close();
    runtime = undefined;
    const matrixModel = createCaptureMatrixModel();
    runtime = await startRuntime({ dataDirectory, model: matrixModel, memoryEnabled: true });
    strategyMatrix = await verifyCaptureRecallMatrix({ request, baseUrl: runtime.url, model: matrixModel });
    checks.captureRecallMatrix = true;
    assert.equal(checks.captureRecallMatrix, true);
    checks.scopeIsolation = await verifySearchFixtures(join(root, 'search-fixtures.sqlite'));

    await runtime.close();
    runtime = undefined;
    const recallModel = new RecordingScriptedModel([
      { toolCalls: [{ id: 'memory-resume-confirm-call', name: 'fixture.confirm_probe', input: { confirm: true } }] },
    ]);
    runtime = await startRuntime({ dataDirectory, model: recallModel, memoryEnabled: true });
    const recallRunId = 'memory-acceptance-recall-resume';
    await startRun(request, runtime.url, { runId: recallRunId, profileId: scopeA.profileId,
      message: '调查结算失败与连接池等待', memoryPreferences: { capture: 'skip', recall: 'enabled' } });
    const pausedRun = await waitForRun(request, runtime.url, recallRunId, 'awaiting_confirmation');
    const recallModelInputs = JSON.stringify(recallModel.requests);
    assert.ok(recallModelInputs.includes(CAPTURED_MEMORY_MARKER));
    assert.ok(!recallModelInputs.includes(ORACLE_MARKER));
    const pausedMemory = await getJson(request, `${runtime.url}/runs/${recallRunId}/memory`);
    assert.equal(pausedMemory.selectionState, 'selected');
    assert.ok(pausedMemory.selections.some(value => value.memoryId === savedTicket.memoryId));
    assert.ok(pausedMemory.hints.some(value => value.memoryId === savedTicket.memoryId));

    await runtime.close();
    runtime = undefined;
    const resumedModel = new RecordingScriptedModel([
      { text: '按当前状态重新核验，调查已完成。', toolCalls: [] },
    ]);
    runtime = await startRuntime({ dataDirectory, model: resumedModel, memoryEnabled: true });
    const revoke = await sendJson(request, `${runtime.url}/memory/cases/${encodeURIComponent(savedTicket.memoryId)}/review`, {
      profileId: scopeA.profileId, requestId: 'memory-acceptance-revoke', expectedRevision: 2,
      decision: 'rejected', claimCheck: 'supported',
    });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.status, 'rejected');
    const confirmation = await sendJson(request, `${runtime.url}/runs/${recallRunId}/confirmation`, {
      toolCallId: 'memory-resume-confirm-call', confirmed: true, expectedRevision: pausedRun.revision,
    });
    assert.equal(confirmation.status, 200);
    const resume = await sendJson(request, `${runtime.url}/runs/${recallRunId}/resume`, {});
    assert.equal(resume.status, 202);
    await waitForRun(request, runtime.url, recallRunId, 'completed');
    const revalidatedMemory = await getJson(request, `${runtime.url}/runs/${recallRunId}/memory`);
    assert.equal(revalidatedMemory.selectionState, 'selected');
    assert.ok(revalidatedMemory.selections.some(value => value.memoryId === savedTicket.memoryId));
    assert.equal(revalidatedMemory.hints.length, 0);
    assert.ok(!JSON.stringify(resumedModel.requests).includes(CAPTURED_MEMORY_MARKER));
    checks.resumeRevalidation = true;
    assert.deepEqual(await getJson(request, `${runtime.url}/runs/${sourceRunId}`), sourceBefore);
    checks.sourceRunUnchanged = true;

    const rawEvidence = await getJson(request, `${runtime.url}/runs/${sourceRunId}/evidence`);
    const publicCases = await getJson(request, `${runtime.url}/memory/cases?profileId=${scopeA.profileId}`);
    const publicMemory = JSON.stringify({ rawEvidence, publicCases, pausedMemory, revalidatedMemory });
    assert.ok(!publicMemory.includes(RAW_MARKER));
    const modelInputs = JSON.stringify([
      ...sourceModel.requests, ...matrixModel.requests, ...recallModel.requests, ...resumedModel.requests,
    ]);
    assert.ok(!modelInputs.includes(RAW_MARKER));
    checks.noRawPublicData = true;
    assert.ok(!modelInputs.includes(ORACLE_MARKER));
    assert.ok(!publicMemory.includes(ORACLE_MARKER));
    checks.noOracleLeak = true;

    checks.transactionRollback = await verifyTransactionRollback(join(root, 'rollback.sqlite'));
    checks.staleWorkerRejected = await verifyStaleWorkerFencing(join(root, 'stale-worker.sqlite'));
    assert.equal(checks.transactionRollback, true);
    assert.equal(checks.staleWorkerRejected, true);

    await runtime.close();
    runtime = undefined;
    const disabledDirectory = join(root, 'disabled-data');
    const disabledModel = new RecordingScriptedModel([{ text: '无记忆配置时仍完成只读巡检。', toolCalls: [] }]);
    disabledRuntime = await startRuntime({ dataDirectory: disabledDirectory, model: disabledModel, memoryEnabled: false });
    const capabilities = await getJson(request, `${disabledRuntime.url}/memory/capabilities?profileId=${scopeA.profileId}`);
    assert.equal(capabilities.enabled, false);
    const disabledCapture = await sendJson(request, `${disabledRuntime.url}/runs/unknown/memory/capture`, {
      requestId: 'disabled-capture', expectedCheckpointRevision: 1,
    });
    assert.equal(disabledCapture.status, 503);
    const disabledRunId = 'memory-acceptance-disabled-baseline';
    await startRun(request, disabledRuntime.url, { runId: disabledRunId, profileId: scopeA.profileId,
      message: '无记忆基线巡检', memoryPreferences: { capture: 'skip', recall: 'disabled' } });
    await waitForRun(request, disabledRuntime.url, disabledRunId, 'completed');
    assert.equal(disabledModel.requests.length, 1);
    assert.ok(!JSON.stringify(disabledModel.requests[0]).includes(CAPTURED_MEMORY_MARKER));
    checks.disabledBaseline = true;

    assert.equal(completedSource.status, 'completed');
    return resultFrom(checks, strategyMatrix, boundary.counts());
  } catch (error) {
    const failedChecks = Object.fromEntries(CHECK_NAMES.map(name => [name, false]));
    return { ...resultFrom(failedChecks, [], boundary.counts()), code: safeAcceptanceFailureCode(error) };
  } finally {
    try {
      if (runtime !== undefined) await runtime.close();
      if (disabledRuntime !== undefined) await disabledRuntime.close();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  }
}

export function safeAcceptanceFailureCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && SAFE_ACCEPTANCE_FAILURE_CODES.has(code)
    ? code
    : 'MEMORY_ACCEPTANCE_INTERNAL_ERROR';
}

/** Fails closed before any non-loopback request is sent; redirects cannot escape the boundary. */
export function createOfflineFetchBoundary(delegate) {
  let externalRequestsBlocked = 0;
  const fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const parsed = new URL(rawUrl);
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname.toLowerCase())
      || parsed.username.length > 0 || parsed.password.length > 0) {
      externalRequestsBlocked += 1;
      throw Object.assign(new Error('Offline acceptance blocks external requests.'), {
        code: 'MEMORY_ACCEPTANCE_EXTERNAL_REQUEST_FORBIDDEN',
      });
    }
    return delegate(input, { ...init, redirect: 'error' });
  };
  return { fetch, counts: () => ({ externalRequestsSent: 0, externalRequestsBlocked }) };
}

function resultFrom(checks, strategyMatrix = [], network = { externalRequestsSent: 0, externalRequestsBlocked: 0 }) {
  return { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks,
    strategyMatrix, modelRequestsSent: 0, ...network };
}

function simulatedScope(profileId, datasetId) {
  return { profileId, profileRevision: 'sim-v1', serviceId: 'settlement', faultType: 'settlement_failure',
    targetFingerprint: 'a'.repeat(64), environment: 'simulation', dataClass: 'simulated', datasetId };
}

function sourceContext({ runId, scope, status, summary, capture = 'manual', recall = false }) {
  const stage = status === 'completed' ? 'postmortem' : 'triage';
  return parseAgentContext({
    runId, profileId: scope.profileId, status, stage,
    messages: [{ id: `${runId}-report`, role: 'assistant', createdAt: NOW,
      blocks: [{ type: 'text', text: summary }] }],
    pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds: [], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: NOW, maxIterations: 8, iteration: 1, maxToolCalls: 16,
      toolCallsUsed: 0, maxDurationMs: 60_000 },
    memoryControl: { schemaVersion: 1, scope, profilePolicyRevision: 'policy-v1', capture, recall },
  });
}

async function seedNonterminalSources(databasePath) {
  await mkdir(dirname(databasePath), { recursive: true });
  const persistence = createSqlitePersistence({ path: databasePath, clock });
  try {
    await persistence.checkpoints.save(sourceContext({ runId: 'memory-acceptance-failed', scope: scopeA,
      status: 'failed', summary: '模拟调查未完成，保留为待复核记录。' }), null);
    await persistence.checkpoints.save(sourceContext({ runId: 'memory-acceptance-running', scope: scopeA,
      status: 'running', summary: '尚未结束的调查不得沉淀。' }), null);
  } finally { persistence.close(); }
}

async function startRuntime({ dataDirectory, model, memoryEnabled }) {
  return startAgentWebRuntime({ dataDirectory, workspaceRoots: [dataDirectory], model, clock,
    tools: [
      {
        name: 'fixture.metrics', description: 'Return deterministic in-memory settlement metric evidence.',
        kind: 'evidence', source: 'builtin', inputSchema: z.object({ metric: z.string() }),
        isConcurrencySafe: () => true,
        call: async (_input, options) => {
          const persistence = createSqlitePersistence({ path: join(dataDirectory, 'agent.sqlite'), clock });
          const evidenceId = `memory-evidence-${options.runId}`;
          try {
            await persistence.evidence.save({ evidenceId, runId: options.runId, source: 'metric', capturedAt: NOW,
              businessTraceIds: [], summary: { metric: 'settlement_failure_rate', value: 0.15, start: 1_791_676_800, end: 1_791_677_100 },
              raw: { marker: RAW_MARKER, sample: [0.1, 0.15] } });
          } finally { persistence.close(); }
          return { blocks: [{ type: 'evidence_ref', evidenceId },
            { type: 'json', value: { source: 'metric', observation: 'settlement_failure_rate elevated' } }], evidenceIds: [evidenceId] };
        },
      },
      {
        name: 'fixture.confirm_probe', description: 'Pause for a deterministic resume/revalidation acceptance check.',
        kind: 'utility', source: 'builtin', requireUserConfirm: true,
        inputSchema: z.object({ confirm: z.boolean() }), isConcurrencySafe: () => false,
        call: () => ({ blocks: [{ type: 'text', text: 'fixture confirmation executed' }] }),
      },
    ],
    profiles: scopes.map(scope => ({ id: scope.profileId, name: scope.profileId, description: 'Offline memory acceptance fixture.' })),
    diagnosticMemory: memoryEnabled ? memoryConfig : { enabled: false },
    host: '127.0.0.1',
  });
}

async function startRun(request, baseUrl, body) {
  const result = await sendJson(request, `${baseUrl}/runs`, body);
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'started');
}

async function waitForRun(request, baseUrl, runId, expectedStatus) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = await getJson(request, `${baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (run.status === expectedStatus) return run;
    if (['failed', 'cancelled'].includes(run.status) && run.status !== expectedStatus) {
      throw new Error(`MEMORY_ACCEPTANCE_RUN_${run.status.toUpperCase()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('MEMORY_ACCEPTANCE_RUN_TIMEOUT');
}

async function waitForCapture(request, baseUrl, runId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ticket = await getJson(request, `${baseUrl}/runs/${encodeURIComponent(runId)}/memory/capture`);
    if (ticket.state === 'saved' || ticket.state === 'failed') return ticket;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('MEMORY_ACCEPTANCE_CAPTURE_TIMEOUT');
}

async function guardedLocalRequest(request, url, init) {
  const parsed = new URL(url);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('MEMORY_ACCEPTANCE_EXTERNAL_REQUEST_FORBIDDEN');
  }
  return request(parsed.href, init);
}

async function getJson(request, url) {
  const response = await guardedLocalRequest(request, url);
  const body = await response.json();
  assert.ok(response.ok, `MEMORY_ACCEPTANCE_HTTP_${response.status}`);
  return body;
}

async function sendJson(request, url, body) {
  const response = await guardedLocalRequest(request, url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function loadCheckpoint(databasePath, runId) {
  const persistence = createSqlitePersistence({ path: databasePath, clock });
  try { return await persistence.checkpoints.load(runId); }
  finally { persistence.close(); }
}

async function searchMainDatabase(databasePath, scope, text, excludeRunIds) {
  const persistence = createSqlitePersistence({ path: databasePath, clock });
  try { return await persistence.memory.queries.search({ scope, text, excludeRunIds, limit: 10, now: NOW }); }
  finally { persistence.close(); }
}

function createCaptureMatrixModel() {
  const replies = [];
  for (const capture of ['manual', 'automatic', 'skip']) {
    for (const recall of [false, true]) {
      const runId = `memory-matrix-${capture}-${recall ? 'recall' : 'no-recall'}`;
      replies.push(
        { toolCalls: [{ id: `${runId}-metrics-call`, name: 'fixture.metrics', input: { metric: 'settlement_failure_rate' } }] },
        { text: `确定性策略矩阵结果 ${capture} ${recall ? 'recall-on' : 'recall-off'}`, toolCalls: [] },
      );
    }
  }
  return new RecordingScriptedModel(replies);
}

async function verifyCaptureRecallMatrix({ request, baseUrl, model }) {
  const results = [];
  for (const capture of ['manual', 'automatic', 'skip']) {
    for (const recall of [false, true]) {
      const runId = `memory-matrix-${capture}-${recall ? 'recall' : 'no-recall'}`;
      const requestStart = model.requests.length;
      await startRun(request, baseUrl, { runId, profileId: scopeA.profileId,
        message: `结算失败率与连接池等待；矩阵用例 ${capture} ${recall ? 'recall-on' : 'recall-off'}`,
        memoryPreferences: { capture, recall: recall ? 'enabled' : 'disabled' } });
      const completed = await waitForRun(request, baseUrl, runId, 'completed');
      const modelInput = JSON.stringify(model.requests.slice(requestStart));
      const recalled = modelInput.includes(CAPTURED_MEMORY_MARKER);
      assert.equal(recalled, recall, `MEMORY_ACCEPTANCE_RECALL_MATRIX_${capture}_${recall}`);

      let captureOutcome;
      if (capture === 'automatic') {
        const saved = await waitForCapture(request, baseUrl, runId);
        assert.equal(saved.state, 'saved', `MEMORY_ACCEPTANCE_AUTO_CAPTURE_${recall}`);
        captureOutcome = 'saved_automatically';
      } else if (capture === 'manual') {
        const beforeManual = await getJson(request, `${baseUrl}/runs/${encodeURIComponent(runId)}/memory/capture`);
        assert.equal(beforeManual.state, 'not_saved');
        const command = { requestId: `${runId}-manual-capture`, expectedCheckpointRevision: completed.revision };
        const accepted = await sendJson(request, `${baseUrl}/runs/${encodeURIComponent(runId)}/memory/capture`, command);
        assert.ok(accepted.status === 200 || accepted.status === 202);
        const saved = await waitForCapture(request, baseUrl, runId);
        assert.equal(saved.state, 'saved');
        captureOutcome = 'saved_manually';
      } else {
        const skipped = await getJson(request, `${baseUrl}/runs/${encodeURIComponent(runId)}/memory/capture`);
        assert.equal(skipped.state, 'not_saved');
        captureOutcome = 'not_saved';
      }
      results.push({ capture, recall, captureOutcome, recalled });
    }
  }
  assert.equal(model.requests.length, 12);
  return results;
}

async function verifySearchFixtures(databasePath) {
  const database = SqliteDatabase.open(databasePath);
  try {
    const repository = createSqliteDiagnosticMemoryRepository(database);
    const store = new SqliteDiagnosticMemoryStore(database, { clock });
    const fixtures = [
      memoryCase('zh-settlement', scopeA, '结算失败率升高，连接池等待增加', { symptomCodes: ['SETTLEMENT_FAILURE_HIGH'] }),
      memoryCase('scope-exact', scopeA, 'scope_component_unique_marker'),
      ...scopeComponentVariants().map(([name, scope]) => memoryCase(`scope-${name}`, scope, 'scope_component_unique_marker')),
      memoryCase('en-timeout', scopeA, 'database connection pool timeout during settlement checkout'),
      memoryCase('wrong-scope', scopeB, 'shared_scope_marker settlement pool timeout'),
      memoryCase('same-scope-marker', scopeA, 'shared_scope_marker settlement pool timeout'),
      memoryCase('tie-a', scopeA, 'tie_rank_fixture pool timeout', { capturedAt: '2026-10-10T00:00:00.000Z' }),
      memoryCase('tie-b', scopeA, 'tie_rank_fixture pool timeout', { capturedAt: '2026-10-10T00:00:00.000Z' }),
      memoryCase('expired-case', scopeA, 'expired_unique_token settlement', { capturedAt: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z' }),
      memoryCase('missing-evidence', scopeA, 'missing_evidence_unique_token', { status: 'observation', quality: 'insufficient', evidenceRefs: [] }),
      memoryCase('operator-input', scopeA, 'operator_safe_token timeout'),
      memoryCase('excluded-source', scopeA, 'excluded_run_unique_token', { sourceRunId: 'current-run' }),
      memoryCase('unicode-normalized', scopeA, 'fullwidth timeout normalization'),
      memoryCase('limited-a', scopeA, 'bounded_limit_fixture timeout one'),
      memoryCase('limited-b', scopeA, 'bounded_limit_fixture timeout two'),
      memoryCase('live-negative', liveScope, 'shared_scope_marker settlement pool timeout'),
    ];
    for (const value of fixtures) {
      const observation = value.status === 'observation' ? value : { ...value, revision: 1, status: 'observation' };
      repository.putCase(observation);
      if (value.status === 'approved') repository.putCase({ ...observation, revision: 2, status: 'approved' }, 1);
    }
    const search = (scope, text, excludeRunIds = [], limit = 10) => store.search({ scope, text, excludeRunIds, limit, now: NOW });

    assert.ok((await search(scopeA, '连接池等待')).some(value => value.id === 'zh-settlement'));
    assert.ok((await search(scopeA, 'connection pool timeout')).some(value => value.id === 'en-timeout'));
    assert.deepEqual((await search(scopeA, 'shared_scope_marker')).map(value => value.id).sort(), ['same-scope-marker']);
    const ties = (await search(scopeA, 'tie_rank_fixture')).filter(value => value.id.startsWith('tie-')).map(value => value.id);
    assert.deepEqual(ties, ['tie-a', 'tie-b']);
    assert.equal((await search(scopeA, 'expired_unique_token')).length, 0);
    assert.equal((await search(scopeA, 'missing_evidence_unique_token')).length, 0);
    const operatorResults = await search(scopeA, 'operator_safe_token timeout*) OR service:* --');
    assert.ok(operatorResults.every(value => value.scope.profileId === scopeA.profileId));
    assert.equal((await search(scopeA, 'unmatched_query_zzzz')).length, 0);
    assert.equal((await search(scopeA, 'excluded_run_unique_token', ['current-run'])).length, 0);
    assert.equal((await search(scopeA, 'bounded_limit_fixture', [], 1)).length, 1);
    assert.ok((await search(scopeA, 'ｆｕｌｌｗｉｄｔｈ')).some(value => value.id === 'unicode-normalized'));
    assert.deepEqual((await search(scopeA, 'scope_component_unique_marker')).map(value => value.id), ['scope-exact']);
    assert.deepEqual((await search(scopeB, 'shared_scope_marker')).map(value => value.id), ['wrong-scope']);
    assert.deepEqual((await search(liveScope, 'shared_scope_marker')).map(value => value.id), ['live-negative']);

    database.raw.prepare("UPDATE diagnostic_memory_cases SET index_version = 'unsupported-index-v0' WHERE id = ?").run('operator-input');
    await assert.rejects(search(scopeA, 'operator_safe_token'), error => error?.code === 'MEMORY_DATA_INVALID');
    return true;
  } finally { database.close(); }
}

async function seedOracleCase(databasePath) {
  const database = SqliteDatabase.open(databasePath);
  try {
    const repository = createSqliteDiagnosticMemoryRepository(database);
    const observation = memoryCase('acceptance-oracle-other-scope', scopeB, ORACLE_MARKER, { status: 'observation' });
    repository.putCase(observation);
    repository.putCase({ ...observation, revision: 2, status: 'approved' }, 1);
  } finally { database.close(); }
}

function scopeComponentVariants() {
  return [
    ['profile', { ...scopeA, profileId: 'other-profile' }],
    ['revision', { ...scopeA, profileRevision: 'sim-v2' }],
    ['service', { ...scopeA, serviceId: 'checkout' }],
    ['fault', { ...scopeA, faultType: 'checkout_timeout' }],
    ['target', { ...scopeA, targetFingerprint: 'b'.repeat(64) }],
    ['environment', { ...scopeA, environment: 'staging' }],
    ['dataset', { ...scopeA, datasetId: 'other-dataset' }],
  ];
}

function memoryCase(id, scope, summary, overrides = {}) {
  const sourceRunId = overrides.sourceRunId ?? `source-${id}`;
  const evidenceRefs = overrides.evidenceRefs ?? [{ evidenceId: `evidence-${id}`, ownerRunId: sourceRunId,
    source: 'metric', capturedAt: overrides.capturedAt ?? NOW, rawSha256: createHash('sha256').update(id).digest('hex') }];
  const { sourceRunId: ignoredRunId, ...caseOverrides } = overrides;
  void ignoredRunId;
  return {
    schemaVersion: 1, id, revision: 1, extractorVersion: 'episodic-v1', scope, sourceRunId,
    sourceRunStatus: 'completed', capturedAt: NOW, validUntil: '2026-11-10T12:00:00.000Z',
    status: 'approved', quality: 'sufficient', summary, symptomCodes: [], limitations: [], evidenceRefs,
    diagnosisOnly: true, eligibleForPromotion: false,
    digest: createHash('sha256').update(`digest:${id}`).digest('hex'), ...caseOverrides,
  };
}

async function verifyTransactionRollback(databasePath) {
  const seed = createSqlitePersistence({ path: databasePath, clock });
  const context = sourceContext({ runId: 'rollback-source', scope: scopeA, status: 'completed', summary: 'rollback fixture report' });
  const saved = await seed.checkpoints.save(context, null);
  seed.close();

  const database = SqliteDatabase.open(databasePath);
  try {
    database.raw.exec(`CREATE TRIGGER force_memory_job_rollback BEFORE INSERT ON diagnostic_memory_capture_jobs
      BEGIN SELECT RAISE(ABORT, 'acceptance rollback fixture'); END;`);
    const writes = new SqliteDiagnosticMemoryStore(database, { clock });
    const command = { sourceRunId: context.runId, scope: scopeA, expectedCheckpointRevision: saved.revision,
      requestId: 'rollback-command', actorId: 'local-operator', requestedAt: NOW };
    const intent = captureIntent(context, command.requestId);
    const count = (table, where, value) => database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
      .get(value).count;
    await assert.rejects(writes.enqueueManualCapture({ command, intent }));
    assert.equal(count('diagnostic_memory_capture_commands', 'source_run_id = ?', context.runId), 0);
    assert.equal(count('diagnostic_memory_capture_jobs', 'source_run_id = ?', context.runId), 0);
    assert.equal(count('diagnostic_memory_cases', 'source_run_id = ?', context.runId), 0);
    assert.equal(count('diagnostic_memory_case_fts', 'memory_id = ?', intent.request.candidateId), 0);
    assert.equal(count('durable_event_outbox', 'run_id = ?', context.runId), 0);
    return true;
  } finally { database.close(); }
}

async function verifyStaleWorkerFencing(databasePath) {
  const seed = createSqlitePersistence({ path: databasePath, clock });
  const context = sourceContext({ runId: 'stale-worker-source', scope: scopeA, status: 'completed', summary: 'lease fixture report' });
  await seed.checkpoints.save(context, null);
  seed.close();

  const database = SqliteDatabase.open(databasePath);
  try {
    const writes = new SqliteDiagnosticMemoryStore(database, { clock });
    const requestId = 'stale-worker-command';
    await writes.enqueueManualCapture({ command: { sourceRunId: context.runId, scope: scopeA, expectedCheckpointRevision: 1,
      requestId, actorId: 'local-operator', requestedAt: NOW }, intent: captureIntent(context, requestId) });
    const first = await writes.claimNext({ ownerId: 'worker-old', now: NOW,
      leaseUntil: '2026-10-11T12:00:30.000Z', maxAttempts: 2 });
    assert.ok(first);
    const second = await writes.claimNext({ ownerId: 'worker-new', now: '2026-10-11T12:00:31.000Z',
      leaseUntil: '2026-10-11T12:01:01.000Z', maxAttempts: 2 });
    assert.ok(second);
    assert.equal(second.ownerId, 'worker-new');
    const candidate = memoryCase(first.request.candidateId, scopeA, 'stale lease candidate', {
      sourceRunId: context.runId, capturedAt: NOW,
    });
    await assert.rejects(writes.completeCapture({ claim: first, candidate, now: '2026-10-11T12:00:32.000Z', events: [] }),
      error => error?.code === 'MEMORY_SOURCE_CONFLICT');
    return true;
  } finally { database.close(); }
}

function captureIntent(context, requestId, origin = 'manual') {
  const candidateId = `candidate-${requestId}`;
  const envelope = { schemaVersion: 2, runId: context.runId, correlationId: `run:${context.runId}`,
    timestamp: NOW, visibility: 'audit', durability: 'durable' };
  let next = 0;
  const factory = new EventFactoryV2(clock, { next: prefix => `${prefix}-${requestId}-${++next}` });
  const failedEvent = category => factory.create('MEMORY_UPDATE_FAILED', envelope, { candidateId,
    error: { code: 'STORAGE_ERROR', message: 'Memory update unavailable.', retryable: false, details: { category } } });
  return {
    request: { candidateId, sourceRunId: context.runId, scope: scopeA, extractorVersion: 'episodic-v1',
      origin, requestId, sourceRunStatus: context.status, sourceContextVersion: context.contextVersion,
      sourceCheckpointChecksum: checkpointChecksum(context),
      requiredSources: ['metric'], requestedAt: NOW },
    scheduledEvent: factory.create('MEMORY_UPDATE_SCHEDULED', envelope, {
      candidateType: 'episodic', sourceRunId: context.runId,
    }),
    rejectedEvent: failedEvent('MEMORY_CAPACITY_EXCEEDED'),
    failedEvent: failedEvent('MEMORY_CAPTURE_FAILED'),
  };
}

async function verifyAutomaticManualCompetition(databasePath) {
  const persistence = createSqlitePersistence({ path: databasePath, clock });
  try {
    const context = sourceContext({ runId: 'automatic-manual-race', scope: scopeA, status: 'completed',
      summary: 'concurrent capture fixture', capture: 'automatic' });
    const automatic = captureIntent(context, 'automatic-race-request', 'automatic');
    await persistence.transitions.commit({ expectedRevision: null, context, outboxEvents: [], memoryCapture: automatic });
    const ticket = await persistence.memory.writes.enqueueManualCapture({
      command: { sourceRunId: context.runId, scope: scopeA, expectedCheckpointRevision: 1,
        requestId: 'manual-race-request', actorId: 'local-operator', requestedAt: NOW },
      intent: captureIntent(context, 'manual-race-request', 'manual'),
    });
    assert.equal(ticket.state, 'queued');
    assert.equal(ticket.candidateId, automatic.request.candidateId);
    const pending = await persistence.outbox.listPending({ runId: context.runId, limit: 10 });
    assert.deepEqual(pending.map(record => record.event.type), ['MEMORY_UPDATE_SCHEDULED']);
    const capture = await persistence.memory.queries.getCapture({ runId: context.runId, scope: scopeA });
    assert.equal(capture?.candidateId, automatic.request.candidateId);
    return true;
  } finally { persistence.close(); }
}

async function main() {
  let result;
  try { result = await runMemoryAcceptance(); }
  catch (error) {
    result = { ...resultFrom(Object.fromEntries(CHECK_NAMES.map(name => [name, false]))),
      code: safeAcceptanceFailureCode(error) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
