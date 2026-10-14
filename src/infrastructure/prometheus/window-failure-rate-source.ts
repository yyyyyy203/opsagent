import { z } from 'zod';
import type { TargetScenarioBinding } from '../../contracts/target.js';
import { assessWindowFailureRateV1, parseWindowCountSnapshotV1,
  type HostAuthorizedRequestedWindowV1, type WindowCountSnapshotV1,
  type WindowFailureRateAssessmentV1 } from '../../profiles/scenarios/window-failure-rate-v1.js';

/** Host-owned transport returns unread bytes; it must not prebuffer the response. */
export interface WindowPrometheusQueryPort {
  query(request: Readonly<{ query: string; evaluationUnixSeconds: number; signal: AbortSignal }>):
    Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;
}
export interface WindowFreshnessPolicy {
  authorize(window: Readonly<HostAuthorizedRequestedWindowV1>, nowUnixSeconds: number): 'authorized' | 'stale' | 'denied';
}
export interface PrometheusWindowFailureRateOptions {
  scenario: TargetScenarioBinding;
  queryPort: WindowPrometheusQueryPort;
  windowPolicy: WindowFreshnessPolicy;
  nowUnixSeconds: () => number;
  maxResponseBytes: number;
  timeoutMs: number;
}
/** Private capture material is handed to application evidence storage in Task 5. */
export interface WindowQueryCapture {
  query: string;
  evaluationUnixSeconds: number;
  payload: unknown;
}
export interface WindowFailureRateCollection {
  fact: WindowCountSnapshotV1;
  assessment: WindowFailureRateAssessmentV1;
  rawCapture: readonly WindowQueryCapture[];
}
export type WindowSourceErrorCode = 'WINDOW_AUTHORITY_REQUIRED' | 'WINDOW_NOT_AUTHORIZED' | 'STALE_WINDOW'
  | 'INVALID_REQUESTED_WINDOW' | 'INVALID_MAPPING' | 'INVALID_LIMITS' | 'INVALID_RESPONSE'
  | 'SCOPE_MISMATCH' | 'AMBIGUOUS_SERIES' | 'MISSING_SERIES' | 'RESPONSE_TOO_LARGE'
  | 'QUERY_TIMEOUT' | 'ABORTED' | 'QUERY_FAILED' | 'HTTP_ERROR';

export class WindowSourceError extends Error {
  constructor(readonly code: WindowSourceErrorCode) { super(code); this.name = 'WindowSourceError'; }
}

const requestedWindowSchema = z.object({
  timestampUnit: z.literal('unix_seconds'), startUnixSeconds: z.number().finite(), endUnixSeconds: z.number().finite(),
}).strict().refine(value => value.startUnixSeconds < value.endUnixSeconds);
const envelope = z.object({
  status: z.literal('success'), warnings: z.array(z.string()).optional(), infos: z.array(z.string()).optional(),
  data: z.object({ resultType: z.literal('vector'), result: z.array(z.object({
    metric: z.record(z.string()), value: z.tuple([z.number().finite(), z.string()]),
  })) }),
});
type QuerySpec = Readonly<{ query: string; metricName: string; outcome?: string }>;

/** Infrastructure only: no ToolResponse, public events, persistence, or private connection arguments. */
export class PrometheusWindowFailureRateSource {
  private readonly options: Readonly<PrometheusWindowFailureRateOptions>;
  private readonly queries: readonly QuerySpec[];

