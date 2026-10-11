import { systemClock, type Clock } from '../contracts/common.js';
import type { AgentContext } from '../contracts/context.js';
import type { MemoryCaptureIntent } from '../contracts/diagnostic-memory.js';
import { EventIdConflictError, type PendingAgentEventV2 } from '../contracts/event-store.js';
import { parseAgentEventV2 } from '../contracts/event-v2/schema.js';
import type { GovernanceEffect } from '../contracts/hooks.js';
import {
  CheckpointConflictError,
  type AgentStateUnitOfWork,
  type DurableEventOutbox,
  type DurableExecutionTransition,
  type DurableOutboxRecord,
  type DurableRunState,
  type DurableTransitionUnitOfWork,
  type EvidencePage,
  type EvidenceQueryStore,
  type EvidenceRecord,
  type EvidenceStore,
  type StoredRunCheckpoint,
  type ToolExecutionJournal,
  type ToolExecutionRecord,
  type VersionedCheckpointStore,
} from '../contracts/storage.js';
import type { ToolExecutionResult } from '../contracts/tool.js';
import { TargetConfigurationError, type ResolvedTargetSnapshot, type TargetBindingStore,
  type TargetBindingTransition, type TargetRunBindingRecord, type TargetRunBindingPage,
  type TargetRunRequestRecord } from '../contracts/target.js';
import { parseResolvedTargetSnapshot, parseTargetRunRequestRecord } from '../contracts/target-schema.js';
import { checkpointChecksum, parseAgentContext } from './durable-codec.js';
import type { InMemoryDiagnosticTransaction } from '../memory/diagnostic-memory-state.js';
import { cloneInMemoryDiagnosticRecords, createInMemoryDiagnosticRecords, createInMemoryDiagnosticRepository,
  stageAutomaticMemoryCapture, stageMemorySignals } from '../memory/diagnostic-memory-state.js';
import { InMemoryDiagnosticMemoryStore } from '../memory/in-memory-diagnostic-memory.js';
import { sameTargetRecord, validateTargetBindingState } from './target-binding-state.js';

const DEFAULT_EVIDENCE_PAGE_SIZE = 50;
const MAX_EVIDENCE_PAGE_SIZE = 100;

/**
 * Deterministic in-memory implementation of the durable Run state contracts.
 * It is intentionally a test/default-runtime implementation, not a persistence fallback.
 */
