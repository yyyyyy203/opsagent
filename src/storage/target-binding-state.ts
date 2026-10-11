import type { AgentContext } from '../contracts/context.js';
import { TargetConfigurationError, type ResolvedTargetSnapshot, type TargetBindingTransition,
  type TargetRunBindingRecord, type TargetRunRequestRecord } from '../contracts/target.js';
import { parseResolvedTargetSnapshot, parseTargetRunBindingRecord } from '../contracts/target-schema.js';
import { checkpointChecksum } from '../contracts/stable-json.js';

export interface TargetBindingStateReader {
  bindingByRunId(runId: string): TargetRunBindingRecord | null;
  snapshotByBindingId(bindingId: string): ResolvedTargetSnapshot | null;
  requestById(requestId: string): TargetRunRequestRecord | null;
}

export interface ValidatedTargetBindingTransition {
  binding?: TargetRunBindingRecord;
  snapshot?: ResolvedTargetSnapshot;
}

/** Shared persistence invariants for SQLite and in-memory durable stores. */
export function validateTargetBindingState(
  context: AgentContext,
  transition: TargetBindingTransition | undefined,
  reader: TargetBindingStateReader,
): ValidatedTargetBindingTransition {
  const bindingId = context.targetBindingId;
  const existing = reader.bindingByRunId(context.runId);
  if (bindingId === undefined) {
    if (transition !== undefined || existing !== null) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    return {};
  }

  if (transition === undefined) {
    if (existing === null || existing.bindingId !== bindingId || existing.runId !== context.runId) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const snapshot = reader.snapshotByBindingId(existing.bindingId);
    assertSnapshotMatches(context, existing, snapshot);
    return { binding: existing, snapshot };
  }

  const binding = parseTargetRunBindingRecord(transition.binding);
  if (binding.bindingId !== bindingId || binding.runId !== context.runId
    || (existing !== null && !sameRecord(existing, binding))) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }

  const savedSnapshot = reader.snapshotByBindingId(binding.bindingId);
  const suppliedSnapshot = transition.snapshot === undefined
    ? null
    : parseResolvedTargetSnapshot(transition.snapshot);
  if (savedSnapshot !== null && savedSnapshot.digest !== binding.snapshotDigest) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
  if (suppliedSnapshot !== null && (suppliedSnapshot.targetId !== binding.targetId
    || suppliedSnapshot.digest !== binding.snapshotDigest
    || (savedSnapshot !== null && !sameRecord(savedSnapshot, suppliedSnapshot)))) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
  const snapshot = savedSnapshot ?? suppliedSnapshot;
  if (snapshot === null || snapshot === undefined) throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
  assertSnapshotMatches(context, binding, snapshot);

  if (binding.runId === binding.rootRunId) {
    if (suppliedSnapshot === null || binding.requestId === undefined || binding.requestDigest === undefined) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const request = reader.requestById(binding.requestId);
    if (request === null || request.requestId !== binding.requestId || request.runId !== binding.runId
      || request.targetId !== binding.targetId || request.requestDigest !== binding.requestDigest) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
  } else {
    const root = reader.bindingByRunId(binding.rootRunId);
    if (root === null || root.runId !== root.rootRunId || root.bindingId !== binding.bindingId
      || root.targetId !== binding.targetId || root.snapshotDigest !== binding.snapshotDigest) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
  }

  return { binding, ...(savedSnapshot === null ? { snapshot } : {}) };
}

export function sameTargetRecord(left: unknown, right: unknown): boolean {
  return sameRecord(left, right);
}

function assertSnapshotMatches(
  context: AgentContext,
  binding: TargetRunBindingRecord,
  snapshot: ResolvedTargetSnapshot | null,
): asserts snapshot is ResolvedTargetSnapshot {
  if (snapshot === null || snapshot.digest !== binding.snapshotDigest || snapshot.targetId !== binding.targetId
    || context.profileId !== snapshot.profile.profileId
    || (context.governance !== undefined && (context.governance.profile.profileId !== snapshot.profile.profileId
      || context.governance.profile.revision !== snapshot.profile.revision
      || context.governance.profile.digest !== snapshot.profile.digest))) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
}

function sameRecord(left: unknown, right: unknown): boolean {
  try {
    return checkpointChecksum(left) === checkpointChecksum(right);
  } catch {
    return false;
  }
}