  constructor(options: PrometheusWindowFailureRateOptions) {
    if (typeof options.nowUnixSeconds !== 'function' || typeof options.windowPolicy?.authorize !== 'function') {
      throw new WindowSourceError('WINDOW_AUTHORITY_REQUIRED');
    }
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
      throw new WindowSourceError('INVALID_LIMITS');
    }
    // Snapshot resolution is upstream authority; freeze our own copy against caller mutation.
    const scenario = structuredClone(options.scenario);
    validateMapping(scenario);
    this.options = Object.freeze({ ...options, scenario });
    const mapping = scenario.metricMapping;
    const boundary = mapping.windowBoundaryMapping!;
    const selectors = [mapping.serviceSelector, ...Object.entries(mapping.staticLabels)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([label, value]) => ({ label, value }))];
    const base = selectors.map(({ label, value }) => `${label}=${JSON.stringify(value)}`).join(',');
    this.queries = Object.freeze([
      { metricName: boundary.startMetricName, query: `${boundary.startMetricName}{${base}}` },
      { metricName: boundary.endMetricName, query: `${boundary.endMetricName}{${base}}` },
      ...[mapping.successValue, mapping.failureValue].map(outcome => ({ metricName: mapping.metricName, outcome,
        query: `${mapping.metricName}{${base},${mapping.outcomeLabel}=${JSON.stringify(outcome)}}` })),
    ]);
  }

  async collect(input: HostAuthorizedRequestedWindowV1, signal: AbortSignal): Promise<WindowFailureRateCollection> {
    checkAbort(signal);
    const parsed = requestedWindowSchema.safeParse(input);
    if (!parsed.success) throw new WindowSourceError('INVALID_REQUESTED_WINDOW');
    const requestedWindow = Object.freeze(parsed.data);
    const evaluationUnixSeconds = this.authorize(requestedWindow);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.options.timeoutMs);
    const boundedSignal = AbortSignal.any([signal, deadline.signal]);
    const rawCapture: WindowQueryCapture[] = [];
    const samples: (number | undefined)[] = [];
    let exporter: string | undefined;
    try {
      for (const spec of this.queries) {
        checkAbort(boundedSignal);
        const payload = await this.query(spec.query, evaluationUnixSeconds, boundedSignal);
        const parsedEnvelope = envelope.safeParse(payload);
        if (!parsedEnvelope.success || parsedEnvelope.data.warnings?.length || parsedEnvelope.data.infos?.length) {
          throw new WindowSourceError('INVALID_RESPONSE');
        }
        const series = parsedEnvelope.data.data.result;
        if (series.length > 1) throw new WindowSourceError('AMBIGUOUS_SERIES');
        const sample = series[0];
        if (sample !== undefined) {
          const mapping = this.options.scenario.metricMapping;
          if (sample.metric.__name__ !== spec.metricName
            || sample.metric[mapping.serviceSelector.label] !== mapping.serviceSelector.value
            || Object.entries(mapping.staticLabels).some(([label, value]) => sample.metric[label] !== value)
            || sample.metric[mapping.outcomeLabel] !== spec.outcome) {
            throw new WindowSourceError('SCOPE_MISMATCH');
          }
          const identity = JSON.stringify(Object.entries(sample.metric)
            .filter(([label]) => label !== '__name__' && label !== mapping.outcomeLabel)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
          if (exporter !== undefined && exporter !== identity) throw new WindowSourceError('AMBIGUOUS_SERIES');
          exporter = identity;
          const [timestamp, text] = sample.value;
          // Reject JavaScript-specific numeric syntaxes and empty strings; Prometheus numbers are decimal.
          if (timestamp > evaluationUnixSeconds || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)
            || !Number.isFinite(Number(text))) throw new WindowSourceError('INVALID_RESPONSE');
          samples.push(Number(text));
        } else {
          samples.push(undefined);
        }
        // Captures are private and only retained after scope/shape validation.
        rawCapture.push(Object.freeze({ query: spec.query, evaluationUnixSeconds, payload }));
      }
      this.authorize(requestedWindow);
      checkAbort(boundedSignal);
      const [startUnixSeconds, endUnixSeconds, successCount, failureCount] = samples;
      const missingEvidence: ('start_boundary' | 'end_boundary')[] = [];
      if (startUnixSeconds === undefined) missingEvidence.push('start_boundary');
      if (endUnixSeconds === undefined) missingEvidence.push('end_boundary');
      if (successCount === undefined || failureCount === undefined) throw new WindowSourceError('MISSING_SERIES');
      const fact = parseWindowCountSnapshotV1(missingEvidence.length ? {
        schemaVersion: 'window_count_snapshot.v1', availability: 'unavailable', reason: 'missing_window_evidence', missingEvidence,
      } : {
        schemaVersion: 'window_count_snapshot.v1', availability: 'available', timestampUnit: 'unix_seconds',
        window: { startUnixSeconds, endUnixSeconds }, successCount, failureCount, totalCount: successCount + failureCount,
      });
      const assessment = assessWindowFailureRateV1({ snapshot: fact, requestedWindow,
        threshold: this.options.scenario.threshold, minSamples: this.options.scenario.minSamples });
      return Object.freeze({ fact, assessment, rawCapture: Object.freeze(rawCapture) });
    } catch (error) {
      if (signal.aborted) throw new WindowSourceError('ABORTED');
      if (deadline.signal.aborted) throw new WindowSourceError('QUERY_TIMEOUT');
      throw error;
    } finally { clearTimeout(timer); }
  }

  private authorize(window: Readonly<HostAuthorizedRequestedWindowV1>): number {
    try {
      const now = this.options.nowUnixSeconds();
      if (!Number.isFinite(now)) throw new WindowSourceError('WINDOW_NOT_AUTHORIZED');
      const decision = this.options.windowPolicy.authorize(window, now);
      if (decision === 'stale') throw new WindowSourceError('STALE_WINDOW');
      if (decision !== 'authorized') throw new WindowSourceError('WINDOW_NOT_AUTHORIZED');
      return now;
    } catch (error) {
      if (error instanceof WindowSourceError) throw error;
      throw new WindowSourceError('WINDOW_NOT_AUTHORIZED');
    }
  }

  private async query(query: string, evaluationUnixSeconds: number, signal: AbortSignal): Promise<unknown> {
    try {
      const pending = this.options.queryPort.query(Object.freeze({ query, evaluationUnixSeconds, signal }))
        .then(response => {
          // An uncooperative transport may finish after abort. Dispose its unread body.
          if (signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new WindowSourceError('ABORTED');
          }
          return response;
        });
      const response = await abortable(pending, signal);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new WindowSourceError('HTTP_ERROR');
      }
      if (response.body === null) throw new WindowSourceError('INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let complete = false;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) { complete = true; break; }
          bytes += chunk.value.byteLength;
          if (bytes > this.options.maxResponseBytes) throw new WindowSourceError('RESPONSE_TOO_LARGE');
          chunks.push(chunk.value);
        }
      } finally {
        if (!complete) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      checkAbort(signal);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
      catch { throw new WindowSourceError('INVALID_RESPONSE'); }
    } catch (error) {
      if (error instanceof WindowSourceError) throw error;
      throw new WindowSourceError('QUERY_FAILED');
    }
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new WindowSourceError('ABORTED');
}