export class InMemoryDurableState implements DurableRunState, VersionedCheckpointStore, ToolExecutionJournal,
  AgentStateUnitOfWork, DurableTransitionUnitOfWork, DurableEventOutbox, TargetBindingStore {
  private readonly checkpointRecords = new Map<string, StoredRunCheckpoint>();
  private readonly executionRecords = new Map<string, ToolExecutionRecord>();
  private readonly outboxRecords = new Map<string, DurableOutboxRecord>();
  private readonly targetSnapshots = new Map<string, ResolvedTargetSnapshot>();
  private readonly targetBindingRecords = new Map<string, TargetRunBindingRecord>();
  private readonly targetRequestRecords = new Map<string, TargetRunRequestRecord>();
  private readonly diagnosticState: InMemoryDiagnosticTransaction;

  public readonly checkpoints: VersionedCheckpointStore = this;
  public readonly executions: ToolExecutionJournal = this;
  public readonly stateUnitOfWork: AgentStateUnitOfWork = this;
  public readonly transitions: DurableTransitionUnitOfWork = this;
  public readonly outbox: DurableEventOutbox = this;
  public readonly targetBindings: TargetBindingStore = this;

  public readonly evidence = new InMemoryEvidenceRepository();
  public readonly memory: InMemoryDiagnosticMemoryStore;

  public constructor(private readonly clock: Clock = systemClock) {
    this.diagnosticState = { checkpointRecords: this.checkpointRecords, executionRecords: this.executionRecords,
      outboxRecords: this.outboxRecords, memory: createInMemoryDiagnosticRecords() };
    this.memory = new InMemoryDiagnosticMemoryStore({ clock, transaction: this.diagnosticState });
  }

  public load(runId: string): Promise<StoredRunCheckpoint | null> {
    const checkpoint = this.checkpointRecords.get(runId);
    if (checkpoint === undefined) return Promise.resolve(null);
    try {
      validateTargetBindingState(checkpoint.context, undefined, this.targetBindingReader());
      return Promise.resolve(clone(checkpoint));
    } catch {
      return Promise.reject(new TargetConfigurationError('TARGET_BINDING_INVALID'));
    }
  }

  public save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => {
      validateTargetBindingState(context, undefined, this.targetBindingReader());
      const checkpoint = this.nextCheckpoint(context, expectedRevision);
      this.checkpointRecords.set(context.runId, clone(checkpoint));
      return clone(checkpoint);
    });
  }

  public prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    return Promise.resolve().then(() => {
      validatePreparedExecution(record);
      const existing = this.executionRecords.get(record.toolCallId);
      if (existing !== undefined) {
        if (!sameExecutionIdentity(existing, record)) throw new Error(`tool execution identity collision: ${record.toolCallId}`);
        return clone(existing);
      }
      const stored = clone(record);
      this.executionRecords.set(record.toolCallId, stored);
      return clone(stored);
    });
  }

  public get(toolCallId: string): Promise<ToolExecutionRecord | null> {
    const execution = this.executionRecords.get(toolCallId);
    return Promise.resolve(execution === undefined ? null : clone(execution));
  }

  public reserveRequest(record: TargetRunRequestRecord): Promise<{ record: TargetRunRequestRecord; created: boolean }> {
    return Promise.resolve().then(() => {
      const normalized = parseTargetRunRequestRecord(record);
      const existing = this.targetRequestRecords.get(normalized.requestId);
      if (existing !== undefined) {
        if (!sameRequestIdentity(existing, normalized)) throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
        return { record: clone(existing), created: false };
      }
      const runCollision = [...this.targetRequestRecords.values()].some(item => item.runId === normalized.runId)
        || this.targetBindingRecords.has(normalized.runId);
      if (runCollision) throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
      this.targetRequestRecords.set(normalized.requestId, clone(normalized));
      return { record: clone(normalized), created: true };
    });
  }

  public getRequest(requestId: string): Promise<TargetRunRequestRecord | null> {
    const record = this.targetRequestRecords.get(requestId);
    return Promise.resolve(record === undefined ? null : clone(record));
  }

  public getBinding(runId: string): Promise<TargetRunBindingRecord | null> {
    const record = this.targetBindingRecords.get(runId);
    return Promise.resolve(record === undefined ? null : clone(record));
  }

  public getSnapshot(bindingId: string): Promise<ResolvedTargetSnapshot | null> {
    const snapshot = this.targetSnapshots.get(bindingId);
    return Promise.resolve(snapshot === undefined ? null : parseResolvedTargetSnapshot(snapshot));
  }

  public listByTarget(input: { targetId: string; cursor?: string; limit: number }): Promise<TargetRunBindingPage> {
    return Promise.resolve().then(() => {
      if (input.targetId.length === 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new RangeError('Target Run page request is invalid.');
      }
      const after = input.cursor;
      const rows = [...this.targetBindingRecords.values()]
        .filter(record => record.targetId === input.targetId && (after === undefined || record.runId > after))
        .sort((left, right) => left.runId.localeCompare(right.runId));
      const page = rows.slice(0, input.limit + 1);
      const hasMore = page.length > input.limit;
      const items = page.slice(0, input.limit).map(record => clone(record));
      const last = items.at(-1);
      return { items, ...(hasMore && last !== undefined ? { nextCursor: last.runId } : {}) };
    });
  }

  public commitToolResult(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    result: ToolExecutionResult;
  }): Promise<StoredRunCheckpoint> {
    return this.commit({
      expectedRevision: input.expectedRevision,
      context: input.context,
      execution: { kind: 'completed', record: input.execution, result: input.result },
      outboxEvents: [],
    });
  }

  public markToolUncertain(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    reasonCode: string;
  }): Promise<StoredRunCheckpoint> {
    return this.commit({
      expectedRevision: input.expectedRevision,
      context: input.context,
      execution: { kind: 'uncertain', record: input.execution, reasonCode: input.reasonCode },
      outboxEvents: [],
    });
  }

  public commit(input: {
    expectedRevision: number | null;
    context: AgentContext;
    execution?: DurableExecutionTransition;
    outboxEvents: readonly PendingAgentEventV2[];
    governanceEffects?: readonly GovernanceEffect[];
    memoryCapture?: MemoryCaptureIntent;
    targetBinding?: TargetBindingTransition;
  }): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => {
      const transition = input.execution;
      const nextContext = transition?.kind === 'completed'
        ? appendCompletedResult(input.context, transition.result)
        : clone(input.context);
      const stagedTargetSnapshots = cloneMap(this.targetSnapshots);
      const stagedTargetBindings = cloneMap(this.targetBindingRecords);
      this.stageTargetBinding(nextContext, input.targetBinding, stagedTargetSnapshots, stagedTargetBindings);
      let existing: ToolExecutionRecord | undefined;
      let nextExecution: ToolExecutionRecord | undefined;
      // Preserve the legacy CAS-first error contract for completed results:
      // a stale checkpoint must be reported before a now-terminal execution.
      // Uncertain transitions retain their former execution-first behavior,
      // because the prepared state determines whether a no-op context must
      // still advance its revision.
      if (transition?.kind === 'uncertain') {
        existing = this.requireCompatibleExecution(transition.record);
        nextExecution = uncertainExecution(existing, transition.reasonCode, this.clock);
      }
      const checkpoint = this.nextCheckpoint(
        nextContext,
        input.expectedRevision,
        transition?.kind === 'uncertain' && existing?.state === 'prepared',
      );
      if (transition?.kind === 'completed') {
        existing = this.requireCompatibleExecution(transition.record);
        nextExecution = completedExecution(existing, transition.result, this.clock);
      }
      const outbox = this.planOutbox(input.outboxEvents, this.clock.now().toISOString(), nextContext.runId);
      const working: InMemoryDiagnosticTransaction = {
        checkpointRecords: cloneMap(this.checkpointRecords),
        executionRecords: cloneMap(this.executionRecords),
        outboxRecords: cloneMap(this.outboxRecords),
        memory: cloneInMemoryDiagnosticRecords(this.diagnosticState.memory),
      };
      working.checkpointRecords.set(nextContext.runId, clone(checkpoint));
      if (nextExecution !== undefined) working.executionRecords.set(nextExecution.toolCallId, clone(nextExecution));
      for (const record of outbox) working.outboxRecords.set(record.event.eventId, clone(record));
      const repository = createInMemoryDiagnosticRepository(working);
      if (input.governanceEffects !== undefined) stageMemorySignals(repository, nextContext, input.governanceEffects);
      if (input.memoryCapture !== undefined) stageAutomaticMemoryCapture(repository, input.memoryCapture);
      replaceMap(this.checkpointRecords, working.checkpointRecords);
      replaceMap(this.executionRecords, working.executionRecords);
      replaceMap(this.outboxRecords, working.outboxRecords);
      replaceMemoryRecords(this.diagnosticState.memory, working.memory);
      replaceMap(this.targetSnapshots, stagedTargetSnapshots);
      replaceMap(this.targetBindingRecords, stagedTargetBindings);
      return clone(checkpoint);
    });
  }

  public enqueue(input: { events: readonly PendingAgentEventV2[]; createdAt: string }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => {
      const records = this.planOutbox(input.events, input.createdAt);
      for (const record of records) this.outboxRecords.set(record.event.eventId, clone(record));
      return records.map((record) => clone(record));
    });
  }

  public listPending(input: { runId?: string; limit: number }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => {
      assertOutboxLimit(input.limit);
      return [...this.outboxRecords.values()]
        .filter((record) => record.publishedAt === undefined && (input.runId === undefined || record.event.runId === input.runId))
        .slice(0, input.limit)
        .map((record) => clone(record));
    });
  }

  public markPublished(input: { eventId: string; publishedAt: string }): Promise<void> {
    return Promise.resolve().then(() => {
      assertTimestamp(input.publishedAt, 'publishedAt');
      const existing = this.outboxRecords.get(input.eventId);
      if (existing === undefined) throw new Error(`Outbox event not found: ${input.eventId}`);
      if (existing.publishedAt === undefined) {
        this.outboxRecords.set(input.eventId, { ...clone(existing), publishedAt: input.publishedAt });
      }
    });
  }

  private requireCompatibleExecution(incoming: ToolExecutionRecord): ToolExecutionRecord {
    const existing = this.executionRecords.get(incoming.toolCallId);
    if (existing === undefined) throw new Error(`prepared tool execution not found: ${incoming.toolCallId}`);
    if (!sameExecutionIdentity(existing, incoming)) throw new Error(`tool execution identity collision: ${incoming.toolCallId}`);
    return existing;
  }

  private nextCheckpoint(
    context: AgentContext,
    expectedRevision: number | null,
    forceRevisionAdvance = false,
  ): StoredRunCheckpoint {
    const normalized = parseAgentContext(context);
    const current = this.checkpointRecords.get(normalized.runId);
    const checksum = checkpointChecksum(normalized);
    const actualRevision = current?.revision ?? null;
    const validCreate = current === undefined && expectedRevision === null;
    const validUpdate = current !== undefined && expectedRevision === actualRevision;
    if (!validCreate && !validUpdate) {
      throw new CheckpointConflictError(normalized.runId, expectedRevision, actualRevision);
    }
    if (current !== undefined && current.checksum === checksum && !forceRevisionAdvance) return clone(current);

    return {
      context: clone(normalized),
      revision: (actualRevision ?? 0) + 1,
      savedAt: this.clock.now().toISOString(),
      checksum,
    };
  }

  private stageTargetBinding(
    context: AgentContext,
    transition: TargetBindingTransition | undefined,
    snapshots: Map<string, ResolvedTargetSnapshot>,
    bindings: Map<string, TargetRunBindingRecord>,
  ): void {
    const validated = validateTargetBindingState(context, transition, {
      bindingByRunId: runId => bindings.get(runId) ?? null,
      snapshotByBindingId: bindingId => snapshots.get(bindingId) ?? null,
      requestById: requestId => this.targetRequestRecords.get(requestId) ?? null,
    });
    if (transition === undefined || validated.binding === undefined) return;
    const current = bindings.get(validated.binding.runId);
    if (current !== undefined && !sameTargetRecord(current, validated.binding)) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    if (validated.snapshot !== undefined) snapshots.set(validated.binding.bindingId, clone(validated.snapshot));
    bindings.set(validated.binding.runId, clone(validated.binding));
  }

  private targetBindingReader(): {
    bindingByRunId: (runId: string) => TargetRunBindingRecord | null;
    snapshotByBindingId: (bindingId: string) => ResolvedTargetSnapshot | null;
    requestById: (requestId: string) => TargetRunRequestRecord | null;
  } {
    return {
      bindingByRunId: runId => this.targetBindingRecords.get(runId) ?? null,
      snapshotByBindingId: bindingId => this.targetSnapshots.get(bindingId) ?? null,
      requestById: requestId => this.targetRequestRecords.get(requestId) ?? null,
    };
  }

  private planOutbox(
    events: readonly PendingAgentEventV2[],
    createdAt: string,
    expectedRunId?: string,
  ): DurableOutboxRecord[] {
    assertTimestamp(createdAt, 'createdAt');
    const eventIds = new Set<string>();
    return events.map((event) => {
      const normalized = parsePendingEvent(event);
      if (expectedRunId !== undefined && normalized.runId !== expectedRunId) {
        throw new Error(`Outbox event runId mismatch: expected ${expectedRunId}, received ${normalized.runId}`);
      }
      if (normalized.durability !== 'durable') throw new Error('Outbox accepts durable events only');
      if (eventIds.has(normalized.eventId)) throw new EventIdConflictError(normalized.eventId);
      eventIds.add(normalized.eventId);
      const existing = this.outboxRecords.get(normalized.eventId);
      if (existing !== undefined) {
        if (!samePendingEvent(existing.event, normalized)) throw new EventIdConflictError(normalized.eventId);
        return clone(existing);
      }
      return { event: normalized, enqueuedAt: createdAt };
    });
  }
}

