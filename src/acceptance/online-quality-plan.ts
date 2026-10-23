import { systemClock, type Clock } from '../contracts/common.js';
import type { ScenarioFamilyCode } from '../profiles/scenarios/index.js';

export const ONLINE_QUALITY_PLAN_SCHEMA_VERSION = 1 as const;
export const ONLINE_QUALITY_OPT_IN_ENV_NAME = 'AGENTOPS_REAL_MODEL_SMOKE';
export const ONLINE_QUALITY_MAX_BATCH_RUNS = 4;

/** Environment names the online batch may read. Values are never recorded or printed. */
export const ONLINE_QUALITY_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'AGENTOPS_MODEL',
  'AGENTOPS_MODEL_BASE_URL',
  'AGENTOPS_MODEL_API_KEY',
  'AGENTOPS_MODEL_PROVIDER',
  'LANGSMITH_TRACING',
  'LANGSMITH_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGSMITH_ENDPOINT',
]);

export type OnlineQualitySampleId = 'normal' | 'failure_rate_breach' | 'dependency_ambiguity' | 'source_missing';

export type OnlineQualityBlockedReasonCode =
  | 'AUTHORIZATION_MISSING'
  | 'CREDENTIALS_MISSING'
  | 'SCENARIO_NOT_BOUND_TO_TARGET_RUNTIME';

export interface OnlineQualityPlanSampleV1 {
  readonly sampleId: OnlineQualitySampleId;
  readonly family: ScenarioFamilyCode;
  /** Existing joint-acceptance case id, or null when no runnable mapping exists yet. */
  readonly mappedAcceptanceCaseId: string | null;
  readonly status: 'ready' | 'blocked';
  readonly blockedReasonCodes: readonly OnlineQualityBlockedReasonCode[];
}

export interface OnlineQualityPlanV1 {
  readonly schemaVersion: typeof ONLINE_QUALITY_PLAN_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly authorization: { readonly optInEnvName: string; readonly granted: boolean };
  readonly credentialEnvNames: readonly string[];
  /** Presence only; a plan must never carry a secret value. */
  readonly credentialsPresent: Readonly<Record<string, boolean>>;
  readonly samples: readonly OnlineQualityPlanSampleV1[];
  readonly budget: {
    readonly maxBatchRuns: number;
    readonly maxRunsPerSample: number;
    readonly autoRerun: false;
    readonly perRunLimitOwner: 'real-model-runner';
    readonly batchCapRule: 'sum_of_existing_per_run_limits';
  };
  readonly outputDir: string;
  readonly probeGate: { readonly required: true; readonly owner: 'langsmith-trace-probe'; readonly onFail: 'keep_not_run' };
  readonly manualReview: { readonly required: true; readonly maxUnsupportedClaims: 0 };
  readonly verdict: 'ready' | 'blocked';
}

export interface BuildOnlineQualityPlanOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly outputDir: string;
  readonly clock?: Clock;
  /** Set when the S3 dependency scenario becomes bindable to a Target runtime. */
  readonly dependencyScenarioRunnable?: boolean;
}

/**
 * Prepare the reviewable online batch (L07) without performing it. Building a plan
 * is never an authorization to spend money: the runner still requires the explicit
 * opt-in environment value, credentials, and a passing LangSmith probe.
 */
export function buildOnlineQualityPlan(options: BuildOnlineQualityPlanOptions): OnlineQualityPlanV1 {
  const clock = options.clock ?? systemClock;
  const authorized = options.env[ONLINE_QUALITY_OPT_IN_ENV_NAME] === '1';
  const credentialsPresent: Record<string, boolean> = {};
  for (const name of ONLINE_QUALITY_CREDENTIAL_ENV_NAMES) credentialsPresent[name] = options.env[name] !== undefined;
  const credentialsComplete = ONLINE_QUALITY_CREDENTIAL_ENV_NAMES
    .every((name) => credentialsPresent[name] === true);
  const dependencyRunnable = options.dependencyScenarioRunnable === true;

  const blocking: OnlineQualityBlockedReasonCode[] = [];
  if (!authorized) blocking.push('AUTHORIZATION_MISSING');
  if (!credentialsComplete) blocking.push('CREDENTIALS_MISSING');

  const samples: OnlineQualityPlanSampleV1[] = [
    sample('normal', 'failure_rate', 'normal', blocking, true),
    sample('failure_rate_breach', 'failure_rate', 'settlement_failure', blocking, true),
    sample('source_missing', 'failure_rate', 'logs_offline', blocking, true),
    sample('dependency_ambiguity', 'dependency', null,
      dependencyRunnable ? blocking : [...blocking, 'SCENARIO_NOT_BOUND_TO_TARGET_RUNTIME'], dependencyRunnable),
  ];

  return Object.freeze({
    schemaVersion: ONLINE_QUALITY_PLAN_SCHEMA_VERSION,
    generatedAt: clock.now().toISOString(),
    authorization: Object.freeze({ optInEnvName: ONLINE_QUALITY_OPT_IN_ENV_NAME, granted: authorized }),
    credentialEnvNames: ONLINE_QUALITY_CREDENTIAL_ENV_NAMES,
    credentialsPresent: Object.freeze(credentialsPresent),
    samples: Object.freeze(samples),
    budget: Object.freeze({
      maxBatchRuns: ONLINE_QUALITY_MAX_BATCH_RUNS,
      maxRunsPerSample: 1,
      autoRerun: false,
      perRunLimitOwner: 'real-model-runner',
      batchCapRule: 'sum_of_existing_per_run_limits',
    }),
    outputDir: options.outputDir,
    probeGate: Object.freeze({ required: true, owner: 'langsmith-trace-probe', onFail: 'keep_not_run' }),
    manualReview: Object.freeze({ required: true, maxUnsupportedClaims: 0 }),
    verdict: samples.every((entry) => entry.status === 'ready') ? 'ready' : 'blocked',
  });
}

function sample(
  sampleId: OnlineQualitySampleId,
  family: ScenarioFamilyCode,
  mappedAcceptanceCaseId: string | null,
  blocking: readonly OnlineQualityBlockedReasonCode[],
  runnable: boolean,
): OnlineQualityPlanSampleV1 {
  return Object.freeze({
    sampleId,
    family,
    mappedAcceptanceCaseId,
    status: blocking.length === 0 && runnable ? 'ready' : 'blocked',
    blockedReasonCodes: Object.freeze([...blocking]),
  });
}
