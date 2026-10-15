import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CheckpointStore,
  Clock,
  SourceResilienceEvent,
  SourceSubagentDescriptor,
  SourceSubagentExecution,
  SourceSubagentRequest,
  SubagentLifecyclePorts,
  TargetBindingStore,
  Tool,
  ToolCallOptions,
  ToolResponse,
  ToolResponseChunk,
} from '../contracts/index.js';
import { TargetConfigurationError } from '../contracts/target.js';
import type { ResolvedTargetSnapshotV2, TargetScenarioBinding, TargetSourceBinding } from '../contracts/target.js';
import type { EvidenceRecorder } from '../application/evidence-recorder.js';
import {
  DefaultSourceSubagentRunner,
  SourceSubagentFailure,
  type SourceChildAgentFactory,
  type SourceChildToolsFactory,
} from '../application/source-subagent-runner.js';
import { TargetMetricsSourceReportCollector, TARGET_METRICS_WINDOW_TOOL_NAME } from '../application/target-metrics-source-report-collector.js';
import { attachSourceEvidenceObservation } from '../application/source-evidence-observation.js';
import { parseExecutableTargetSnapshot } from '../contracts/target-schema.js';
import { WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST } from '../profiles/scenarios/window-failure-rate-v1.js';
import {
  PrometheusWindowFailureRateSource,
  WindowSourceError,
  type WindowFreshnessPolicy,
  type WindowPrometheusQueryPort,
} from '../infrastructure/prometheus/window-failure-rate-source.js';
import type { TargetSourceCircuitEvent, TargetSourcePartitionLease, TargetSourcePartitionRegistryPort, TargetSourceRetryEvent } from '../infrastructure/target-source-partition-registry.js';
import { SourceFailure } from '../mcp/resilience.js';
import { createSourceReportTool } from './source-report-tool.js';
import { createSourceSubagentTool } from '../tool/adapters/source-subagent-tool-adapter.js';
import { stableSourceChildRunId } from './source-subagent-identity.js';

const MAX_QUESTION_BYTES = 2 * 1024;
const MAX_OPERATION_MS = 30_000;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** The model supplies only a question/window; all Target identity and Prometheus mapping stay host-owned. */
export const targetMetricsSubagentInputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).max(20).optional(),
}).strict();