function sameRequestIdentity(
  left: TargetRunRequestRecord,
  right: TargetRunRequestRecord,
): boolean {
  return left.requestId === right.requestId && left.targetId === right.targetId
    && left.requestDigest === right.requestDigest;
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, clone(value));
}

function replaceMemoryRecords(target: ReturnType<typeof createInMemoryDiagnosticRecords>,
  source: ReturnType<typeof createInMemoryDiagnosticRecords>): void {
  replaceMap(target.cases, source.cases);
  replaceMap(target.indexes, source.indexes);
  replaceMap(target.jobs, source.jobs);
  replaceMap(target.captureCommands, source.captureCommands);
  replaceMap(target.reviews, source.reviews);
  replaceMap(target.signals, source.signals);
}

/** In-memory Evidence repository with the same duplicate and pagination behavior as SQLite. */
export class InMemoryEvidenceRepository implements EvidenceStore, EvidenceQueryStore {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly captureKeys = new Map<string, string>();

  public save(record: EvidenceRecord): Promise<void> {
    return Promise.resolve().then(() => {
      const normalized = normalizeEvidence(record);
      const existingById = this.records.get(normalized.evidenceId);
      const existingByCapture = normalized.captureKey === undefined
        ? undefined
        : this.records.get(this.captureKeys.get(normalized.captureKey) ?? '');
      const existing = existingById ?? existingByCapture;

      if (existing !== undefined) {
        if (sameEvidenceIdentity(existing, normalized)) return;
        throw new Error(`evidence identity collision: ${normalized.evidenceId}`);
      }
      this.records.set(normalized.evidenceId, clone(normalized));
      if (normalized.captureKey !== undefined) this.captureKeys.set(normalized.captureKey, normalized.evidenceId);
    });
  }

