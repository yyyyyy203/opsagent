import type {
  SourceEvidenceObservation,
  SourceSubagentRequest,
  SourceSubagentResult,
  ToolResponse,
} from '../contracts/index.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import { projectSourceMissingEvidenceCodes } from '../contracts/missing-evidence.js';
import type { TargetScenarioBinding } from '../contracts/target.js';
import {
  assessWindowFailureRateV1,
  parseWindowCountSnapshotV1,
  type HostAuthorizedRequestedWindowV1,
  type WindowCountSnapshotV1,
  type WindowFailureRateAssessmentV1,
} from '../profiles/scenarios/window-failure-rate-v1.js';
import { readSourceEvidenceObservation } from './source-evidence-observation.js';
import {
  DefaultSourceReportCollector,
  SourceReportValidationError,
  type SourceReportCandidate,
  type SourceReportCollector,
  type SourceReportFinalizeInput,
} from './source-report-collector.js';

export const TARGET_METRICS_WINDOW_TOOL_NAME = 'metrics.window_snapshot';

interface WindowObservation {
  evidenceId: string;
  fact: WindowCountSnapshotV1;
  assessment: WindowFailureRateAssessmentV1;
  observation: SourceEvidenceObservation;
}

/** Revalidates the deterministic metric fact and never trusts model-authored conclusions. */
export class TargetMetricsSourceReportCollector implements SourceReportCollector {
  private readonly delegate = new DefaultSourceReportCollector();
  private readonly requestedWindow: HostAuthorizedRequestedWindowV1;
  private readonly observations: WindowObservation[] = [];
  private reportAccepted = false;
  private toolCallsUsed = 0;

  public constructor(private readonly options: {
    request: SourceSubagentRequest;
    scenario: TargetScenarioBinding;
  }) {
    const startUnixSeconds = Date.parse(options.request.start) / 1_000;
    const endUnixSeconds = Date.parse(options.request.end) / 1_000;
    if (!Number.isFinite(startUnixSeconds) || !Number.isFinite(endUnixSeconds) || startUnixSeconds >= endUnixSeconds) {
      throw new TargetMetricsReportPolicyError('request window is invalid');
    }
    this.requestedWindow = Object.freeze({ timestampUnit: 'unix_seconds', startUnixSeconds, endUnixSeconds });
  }

  public observeToolResult(toolName: string, response: ToolResponse): void {
    this.toolCallsUsed += 1;
    this.delegate.observeToolResult(toolName, response);
    if (toolName !== TARGET_METRICS_WINDOW_TOOL_NAME || response.isError === true) return;

    const observation = readSourceEvidenceObservation(response);
    if (observation === undefined || observation.source !== 'metrics') {
      throw new TargetMetricsReportProtocolError('metric result requires source evidence metadata');
    }
    if (response.evidenceIds?.length !== 1 || response.evidenceIds[0] !== observation.evidenceId
      || response.blocks.filter(block => block.type === 'evidence_ref' && block.evidenceId === observation.evidenceId).length !== 1) {
      throw new TargetMetricsReportProtocolError('metric result must contain one paired evidence reference');
    }
    const facts = response.blocks.filter(block => block.type === 'json');
    if (facts.length !== 1 || facts[0]?.type !== 'json' || !isRecord(facts[0].value)
      || !hasOnlyKeys(facts[0].value, ['fact', 'assessment'])) {
      throw new TargetMetricsReportProtocolError('metric result must contain one fact/assessment object');
    }
    const fact = parseWindowCountSnapshotV1(facts[0].value.fact);
    const assessment = assessWindowFailureRateV1({
      snapshot: fact,
      requestedWindow: this.requestedWindow,
      threshold: this.options.scenario.threshold,
      minSamples: this.options.scenario.minSamples,
    });
    if (!sameJson(assessment, facts[0].value.assessment)) {
      throw new TargetMetricsReportProtocolError('metric assessment does not match the deterministic Target scenario');
    }
    this.observations.push({ evidenceId: observation.evidenceId, fact, assessment, observation });
  }

  public acceptReport(candidate: SourceReportCandidate): void {
    this.delegate.acceptReport(candidate);
    const evidenceIds = new Set(this.observations.map(item => item.evidenceId));
    if (!candidate.findings.some(finding => finding.evidenceIds.some(id => evidenceIds.has(id)))) {
      throw new SourceReportValidationError('Target Metrics report must cite an observed metric evidence ID');
    }
    this.reportAccepted = true;
  }

  public finalize(input: SourceReportFinalizeInput): SourceSubagentResult {
    if (input.parentRunId.length === 0 || input.childRunId.length === 0) throw new Error('source run identities are required');
    const evidenceIds = this.observations.map(item => item.evidenceId);
    const missingEvidence: string[] = [];
    if (evidenceIds.length === 0) missingEvidence.push('metrics');
    if (!this.reportAccepted) missingEvidence.push('source_report');
    if (this.observations.length > 1) missingEvidence.push('multiple_metric_snapshots');
    if (this.observations.some(item => item.observation.state === 'partial' || item.assessment.status === 'unavailable')) {
      missingEvidence.push('metric_evidence_partial');
    }
    const status = evidenceIds.length === 0 ? 'unavailable'
      : missingEvidence.length === 0 ? 'complete' : 'partial';
    const coverage = evidenceIds.length === 0 ? 0 : Math.min(...this.observations.map(item => item.observation.coverage));
    const onlyObservation = this.observations.length === 1 ? this.observations[0] : undefined;
    const summary = onlyObservation === undefined
      ? status === 'unavailable' ? '没有获得可验证的 Target 指标证据。' : '存在多个指标快照，无法形成单一确定性结论。'
      : renderAssessment(onlyObservation.assessment);
    const findings = onlyObservation === undefined || onlyObservation.assessment.status === 'unavailable'
      ? []
      : [{ kind: 'observation' as const, statement: summary, evidenceIds: [onlyObservation.evidenceId] }];
    return {
      source: 'metrics', status, summary, findings, evidenceIds, businessTraceIds: [], missingEvidence,
      missingEvidenceCodes: projectSourceMissingEvidenceCodes('metrics', missingEvidence), coverage,
      toolCallsUsed: this.toolCallsUsed,
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
    };
  }
}

export class TargetMetricsReportProtocolError extends Error {
  public readonly code = 'MCP_PROTOCOL_ERROR';
  public readonly retryable = false;
  public constructor(message: string) { super(message); this.name = 'TargetMetricsReportProtocolError'; }
}

export class TargetMetricsReportPolicyError extends Error {
  public readonly code = 'POLICY_DENIED';
  public readonly retryable = false;
  public constructor(message: string) { super(message); this.name = 'TargetMetricsReportPolicyError'; }
}

function renderAssessment(assessment: WindowFailureRateAssessmentV1): string {
  switch (assessment.status) {
    case 'complete':
      return `窗口内失败率 ${(assessment.failureRate * 100).toFixed(2)}%，${assessment.thresholdReached ? '达到或超过' : '低于'} Target 阈值 ${(assessment.threshold * 100).toFixed(2)}%；样本 ${assessment.totalCount}。`;
    case 'insufficient_samples':
      return `窗口内样本不足：${assessment.sampleCount}，至少需要 ${assessment.minimumSamples}。`;
    case 'unavailable':
      return `窗口边界证据不完整（${assessment.missingEvidence.join('、')}），无法计算失败率。`;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return checkpointChecksum(left) === checkpointChecksum(right); }
  catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