export interface TargetMetricsSubagentRuntimeOptions {
  /** Must be the exact snapshot passed to TargetRuntimeProvider.acquire. */
  snapshot: ResolvedTargetSnapshotV2;
  sourcePartitions: TargetSourcePartitionRegistryPort;
  /** Constructed by the host from a secret reference; never exposed to model input or Tool schema. */
  queryPort: WindowPrometheusQueryPort;
  /** Host-authorized window/freshness rules, not supplied by user/model arguments. */
  windowPolicy: WindowFreshnessPolicy;
  evidenceRecorder: EvidenceRecorder;
  childAgentFactory: SourceChildAgentFactory;
  targetBindings: TargetBindingStore;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  lifecycle?: SubagentLifecyclePorts;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface TargetMetricsSubagentRuntime {
  readonly tool: Tool;
  /** Release the source-partition lease when the owning Target runtime lease ends. */
  release(): void;
}

/**
 * Bootstrap adapter for one immutable Target snapshot. A TargetRuntimeProvider returns only `tool`;
 * its runtime lease must call `release()` when the Run ends. Child Tools are created per request.
 */
export function createTargetMetricsSubagentRuntime(options: TargetMetricsSubagentRuntimeOptions): TargetMetricsSubagentRuntime {
  const snapshot = parseExecutableTargetSnapshot(options.snapshot);
  assertScenario(snapshot.scenario, snapshot.scenarioImplementationDigest);
  const sourceBinding = resolveMetricsSourceBinding(snapshot);
  const sourceId = sourceBinding.sourceId;
  const partition = options.sourcePartitions.acquire(snapshot, sourceId);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    partition.release();
  };
  try {
    const clock = options.clock ?? { now: () => new Date() };
    const source = new PrometheusWindowFailureRateSource({
      scenario: snapshot.scenario,
      queryPort: options.queryPort,
      windowPolicy: options.windowPolicy,
      nowUnixSeconds: () => clock.now().getTime() / 1_000,
      maxResponseBytes: options.maxResponseBytes,
      timeoutMs: options.timeoutMs,
    });
    const childTools: SourceChildToolsFactory = {
      create: ({ request, collector }) => Object.freeze([
        createWindowMetricsEvidenceTool({
          request,
          snapshot,
          sourceId,
          partition,
          source,
          recorder: options.evidenceRecorder,
          clock,
        }),
        createSourceReportTool(collector),
      ]),
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'metrics',
      childAgentFactory: options.childAgentFactory,
      childTools,
      targetBindings: options.targetBindings,
      clock,
      ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
      collector: ({ request }) => new TargetMetricsSourceReportCollector({ request, scenario: snapshot.scenario }),
      renderPrompt: renderTargetMetricsPrompt,
    });
    const descriptor: SourceSubagentDescriptor = {
      publicToolName: 'metrics_subagent',
      subagentType: 'metrics',
      description: `调查当前 Target 的 ${snapshot.scenario.serviceName} 指标，返回可回查的确定性窗口分析。`,
      inputSchema: targetMetricsSubagentInputSchema,
      runner,
      childRunId: execution => stableSourceChildRunId('metrics', execution.parentRunId, execution.parentToolCallId),
      validateRequest: (request, execution) => validateTargetMetricsRequest({
        request, execution, snapshot, policy: options.windowPolicy, nowUnixSeconds: () => clock.now().getTime() / 1_000,
      }),
      ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    };
    const base = createSourceSubagentTool(descriptor);
    const tool = Object.freeze({
      ...base,
      targetSourceId: sourceId,
      implementationVersion: `target-metrics-subagent.v1:${snapshot.scenarioImplementationDigest}`,
    });
    return Object.freeze({ tool, release });
  } catch (error) {
    release();
    throw error;
  }
}

function createWindowMetricsEvidenceTool(input: {
  request: SourceSubagentRequest;
  snapshot: ResolvedTargetSnapshotV2;
  sourceId: string;
  partition: TargetSourcePartitionLease;
  source: PrometheusWindowFailureRateSource;
  recorder: EvidenceRecorder;
  clock: Clock;
}): Tool {
  const tool: Tool = {
    name: TARGET_METRICS_WINDOW_TOOL_NAME,
    description: '读取当前 Target 已绑定的 Prometheus 窗口指标；窗口、指标名和标签均由宿主固定。',
    kind: 'evidence',
    source: 'mcp',
    targetSourceId: input.sourceId,
    implementationVersion: `prometheus-window-snapshot.v1:${input.snapshot.scenarioImplementationDigest}`,
    inputSchema: z.object({}).strict(),
    recoveryPolicy: 'replay_safe',
    isConcurrencySafe: () => false,
    userFacingLabel: () => '查询当前 Target 指标窗口',
    call: (_arguments, callOptions) => collectWindowEvidence(input, callOptions),
  };
  return Object.freeze(tool);
}