  public get(evidenceId: string): Promise<EvidenceRecord | null> {
    const record = this.records.get(evidenceId);
    return Promise.resolve(record === undefined ? null : clone(record));
  }

  public listByRun(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<EvidencePage> {
    return Promise.resolve().then(() => {
      const limit = pageLimit(options.limit);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      if (cursor !== undefined && cursor.runId !== runId) throw new Error('evidence cursor does not belong to this Run');
      const matching = [...this.records.values()]
        .filter((record) => record.runId === runId)
        .sort(compareEvidencePosition);
      const afterCursor = cursor === undefined
        ? matching
        : matching.filter((record) => compareEvidencePosition(record, cursor) > 0);
      const items = afterCursor.slice(0, limit).map((record) => clone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last === undefined || afterCursor.length <= items.length ? {} : { nextCursor: encodeCursor(last) }),
      };
    });
  }
}

function completedExecution(existing: ToolExecutionRecord, result: ToolExecutionResult, clock: Clock): ToolExecutionRecord {
  if (existing.toolCallId !== result.toolCallId || existing.toolName !== result.toolName) {
    throw new Error(`tool result does not match execution: ${result.toolCallId}`);
  }
  if (result.status === 'interrupted' || result.status === 'awaiting_external') {
    throw new Error(`tool result is not terminal: ${result.toolCallId}`);
  }
  const state = result.status === 'success' ? 'succeeded' : 'failed';
  if (existing.state !== 'prepared') {
    if (existing.state === state && existing.result !== undefined && sameJson(existing.result, result)) return clone(existing);
    throw new Error(`tool execution is already terminal: ${result.toolCallId}`);
  }
  return {
    ...clone(existing),
    state,
    result: clone(result),
    finishedAt: result.finishedAt ?? clock.now().toISOString(),
  };
}

