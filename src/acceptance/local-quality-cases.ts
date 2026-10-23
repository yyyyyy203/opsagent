import type { LocalQualityCaseV1 } from './local-quality.js';
import { SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS, SCENARIO_FIXTURE_WINDOW_SECONDS } from '../infrastructure/simulator/scenario-window-fixtures.js';

/** Frozen window boundaries shared by every offline case; the dataset never drifts. */
export const LOCAL_QUALITY_WINDOW_START_UNIX_SECONDS =
  SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS - SCENARIO_FIXTURE_WINDOW_SECONDS;
export const LOCAL_QUALITY_WINDOW_END_UNIX_SECONDS = SCENARIO_FIXTURE_EVALUATION_TIME_UNIX_SECONDS;
export const LOCAL_QUALITY_BASELINE_WINDOW_START_UNIX_SECONDS =
  LOCAL_QUALITY_WINDOW_START_UNIX_SECONDS - SCENARIO_FIXTURE_WINDOW_SECONDS;
export const LOCAL_QUALITY_BASELINE_WINDOW_END_UNIX_SECONDS = LOCAL_QUALITY_WINDOW_START_UNIX_SECONDS;

const WINDOW_NUMBERS = {
  windowStartUnixSeconds: LOCAL_QUALITY_WINDOW_START_UNIX_SECONDS,
  windowEndUnixSeconds: LOCAL_QUALITY_WINDOW_END_UNIX_SECONDS,
} as const;

const RESOURCE_THRESHOLDS = { cpu: 0.85, memory: 0.9, disk: 0.85, thread_pool: 0.85 } as const;

const FAILURE_RATE_PARAMS = { family: 'failure_rate', threshold: 0.05, minSamples: 20 } as const;
const LATENCY_PARAMS = { family: 'latency', p95ThresholdMs: 250, minSamples: 50 } as const;
const TRAFFIC_PARAMS = { family: 'traffic', dropThresholdRatio: 0.3, minSamples: 100 } as const;
const DEPENDENCY_PARAMS = { family: 'dependency', minErrorCount: 5, minCorroboratingRecords: 1 } as const;
const RESOURCE_PARAMS = { family: 'resource', thresholds: RESOURCE_THRESHOLDS, minSignalsForConfirmation: 2 } as const;

/**
 * The named offline quality set (L06). Expectations are authored independently of
 * the scenario code: exact numbers, expected missing evidence, and the conclusions
 * each case may and may not draw. Natural-language wording is never asserted.
 */
