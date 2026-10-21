import type { Clock, IdGenerator, InspectionQueryService, PublicRunDetail, PublicRunSummary } from '../contracts/index.js';
import { randomIdGenerator, systemClock } from '../contracts/index.js';
import type { ReplyOptions } from '../agent/types.js';
import type { MemoryPreferences } from '../contracts/diagnostic-memory.js';
import { parseMemoryPreferences } from '../contracts/diagnostic-memory-schema.js';
import type { TargetResolver, TargetRunBindingPage, TargetBindingStore, TargetRunRequestRecord, TrustedTargetBinding,
  TargetReadinessDto, VersionedResolvedTargetSnapshot } from '../contracts/target.js';
import type { TargetRecoveryGate } from '../contracts/target.js';
import { TargetConfigurationError } from '../contracts/target.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import type { WebConfirmationDecisionInput, WebConfirmationService } from './web-confirmation-service.js';

export interface TargetRunExecutionCommands {
  /** Schedules recovery without awaiting the entire long-running Run. */
  resume(runId: string): void;
  cancel(runId: string): Promise<void>;
}

export interface TargetRunStarter {
  /** Resolves only after the first RUN_STARTED transition is durably committed. */
  startAccepted(options: ReplyOptions): Promise<void>;
}

export interface TargetRunStartInput {
  targetId: string;
  requestId: string;
  message: string;
  memoryPreferences?: Pick<MemoryPreferences, 'capture' | 'recall'>;
}

export interface TargetRunStartResult {
  runId: string;
  status: 'accepted' | 'reused';
}

export interface TargetRunServiceOptions {
  resolver: TargetResolver;
  bindings: TargetBindingStore;
  queries: InspectionQueryService;
  start?: TargetRunStarter;
  execution?: TargetRunExecutionCommands;
  confirmation?: Pick<WebConfirmationService, 'decide'>;
  targetRecoveryGate?: Pick<TargetRecoveryGate, 'authorizeResume'>;
  clock?: Clock;
  ids?: IdGenerator;
}