function uncertainExecution(existing: ToolExecutionRecord, reasonCode: string, clock: Clock): ToolExecutionRecord {
  if (reasonCode.length === 0) throw new Error('uncertain tool execution requires a reason code');
  if (existing.state === 'uncertain') {
    if (existing.reasonCode === reasonCode) return clone(existing);
    throw new Error(`tool execution uncertainty conflicts: ${existing.toolCallId}`);
  }
  if (existing.state !== 'prepared') throw new Error(`tool execution is already terminal: ${existing.toolCallId}`);
  return { ...clone(existing), state: 'uncertain', reasonCode, finishedAt: clock.now().toISOString() };
}

function appendCompletedResult(context: AgentContext, result: ToolExecutionResult): AgentContext {
  const batch = context.pendingToolBatch;
  if (batch === undefined) throw new Error(`pending batch is required for tool result: ${result.toolCallId}`);
  const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
  if (call === undefined || call.name !== result.toolName) throw new Error(`tool result does not belong to pending batch: ${result.toolCallId}`);
  const existing = batch.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
  if (existing !== undefined) {
    if (!sameJson(existing, result)) throw new Error(`pending batch result conflicts: ${result.toolCallId}`);
    return clone(context);
  }
  return {
    ...clone(context),
    pendingToolBatch: {
      ...clone(batch),
      completedResults: [...batch.completedResults.map((item) => clone(item)), clone(result)],
    },
  };
}