export const LOCAL_INSPECTION_QUALITY_CASES: readonly LocalQualityCaseV1[] = Object.freeze([
  {
    caseId: 'fr-normal',
    family: 'failure_rate',
    title: '失败率正常：低于阈值且样本充分',
    fixtureId: 'failure_rate.normal',
    params: FAILURE_RATE_PARAMS,
    expectation: {
      status: 'complete',
      numbers: { successCount: 96, failureCount: 4, totalCount: 100, failureRate: 0.04, threshold: 0.05 },
      booleans: { thresholdReached: false },
      missingEvidence: [],
      allowedConclusions: ['metric_within_threshold'],
      forbiddenConclusions: ['metric_threshold_breached', 'root_cause_established', 'healthy_system_wide'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'fr-breached',
    family: 'failure_rate',
    title: '失败率超阈值：确定性判定为已触发',
    fixtureId: 'failure_rate.breached',
    params: FAILURE_RATE_PARAMS,
    expectation: {
      status: 'complete',
      numbers: { successCount: 85, failureCount: 15, totalCount: 100, failureRate: 0.15, threshold: 0.05 },
      booleans: { thresholdReached: true },
      missingEvidence: [],
      allowedConclusions: ['metric_threshold_breached'],
      forbiddenConclusions: ['metric_within_threshold', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'fr-low-sample',
    family: 'failure_rate',
    title: '失败率低样本：不得高置信归因',
    fixtureId: 'failure_rate.low_sample',
    params: FAILURE_RATE_PARAMS,
    expectation: {
      status: 'insufficient_samples',
      numbers: { sampleCount: 10, minimumSamples: 20 },
      missingEvidence: [],
      allowedConclusions: ['insufficient_samples_no_attribution'],
      forbiddenConclusions: ['metric_threshold_breached', 'metric_within_threshold', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'fr-contradictory-total',
    family: 'failure_rate',
    title: '失败率矛盾信息：分项之和不等于总数时拒绝',
    fixtureId: 'failure_rate.contradictory_total',
    params: FAILURE_RATE_PARAMS,
    expectation: {
      errorCode: 'INCONSISTENT_TOTAL',
      allowedConclusions: [],
      forbiddenConclusions: ['metric_threshold_breached', 'metric_within_threshold'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'fr-missing-window',
    family: 'failure_rate',
    title: '失败率窗口边界缺失：显式缺失证据而非补值',
    fixtureId: 'failure_rate.missing_window',
    params: FAILURE_RATE_PARAMS,
    expectation: {
      status: 'unavailable',
      strings: { reason: 'missing_window_evidence' },
      missingEvidence: ['end_boundary'],
      allowedConclusions: ['missing_evidence_partial_diagnosis'],
      forbiddenConclusions: ['metric_threshold_breached', 'metric_within_threshold', 'insufficient_samples_no_attribution'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'lat-normal',
    family: 'latency',
    title: '延迟正常：p95 低于阈值且声明计算方式',
    fixtureId: 'latency.normal',
    params: LATENCY_PARAMS,
    expectation: {
      status: 'complete',
      numbers: {
        ...WINDOW_NUMBERS, sampleCount: 1_200, p50Ms: 42, p95Ms: 180, p99Ms: 320, thresholdMs: 250,
      },
      booleans: { thresholdReached: false },
      strings: { computation: 'source_histogram_bucket' },
      missingEvidence: [],
      allowedConclusions: ['metric_within_threshold'],
      forbiddenConclusions: ['metric_threshold_breached', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'lat-p95-breached',
    family: 'latency',
    title: '延迟 p95 升高：同窗口同单位确定性触发',
    fixtureId: 'latency.p95_breached',
    params: LATENCY_PARAMS,
    expectation: {
      status: 'complete',
      numbers: {
        ...WINDOW_NUMBERS, sampleCount: 1_180, p50Ms: 55, p95Ms: 480, p99Ms: 910, thresholdMs: 250,
      },
      booleans: { thresholdReached: true },
      strings: { computation: 'source_histogram_bucket' },
      missingEvidence: [],
      allowedConclusions: ['metric_threshold_breached'],
      forbiddenConclusions: ['metric_within_threshold', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'lat-low-sample',
    family: 'latency',
    title: '延迟低样本：分位数不作为结论',
    fixtureId: 'latency.low_sample',
    params: LATENCY_PARAMS,
    expectation: {
      status: 'insufficient_samples',
      numbers: { ...WINDOW_NUMBERS, sampleCount: 8, minimumSamples: 50 },
      missingEvidence: [],
      allowedConclusions: ['insufficient_samples_no_attribution'],
      forbiddenConclusions: ['metric_threshold_breached', 'metric_within_threshold'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'traffic-normal',
    family: 'traffic',
    title: '流量正常：与对齐基线相比无显著下降',
    fixtureId: 'traffic.normal',
    params: TRAFFIC_PARAMS,
    expectation: {
      status: 'complete',
      numbers: {
        ...WINDOW_NUMBERS,
        requestCount: 1_000,
        baselineRequestCount: 1_020,
        baselineStartUnixSeconds: LOCAL_QUALITY_BASELINE_WINDOW_START_UNIX_SECONDS,
        baselineEndUnixSeconds: LOCAL_QUALITY_BASELINE_WINDOW_END_UNIX_SECONDS,
        changeRatio: -0.0196078431372549,
        dropRatio: 0.0196078431372549,
        dropThresholdRatio: 0.3,
      },
      booleans: { dropThresholdReached: false },
      missingEvidence: [],
      allowedConclusions: ['metric_within_threshold', 'baseline_comparison_valid'],
      forbiddenConclusions: ['metric_threshold_breached', 'baseline_unavailable_no_comparison'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'traffic-drop',
    family: 'traffic',
    title: '流量相对基线下降：确定性判定为已触发',
    fixtureId: 'traffic.drop',
    params: TRAFFIC_PARAMS,
    expectation: {
      status: 'complete',
      numbers: {
        ...WINDOW_NUMBERS,
        requestCount: 620,
        baselineRequestCount: 1_000,
        baselineStartUnixSeconds: LOCAL_QUALITY_BASELINE_WINDOW_START_UNIX_SECONDS,
        baselineEndUnixSeconds: LOCAL_QUALITY_BASELINE_WINDOW_END_UNIX_SECONDS,
        changeRatio: -0.38,
        dropRatio: 0.38,
        dropThresholdRatio: 0.3,
      },
      booleans: { dropThresholdReached: true },
      missingEvidence: [],
      allowedConclusions: ['metric_threshold_breached', 'baseline_comparison_valid'],
      forbiddenConclusions: ['metric_within_threshold', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'traffic-baseline-missing',
    family: 'traffic',
    title: '流量基线缺失：不得推断比较结果',
    fixtureId: 'traffic.baseline_missing',
    params: TRAFFIC_PARAMS,
    expectation: {
      status: 'baseline_missing',
      numbers: { ...WINDOW_NUMBERS, requestCount: 640 },
      missingEvidence: ['baseline_count', 'baseline_window'],
      allowedConclusions: ['baseline_unavailable_no_comparison'],
      forbiddenConclusions: ['metric_threshold_breached', 'metric_within_threshold', 'baseline_comparison_valid'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'dep-corroborated',
    family: 'dependency',
    title: '依赖异常可印证：上游错误与依赖日志同身份同窗口',
    fixtureId: 'dependency.corroborated',
    params: DEPENDENCY_PARAMS,
    expectation: {
      status: 'corroborated',
      numbers: {
        ...WINDOW_NUMBERS, errorCount: 42, callCount: 1_200, errorRatio: 0.035, recordCount: 3,
        corroboratingRecordCount: 2,
      },
      strings: { dependencyId: 'payment-gateway' },
      missingEvidence: [],
      allowedConclusions: ['dependency_association_corroborated', 'correlation_not_root_cause'],
      forbiddenConclusions: ['temporal_coincidence_only', 'root_cause_established'],
      evidenceSources: ['logs-sim', 'metrics-sim'],
    },
  },
  {
    caseId: 'dep-time-overlap-only',
    family: 'dependency',
    title: '依赖异常仅时间重合：不得升级为已证实关联',
    fixtureId: 'dependency.time_overlap_only',
    params: DEPENDENCY_PARAMS,
    expectation: {
      status: 'time_overlap_only',
      numbers: {
        ...WINDOW_NUMBERS, errorCount: 42, callCount: 1_200, errorRatio: 0.035, recordCount: 2,
        overlappingRecordCount: 2,
      },
      strings: { dependencyId: 'payment-gateway', missingCorroboration: 'dependency_identity,error_level' },
      missingEvidence: [],
      allowedConclusions: ['temporal_coincidence_only'],
      forbiddenConclusions: ['dependency_association_corroborated', 'root_cause_established'],
      evidenceSources: ['logs-sim', 'metrics-sim'],
    },
  },
  {
    caseId: 'dep-log-source-missing',
    family: 'dependency',
    title: '依赖日志来源缺失：只输出部分诊断',
    fixtureId: 'dependency.log_source_missing',
    params: DEPENDENCY_PARAMS,
    expectation: {
      status: 'insufficient_evidence',
      numbers: { ...WINDOW_NUMBERS },
      missingEvidence: ['log_records', 'log_source'],
      allowedConclusions: ['missing_evidence_partial_diagnosis'],
      forbiddenConclusions: ['dependency_association_corroborated', 'temporal_coincidence_only'],
      evidenceSources: ['logs-sim', 'metrics-sim'],
    },
  },
  {
    caseId: 'dep-record-outside-window',
    family: 'dependency',
    title: '依赖日志时间越界：矛盾信息按稳定错误码拒绝',
    fixtureId: 'dependency.record_outside_window',
    params: DEPENDENCY_PARAMS,
    expectation: {
      errorCode: 'RECORD_OUTSIDE_WINDOW',
      allowedConclusions: [],
      forbiddenConclusions: ['dependency_association_corroborated', 'temporal_coincidence_only'],
      evidenceSources: ['logs-sim', 'metrics-sim'],
    },
  },
  {
    caseId: 'res-saturated-multi-signal',
    family: 'resource',
    title: '资源饱和：CPU 与内存双信号超阈值',
    fixtureId: 'resource.saturated_multi_signal',
    params: RESOURCE_PARAMS,
    expectation: {
      status: 'saturated',
      numbers: {
        ...WINDOW_NUMBERS,
        signalCount: 2,
        breachedSignalCount: 2,
        minimumSignalsForConfirmation: 2,
        'signals.cpu.utilizationRatio': 0.93,
        'signals.cpu.threshold': 0.85,
        'signals.memory.utilizationRatio': 0.94,
        'signals.memory.threshold': 0.9,
      },
      booleans: { 'signals.cpu.thresholdReached': true, 'signals.memory.thresholdReached': true },
      strings: { breachedKinds: 'cpu,memory' },
      missingEvidence: [],
      allowedConclusions: ['resource_saturation_confirmed'],
      forbiddenConclusions: ['resource_saturation_candidate', 'root_cause_established'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'res-single-signal-candidate',
    family: 'resource',
    title: '资源单一指标：只输出候选不确认饱和',
    fixtureId: 'resource.single_signal_candidate',
    params: RESOURCE_PARAMS,
    expectation: {
      status: 'candidate_only',
      numbers: {
        ...WINDOW_NUMBERS,
        signalCount: 1,
        breachedSignalCount: 1,
        minimumSignalsForConfirmation: 2,
        'signals.cpu.utilizationRatio': 0.93,
        'signals.cpu.threshold': 0.85,
      },
      booleans: { 'signals.cpu.thresholdReached': true },
      strings: { breachedKinds: 'cpu' },
      missingEvidence: [],
      allowedConclusions: ['resource_saturation_candidate'],
      forbiddenConclusions: ['resource_saturation_confirmed', 'metric_within_threshold'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'res-within-threshold',
    family: 'resource',
    title: '资源正常：双信号均低于阈值',
    fixtureId: 'resource.within_threshold',
    params: RESOURCE_PARAMS,
    expectation: {
      status: 'within_threshold',
      numbers: {
        ...WINDOW_NUMBERS,
        signalCount: 2,
        breachedSignalCount: 0,
        minimumSignalsForConfirmation: 2,
        'signals.cpu.utilizationRatio': 0.31,
        'signals.memory.utilizationRatio': 0.44,
      },
      booleans: { 'signals.cpu.thresholdReached': false, 'signals.memory.thresholdReached': false },
      strings: { breachedKinds: '' },
      missingEvidence: [],
      allowedConclusions: ['metric_within_threshold'],
      forbiddenConclusions: ['resource_saturation_confirmed', 'metric_threshold_breached'],
      evidenceSources: ['metrics-sim'],
    },
  },
  {
    caseId: 'res-series-missing',
    family: 'resource',
    title: '资源序列缺失：不得伪装完整',
    fixtureId: 'resource.series_missing',
    params: RESOURCE_PARAMS,
    expectation: {
      status: 'unavailable',
      numbers: { ...WINDOW_NUMBERS },
      strings: { reason: 'missing_window_evidence' },
      missingEvidence: ['resource_series'],
      allowedConclusions: ['missing_evidence_partial_diagnosis'],
      forbiddenConclusions: ['resource_saturation_confirmed', 'resource_saturation_candidate', 'metric_within_threshold'],
      evidenceSources: ['metrics-sim'],
    },
  },
]);

/** Family coverage required by L06: five families, at least eleven named samples. */
export const LOCAL_QUALITY_MINIMUM_CASE_COUNT = 11;
export const LOCAL_QUALITY_MINIMUM_CASES_PER_FAMILY: Readonly<Record<string, number>> = Object.freeze({
  failure_rate: 3,
  latency: 2,
  traffic: 2,
  dependency: 2,
  resource: 2,
});
