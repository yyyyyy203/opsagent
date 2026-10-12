import type {
  ResolvedTargetSnapshotV2,
  TargetBindingStore,
  TargetIdentityRegistry,
  TargetOperationGuard,
  TargetOperationPermit,
  TargetOperationPolicy,
  TargetOperationRequest,
  TargetRecoveryGate,
  TargetResolver,
  TargetRunBindingRecord,
  TargetRunRuntimeLease,
  TargetRuntimeProvider,
} from '../contracts/target.js';
import type { Tool } from '../contracts/tool.js';
import { TargetConfigurationError } from '../contracts/target.js';
import { systemClock, type Clock } from '../contracts/common.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import { parseExecutableTargetSnapshot, parseTargetRunBindingRecord } from '../contracts/target-schema.js';

export interface TargetRecoveryServiceOptions {
  bindings: TargetBindingStore;
  identityRegistry: TargetIdentityRegistry;
  resolver: TargetResolver;
  operationPolicy: TargetOperationPolicy;
  runtimeProvider: TargetRuntimeProvider;
  clock?: Clock;
}

/** Validates persisted Target identity and current restrictions before rebuilding a scoped runtime. */
export class TargetRecoveryService implements TargetRecoveryGate {
  private readonly clock: Clock;

  public constructor(private readonly options: TargetRecoveryServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  public async acquireForStart(input: {
    binding: TargetRunBindingRecord;
    snapshot: ResolvedTargetSnapshotV2;
    signal: AbortSignal;
    sourceScopeId?: string;
  }): Promise<TargetRunRuntimeLease> {
    const binding = parseTargetRunBindingRecord(input.binding);
    const snapshot = parseExecutableTargetSnapshot(input.snapshot);
    this.assertBinding(binding, snapshot, binding.runId, binding.rootRunId);
    assertSourceScope(snapshot, input.sourceScopeId);
    await this.assertCurrent(binding, snapshot, input.signal);
    return this.acquireRuntime(binding, snapshot, 'start', input.signal);
  }

  public async acquireForResume(input: {
    runId: string;
    targetBindingId: string;
    signal: AbortSignal;
    sourceScopeId?: string;
  }): Promise<TargetRunRuntimeLease> {
    const { binding, snapshot } = await this.loadResumeContext(input.runId, input.targetBindingId, input.signal, input.sourceScopeId);
    return this.acquireRuntime(binding, snapshot, 'resume', input.signal);
  }

  public async authorizeResume(input: { runId: string; targetBindingId: string; signal: AbortSignal }): Promise<void> {
    const { binding, snapshot } = await this.loadResumeContext(input.runId, input.targetBindingId, input.signal);
    const request: TargetOperationRequest = {
      binding,
      snapshot,
      runId: binding.runId,
      rootRunId: binding.rootRunId,
      operation: 'resume',
      capability: 'target_runtime',
      signal: input.signal,
    };
    await this.validate(await this.authorize(request), request);
  }

  private async loadResumeContext(
    runId: string,
    targetBindingId: string,
    signal: AbortSignal,
    sourceScopeId?: string,
  ): Promise<{ binding: TargetRunBindingRecord; snapshot: ResolvedTargetSnapshotV2 }> {
    if (runId.trim().length === 0 || targetBindingId.trim().length === 0) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const record = await this.options.bindings.getBinding(runId);
    if (record === null || record.bindingId !== targetBindingId || record.runId !== runId) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
    const binding = parseTargetRunBindingRecord(record);
    const storedSnapshot = await this.options.bindings.getSnapshot(binding.bindingId);
    if (storedSnapshot === null) throw new TargetConfigurationError('TARGET_SNAPSHOT_UNAVAILABLE');
    const snapshot = parseExecutableTargetSnapshot(storedSnapshot);
    this.assertBinding(binding, snapshot, runId, binding.rootRunId);
    assertSourceScope(snapshot, sourceScopeId);
    await this.assertCurrent(binding, snapshot, signal);
    return { binding, snapshot };
  }

  private async acquireRuntime(
    binding: TargetRunBindingRecord,
    snapshot: ResolvedTargetSnapshotV2,
    operation: 'start' | 'resume',
    signal: AbortSignal,
  ): Promise<TargetRunRuntimeLease> {
    const request: TargetOperationRequest = {
      binding,
      snapshot,
      runId: binding.runId,
      rootRunId: binding.rootRunId,
      operation,
      capability: 'target_runtime',
      signal,
    };
    const permit = await this.authorize(request);
    await this.validate(permit, request);
    let runtime: Awaited<ReturnType<TargetRuntimeProvider['acquire']>> | undefined;
    try {
      runtime = await this.options.runtimeProvider.acquire(snapshot);
      assertRuntimeTools(snapshot, runtime.tools);
      await this.validate(permit, request);
      return {
        model: runtime.model,
        tools: Object.freeze([...runtime.tools]),
        operations: this.operationGuard(binding, snapshot),
        release: () => runtime!.release(),
      };
    } catch (error) {
      await runtime?.release();
      throw error;
    }
  }

  private operationGuard(binding: TargetRunBindingRecord, snapshot: ResolvedTargetSnapshotV2): TargetOperationGuard {
    const requestSignals = new WeakMap<TargetOperationPermit, AbortSignal>();
    return {
      authorize: async input => {
        if (!isCapability(input.capability)) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
        const request: TargetOperationRequest = {
          binding,
          snapshot,
          runId: binding.runId,
          rootRunId: binding.rootRunId,
          operation: input.operation,
          capability: input.capability,
          signal: input.signal,
        };
        const permit = await this.authorize(request);
        assertPermitMatches(permit, request);
        requestSignals.set(permit, input.signal);
        return permit;
      },
      validate: async (permit, signal) => {
        const requestSignal = signal ?? requestSignals.get(permit) ?? permit.signal;
        const request: TargetOperationRequest = {
          binding,
          snapshot,
          runId: binding.runId,
          rootRunId: binding.rootRunId,
          operation: permit.operation,
          capability: permit.capability,
          signal: requestSignal,
        };
        assertPermitMatches(permit, request);
        await this.validate(permit, request);
      },
    };
  }

  private async authorize(request: TargetOperationRequest): Promise<TargetOperationPermit> {
    if (request.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    try {
      const permit = await this.options.operationPolicy.authorize(request);
      assertPermitMatches(permit, request);
      if (permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
      return permit;
    } catch (error) {
      if (error instanceof TargetConfigurationError) throw error;
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
  }

  private async validate(permit: TargetOperationPermit, request: TargetOperationRequest): Promise<void> {
    assertPermitMatches(permit, request);
    if (request.signal.aborted || permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    try {
      await this.options.operationPolicy.validate(permit, request);
    } catch (error) {
      if (error instanceof TargetConfigurationError) throw error;
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
    if (request.signal.aborted || permit.signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }

  private assertBinding(
    binding: TargetRunBindingRecord,
    snapshot: ResolvedTargetSnapshotV2,
    runId: string,
    rootRunId: string,
  ): void {
    if (binding.runId !== runId || binding.rootRunId !== rootRunId || binding.targetId !== snapshot.targetId
      || binding.snapshotDigest !== snapshot.digest || snapshot.schemaVersion !== 2) {
      throw new TargetConfigurationError('TARGET_BINDING_INVALID');
    }
  }

  private async assertCurrent(
    binding: TargetRunBindingRecord,
    snapshot: ResolvedTargetSnapshotV2,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    const identities = await this.options.identityRegistry.readSnapshot();
    const targetIdentity = identities.targets.find(item => item.targetId === snapshot.targetId);
    if (targetIdentity === undefined || targetIdentity.status !== 'active') {
      throw new TargetConfigurationError('TARGET_IDENTITY_UNPROVEN');
    }
    if (targetIdentity.projectId !== snapshot.projectId || targetIdentity.deploymentId !== snapshot.deploymentId
      || targetIdentity.deploymentGeneration !== snapshot.deploymentGeneration
      || targetIdentity.scenarioId !== snapshot.scenario.id || targetIdentity.primaryServiceId !== snapshot.scenario.serviceId
      || targetIdentity.profileId !== snapshot.profile.profileId) {
      throw new TargetConfigurationError('TARGET_GENERATION_CHANGED');
    }
    assertSnapshotSourceIdentities(snapshot, identities.sources);

    let current: ResolvedTargetSnapshotV2;
    try {
      current = parseExecutableTargetSnapshot(await this.options.resolver.resolve({
        targetId: snapshot.targetId,
        capturedAt: this.clock.now().toISOString(),
        signal,
      }));
    } catch (error) {
      if (error instanceof TargetConfigurationError) throw error;
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
    assertCurrentSnapshotCompatible(snapshot, current, binding);
  }
}

function assertCurrentSnapshotCompatible(
  original: ResolvedTargetSnapshotV2,
  current: ResolvedTargetSnapshotV2,
  binding: TargetRunBindingRecord,
): void {
  if (binding.targetId !== current.targetId || original.targetId !== current.targetId
    || original.projectId !== current.projectId || original.deploymentId !== current.deploymentId
    || original.deploymentGeneration !== current.deploymentGeneration
    || original.targetFingerprint !== current.targetFingerprint
    || original.environment !== current.environment || original.dataClass !== current.dataClass
    || original.datasetId !== current.datasetId) {
    throw new TargetConfigurationError('TARGET_GENERATION_CHANGED');
  }
  if (original.scenarioImplementationDigest !== current.scenarioImplementationDigest
    || checksum(original.scenario) !== checksum(current.scenario)
    || original.profile.revision !== current.profile.revision
    || original.profile.digest !== current.profile.digest
    || checksum(profileForPolicy(original)) !== checksum(profileForPolicy(current))) {
    throw new TargetConfigurationError('SCENARIO_DIGEST_MISMATCH');
  }
  for (const originalSource of original.sourceBindings) {
    const currentSource = current.sourceBindings.find(item => item.sourceId === originalSource.sourceId);
    if (currentSource === undefined || checksum(currentSource) !== checksum(originalSource)
      || (original.sourceIdentities.some(identity => identity.sourceId === originalSource.sourceId)
        && current.unavailableOptionalSourceIds.includes(originalSource.sourceId))) {
      throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
    }
  }
  assertSnapshotSourceIdentities(original, current.sourceIdentities);
  if (original.knowledgePolicy.policyEpoch !== current.knowledgePolicy.policyEpoch
    || original.knowledgePolicy.policyVersion !== current.knowledgePolicy.policyVersion
    || checksum(original.knowledgeRefs) !== checksum(current.knowledgeRefs)
    || checksum(original.knowledgePolicy.requirements) !== checksum(current.knowledgePolicy.requirements)) {
    throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }
}

function assertSnapshotSourceIdentities(
  snapshot: ResolvedTargetSnapshotV2,
  current: readonly { sourceId: string; dataDomainId: string; sourceGeneration: number; permissionScopeDigest: string }[],
): void {
  for (const expected of snapshot.sourceIdentities) {
    const actual = current.reduce<typeof current[number] | undefined>((latest, item) => {
      if (item.sourceId !== expected.sourceId) return latest;
      return latest === undefined || item.sourceGeneration > latest.sourceGeneration ? item : latest;
    }, undefined);
    if (actual === undefined || actual.dataDomainId !== expected.dataDomainId
      || actual.sourceGeneration !== expected.sourceGeneration
      || actual.permissionScopeDigest !== expected.permissionScopeDigest) {
      throw new TargetConfigurationError('SOURCE_MAPPING_INVALID');
    }
  }
}

function profileForPolicy(snapshot: ResolvedTargetSnapshotV2): Record<string, unknown> {
  const { capturedAt, ...profile } = snapshot.profile;
  void capturedAt;
  return profile;
}

function assertRuntimeTools(snapshot: ResolvedTargetSnapshotV2, tools: readonly Tool[]): void {
  const allowed = new Set(snapshot.sourceBindings
    .filter(source => !snapshot.unavailableOptionalSourceIds.includes(source.sourceId))
    .map(source => source.sourceId));
  for (const tool of tools) {
    if (typeof tool.implementationVersion !== 'string' || tool.implementationVersion.length === 0
      || tool.implementationVersion.length > 256 || tool.implementationVersion.trim() !== tool.implementationVersion) {
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
    if (tool.targetSourceId !== undefined && !allowed.has(tool.targetSourceId)) {
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
    if ((tool.source === 'mcp' || tool.source === 'subagent')
      && (tool.targetSourceId === undefined || !allowed.has(tool.targetSourceId))) {
      throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
    }
  }
}

function assertSourceScope(snapshot: ResolvedTargetSnapshotV2, sourceScopeId: string | undefined): void {
  if (sourceScopeId === undefined) return;
  if (!isCapability(sourceScopeId)
    || !snapshot.sourceBindings.some(source => source.sourceId === sourceScopeId)
    || snapshot.unavailableOptionalSourceIds.includes(sourceScopeId)) {
    throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }
}

function checksum(value: unknown): string {
  return checkpointChecksum({ algorithm: 'sha256', version: 1, value });
}

function assertPermitMatches(permit: TargetOperationPermit, request: TargetOperationRequest): void {
  if (permit.bindingId !== request.binding.bindingId || permit.runId !== request.runId
    || permit.rootRunId !== request.rootRunId || permit.snapshotDigest !== request.snapshot.digest
    || permit.operation !== request.operation || permit.capability !== request.capability
    || !Number.isSafeInteger(permit.policyEpoch) || permit.policyEpoch < 0
    || typeof permit.signal?.aborted !== 'boolean') {
    throw new TargetConfigurationError('TARGET_OPERATION_DENIED');
  }
}

function isCapability(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(value);
}