/** Bounded waiting also covers ports/readers that fail to honor the signal. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new WindowSourceError('ABORTED'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

function validateMapping(scenario: TargetScenarioBinding): void {
  const mapping = scenario.metricMapping;
  const boundary = mapping.windowBoundaryMapping;
  const metric = (value: string) => value.length <= 256 && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(value);
  const label = (value: string) => value !== '__name__' && value.length <= 128 && /^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value);
  if (scenario.id !== 'window_failure_rate.v1' || scenario.version !== '1.1.0'
    || scenario.metricSemantics !== 'integer_window_snapshot' || !boundary || boundary.timestampUnit !== 'unix_seconds'
    || ![mapping.metricName, boundary.startMetricName, boundary.endMetricName].every(metric)
    || new Set([mapping.metricName, boundary.startMetricName, boundary.endMetricName]).size !== 3
    || ![mapping.outcomeLabel, mapping.serviceSelector.label, ...Object.keys(mapping.staticLabels)].every(label)
    || mapping.outcomeLabel === mapping.serviceSelector.label || mapping.successValue === mapping.failureValue
    || Object.hasOwn(mapping.staticLabels, mapping.outcomeLabel) || Object.hasOwn(mapping.staticLabels, mapping.serviceSelector.label)) {
    throw new WindowSourceError('INVALID_MAPPING');
  }
}
