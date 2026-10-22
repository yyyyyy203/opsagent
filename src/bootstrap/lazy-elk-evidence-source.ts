import { canonicalJson, type EvidenceSourcePage, type LogEvidenceQuery } from '../contracts/index.js';
import { HttpMcpConnection } from '../infrastructure/mcp/http-connection.js';
import {
  McpElkPageClient,
  PagedEvidenceSource,
  ResilientElkPageClient,
  type ElkPageRequestOptions,
} from '../infrastructure/elk/paged-evidence-source.js';
import {
  logsCloseSnapshotInputJsonSchema,
  logsSearchPageInputJsonSchema,
} from '../mcp/logs-protocol.js';
import type { McpConnection } from '../mcp/types.js';
import { SourceFailure } from '../mcp/resilience.js';
import type { ExecutionDeadline, ResilientExecutor } from '../mcp/resilience.js';
import type { TargetSourcePartitionLease } from '../infrastructure/target-source-partition-registry.js';
import type { McpToolDescriptor } from '../tool/adapters/mcp-tool-adapter.js';
import type { LogEvidencePageSource } from './log-evidence-tools.js';

const DEFAULT_INIT_DEADLINE_MS = 60_000;

export interface LazyElkEvidenceSourceOptions {
  mcpUrl: string;
  executor: ResilientExecutor;
  partition?: TargetSourcePartitionLease;
  sourceId?: string;
  now: () => number;
  registerShutdownHook: (callback: () => Promise<void>) => void;
  /** Test seam and alternate transport injection; production defaults to the official HTTP MCP adapter. */
  connectionFactory?: (url: string) => McpConnection;
}

/**
 * Builds a read-only log page source without connecting during application startup.
 * The first request validates the complete MCP contract before allowing a search call.
 */
export function createLazyElkEvidenceSource(options: LazyElkEvidenceSourceOptions): LogEvidencePageSource {
  const connection = (options.connectionFactory ?? ((url) => new HttpMcpConnection({ url })))(options.mcpUrl);
  const lifecycle = new AbortController();
  let connected = false;
  let closed = false;
  let binding: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const pageClient = new ResilientElkPageClient(new McpElkPageClient(connection), {
    executor: options.executor,
    ...(options.partition === undefined ? {} : { partition: options.partition }),
    now: options.now,
    sourceId: options.sourceId ?? 'elk',
  });
  const paged = new PagedEvidenceSource(pageClient, { now: options.now });

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    lifecycle.abort();
    const pendingBinding = binding;
    closePromise = (async () => {
      await pendingBinding?.catch(() => undefined);
      await connection.close();
    })();
    return closePromise;
  };

  const ensureConnected = async (request: ElkPageRequestOptions & { signal: AbortSignal; deadline: number }): Promise<void> => {
    if (closed) throw new SourceFailure('ABORTED');
    if (connected) return;
    if (binding !== undefined) return waitForBinding(binding, request, options.now);
    const attempt = (async (): Promise<void> => {
      try {
        await executeSourceOperation(
          (signal) => connection.connect(signal, request.networkAttemptBudget === undefined
            ? undefined : { networkAttemptBudget: request.networkAttemptBudget }),
          request,
        );
        if (closed) throw new SourceFailure('ABORTED');
        const tools = await executeSourceOperation(
          (signal) => connection.listTools(signal, request.networkAttemptBudget === undefined
            ? undefined : { networkAttemptBudget: request.networkAttemptBudget }),
          request,
        );
        validateLogsTools(tools);
        if (closed) throw new SourceFailure('ABORTED');
        connected = true;
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw safeFailure(error);
      }
    })();
    binding = attempt;
    try {
      await attempt;
    } finally {
      if (binding === attempt) binding = undefined;
    }
  };

  const source: LogEvidencePageSource = {
    close,
    pages(query: LogEvidenceQuery, requestOptions: ElkPageRequestOptions = {}): AsyncIterable<EvidenceSourcePage> {
      return iterate(query, requestOptions);
    },
  };

  async function* iterate(
    query: LogEvidenceQuery,
    requestOptions: ElkPageRequestOptions,
  ): AsyncGenerator<EvidenceSourcePage, void> {
    if (closed) throw new SourceFailure('ABORTED');
    const signal = AbortSignal.any([
      requestOptions.signal ?? new AbortController().signal,
      lifecycle.signal,
    ]);
    const request: ElkPageRequestOptions & { signal: AbortSignal; deadline: number } = {
      ...requestOptions,
      signal,
      deadline: requestOptions.deadline ?? options.now() + DEFAULT_INIT_DEADLINE_MS,
      ...(requestOptions.targetOperations === undefined ? {} : { targetOperations: requestOptions.targetOperations }),
      ...(requestOptions.targetSourceId === undefined ? {} : { targetSourceId: requestOptions.targetSourceId }),
    };
    if (options.now() >= request.deadline
      || (request.networkAttemptBudget !== undefined && request.networkAttemptBudget.remaining <= 0)) {
      throw new SourceFailure('BUDGET_EXCEEDED');
    }
    await ensureConnected(request);
    yield* paged.pages(query, request);
  }

  options.registerShutdownHook(close);
  return source;

  function executeSourceOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    request: ElkPageRequestOptions & { signal: AbortSignal; deadline: number },
  ): Promise<T> {
    if (options.partition !== undefined) {
      return options.partition.execute(operation, {
        signal: request.signal,
        deadline: request.deadline,
        ...(request.targetOperations === undefined ? {} : { targetOperations: request.targetOperations }),
        onEvent: event => {
          if (event.type === 'retry' && event.code !== undefined) request.onResilienceEvent?.({
            type: 'retry_scheduled', sourceId: options.sourceId ?? request.targetSourceId ?? 'elk',
            attempt: event.attempt, reasonCode: event.code, delayMs: event.delayMs ?? 0,
          });
        },
        onCircuitEvent: event => {
          const sourceId = options.sourceId ?? request.targetSourceId ?? 'elk';
          if (event.type === 'opened') request.onResilienceEvent?.({
            type: 'circuit_opened', sourceId, failureWindow: event.failureWindow, openUntil: event.openUntil,
          });
          else if (event.type === 'half_opened') request.onResilienceEvent?.({
            type: 'circuit_half_opened', sourceId, probePolicy: 'single_probe',
          });
          else request.onResilienceEvent?.({ type: 'circuit_closed', sourceId, recoveryEvidence: ['source_success'] });
        },
      });
    }
    return options.executor.execute(operation, executionDeadline(request, options.now));
  }
}

