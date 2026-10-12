import type { Clock } from '../../contracts/common.js';
import type { AgentContext } from '../../contracts/context.js';
import type { MemoryCaptureIntent } from '../../contracts/diagnostic-memory.js';
import { StoredDataCorruptionError, type PendingAgentEventV2 } from '../../contracts/event-store.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { GovernanceEffect } from '../../contracts/hooks.js';
import {
  CheckpointConflictError,
  type AgentStateUnitOfWork,
  type DurableExecutionTransition,
  type DurableTransitionUnitOfWork,
  type StoredRunCheckpoint,
  type ToolExecutionJournal,
  type ToolExecutionRecord,
  type VersionedCheckpointStore,
} from '../../contracts/storage.js';
import type { ToolExecutionResult } from '../../contracts/tool.js';
import { TargetConfigurationError, type VersionedResolvedTargetSnapshot, type TargetBindingStore,
  type TargetBindingTransition, type TargetRunBindingRecord, type TargetRunBindingPage,
  type TargetRunRequestRecord, type TargetStartClaim, type TargetStartClaimResult,
  type TargetStartRequestIdentity, type TargetStartReconciliation, type TargetStartStore } from '../../contracts/target.js';
import { parseVersionedResolvedTargetSnapshot, parseTargetRunBindingRecord, parseTargetRunRequestRecord } from '../../contracts/target-schema.js';
import {
  checkpointChecksum,
  parseAgentContext,
  parseToolExecutionRecord,
} from '../../storage/durable-codec.js';
import type { SqliteDatabase } from './database.js';
import { enqueueOutboxEvents } from './event-outbox-store.js';
import { enqueueMemoryCapture, persistMemorySignals } from './memory-job-store.js';
import { validateTargetBindingState } from '../../storage/target-binding-state.js';

const CHECKPOINT_SCHEMA_VERSION = 4;

interface CheckpointRow {
  run_id: string;
  revision: number;
  context_version: number;
  status: string;
  stage: string;
  profile_id: string;
  checkpoint_schema_version: number;
  checkpoint_json: string;
  checksum: string;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  tool_call_id: string;
  run_id: string;
  step_id: string;
  tool_name: string;
  tool_kind: string;
  input_digest: string;
  state: string;
  result_json: string | null;
  reason_code: string | null;
  prepared_at: string;
  finished_at: string | null;
}

interface RequestRow {
  request_id: string;
  target_id: string;
  request_digest: string;
  run_id: string;
  created_at: string;
}

interface BindingRow {
  run_id: string;
  binding_id: string;
  target_id: string;
  root_run_id: string;
  snapshot_digest: string;
  created_at: string;
  request_id: string | null;
  request_digest: string | null;
}

interface SnapshotRow {
  binding_id: string;
  target_id: string;
  snapshot_digest: string;
  snapshot_json: string;
}

interface StartClaimRow {
  request_id: string;
  run_id: string;
  target_id: string;
  request_digest: string;
  owner_id: string | null;
  claim_epoch: number;
  lease_until: string | null;
  state: 'reserved' | 'claimed' | 'started';
}