async function* collectWindowEvidence(
  input: Parameters<typeof createWindowMetricsEvidenceTool>[0],
  callOptions: ToolCallOptions,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  if (callOptions.signal.aborted) throw new SourceFailure('ABORTED');
  const permit = callOptions.targetOperationPermit;
  if (callOptions.targetBindingId === undefined || callOptions.targetSourceId !== input.sourceId
    || callOptions.targetOperations === undefined || permit === undefined
    || permit.bindingId !== callOptions.targetBindingId || permit.runId !== callOptions.runId
    || permit.snapshotDigest !== input.snapshot.digest || permit.operation !== 'source' || permit.capability !== input.sourceId) {
    throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }
  if (callOptions.toolCallId === undefined || callOptions.profileId !== input.snapshot.profile.profileId) {
    throw new SourceFailure('POLICY_DENIED');
  }
  const requestedWindow = requestWindow(input.request);
  const controller = new AbortController();
  const signal = AbortSignal.any([callOptions.signal, controller.signal]);
  const events: SourceResilienceEvent[] = [];
  let wake: (() => void) | undefined;
  let completed = false;
  let result: Awaited<ReturnType<PrometheusWindowFailureRateSource['collect']>> | undefined;
  let failure: unknown;
  const notify = (): void => { wake?.(); wake = undefined; };
  const deadline = Math.min(callOptions.deadline ?? Number.POSITIVE_INFINITY, input.clock.now().getTime() + MAX_OPERATION_MS);
  const pending = input.partition.execute(async operationSignal => {
    try { return await input.source.collect(requestedWindow, operationSignal, callOptions.networkAttemptBudget); }
    catch (error) { throw mapWindowSourceError(error); }
  }, {
    signal,
    deadline,
    ...(callOptions.targetOperations === undefined ? {} : { targetOperations: callOptions.targetOperations }),
    onEvent: event => { const mapped = retryEvent(event, input.sourceId); if (mapped !== undefined) { events.push(mapped); notify(); } },
    onCircuitEvent: event => { events.push(circuitEvent(event, input.sourceId)); notify(); },
  }).then(value => { result = value; }).catch(error => { failure = error; }).finally(() => { completed = true; notify(); });

  try {
    while (!completed || events.length > 0) {
      const event = events.shift();
      if (event !== undefined) yield { type: 'event', name: 'source_resilience', payload: resiliencePayload(event) };
      else await new Promise<void>(resolve => { wake = resolve; });
    }
    await pending;
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    if (result === undefined) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    callOptions.signal.throwIfAborted();
    await callOptions.targetOperations.validate(permit, callOptions.signal);
    const evidenceId = stableEvidenceId(callOptions.runId, callOptions.toolCallId);
    const capturedAt = input.clock.now().toISOString();
    const missingEvidence = result.assessment.status === 'unavailable' ? ['metric_evidence_partial'] : [];
    const coverage = missingEvidence.length === 0 ? 1 : 0;
    const validateBeforeCommit = async (): Promise<void> => {
      callOptions.signal.throwIfAborted();
      await callOptions.targetOperations!.validate(permit, callOptions.signal);
    };
    try {
      await input.recorder.capture({
        record: {
          evidenceId,
          runId: callOptions.runId,
          source: 'metric',
          summary: { scenarioId: input.snapshot.scenario.id, scenarioVersion: input.snapshot.scenario.version,
            fact: result.fact, assessment: result.assessment },
          raw: result.rawCapture,
          businessTraceIds: [],
          capturedAt,
          toolCallId: callOptions.toolCallId,
          captureKey: `metric:${callOptions.runId}:${callOptions.toolCallId}:0`,
        },
        stepId: callOptions.stepId,
        toolCallId: callOptions.toolCallId,
        coverage,
        publicSummary: renderPublicAssessment(result.assessment),
      }, { validateBeforeCommit });
    } catch (error) {
      if (error instanceof TargetConfigurationError) throw error;
      throw new SourceFailure('STORAGE_ERROR');
    }
    await validateBeforeCommit();
    const response = attachSourceEvidenceObservation({
      blocks: [
        { type: 'json', value: { fact: result.fact, assessment: result.assessment } },
        { type: 'evidence_ref', evidenceId },
      ],
      evidenceIds: [evidenceId],
    }, {
      schemaVersion: 1,
      source: 'metrics',
      evidenceId,
      state: missingEvidence.length === 0 ? 'committed' : 'partial',
      coverage,
      timeRange: {
        start: new Date(requestedWindow.startUnixSeconds * 1_000).toISOString(),
        end: new Date(requestedWindow.endUnixSeconds * 1_000).toISOString(),
      },
      missingEvidence,
    });
    return response;
  } finally {
    controller.abort();
    await pending;
  }
}