function validatePreparedExecution(record: ToolExecutionRecord): void {
  if (record.toolCallId.length === 0 || record.runId.length === 0 || record.stepId.length === 0 || record.toolName.length === 0 || record.inputDigest.length === 0) {
    throw new Error('prepared tool execution requires stable identity fields');
  }
  if (record.state !== 'prepared' || record.result !== undefined || record.finishedAt !== undefined || record.reasonCode !== undefined) {
    throw new Error('journal prepare only accepts a new prepared execution');
  }
}

function sameExecutionIdentity(left: ToolExecutionRecord, right: ToolExecutionRecord): boolean {
  return left.toolCallId === right.toolCallId
    && left.runId === right.runId
    && left.stepId === right.stepId
    && left.toolName === right.toolName
    && left.toolKind === right.toolKind
    && left.inputDigest === right.inputDigest;
}

function normalizeEvidence(record: EvidenceRecord): EvidenceRecord {
  if (record.evidenceId.length === 0 || record.runId.length === 0) throw new Error('evidence requires an ID and Run ID');
  if (!['metric', 'log', 'trace', 'change'].includes(record.source)) throw new Error('evidence source is invalid');
  if (!Number.isFinite(Date.parse(record.capturedAt))) throw new Error('evidence capture time is invalid');
  if (record.captureKey !== undefined && record.captureKey.length === 0) throw new Error('evidence capture key cannot be empty');
  checkpointChecksum({ summary: record.summary, businessTraceIds: record.businessTraceIds });
  const calculatedRawSha256 = checkpointChecksum(record.raw);
  if (record.rawSha256 !== undefined && record.rawSha256 !== calculatedRawSha256) {
    throw new Error(`evidence raw hash does not match: ${record.evidenceId}`);
  }
  return clone({ ...record, rawSha256: calculatedRawSha256 });
}

function sameEvidenceIdentity(left: EvidenceRecord, right: EvidenceRecord): boolean {
  return left.evidenceId === right.evidenceId
    && left.captureKey === right.captureKey
    && left.rawSha256 === right.rawSha256;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EVIDENCE_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_EVIDENCE_PAGE_SIZE) {
    throw new RangeError(`evidence page limit must be between 1 and ${MAX_EVIDENCE_PAGE_SIZE}`);
  }
  return value;
}

interface EvidenceCursor {
  runId: string;
  capturedAt: string;
  evidenceId: string;
}

function encodeCursor(record: EvidenceRecord): string {
  return Buffer.from(JSON.stringify({ runId: record.runId, capturedAt: record.capturedAt, evidenceId: record.evidenceId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): EvidenceCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('evidence cursor is invalid');
  }
  if (!isEvidenceCursor(parsed)) throw new Error('evidence cursor is invalid');
  return parsed;
}

function isEvidenceCursor(value: unknown): value is EvidenceCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EvidenceCursor>;
  return typeof candidate.runId === 'string'
    && typeof candidate.capturedAt === 'string'
    && typeof candidate.evidenceId === 'string';
}

function compareEvidencePosition(record: EvidenceRecord, cursor: EvidenceCursor): number {
  // The source page and aggregate cursor must use SQLite BINARY byte ordering.
  return Buffer.compare(Buffer.from(record.capturedAt, 'utf8'), Buffer.from(cursor.capturedAt, 'utf8'))
    || Buffer.compare(Buffer.from(record.evidenceId, 'utf8'), Buffer.from(cursor.evidenceId, 'utf8'));
}

function sameJson(left: unknown, right: unknown): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}

function parsePendingEvent(event: PendingAgentEventV2): PendingAgentEventV2 {
  const parsed = parseAgentEventV2({ ...clone(event), sequence: 1 });
  const { sequence, ...pending } = parsed;
  void sequence;
  return pending;
}

function samePendingEvent(left: PendingAgentEventV2, right: PendingAgentEventV2): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}

function assertOutboxLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Outbox limit must be a positive safe integer');
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