function executionDeadline(
  request: ElkPageRequestOptions & { signal: AbortSignal; deadline: number },
  now: () => number,
): ExecutionDeadline {
  const sourceId = request.targetSourceId ?? 'elk';
  return {
    signal: request.signal,
    deadline: request.deadline,
    now,
    onEvent: (event) => {
      if (event.type === 'retry' && event.code !== undefined) request.onResilienceEvent?.({
        type: 'retry_scheduled', sourceId, attempt: event.attempt,
        reasonCode: event.code, delayMs: event.delayMs ?? 0,
      });
    },
    onCircuitEvent: (event) => {
      if (event.type === 'opened') request.onResilienceEvent?.({
        type: 'circuit_opened', sourceId, failureWindow: event.failureWindow, openUntil: event.openUntil,
      });
      else if (event.type === 'half_opened') request.onResilienceEvent?.({
        type: 'circuit_half_opened', sourceId, probePolicy: 'single_probe',
      });
      else request.onResilienceEvent?.({ type: 'circuit_closed', sourceId, recoveryEvidence: [] });
    },
  };
}

function waitForBinding(
  binding: Promise<void>,
  request: ElkPageRequestOptions & { signal: AbortSignal; deadline: number },
  now: () => number,
): Promise<void> {
  if (request.signal.aborted) return Promise.reject(new SourceFailure('ABORTED'));
  const remainingMs = request.deadline - now();
  if (remainingMs <= 0) return Promise.reject(new SourceFailure('BUDGET_EXCEEDED'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const pending = new Promise<void>((resolve, reject) => {
    abort = () => reject(new SourceFailure('ABORTED'));
    timer = setTimeout(() => reject(new SourceFailure('BUDGET_EXCEEDED')), remainingMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    void binding.then(resolve, reject);
  });
  return pending.finally(() => {
    // Each waiter owns only its listener and timer; the shared binding keeps running.
    if (abort !== undefined) request.signal.removeEventListener('abort', abort);
    if (timer !== undefined) clearTimeout(timer);
  });
}

function validateLogsTools(tools: readonly McpToolDescriptor[]): void {
  const expected = new Map<string, Record<string, unknown>>([
    ['logs.search_page', logsSearchPageInputJsonSchema],
    ['logs.close_snapshot', logsCloseSnapshotInputJsonSchema],
  ]);
  if (tools.length !== expected.size) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  const validated = new Set<string>();
  for (const tool of tools) {
    const schema = expected.get(tool.name);
    if (schema === undefined || validated.has(tool.name)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const annotations = tool.annotations;
    if (annotations?.readOnlyHint !== true
      || annotations.destructiveHint !== false
      || annotations.idempotentHint !== true
      || annotations.openWorldHint !== false
      || canonicalJson(tool.inputSchema) !== canonicalJson(schema)) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    validated.add(tool.name);
  }
  if (validated.size !== expected.size) throw new SourceFailure('MCP_PROTOCOL_ERROR');
}

function safeFailure(error: unknown): SourceFailure {
  return error instanceof SourceFailure ? error : new SourceFailure('MCP_PROTOCOL_ERROR');
}