function validateTargetMetricsRequest(input: {
  request: SourceSubagentRequest;
  execution: Omit<SourceSubagentExecution, 'childRunId'>;
  snapshot: ResolvedTargetSnapshotV2;
  policy: WindowFreshnessPolicy;
  nowUnixSeconds: () => number;
}): void {
  const { request, execution, snapshot } = input;
  if (request.profileId !== snapshot.profile.profileId || request.service !== snapshot.scenario.serviceId
    || !snapshot.sourceBindings.some(source => source.kind === 'metrics' && source.allowedServiceIds.includes(request.service))) {
    throw new SourceSubagentFailure('POLICY_DENIED', 'Metrics request is outside the immutable Target binding.', false);
  }
  if (request.evidenceIds.length > 0) throw new SourceSubagentFailure('POLICY_DENIED', 'Target Metrics does not accept prior evidence hints.', false);
  if (request.question.trim().length === 0 || Buffer.byteLength(request.question, 'utf8') > MAX_QUESTION_BYTES
    || !isStrictIsoWithZone(request.start) || !isStrictIsoWithZone(request.end)) {
    throw new SourceSubagentFailure('INVALID_INPUT', 'Metrics question or window is invalid.', false);
  }
  if (execution.remainingToolCalls === undefined || execution.remainingToolCalls < 2
    || (execution.toolCallBudget !== undefined && execution.toolCallBudget.remaining < 2)) {
    throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Target Metrics child requires two remaining Tool calls.', false);
  }
  const window = requestWindow(request);
  let decision: ReturnType<WindowFreshnessPolicy['authorize']>;
  try { decision = input.policy.authorize(window, input.nowUnixSeconds()); }
  catch { throw new SourceSubagentFailure('POLICY_DENIED', 'Metrics window is not authorized by the host.', false); }
  if (decision !== 'authorized') {
    throw new SourceSubagentFailure(decision === 'stale' ? 'INVALID_INPUT' : 'POLICY_DENIED', 'Metrics window is not authorized by the host.', false);
  }
}

function assertScenario(scenario: TargetScenarioBinding, implementationDigest: string): void {
  if (scenario.id !== 'window_failure_rate.v1' || scenario.version !== '1.1.0'
    || scenario.metricSemantics !== 'integer_window_snapshot'
    || implementationDigest !== WINDOW_FAILURE_RATE_IMPLEMENTATION_DIGEST) {
    throw new TargetConfigurationError('SCENARIO_VERSION_UNSUPPORTED');
  }
}

function resolveMetricsSourceBinding(snapshot: ResolvedTargetSnapshotV2): TargetSourceBinding {
  const bindings = snapshot.sourceBindings.filter(source => source.kind === 'metrics'
    && !snapshot.unavailableOptionalSourceIds.includes(source.sourceId));
  if (bindings.length !== 1) throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
  const binding = bindings[0]!;
  if (binding.adapterId !== 'prometheus-mcp.v1'
    || !binding.allowedServiceIds.includes(snapshot.scenario.serviceId)) {
    throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
  }
  return binding;
}

function requestWindow(request: SourceSubagentRequest) {
  return Object.freeze({
    timestampUnit: 'unix_seconds' as const,
    startUnixSeconds: Date.parse(request.start) / 1_000,
    endUnixSeconds: Date.parse(request.end) / 1_000,
  });
}

function isStrictIsoWithZone(value: string): boolean {
  const match = ISO_WITH_ZONE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day <= days && Number.isFinite(Date.parse(value));
}

function renderTargetMetricsPrompt(request: SourceSubagentRequest): string {
  return [
    '你是当前 Target 的只读 Metrics 取证 Subagent。',
    '只能调用提供的 metrics.window_snapshot 和 source_report。',
    '指标映射、标签、Target 身份和来源范围已由宿主绑定，不要尝试修改或推断。',
    '工具会使用当前问题的已授权窗口进行一次查询；不要添加 URL、PromQL、Target ID 或来源 ID。',
    '失败率、阈值和样本充分性由确定性工具计算；不得自行改写数值或声称未被证据支持的根因。',
    `service=${JSON.stringify(request.service)}`,
    `start=${JSON.stringify(request.start)}`,
    `end=${JSON.stringify(request.end)}`,
    `question=${JSON.stringify(request.question)}`,
    '最后调用 source_report，并只引用本次工具实际返回的 evidenceId。',
  ].join('\n');
}

function stableEvidenceId(runId: string, toolCallId: string): string {
  const digest = createHash('sha256').update(`${runId}\u0000${toolCallId}`).digest('hex').slice(0, 32);
  return `metric-evidence-${digest}`;
}

