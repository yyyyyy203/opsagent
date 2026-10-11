import type { Clock, IdGenerator, InspectionQueryService, PublicRunDetail, PublicRunSummary } from '../contracts/index.js';
import { randomIdGenerator, systemClock } from '../contracts/index.js';
import type { ReplyOptions } from '../agent/types.js';
import type { TargetResolver, TargetRunBindingPage, TargetBindingStore, TargetRunRequestRecord, TrustedTargetBinding } from '../contracts/target.js';
import { TargetConfigurationError } from '../contracts/target.js';
import { checkpointChecksum } from '../contracts/stable-json.js';

export interface TargetRunStarter {
  /** Resolves only after the first RUN_STARTED transition is durably committed. */
  startAccepted(options: ReplyOptions): Promise<void>;
}

export interface TargetRunStartInput {
  targetId: string;
  requestId: string;
  message: string;
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

  public async start(input: TargetRunStartInput): Promise<TargetRunStartResult> {
    validateStartInput(input);
    const inFlight = this.inFlightStarts.get(input.requestId);
    if (inFlight !== undefined) {
      if (inFlight.targetId !== input.targetId || inFlight.message !== input.message) {
        throw new TargetConfigurationError('TARGET_REQUEST_CONFLICT');
      }
      const result = await inFlight.promise;
      return { runId: result.runId, status: 'reused' };
    }
    const promise = this.startOnce(input);
    const entry = { targetId: input.targetId, message: input.message, promise };
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
    const requestDigest = digestRequest(snapshot, input.message);
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
      || digestRequest(committedSnapshot, input.message) !== requestDigest) {
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
    const bindings: TargetRunBindingPage = await this.options.bindings.listByTarget({
      targetId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit,
    });
    const items = (await Promise.all(bindings.items.map(record => this.options.queries.getRun(record.runId))))
      .filter((run): run is PublicRunDetail => run !== null);
    return { items, ...(bindings.nextCursor === undefined ? {} : { nextCursor: bindings.nextCursor }) };
  }

  public async getRun(targetId: string, runId: string) {
    if (!isIdentifier(targetId) || !isIdentifier(runId)) return null;
    const binding = await this.options.bindings.getBinding(runId);
    if (binding === null || binding.targetId !== targetId) return null;
    return this.options.queries.getRun(runId);
  }

  public async ownsRun(targetId: string, runId: string): Promise<boolean> {
    const binding = await this.options.bindings.getBinding(runId);
    return binding !== null && binding.targetId === targetId;
  }

  public async bindingForRun(runId: string) {
    return this.options.bindings.getBinding(runId);
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
      || digestRequest(snapshot, input.message) !== request.requestDigest) {
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

function digestRequest(snapshot: TrustedTargetBinding['snapshot'], message: string): string {
  const targetConfiguration: Record<string, unknown> = { ...snapshot };
  delete targetConfiguration.capturedAt;
  delete targetConfiguration.digest;
  const stableProfile: Record<string, unknown> = { ...snapshot.profile };
  delete stableProfile.capturedAt;
  targetConfiguration.profile = stableProfile;
  const checksum = checkpointChecksum({
    algorithm: 'sha256',
    version: 1,
    request: { targetId: snapshot.targetId, message },
    targetConfiguration,
  });
  return `sha256:v1:${checksum}`;
}

function isIdentifier(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}