/** SQLite control-plane implementation for checkpoint CAS and execution journal transitions. */
export class SqliteDurableStateStore implements VersionedCheckpointStore, ToolExecutionJournal, AgentStateUnitOfWork,
  DurableTransitionUnitOfWork, TargetBindingStore, TargetStartStore {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  public load(runId: string): Promise<StoredRunCheckpoint | null> {
    return Promise.resolve().then(() => {
      const row = this.checkpointRow(runId);
      return row === undefined ? null : this.parseCheckpoint(row);
    });
  }

  public save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => (
      this.writeCheckpoint(context, expectedRevision)
    )).immediate());
  }

  public prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = parseToolExecutionRecord(record);
      validatePreparedExecution(normalized);
      const row = this.executionRow(normalized.toolCallId);
      if (row !== undefined) {
        const existing = this.parseExecution(row);
        if (!sameExecutionIdentity(existing, normalized)) throw new Error(`tool execution identity collision: ${normalized.toolCallId}`);
        return existing;
      }
      this.insertExecution(normalized);
      return structuredClone(normalized);
    }).immediate());
  }

  public get(toolCallId: string): Promise<ToolExecutionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.executionRow(toolCallId);
      return row === undefined ? null : this.parseExecution(row);
    });
  }

  public reserveRequest(record: TargetRunRequestRecord): Promise<{ record: TargetRunRequestRecord; created: boolean }> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = parseTargetRunRequestRecord(record);
      const existing = this.requestRow(normalized.requestId);
      if (existing !== undefined) {
        const parsed = this.parseRequest(existing);
        if (!sameRequestIdentity(parsed, normalized)) throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
        return { record: parsed, created: false };
      }
      const runCollision = this.database.raw.prepare('SELECT request_id FROM target_run_requests WHERE run_id = ?')
        .get(normalized.runId) as { request_id: string } | undefined;
      if (runCollision !== undefined || this.bindingRow(normalized.runId) !== undefined) {
        throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
      }
      this.database.raw.prepare(`INSERT INTO target_run_requests(request_id, target_id, request_digest, run_id, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(normalized.requestId, normalized.targetId, normalized.requestDigest,
        normalized.runId, normalized.createdAt);
      this.database.raw.prepare(`INSERT INTO target_run_start_claims(
        request_id, run_id, target_id, request_digest, owner_id, claim_epoch, lease_until, state
      ) VALUES (?, ?, ?, ?, NULL, 0, NULL, 'reserved')`).run(
        normalized.requestId, normalized.runId, normalized.targetId, normalized.requestDigest,
      );
      return { record: structuredClone(normalized), created: true };
    }).immediate());
  }

  public claimStart(input: TargetStartRequestIdentity & { ownerId: string; now: string; leaseUntil: string }): Promise<TargetStartClaimResult> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      validateStartClaimInput(input);
      const request = this.requestRow(input.requestId);
      const row = this.startClaimRow(input.requestId);
      if (request === undefined || row === undefined || !sameStartIdentity(this.parseRequest(request), input)
        || !sameStartIdentity(startIdentity(row), input)) return { status: 'unknown' } as const;

      const reconciliation = this.reconcileStartSync(input, row);
      if (reconciliation === 'present') {
        this.database.raw.prepare(`UPDATE target_run_start_claims SET owner_id = NULL, lease_until = NULL, state = 'started'
          WHERE request_id = ?`).run(input.requestId);
        return { status: 'already_started' } as const;
      }
      if (reconciliation === 'unknown') return { status: 'unknown' } as const;

      if (row.state === 'started') return { status: 'unknown' } as const;
      if (row.state === 'claimed') {
        const leaseTime = row.lease_until === null ? Number.NaN : Date.parse(row.lease_until);
        if (!Number.isFinite(leaseTime) || row.owner_id === null) return { status: 'unknown' } as const;
        if (leaseTime > Date.parse(input.now) && row.owner_id !== input.ownerId) return { status: 'busy' } as const;
        if (leaseTime > Date.parse(input.now) && row.owner_id === input.ownerId) {
          return { status: 'claimed', claim: toStartClaim(row) } as const;
        }
      }

      const epoch = row.claim_epoch + 1;
      if (!Number.isSafeInteger(epoch)) return { status: 'unknown' } as const;
      const update = this.database.raw.prepare(`UPDATE target_run_start_claims
        SET owner_id = ?, claim_epoch = ?, lease_until = ?, state = 'claimed'
        WHERE request_id = ? AND claim_epoch = ? AND state = ?`).run(
        input.ownerId, epoch, input.leaseUntil, input.requestId, row.claim_epoch, row.state,
      );
      if (update.changes !== 1) return { status: 'unknown' } as const;
      return { status: 'claimed', claim: { requestId: input.requestId, runId: input.runId,
        targetId: input.targetId, requestDigest: input.requestDigest, ownerId: input.ownerId,
        epoch, leaseUntil: input.leaseUntil } } as const;
    }).immediate());
  }

  public reconcileStart(input: TargetStartRequestIdentity): Promise<TargetStartReconciliation> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const request = this.requestRow(input.requestId);
      const row = this.startClaimRow(input.requestId);
      if (request === undefined || row === undefined || !sameStartIdentity(this.parseRequest(request), input)
        || !sameStartIdentity(startIdentity(row), input)) return { status: 'unknown' } as const;
      const result = this.reconcileStartSync(input, row);
      if (result === 'present') {
        this.database.raw.prepare(`UPDATE target_run_start_claims SET owner_id = NULL, lease_until = NULL, state = 'started'
          WHERE request_id = ?`).run(input.requestId);
        return { status: 'confirmed_present' } as const;
      }
      if (result !== 'absent' || row.state !== 'reserved') return { status: 'unknown' } as const;
      return { status: 'confirmed_absent' } as const;
    }).immediate()).catch(() => ({ status: 'unknown' } as const));
  }

  public releaseStartClaim(input: { claim: TargetStartClaim; now: string }): Promise<boolean> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      validateTimestamp(input.now);
      const request = this.requestRow(input.claim.requestId);
      const row = this.startClaimRow(input.claim.requestId);
      if (request === undefined || !sameStartIdentity(this.parseRequest(request), input.claim)
        || row === undefined || !sameStartIdentity(startIdentity(row), input.claim) || row.state !== 'claimed'
        || row.owner_id !== input.claim.ownerId || row.claim_epoch !== input.claim.epoch
        || row.lease_until !== input.claim.leaseUntil) return false;
      const reconciliation = this.reconcileStartSync(input.claim, row);
      if (reconciliation === 'present') {
        this.database.raw.prepare(`UPDATE target_run_start_claims SET owner_id = NULL, lease_until = NULL, state = 'started'
          WHERE request_id = ? AND state = 'claimed' AND owner_id = ? AND claim_epoch = ?`).run(
          input.claim.requestId, input.claim.ownerId, input.claim.epoch,
        );
        return false;
      }
      if (reconciliation !== 'absent') return false;
      const update = this.database.raw.prepare(`UPDATE target_run_start_claims
        SET owner_id = NULL, lease_until = NULL, state = 'reserved'
        WHERE request_id = ? AND state = 'claimed' AND owner_id = ? AND claim_epoch = ?`).run(
        input.claim.requestId, input.claim.ownerId, input.claim.epoch,
      );
      return update.changes === 1;
    }).immediate()).catch(() => false);
  }

  public getRequest(requestId: string): Promise<TargetRunRequestRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.requestRow(requestId);
      return row === undefined ? null : this.parseRequest(row);
    });
  }

  public getBinding(runId: string): Promise<TargetRunBindingRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.bindingRow(runId);
      return row === undefined ? null : this.parseBinding(row);
    });
  }

  public getSnapshot(bindingId: string): Promise<VersionedResolvedTargetSnapshot | null> {
    return Promise.resolve().then(() => {
      const row = this.database.raw.prepare(`SELECT binding_id, target_id, snapshot_digest, snapshot_json
        FROM target_snapshots WHERE binding_id = ?`).get(bindingId) as SnapshotRow | undefined;
      if (row === undefined) return null;
      try {
        const parsed = parseVersionedResolvedTargetSnapshot(JSON.parse(row.snapshot_json) as unknown);
        if (parsed.targetId !== row.target_id || parsed.digest !== row.snapshot_digest) throw new Error('snapshot row mismatch');
        return parsed;
      } catch {
        throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
      }
    });
  }

  public listByTarget(input: { targetId: string; cursor?: string; limit: number }): Promise<TargetRunBindingPage> {
    return Promise.resolve().then(() => {
      if (input.targetId.length === 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new RangeError('Target Run page request is invalid.');
      }
      const rows = input.cursor === undefined
        ? this.database.raw.prepare(`SELECT * FROM run_target_bindings WHERE target_id = ? ORDER BY run_id LIMIT ?`)
          .all(input.targetId, input.limit + 1) as BindingRow[]
        : this.database.raw.prepare(`SELECT * FROM run_target_bindings WHERE target_id = ? AND run_id > ? ORDER BY run_id LIMIT ?`)
          .all(input.targetId, input.cursor, input.limit + 1) as BindingRow[];
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map(row => this.parseBinding(row));
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
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const transition = input.execution;
      const context = transition?.kind === 'completed'
        ? appendCompletedResult(input.context, transition.result)
        : structuredClone(input.context);
      this.persistTargetBinding(context, input.targetBinding, input.outboxEvents);
      let existing: ToolExecutionRecord | undefined;
      let execution: ToolExecutionRecord | undefined;
      // Keep the established CAS-first result contract.  The checkpoint write
      // remains inside this transaction, so an execution or outbox failure
      // below rolls the write back without weakening atomicity.
      if (transition?.kind === 'uncertain') {
        existing = this.requireExecution(transition.record);
        execution = uncertainExecution(existing, transition.reasonCode, this.clock);
      }
      const checkpoint = this.writeCheckpoint(
        context,
        input.expectedRevision,
        transition?.kind === 'uncertain' && existing?.state === 'prepared',
      );
      if (transition?.kind === 'completed') {
        existing = this.requireExecution(transition.record);
        execution = completedExecution(existing, transition.result, this.clock);
      }
      if (execution !== undefined) this.updateExecution(execution);
      enqueueOutboxEvents(
        this.database,
        { events: input.outboxEvents, createdAt: this.clock.now().toISOString() },
        { expectedRunId: checkpoint.context.runId },
      );
      if (input.governanceEffects !== undefined) persistMemorySignals(this.database, checkpoint.context, input.governanceEffects);
      if (input.memoryCapture !== undefined) enqueueMemoryCapture(this.database, input.memoryCapture);
      return checkpoint;
    }).immediate());
  }

  private requireExecution(incoming: ToolExecutionRecord): ToolExecutionRecord {
    const row = this.executionRow(incoming.toolCallId);
    if (row === undefined) throw new Error(`prepared tool execution not found: ${incoming.toolCallId}`);
    const existing = this.parseExecution(row);
    if (!sameExecutionIdentity(existing, incoming)) throw new Error(`tool execution identity collision: ${incoming.toolCallId}`);
    return existing;
  }

  private writeCheckpoint(
    context: AgentContext,
    expectedRevision: number | null,
    forceRevisionAdvance = false,
  ): StoredRunCheckpoint {
    const normalized = parseAgentContext(context);
    validateTargetBindingState(normalized, undefined, this.targetBindingReader());
    const row = this.checkpointRow(normalized.runId);
    const current = row === undefined ? undefined : this.parseCheckpoint(row);
    const checksum = checkpointChecksum(normalized);
    const actualRevision = current?.revision ?? null;
    const validCreate = current === undefined && expectedRevision === null;
    const validUpdate = current !== undefined && expectedRevision === actualRevision;
    if (!validCreate && !validUpdate) {
      throw new CheckpointConflictError(normalized.runId, expectedRevision, actualRevision);
    }
    if (current !== undefined && row?.checkpoint_schema_version === CHECKPOINT_SCHEMA_VERSION
      && current.checksum === checksum && !forceRevisionAdvance) return current;

    const savedAt = this.clock.now().toISOString();
    const checkpoint: StoredRunCheckpoint = {
      context: structuredClone(normalized),
      revision: (actualRevision ?? 0) + 1,
      savedAt,
      checksum,
    };
    const checkpointJson = JSON.stringify(checkpoint.context);
    if (current === undefined) {
      this.database.raw.prepare(`
        INSERT INTO agent_checkpoints(
          run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
          checkpoint_json, checksum, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.runId, checkpoint.revision, normalized.contextVersion, normalized.status, normalized.stage, normalized.profileId,
        CHECKPOINT_SCHEMA_VERSION, checkpointJson, checksum, savedAt, savedAt,
      );
    } else {
      const update = this.database.raw.prepare(`
        UPDATE agent_checkpoints
        SET revision = ?, context_version = ?, status = ?, stage = ?, profile_id = ?,
            checkpoint_schema_version = ?, checkpoint_json = ?, checksum = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        checkpoint.revision, normalized.contextVersion, normalized.status, normalized.stage, normalized.profileId,
        CHECKPOINT_SCHEMA_VERSION, checkpointJson, checksum, savedAt,
        normalized.runId, current.revision,
      );
      if (update.changes !== 1) {
        const latest = this.checkpointRow(normalized.runId);
        throw new CheckpointConflictError(normalized.runId, expectedRevision, latest?.revision ?? null);
      }
    }
    return structuredClone(checkpoint);
  }

  private checkpointRow(runId: string): CheckpointRow | undefined {
    return this.database.raw.prepare(`
      SELECT run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
             checkpoint_json, checksum, created_at, updated_at
      FROM agent_checkpoints WHERE run_id = ?
    `).get(runId) as CheckpointRow | undefined;
  }

  private executionRow(toolCallId: string): ExecutionRow | undefined {
    return this.database.raw.prepare(`
      SELECT tool_call_id, run_id, step_id, tool_name, tool_kind, input_digest, state,
             result_json, reason_code, prepared_at, finished_at
      FROM tool_executions WHERE tool_call_id = ?
    `).get(toolCallId) as ExecutionRow | undefined;
  }

  private requestRow(requestId: string): RequestRow | undefined {
    return this.database.raw.prepare(`SELECT request_id, target_id, request_digest, run_id, created_at
      FROM target_run_requests WHERE request_id = ?`).get(requestId) as RequestRow | undefined;
  }

  private bindingRow(runId: string): BindingRow | undefined {
    return this.database.raw.prepare(`SELECT run_id, binding_id, target_id, root_run_id, snapshot_digest, created_at,
      request_id, request_digest FROM run_target_bindings WHERE run_id = ?`).get(runId) as BindingRow | undefined;
  }

  private startClaimRow(requestId: string): StartClaimRow | undefined {
    return this.database.raw.prepare(`SELECT request_id, run_id, target_id, request_digest,
      owner_id, claim_epoch, lease_until, state FROM target_run_start_claims WHERE request_id = ?`)
      .get(requestId) as StartClaimRow | undefined;
  }

  private parseRequest(row: RequestRow): TargetRunRequestRecord {
    try {
      return parseTargetRunRequestRecord({ requestId: row.request_id, targetId: row.target_id,
        requestDigest: row.request_digest, runId: row.run_id, createdAt: row.created_at });
    } catch {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
  }

  private parseBinding(row: BindingRow): TargetRunBindingRecord {
    try {
      return parseTargetRunBindingRecord({ bindingId: row.binding_id, targetId: row.target_id, runId: row.run_id,
        rootRunId: row.root_run_id, snapshotDigest: row.snapshot_digest, createdAt: row.created_at,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(row.request_digest === null ? {} : { requestDigest: row.request_digest }) });
    } catch {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
  }

  private targetBindingReader(): {
    bindingByRunId: (runId: string) => TargetRunBindingRecord | null;
    snapshotByBindingId: (bindingId: string) => VersionedResolvedTargetSnapshot | null;
    requestById: (requestId: string) => TargetRunRequestRecord | null;
    publicationVersionByTarget: (targetId: string) => number;
  } {
    return {
      publicationVersionByTarget: targetId => {
        const row = this.database.raw.prepare('SELECT publication_version FROM target_knowledge_bindings WHERE target_id = ?')
          .get(targetId) as { publication_version: number } | undefined;
        return row?.publication_version ?? 0;
      },
      bindingByRunId: runId => {
        const row = this.bindingRow(runId);
        return row === undefined ? null : this.parseBinding(row);
      },
      snapshotByBindingId: bindingId => this.getSnapshotSync(bindingId),
      requestById: requestId => {
        const row = this.requestRow(requestId);
        return row === undefined ? null : this.parseRequest(row);
      },
    };
  }

  private getSnapshotSync(bindingId: string): VersionedResolvedTargetSnapshot | null {
    const row = this.database.raw.prepare(`SELECT binding_id, target_id, snapshot_digest, snapshot_json
      FROM target_snapshots WHERE binding_id = ?`).get(bindingId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    try {
      const parsed = parseVersionedResolvedTargetSnapshot(JSON.parse(row.snapshot_json) as unknown);
      if (parsed.targetId !== row.target_id || parsed.digest !== row.snapshot_digest) throw new Error('snapshot row mismatch');
      return parsed;
    } catch {
      throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
    }
  }

  private persistTargetBinding(
    context: AgentContext,
    transition: TargetBindingTransition | undefined,
    outboxEvents: readonly PendingAgentEventV2[],
  ): void {
    const validated = validateTargetBindingState(context, transition, this.targetBindingReader());
    if (validated.binding === undefined) return;
    if (transition !== undefined) this.consumeStartClaim(context, transition, outboxEvents);
    if (validated.snapshot !== undefined) {
      this.database.raw.prepare(`INSERT OR IGNORE INTO target_snapshots(binding_id, target_id, snapshot_digest, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(validated.binding.bindingId, validated.snapshot.targetId,
        validated.snapshot.digest, JSON.stringify(validated.snapshot), validated.snapshot.capturedAt);
    }
    this.database.raw.prepare(`INSERT OR IGNORE INTO run_target_bindings(
      run_id, binding_id, target_id, root_run_id, snapshot_digest, created_at, request_id, request_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(validated.binding.runId, validated.binding.bindingId, validated.binding.targetId,
      validated.binding.rootRunId, validated.binding.snapshotDigest, validated.binding.createdAt,
      validated.binding.requestId ?? null, validated.binding.requestDigest ?? null);
  }

  /** Reconcile only transactionally durable facts; an absent checkpoint read alone is never enough. */
  private reconcileStartSync(
    identity: TargetStartRequestIdentity,
    claim: StartClaimRow,
  ): 'absent' | 'present' | 'unknown' {
    if (!sameStartIdentity(startIdentity(claim), identity)) return 'unknown';
    try {
      const bindingRow = this.bindingRow(identity.runId);
      const checkpointRow = this.checkpointRow(identity.runId);
      const outboxRows = this.database.raw.prepare(`SELECT event_json FROM durable_event_outbox WHERE run_id = ?`)
        .all(identity.runId) as Array<{ event_json: string }>;
      if (bindingRow === undefined && checkpointRow === undefined && outboxRows.length === 0) {
        return claim.state === 'started' ? 'unknown' : 'absent';
      }
      if (bindingRow === undefined || checkpointRow === undefined || outboxRows.length === 0) return 'unknown';

      const binding = this.parseBinding(bindingRow);
      const checkpoint = this.parseCheckpoint(checkpointRow);
      const snapshot = this.getSnapshotSync(binding.bindingId);
      if (binding.runId !== identity.runId || binding.rootRunId !== identity.runId
        || binding.targetId !== identity.targetId || binding.requestId !== identity.requestId
        || binding.requestDigest !== identity.requestDigest || snapshot === null
        || snapshot.targetId !== identity.targetId || snapshot.digest !== binding.snapshotDigest
        || checkpoint.context.runId !== identity.runId
        || checkpoint.context.targetBindingId !== binding.bindingId) return 'unknown';

      const hasInitialEvent = outboxRows.some(({ event_json }) => {
        try {
          const raw: unknown = JSON.parse(event_json) as unknown;
          const parsed = parseAgentEventV2(typeof raw === 'object' && raw !== null
            ? { ...raw, sequence: 1 } : raw);
          return parsed.type === 'RUN_STARTED' && parsed.runId === identity.runId;
        } catch {
          return false;
        }
      });
      return hasInitialEvent ? 'present' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private consumeStartClaim(
    context: AgentContext,
    transition: TargetBindingTransition,
    outboxEvents: readonly PendingAgentEventV2[],
  ): void {
    const binding = transition.binding;
    if (binding.runId !== binding.rootRunId) {
      if (transition.startClaim !== undefined) throw new TargetConfigurationError('TARGET_BINDING_INVALID');
      return;
    }
    if (binding.requestId === undefined || binding.requestDigest === undefined) {
      if (transition.startClaim !== undefined) throw new TargetConfigurationError('TARGET_BINDING_INVALID');
      return;
    }
    const claim = transition.startClaim;
    if (claim === undefined || !sameStartIdentity(claim, {
      requestId: binding.requestId,
      runId: binding.runId,
      targetId: binding.targetId,
      requestDigest: binding.requestDigest,
    }) || !hasRunStartedEvent(outboxEvents, context.runId)) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const row = this.startClaimRow(claim.requestId);
    const now = this.clock.now().toISOString();
    if (row === undefined || !sameStartIdentity(startIdentity(row), claim) || row.state !== 'claimed'
      || row.owner_id !== claim.ownerId || row.claim_epoch !== claim.epoch || row.lease_until !== claim.leaseUntil
      || Date.parse(claim.leaseUntil) <= Date.parse(now)) {
      throw new TargetConfigurationError('TARGET_START_STATE_UNKNOWN');
    }
    const update = this.database.raw.prepare(`UPDATE target_run_start_claims
      SET owner_id = NULL, lease_until = NULL, state = 'started'
      WHERE request_id = ? AND state = 'claimed' AND owner_id = ? AND claim_epoch = ? AND lease_until = ?`)
      .run(claim.requestId, claim.ownerId, claim.epoch, claim.leaseUntil);
    if (update.changes !== 1) throw new TargetConfigurationError('TARGET_START_STATE_UNKNOWN');
  }

  private insertExecution(record: ToolExecutionRecord): void {
    this.database.raw.prepare(`
      INSERT INTO tool_executions(
        tool_call_id, run_id, step_id, tool_name, tool_kind, input_digest, state,
        result_json, reason_code, prepared_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.toolCallId, record.runId, record.stepId, record.toolName, record.toolKind, record.inputDigest,
      record.state, null, null, record.preparedAt, null,
    );
  }

  private updateExecution(record: ToolExecutionRecord): void {
    const resultJson = record.result === undefined ? null : JSON.stringify(record.result);
    const update = this.database.raw.prepare(`
      UPDATE tool_executions
      SET state = ?, result_json = ?, reason_code = ?, finished_at = ?
      WHERE tool_call_id = ?
    `).run(record.state, resultJson, record.reasonCode ?? null, record.finishedAt ?? null, record.toolCallId);
    if (update.changes !== 1) throw new Error(`tool execution disappeared during update: ${record.toolCallId}`);
  }

  private parseCheckpoint(row: CheckpointRow): StoredRunCheckpoint {
    try {
      const decoded: unknown = JSON.parse(row.checkpoint_json) as unknown;
      // Always verify the original JSON before any codec adds governance defaults.
      if (checkpointChecksum(decoded) !== row.checksum) throw new Error('checkpoint checksum mismatch');
      let context: AgentContext;
      switch (row.checkpoint_schema_version) {
        case 1: context = parseAgentContext(decoded, 1); break;
        case 2: context = parseAgentContext(decoded, 2); break;
        case 3: context = parseAgentContext(decoded, 3); break;
        case 4: context = parseAgentContext(decoded, 4); break;
        default: throw new Error('unsupported checkpoint schema version');
      }
      if (!Number.isSafeInteger(row.revision) || row.revision <= 0
        || context.runId !== row.run_id
        || context.contextVersion !== row.context_version
        || context.status !== row.status
        || context.stage !== row.stage
        || context.profileId !== row.profile_id) {
        throw new Error('checkpoint row integrity mismatch');
      }
      validateTargetBindingState(context, undefined, this.targetBindingReader());
      return { context, revision: row.revision, savedAt: row.updated_at, checksum: row.checksum };
    } catch {
      throw new StoredDataCorruptionError('checkpoint', row.run_id);
    }
  }

  private parseExecution(row: ExecutionRow): ToolExecutionRecord {
    try {
      const result: unknown = row.result_json === null ? undefined : JSON.parse(row.result_json) as unknown;
      return parseToolExecutionRecord({
        toolCallId: row.tool_call_id,
        runId: row.run_id,
        stepId: row.step_id,
        toolName: row.tool_name,
        toolKind: row.tool_kind,
        inputDigest: row.input_digest,
        state: row.state,
        ...(result === undefined ? {} : { result }),
        ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
        preparedAt: row.prepared_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      });
    } catch {
      throw new StoredDataCorruptionError('tool_execution', row.tool_call_id);
    }
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
    if (existing.state === state && existing.result !== undefined && sameJson(existing.result, result)) return structuredClone(existing);
    throw new Error(`tool execution is already terminal: ${result.toolCallId}`);
  }
  return {
    ...structuredClone(existing),
    state,
    result: structuredClone(result),
    finishedAt: result.finishedAt ?? clock.now().toISOString(),
  };
}

function uncertainExecution(existing: ToolExecutionRecord, reasonCode: string, clock: Clock): ToolExecutionRecord {
  if (reasonCode.length === 0) throw new Error('uncertain tool execution requires a reason code');
  if (existing.state === 'uncertain') {
    if (existing.reasonCode === reasonCode) return structuredClone(existing);
    throw new Error(`tool execution uncertainty conflicts: ${existing.toolCallId}`);
  }
  if (existing.state !== 'prepared') throw new Error(`tool execution is already terminal: ${existing.toolCallId}`);
  return { ...structuredClone(existing), state: 'uncertain', reasonCode, finishedAt: clock.now().toISOString() };
}

function appendCompletedResult(context: AgentContext, result: ToolExecutionResult): AgentContext {
  const batch = context.pendingToolBatch;
  if (batch === undefined) throw new Error(`pending batch is required for tool result: ${result.toolCallId}`);
  const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
  if (call === undefined || call.name !== result.toolName) throw new Error(`tool result does not belong to pending batch: ${result.toolCallId}`);
  const existing = batch.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
  if (existing !== undefined) {
    if (!sameJson(existing, result)) throw new Error(`pending batch result conflicts: ${result.toolCallId}`);
    return structuredClone(context);
  }
  return {
    ...structuredClone(context),
    pendingToolBatch: {
      ...structuredClone(batch),
      completedResults: [...batch.completedResults.map((item) => structuredClone(item)), structuredClone(result)],
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

function sameRequestIdentity(left: TargetRunRequestRecord, right: TargetRunRequestRecord): boolean {
  return left.requestId === right.requestId && left.targetId === right.targetId
    && left.requestDigest === right.requestDigest;
}

function startIdentity(row: StartClaimRow): TargetStartRequestIdentity {
  return { requestId: row.request_id, runId: row.run_id, targetId: row.target_id, requestDigest: row.request_digest };
}

function sameStartIdentity(left: TargetStartRequestIdentity, right: TargetStartRequestIdentity): boolean {
  return left.requestId === right.requestId && left.runId === right.runId
    && left.targetId === right.targetId && left.requestDigest === right.requestDigest;
}

function toStartClaim(row: StartClaimRow): TargetStartClaim {
  if (row.state !== 'claimed' || row.owner_id === null || row.lease_until === null || row.claim_epoch < 1) {
    throw new TargetConfigurationError('TARGET_START_STATE_UNKNOWN');
  }
  return { ...startIdentity(row), ownerId: row.owner_id, epoch: row.claim_epoch, leaseUntil: row.lease_until };
}

function validateStartClaimInput(input: TargetStartRequestIdentity & { ownerId: string; now: string; leaseUntil: string }): void {
  parseTargetRunRequestRecord({ requestId: input.requestId, runId: input.runId, targetId: input.targetId,
    requestDigest: input.requestDigest, createdAt: input.now });
  validateTimestamp(input.now);
  validateTimestamp(input.leaseUntil);
  if (input.ownerId.trim().length === 0 || Date.parse(input.leaseUntil) <= Date.parse(input.now)) {
    throw new RangeError('Target start claim owner and future lease are required.');
  }
}

function validateTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RangeError('Target start timestamp must be a canonical ISO timestamp.');
  }
}

function hasRunStartedEvent(events: readonly PendingAgentEventV2[], runId: string): boolean {
  return events.some((event) => {
    try {
      const parsed = parseAgentEventV2({ ...event, sequence: 1 });
      return parsed.type === 'RUN_STARTED' && parsed.runId === runId;
    } catch {
      return false;
    }
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}
