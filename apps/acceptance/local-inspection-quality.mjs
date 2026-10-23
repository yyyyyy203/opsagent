#!/usr/bin/env node
// Offline S3 diagnostic quality set (L06). Deterministic scenarios + simulated
// fixtures only: no model, no LangSmith, no business system, no external network.
import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_FILE_NAME = 'local-inspection-quality-report.json';
const ONLINE_PLAN_FILE_NAME = 'online-quality-plan.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class QualityCliError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.code = code;
  }
}

installFetchGuard();

const args = parseArgs(process.argv.slice(2));
const outDir = resolveOutDir(args.get('out') ?? 'test-results/local-inspection-quality');

try {
  if (args.has('online-plan')) {
    await writeOnlinePlan(outDir);
  } else {
    await runOfflineQualitySet(outDir, args);
  }
} catch (error) {
  const code = error instanceof QualityCliError ? error.code
    : error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message
      : 'QUALITY_INTERNAL_ERROR';
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
  process.exitCode = 1;
}

async function runOfflineQualitySet(targetOutDir, cliArgs) {
  const transport = cliArgs.get('transport') ?? 'in-process';
  if (transport !== 'in-process' && transport !== 'loopback-http') {
    throw new QualityCliError('QUALITY_TRANSPORT_UNSUPPORTED', transport);
  }
  const { LOCAL_INSPECTION_QUALITY_CASES } = await import('../../dist/acceptance/local-quality-cases.js');
  const { runLocalQualitySet, parseLocalQualityReportV1 } = await import('../../dist/acceptance/local-quality.js');

  let loadFixture;
  let lab;
  if (transport === 'in-process') {
    const { createInProcessScenarioFixtureLoader } = await import('../../dist/bootstrap/scenario-quality-lab.js');
    loadFixture = createInProcessScenarioFixtureLoader();
  } else {
    const { startScenarioQualityLab } = await import('../../dist/bootstrap/scenario-quality-lab.js');
    lab = await startScenarioQualityLab();
    loadFixture = lab.createFixtureLoader();
  }

  const options = {
    cases: LOCAL_INSPECTION_QUALITY_CASES,
    loadFixture,
    transport: transport === 'in-process' ? 'injected' : 'loopback_http',
    modelMode: 'offline_deterministic',
  };
  if (cliArgs.has('deadline-ms')) options.deadlineMs = readPositiveInt(cliArgs.get('deadline-ms'), 'deadline-ms');
  if (cliArgs.has('max-cases')) options.maxCases = readPositiveInt(cliArgs.get('max-cases'), 'max-cases');

  try {
    const report = runLocalQualitySet(options);
    await mkdir(targetOutDir, { recursive: true });
    const reportPath = resolve(targetOutDir, REPORT_FILE_NAME);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, serialized, 'utf8');
    // Re-read and re-verify: a stored report must not be editable into a pass.
    parseLocalQualityReportV1(JSON.parse(await readFile(reportPath, 'utf8')));
    process.stdout.write(`${JSON.stringify({
      status: 'completed',
      verdict: report.verdict,
      transport: report.transport,
      modelMode: report.modelMode,
      sourceMode: report.sourceMode,
      datasetId: report.datasetId,
      datasetDigest: report.datasetDigest,
      windowSeconds: report.windowSeconds,
      summary: report.summary.total === undefined ? null : {
        total: report.summary.total,
        passed: report.summary.passed,
        failed: report.summary.failed,
        notRun: report.summary.notRun,
        byFamily: report.summary.byFamily,
      },
      budget: report.budget,
      failedCases: report.cases.filter((entry) => entry.verdict !== 'passed')
        .map((entry) => ({ caseId: entry.caseId, verdict: entry.verdict,
          failedChecks: entry.checks.filter((check) => !check.passed).map((check) => check.code) })),
      reportPath,
    }, null, 2)}\n`);
    if (report.verdict !== 'passed') process.exitCode = 1;
  } finally {
    await lab?.close();
  }
}

async function writeOnlinePlan(targetOutDir) {
  const { buildOnlineQualityPlan } = await import('../../dist/acceptance/online-quality-plan.js');
  const plan = buildOnlineQualityPlan({ env: process.env, outputDir: targetOutDir });
  await mkdir(targetOutDir, { recursive: true });
  const planPath = resolve(targetOutDir, ONLINE_PLAN_FILE_NAME);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: 'plan_written', verdict: plan.verdict, planPath,
    note: 'plan_only_no_model_call_no_authorization' }, null, 2)}\n`);
}

function parseArgs(argv) {
  const map = new Map();
  for (const entry of argv) {
    if (!entry.startsWith('--')) throw new QualityCliError('QUALITY_ARG_INVALID', entry);
    const body = entry.slice(2);
    const separator = body.indexOf('=');
    if (separator === -1) map.set(body, '');
    else map.set(body.slice(0, separator), body.slice(separator + 1));
  }
  return map;
}

function resolveOutDir(value) {
  if (value.length === 0) throw new QualityCliError('QUALITY_OUT_DIR_INVALID');
  const candidate = isAbsolute(value) ? value : resolve(REPO_ROOT, value);
  if (!candidate.startsWith(REPO_ROOT)) throw new QualityCliError('QUALITY_OUT_DIR_OUTSIDE_REPO');
  return candidate;
}

function readPositiveInt(value, name) {
  if (!/^\d+$/u.test(value)) throw new QualityCliError('QUALITY_ARG_INVALID', name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new QualityCliError('QUALITY_ARG_INVALID', name);
  return parsed;
}

/** The offline set must never reach a non-loopback destination, even by accident. */
function installFetchGuard() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url !== 'string') return Promise.reject(new QualityCliError('QUALITY_EXTERNAL_REQUEST_FORBIDDEN'));
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(new QualityCliError('QUALITY_EXTERNAL_REQUEST_FORBIDDEN'));
    }
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return Promise.reject(new QualityCliError('QUALITY_EXTERNAL_REQUEST_FORBIDDEN', parsed.protocol));
    }
    return realFetch(input, init);
  };
}