/** Application facade enforcing immutable Target binding and Target-scoped reads. */
export class TargetRunService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly inFlightStarts = new Map<string, {
    targetId: string;
    message: string;
    memoryPreferences?: Pick<MemoryPreferences, 'capture' | 'recall'>;
    promise: Promise<TargetRunStartResult>;
  }>();

  public constructor(private readonly options: TargetRunServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public listCatalog() {
    return this.options.resolver.listCatalog().map(target => ({
      ...target,
      canStart: target.enabled && this.options.start !== undefined,
    }));
  }

  public isTargetProfileId(profileId: string): boolean {
    return this.options.resolver.ownsProfileId?.(profileId) ?? false;
  }

  /** Re-resolves one Target against current host knowledge policy/capabilities for UI readiness only. */
  public async readiness(targetId: string): Promise<TargetReadinessDto> {
    if (!isIdentifier(targetId)) throw new TargetConfigurationError('TARGET_NOT_FOUND');
    const target = this.options.resolver.listCatalog().find(item => item.targetId === targetId);
    if (target === undefined) throw new TargetConfigurationError('TARGET_NOT_FOUND');
    if (!target.enabled) return { targetId, status: 'disabled', canStart: false, reasonCode: 'TARGET_DISABLED' };
    if (this.options.start === undefined) {
      return { targetId, status: 'unavailable', canStart: false, reasonCode: 'TARGET_RUN_UNAVAILABLE' };
    }
    try {
      await this.options.resolver.resolve({ targetId, capturedAt: this.clock.now().toISOString(), signal: new AbortController().signal });
      return { targetId, status: 'ready', canStart: true };
    } catch (error) {
      const reasonCode = typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'KNOWLEDGE_REQUIRED_DISABLED'
        ? 'KNOWLEDGE_REQUIRED_DISABLED' as const : 'TARGET_CONFIGURATION_UNAVAILABLE' as const;
      return { targetId, status: 'blocked', canStart: false, reasonCode };
    }
  }

  public async start(input: TargetRunStartInput): Promise<TargetRunStartResult> {
    validateStartInput(input);
    const inFlight = this.inFlightStarts.get(input.requestId);
    const memoryPreferences = parseTargetMemoryPreferences(input.memoryPreferences);
    const normalizedInput = { ...input, ...(memoryPreferences === undefined ? {} : { memoryPreferences }) };
    if (inFlight !== undefined) {
      if (inFlight.targetId !== input.targetId || inFlight.message !== input.message
        || JSON.stringify(inFlight.memoryPreferences ?? {}) !== JSON.stringify(memoryPreferences ?? {})) {
        throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
      }
      const result = await inFlight.promise;
      return { runId: result.runId, status: 'reused' };
    }
    const promise = this.startOnce(normalizedInput);
    const entry = { targetId: input.targetId, message: input.message, ...(memoryPreferences === undefined ? {} : { memoryPreferences }), promise };
    this.inFlightStarts.set(input.requestId, entry);
    try {
      return await promise;
    } finally {
      if (this.inFlightStarts.get(input.requestId) === entry) this.inFlightStarts.delete(input.requestId);
    }
  }

  private async startOnce(input: TargetRunStartInput): Promise<TargetRunStartResult> {
    const start = this.options.start;
    if (start === undefined) throw new TargetConfigurationError('TARGET_RUN_UNAVAILABLE');
    const capturedAt = this.clock.now().toISOString();
    const existingRequest = await this.options.bindings.getRequest(input.requestId);
    if (existingRequest !== null) {
      if (existingRequest.targetId !== input.targetId) throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
      const reused = await this.reuseBoundRun(existingRequest, input);
      if (reused !== null) return reused;
    }

    const snapshot = await this.options.resolver.resolve({
      targetId: input.targetId,
      capturedAt,
      signal: new AbortController().signal,
    });
    const requestDigest = digestRequest(snapshot, input.message, input.memoryPreferences);
    const reservation = existingRequest === null
      ? await this.options.bindings.reserveRequest({
        requestId: input.requestId,
        targetId: input.targetId,
        requestDigest,
        runId: this.ids.next('run'),
        createdAt: capturedAt,
      })
      : { record: existingRequest, created: false };
    if (reservation.record.targetId !== input.targetId || reservation.record.requestDigest !== requestDigest) {
      throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
    }
    if (!reservation.created) {
      const reused = await this.reuseBoundRun(reservation.record, input);
      if (reused !== null) return reused;
    }
    const runId = reservation.record.runId;

    const bindingId = this.ids.next('target_binding');
    const binding = {
      bindingId,
      targetId: input.targetId,
      runId,
      rootRunId: runId,
      snapshotDigest: snapshot.digest,
      createdAt: capturedAt,
      requestId: input.requestId,
      requestDigest,
    };
    const trustedTargetBinding: TrustedTargetBinding = { binding, snapshot };
    await start.startAccepted({
      runId,
      profileId: snapshot.profile.profileId,
      message: input.message,
      ...(input.memoryPreferences === undefined ? {} : { memoryPreferences: input.memoryPreferences }),
      trustedTargetBinding,
    });
    const committed = await this.options.bindings.getBinding(runId);
    const committedSnapshot = committed === null
      ? null
      : await this.options.bindings.getSnapshot(committed.bindingId);
    if (committed === null || committed.runId !== runId || committed.rootRunId !== runId
      || committed.targetId !== input.targetId || committed.requestId !== input.requestId
      || committed.requestDigest !== requestDigest || committedSnapshot === null
      || committed.snapshotDigest !== committedSnapshot.digest
      || digestRequest(committedSnapshot, input.message, input.memoryPreferences) !== requestDigest) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    return { runId, status: reservation.created ? 'accepted' : 'reused' };
  }

  public async listRuns(
    targetId: string,
    input: { cursor?: string; limit: number },
  ): Promise<{ items: readonly PublicRunSummary[]; nextCursor?: string }> {
    validateTargetListInput(targetId, input.limit);
    this.assertKnownTarget(targetId);
    const afterRunId = input.cursor === undefined ? undefined : decodeTargetRunCursor(input.cursor, targetId);
    const bindings: TargetRunBindingPage = await this.options.bindings.listByTarget({
      targetId,
      ...(afterRunId === undefined ? {} : { cursor: afterRunId }),
      limit: input.limit,
    });
    const items = await Promise.all(bindings.items.map(async record => {
      const run = await this.options.queries.getRun(record.runId);
      return run === null ? null : this.withTargetScope(run, record);
    }));
    return { items: items.filter((run): run is PublicRunDetail => run !== null),
      ...(bindings.nextCursor === undefined ? {} : { nextCursor: encodeTargetRunCursor(targetId, bindings.nextCursor) }) };
  }

  public async getRun(targetId: string, runId: string) {
    if (!isIdentifier(targetId) || !isIdentifier(runId)) return null;
    const binding = await this.options.bindings.getBinding(runId);
    if (binding === null || binding.targetId !== targetId) return null;
    const run = await this.options.queries.getRun(runId);
    return run === null ? null : this.withTargetScope(run, binding);
  }

  public async snapshotForRun(targetId: string, runId: string): Promise<VersionedResolvedTargetSnapshot | null> {
    if (!isIdentifier(targetId) || !isIdentifier(runId)) return null;
    const binding = await this.options.bindings.getBinding(runId);
    if (binding === null || binding.targetId !== targetId) return null;
    const snapshot = await this.options.bindings.getSnapshot(binding.bindingId);
    if (snapshot === null || snapshot.digest !== binding.snapshotDigest || snapshot.targetId !== targetId) return null;
    return snapshot;
  }

  public async profileIdForTarget(targetId: string): Promise<string | null> {
    const snapshot = await this.snapshotForTarget(targetId);
    return snapshot?.profile.profileId ?? null;
  }

  public async snapshotForTarget(targetId: string): Promise<VersionedResolvedTargetSnapshot | null> {
    if (!isIdentifier(targetId)) return null;
    const catalog = this.options.resolver.listCatalog().find(item => item.targetId === targetId);
    if (catalog === undefined) return null;
    try {
      const snapshot = await this.options.resolver.resolve({ targetId, capturedAt: this.clock.now().toISOString(),
        signal: new AbortController().signal });
      return snapshot.targetId === targetId ? snapshot : null;
    } catch { return null; }
  }

  private async withTargetScope(run: PublicRunDetail, binding: { targetId: string; bindingId: string;
    snapshotDigest: string }): Promise<PublicRunDetail> {
    const snapshot = await this.options.bindings.getSnapshot(binding.bindingId);
    if (snapshot === null || snapshot.digest !== binding.snapshotDigest || snapshot.targetId !== binding.targetId) {
      throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
    }
    return { ...run, targetScope: targetScope(snapshot) };
  }

  public async ownsRun(targetId: string, runId: string): Promise<boolean> {
    const binding = await this.options.bindings.getBinding(runId);
    return binding !== null && binding.targetId === targetId;
  }

  public async resume(targetId: string, runId: string): Promise<void> {
    const binding = await this.requireOwnedBinding(targetId, runId);
    const { execution, targetRecoveryGate } = this.options;
    if (execution === undefined || targetRecoveryGate === undefined) {
      throw new TargetConfigurationError('TARGET_RUN_UNAVAILABLE');
    }
    await targetRecoveryGate.authorizeResume({
      runId,
      targetBindingId: binding.bindingId,
      signal: new AbortController().signal,
    });
    execution.resume(runId);
  }

  public async cancel(targetId: string, runId: string): Promise<void> {
    await this.requireOwnedBinding(targetId, runId);
    if (this.options.execution === undefined) throw new TargetConfigurationError('TARGET_RUN_UNAVAILABLE');
    await this.options.execution.cancel(runId);
  }

  public async decideConfirmation(
    targetId: string,
    runId: string,
    input: WebConfirmationDecisionInput,
  ) {
    const binding = await this.requireOwnedBinding(targetId, runId);
    const confirmation = this.options.confirmation;
    if (confirmation === undefined) throw new TargetConfigurationError('TARGET_RUN_UNAVAILABLE');
    if (input.confirmed) {
      const targetRecoveryGate = this.options.targetRecoveryGate;
      if (targetRecoveryGate === undefined) throw new TargetConfigurationError('TARGET_RUN_UNAVAILABLE');
      await targetRecoveryGate.authorizeResume({
        runId,
        targetBindingId: binding.bindingId,
        signal: new AbortController().signal,
      });
    }
    return confirmation.decide(runId, input);
  }

  public async bindingForRun(runId: string) {
    return this.options.bindings.getBinding(runId);
  }

  private async requireOwnedBinding(targetId: string, runId: string) {
    if (!isIdentifier(targetId) || !isIdentifier(runId)) throw new TargetConfigurationError('TARGET_NOT_FOUND');
    const binding = await this.options.bindings.getBinding(runId);
    if (binding === null || binding.targetId !== targetId) throw new TargetConfigurationError('TARGET_NOT_FOUND');
    return binding;
  }

  private assertKnownTarget(targetId: string): void {
    if (!this.options.resolver.listCatalog().some(target => target.targetId === targetId)) {
      throw new TargetConfigurationError('TARGET_NOT_FOUND');
    }
  }

  private async reuseBoundRun(
    request: TargetRunRequestRecord,
    input: TargetRunStartInput,
  ): Promise<TargetRunStartResult | null> {
    const binding = await this.options.bindings.getBinding(request.runId);
    if (binding === null) return null;
    if (binding.runId !== binding.rootRunId || binding.targetId !== request.targetId
      || binding.requestId !== request.requestId || binding.requestDigest !== request.requestDigest) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const snapshot = await this.options.bindings.getSnapshot(binding.bindingId);
    if (snapshot === null || snapshot.digest !== binding.snapshotDigest
      || digestRequest(snapshot, input.message, input.memoryPreferences) !== request.requestDigest) {
      throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
    }
    if (await this.getRun(input.targetId, request.runId) === null) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    return { runId: request.runId, status: 'reused' };
  }
}