function mapWindowSourceError(error: unknown): unknown {
  if (!(error instanceof WindowSourceError)) return error;
  switch (error.code) {
    case 'ABORTED': return new SourceFailure('ABORTED');
    case 'BUDGET_EXCEEDED': return new SourceFailure('BUDGET_EXCEEDED');
    case 'QUERY_TIMEOUT': return new SourceFailure('MCP_TIMEOUT');
    case 'QUERY_FAILED': return new SourceFailure('MCP_NETWORK_ERROR');
    case 'HTTP_ERROR':
      if (error.httpStatus === 401 || error.httpStatus === 403) return new SourceFailure('MCP_AUTH_ERROR');
      if (error.httpStatus === 408) return new SourceFailure('MCP_TIMEOUT', error.retryAfterMs);
      if (error.httpStatus === 429) return new SourceFailure('MCP_RATE_LIMITED', error.retryAfterMs);
      if (error.httpStatus !== undefined && error.httpStatus >= 500) {
        return new SourceFailure('MCP_SERVER_ERROR', error.retryAfterMs);
      }
      return new SourceFailure('MCP_PROTOCOL_ERROR');
    case 'WINDOW_AUTHORITY_REQUIRED':
    case 'WINDOW_NOT_AUTHORIZED':
    case 'STALE_WINDOW':
    case 'INVALID_REQUESTED_WINDOW': return new SourceFailure('POLICY_DENIED');
    case 'INVALID_MAPPING':
    case 'INVALID_LIMITS':
    case 'INVALID_RESPONSE':
    case 'SCOPE_MISMATCH':
    case 'AMBIGUOUS_SERIES':
    case 'MISSING_SERIES':
    case 'RESPONSE_TOO_LARGE':
    case 'STALE_OBSERVATION':
    case 'OBSERVATIONS_NOT_AUTHORIZED': return new SourceFailure('MCP_PROTOCOL_ERROR');
  }
}

function retryEvent(event: TargetSourceRetryEvent, sourceId: string): SourceResilienceEvent | undefined {
  if (event.type !== 'retry' || event.code === undefined) return undefined;
  return { type: 'retry_scheduled', sourceId, attempt: event.attempt, reasonCode: event.code, delayMs: event.delayMs ?? 0 };
}

function circuitEvent(event: TargetSourceCircuitEvent, sourceId: string): SourceResilienceEvent {
  if (event.type === 'opened') return { type: 'circuit_opened', sourceId, openUntil: event.openUntil, failureWindow: event.failureWindow };
  if (event.type === 'half_opened') return { type: 'circuit_half_opened', sourceId, probePolicy: 'single_probe' };
  return { type: 'circuit_closed', sourceId, recoveryEvidence: [] };
}

function resiliencePayload(event: SourceResilienceEvent): Record<string, unknown> {
  switch (event.type) {
    case 'retry_scheduled': return { kind: event.type, sourceId: event.sourceId, attempt: event.attempt, reasonCode: event.reasonCode, delayMs: event.delayMs };
    case 'circuit_opened': return { kind: event.type, sourceId: event.sourceId, failureWindow: event.failureWindow, openUntil: event.openUntil };
    case 'circuit_half_opened': return { kind: event.type, sourceId: event.sourceId, probePolicy: event.probePolicy };
    case 'circuit_closed': return { kind: event.type, sourceId: event.sourceId, recoveryEvidence: event.recoveryEvidence };
  }
}

function renderPublicAssessment(assessment: Awaited<ReturnType<PrometheusWindowFailureRateSource['collect']>>['assessment']): string {
  switch (assessment.status) {
    case 'complete': return `窗口失败率 ${(assessment.failureRate * 100).toFixed(2)}%，Target 阈值 ${(assessment.threshold * 100).toFixed(2)}%，样本 ${assessment.totalCount}。`;
    case 'insufficient_samples': return `窗口样本不足：${assessment.sampleCount}/${assessment.minimumSamples}。`;
    case 'unavailable': return `窗口边界证据不完整：${assessment.missingEvidence.join('、')}。`;
  }
}
