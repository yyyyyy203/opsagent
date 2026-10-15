import type { WindowPrometheusQueryPort } from './window-failure-rate-source.js';

export interface FetchWindowPrometheusQueryPortOptions {
  /** Trusted Prometheus origin resolved by host bootstrap, never supplied by a Run or model. */
  url: string;
  /** Secret resolved by host bootstrap. It is sent only as an Authorization header. */
  bearerToken?: string;
  /** Injected so HTTP-date Retry-After values are deterministic and testable. */
  now: () => number;
  fetch?: typeof globalThis.fetch;
}

/** Concrete streaming HTTP transport for the Target-bound window query port. */
export class FetchWindowPrometheusQueryPort implements WindowPrometheusQueryPort {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: FetchWindowPrometheusQueryPortOptions) {
    this.baseUrl = new URL(options.url);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username.length > 0
      || this.baseUrl.password.length > 0 || this.baseUrl.search.length > 0 || this.baseUrl.hash.length > 0
      || this.baseUrl.pathname !== '/') {
      throw new Error('INVALID_PROMETHEUS_URL');
    }
    if (options.bearerToken !== undefined && (options.bearerToken.length === 0 || /[\r\n]/u.test(options.bearerToken))) {
      throw new Error('INVALID_PROMETHEUS_CREDENTIALS');
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async query(request: Readonly<{ query: string; evaluationUnixSeconds: number; signal: AbortSignal }>) {
    request.signal.throwIfAborted();
    if (request.query.trim().length === 0 || !Number.isFinite(request.evaluationUnixSeconds)) {
      throw new Error('INVALID_PROMETHEUS_QUERY');
    }
    const url = new URL('/api/v1/query', this.baseUrl);
    url.searchParams.set('query', request.query);
    url.searchParams.set('time', String(request.evaluationUnixSeconds));
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.bearerToken !== undefined) headers.set('authorization', `Bearer ${this.options.bearerToken}`);
    const response = await this.fetcher(url, { headers, redirect: 'error', signal: request.signal });
    const retryAfterMs = retryAfterMsFromHeader(response.headers.get('retry-after'), this.options.now);
    return {
      status: response.status,
      body: response.body,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
}

function retryAfterMsFromHeader(value: string | null, now: () => number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : Number.MAX_SAFE_INTEGER;
  }
  if (!isHttpDate(trimmed)) return undefined;
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return undefined;
  const nowMs = now();
  if (!Number.isFinite(nowMs)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, retryAt - nowMs);
}

function isHttpDate(value: string): boolean {
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const shortDay = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const longDay = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
  return new RegExp(`^${shortDay}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`, 'u').test(value)
    || new RegExp(`^${longDay}, \\d{2}-${month}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT$`, 'u').test(value)
    || new RegExp(`^${shortDay} ${month} +\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}$`, 'u').test(value);
}
