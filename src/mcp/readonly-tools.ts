import type { SourceResilienceEvent, Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../contracts/tool.js';
import type { McpConnection } from './types.js';
import { type ResilientExecutor, SourceFailure, type RetryEvent } from './resilience.js';
import { validateToolInput } from '../tool/schema.js';

export interface ReadonlyMcpManifest {
  localName: string;
  remoteName: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  expectedRemoteSchema: Record<string, unknown>;
  readOnly: true;
  idempotent: true;
  concurrencySafe: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function bindReadonlyMcpTools(
  connection: McpConnection, manifests: readonly ReadonlyMcpManifest[],
  options: {
    signal: AbortSignal;
    executor: ResilientExecutor;
    now?: () => number;
    deadline?: number;
    attemptBudget?: { remaining: number };
    onEvent?: (sourceId: string, event: RetryEvent) => void;
    sourceId?: string;
    /** Host-mapped Target SourceBinding ID; never derived from model input. */
    targetSourceId?: string;
  },
): Promise<Tool[]> {
  const now = options.now ?? Date.now;
  const descriptors = await options.executor.execute((signal) => connection.listTools(signal), {
    signal: options.signal,
    deadline: options.deadline ?? now() + 30_000,
    now,
    ...(options.attemptBudget === undefined ? {} : { attemptBudget: options.attemptBudget }),
  });
  const names = new Set<string>();
  // Validate the complete manifest before returning any capability.
  for (const manifest of manifests) {
    const remote = descriptors.find((tool) => tool.name === manifest.remoteName);
    if (manifest.readOnly !== true || manifest.idempotent !== true || names.has(manifest.localName)) throw new SourceFailure('POLICY_DENIED');
    names.add(manifest.localName);
    if (!remote || canonical(remote.inputSchema) !== canonical(manifest.expectedRemoteSchema)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  return manifests.map((manifest) => {
    const tool: Tool = {
      name: manifest.localName, description: manifest.description, kind: 'evidence', inputSchema: manifest.inputSchema,
      source: 'mcp',
      ...(options.targetSourceId === undefined ? {} : { targetSourceId: options.targetSourceId }),
      isConcurrencySafe: () => manifest.concurrencySafe,
      call: (input, callOptions) => invoke(connection, manifest.localName, manifest.remoteName, options.sourceId ?? manifest.localName, tool, input, callOptions, options.executor, now, options.onEvent),
    };
    return Object.freeze(tool);
  });
}

async function* invoke(
  connection: McpConnection, toolName: string, remoteName: string, sourceId: string, tool: Tool, input: Record<string, unknown>,
  options: ToolCallOptions, executor: ResilientExecutor, now: () => number, onEvent?: (sourceId: string, event: RetryEvent) => void,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  const validation = validateToolInput(tool, input);
  if (!validation.valid || !validation.value) throw new SourceFailure('TOOL_ARGUMENTS_SCHEMA_INVALID');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const queue: SourceResilienceEvent[] = [];
  let wake: () => void = () => {};
  let complete = false;
  let response: ToolResponse | undefined;
  let failure: unknown;
  const pending = executor.execute((attemptSignal) => connection.call(remoteName, validation.value ?? input, attemptSignal), {
    signal, deadline: Math.min(options.deadline ?? Infinity, now() + 30_000),
    now,
    ...(options.networkAttemptBudget ? { attemptBudget: options.networkAttemptBudget } : {}),
    ...(options.targetOperations === undefined ? {} : { targetOperations: options.targetOperations }),
    ...(options.targetSourceId === undefined ? {} : { targetCapability: options.targetSourceId }),
    onEvent: (event) => {
      onEvent?.(toolName, event);
      if (event.type === 'retry' && event.code !== undefined) {
        queue.push({ type: 'retry_scheduled', sourceId, attempt: event.attempt, reasonCode: event.code, delayMs: event.delayMs ?? 0 });
        wake();
      }
    },
    onCircuitEvent: (event) => {
      if (event.type === 'opened') queue.push({ type: 'circuit_opened', sourceId, failureWindow: event.failureWindow, openUntil: event.openUntil });
      else if (event.type === 'half_opened') queue.push({ type: 'circuit_half_opened', sourceId, probePolicy: 'single_probe' });
      else queue.push({ type: 'circuit_closed', sourceId, recoveryEvidence: [] });
      wake();
    },
  }).then((value) => { response = value; }).catch((error: unknown) => { failure = error; }).finally(() => { complete = true; wake(); });
  try {
    while (!complete || queue.length > 0) {
      const event = queue.shift();
      if (event) yield { type: 'event', name: 'source_resilience', payload: sourceResilienceChunkPayload(event) };
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
    await pending;
    if (failure !== undefined) throw failure instanceof Error ? failure : new SourceFailure('MCP_PROTOCOL_ERROR');
    if (!response) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    return response;
  } finally { controller.abort(); }
}

function sourceResilienceChunkPayload(event: SourceResilienceEvent): Record<string, unknown> {
  switch (event.type) {
    case 'retry_scheduled': return { kind: event.type, sourceId: event.sourceId, attempt: event.attempt, reasonCode: event.reasonCode, delayMs: event.delayMs };
    case 'circuit_opened': return { kind: event.type, sourceId: event.sourceId, failureWindow: event.failureWindow, openUntil: event.openUntil };
    case 'circuit_half_opened': return { kind: event.type, sourceId: event.sourceId, probePolicy: event.probePolicy };
    case 'circuit_closed': return { kind: event.type, sourceId: event.sourceId, recoveryEvidence: event.recoveryEvidence };
  }
}
