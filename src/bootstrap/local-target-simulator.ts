import type { LogsPageBackend, LogsPageWireResult } from '../mcp/logs-protocol.js';
import { startLogsMcpServer } from '../infrastructure/mcp/logs-server.js';
import { startSettlementMcpServer } from '../infrastructure/mcp/settlement-server.js';
import { startTargetPrometheusServer } from '../infrastructure/simulator/target-prometheus-server.js';

export interface LocalTargetSimulatorOptions {
  metricsPort?: number;
  logsPort?: number;
  legacyMetricsPort?: number;
  now?: () => number;
  successCount?: number;
  failureCount?: number;
}

/** Owns local-only source fixtures used by the ordinary Target host example. */
export async function startLocalTargetSimulator(options: LocalTargetSimulatorOptions = {}): Promise<{
  metricsUrl: string;
  logsMcpUrl: string;
  legacyMetricsMcpUrl: string;
  close(): Promise<void>;
}> {
  const metrics = await startTargetPrometheusServer({
    ...(options.metricsPort === undefined ? {} : { port: options.metricsPort }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.successCount === undefined ? {} : { successCount: options.successCount }),
    ...(options.failureCount === undefined ? {} : { failureCount: options.failureCount }),
  });
  let logs: Awaited<ReturnType<typeof startLogsMcpServer>> | undefined;
  let legacyMetrics: Awaited<ReturnType<typeof startSettlementMcpServer>> | undefined;
  try {
    const backend: LogsPageBackend = {
      searchPage: (input, signal): Promise<LogsPageWireResult> => {
        signal.throwIfAborted();
        const end = Date.parse(input.end);
        if (!Number.isFinite(end) || Date.parse(input.start) >= end || input.service !== 'checkout') {
          return Promise.resolve({ status: 'source_error', code: 'INVALID_INPUT' });
        }
        const timestamp = new Date(Math.max(Date.parse(input.start), end - 30_000)).toISOString();
        const record = {
          timestamp, service: 'checkout', level: 'ERROR',
          message: 'synthetic settlement timeout',
          fields: { environment: 'simulation', dataset: 'local-settlement-shared-v1' },
        };
        return Promise.resolve({ status: 'available' as const,
          sourceSnapshotId: `local-${input.requestId ?? 'page'}`.slice(0, 256), records: [record] });
      },
      closeSnapshot: (_input, signal) => { signal.throwIfAborted(); return Promise.resolve(); },
      close: () => Promise.resolve(),
    };
    logs = await startLogsMcpServer(backend, { port: options.logsPort ?? 19_391 });
    const now = options.now ?? Date.now;
    const successCount = options.successCount ?? 96;
    const failureCount = options.failureCount ?? 4;
    legacyMetrics = await startSettlementMcpServer({
      query: signal => {
        signal.throwIfAborted();
        const end = Math.floor(now() / 1_000);
        return Promise.resolve({ status: 'available' as const, start: end - 300, end,
          counts: { total: successCount + failureCount, failed: failureCount },
          raw: { source: 'local-target-simulator', dataset: 'local-settlement-shared-v1' } });
      },
    }, { port: options.legacyMetricsPort ?? 19_392 });
  } catch (error) {
    await Promise.allSettled([metrics.close(), ...(logs === undefined ? [] : [logs.close()]),
      ...(legacyMetrics === undefined ? [] : [legacyMetrics.close()])]);
    throw error;
  }
  let closed = false;
  return {
    metricsUrl: metrics.url,
    logsMcpUrl: logs.url,
    legacyMetricsMcpUrl: legacyMetrics.url,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([metrics.close(), logs.close(), legacyMetrics.close()]);
    },
  };
}