function validateStartInput(input: TargetRunStartInput): void {
  if (!isIdentifier(input.targetId) || !isIdentifier(input.requestId)
    || typeof input.message !== 'string' || input.message.trim().length === 0
    || Buffer.byteLength(input.message, 'utf8') > 16 * 1024) {
    throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  }
}

function validateTargetListInput(targetId: string, limit: number): void {
  if (!isIdentifier(targetId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Target Run page request is invalid.');
  }
}

function targetScope(snapshot: VersionedResolvedTargetSnapshot): NonNullable<PublicRunDetail['targetScope']> {
  return {
    targetId: snapshot.targetId,
    projectId: snapshot.projectId,
    deploymentId: snapshot.deploymentId,
    deploymentGeneration: snapshot.deploymentGeneration,
    environment: snapshot.environment,
    scenarioId: snapshot.scenario.id,
    scenarioVersion: snapshot.scenario.version,
    serviceId: snapshot.scenario.serviceId,
    profileRevision: snapshot.profile.revision,
    snapshotDigest: snapshot.digest,
  };
}

interface TargetRunCursor { targetId: string; afterRunId: string }

/** Wrap the durable-store seek key so it cannot be replayed across Target routes. */
function encodeTargetRunCursor(targetId: string, afterRunId: string): string {
  return Buffer.from(JSON.stringify({ version: 1, targetId, afterRunId }), 'utf8').toString('base64url');
}

function decodeTargetRunCursor(value: string, targetId: string): string {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RangeError('Target Run cursor is invalid.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; }
  catch { throw new RangeError('Target Run cursor is invalid.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RangeError('Target Run cursor is invalid.');
  }
  const cursor = parsed as Partial<TargetRunCursor> & { version?: unknown };
  if (cursor.version !== 1 || cursor.targetId !== targetId || !isIdentifier(cursor.afterRunId ?? '')) {
    throw new RangeError('Target Run cursor does not belong to this Target.');
  }
  return cursor.afterRunId!;
}

function digestRequest(snapshot: TrustedTargetBinding['snapshot'], message: string,
  memoryPreferences?: Pick<MemoryPreferences, 'capture' | 'recall'>): string {
  const targetConfiguration: Record<string, unknown> = { ...snapshot };
  delete targetConfiguration.capturedAt;
  delete targetConfiguration.digest;
  const stableProfile: Record<string, unknown> = { ...snapshot.profile };
  delete stableProfile.capturedAt;
  targetConfiguration.profile = stableProfile;
  const checksum = checkpointChecksum({
    algorithm: 'sha256',
    version: 1,
    request: { targetId: snapshot.targetId, message, ...(memoryPreferences === undefined ? {} : { memoryPreferences }) },
    targetConfiguration,
  });
  return `sha256:v1:${checksum}`;
}

function parseTargetMemoryPreferences(value: TargetRunStartInput['memoryPreferences']): TargetRunStartInput['memoryPreferences'] {
  if (value === undefined) return undefined;
  let parsed: MemoryPreferences;
  try { parsed = parseMemoryPreferences(value); }
  catch { throw new TargetConfigurationError('TARGET_BINDING_INVALID'); }
  if (parsed.semantic !== undefined || parsed.procedural !== undefined) throw new TargetConfigurationError('TARGET_BINDING_INVALID');
  return {
    ...(parsed.capture === undefined ? {} : { capture: parsed.capture }),
    ...(parsed.recall === undefined ? {} : { recall: parsed.recall }),
  };
}

function isIdentifier(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}
