import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../contracts/common.js';
import {
  KnowledgeContractError,
  type KnowledgeGovernanceReviewPort,
  type KnowledgeQueryPort,
  type KnowledgeReviewCommand,
  type KnowledgeRevision,
  type KnowledgeScope,
  type ProceduralKnowledgeContent,
  type ProceduralKnowledgeRevision,
  type KnowledgeProvenance,
  type KnowledgeSourceReference,
} from '../contracts/knowledge-memory.js';
import { parseKnowledgeRecord, parseKnowledgeReviewCommand, parseKnowledgeScope,
  safeKnowledgeIdentifierSchema } from '../contracts/knowledge-memory-schema.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import type {
  KnowledgeDraftStore,
  KnowledgeCommandReplayIntent,
  KnowledgeProceduralReplayCapability,
  KnowledgeGovernanceTransitionStore,
  KnowledgeRevisionStateQueryPort,
  KnowledgeSourceGovernanceStore,
  KnowledgeSourceState,
} from '../contracts/knowledge-memory-storage.js';
import type { TargetDataClass, TargetEnvironment } from '../contracts/target.js';

export interface ProceduralTargetContextPort {
  /** Scope and operator identity are resolved by the host, never by a model/browser payload. */
  resolveForTarget(input: { readonly targetId: string; readonly requestId: string }): Promise<{
    readonly actorId: string;
    readonly scope: KnowledgeScope;
  }>;
}

export interface ProceduralReviewAttestationPort {
  resolveForReview(input: {
    readonly requestId: string;
    readonly targetId: string;
    readonly knowledgeId: string;
    readonly decision: 'approve' | 'reject';
  }): Promise<KnowledgeReviewCommand['checks']>;
}

export interface ProceduralSourceManifestEntry {
  readonly sourceType: KnowledgeProvenance['sourceType'];
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceDigest: string;
  readonly dataDomainId: string;
}

/** Identity-only source resolution; implementations must be host-owned and must never fetch/open caller locations. */
export interface ProceduralSourceRegistryPort {
  resolve(input: { readonly targetId: string; readonly reference: KnowledgeSourceReference }): ProceduralSourceManifestEntry;
}

export interface ProceduralReadonlyCapability {
  readonly capabilityId: string;
  readonly access: 'read_only' | 'write';
  readonly serviceIds: readonly string[];
  readonly faultTypes: readonly string[];
  readonly environments: readonly TargetEnvironment[];
  readonly dataClasses: readonly TargetDataClass[];
}

/** Host-owned allowlist. A capability ID in knowledge is only a reference, never a Tool call or authorization. */
export interface ProceduralReadonlyCapabilityRegistryPort {
  resolveForTarget(input: { readonly targetId: string; readonly capabilityId: string }): ProceduralReadonlyCapability | null;
}

export interface ProceduralTemplateServiceOptions {
  readonly sourceRegistry: ProceduralSourceRegistryPort;
  readonly capabilityRegistry: ProceduralReadonlyCapabilityRegistryPort;
  readonly targets: ProceduralTargetContextPort;
  readonly drafts: KnowledgeDraftStore;
  readonly sources: KnowledgeSourceGovernanceStore & Pick<KnowledgeDraftStore, 'registerSource'>;
  readonly queries: KnowledgeQueryPort & KnowledgeRevisionStateQueryPort;
  readonly reviews: KnowledgeGovernanceReviewPort;
  /** Opt in to durable receipt-first replay; older hosts continue through the original T2 ports. */
  readonly replay?: KnowledgeProceduralReplayCapability | undefined;
  readonly transitions: KnowledgeGovernanceTransitionStore;
  readonly reviewAttestations: ProceduralReviewAttestationPort;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface CreateProceduralTemplateDraftRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly source: KnowledgeSourceReference;
  readonly content: ProceduralKnowledgeContent;
  readonly validUntil?: string;
}

export interface ReviseProceduralTemplateDraftRequest extends CreateProceduralTemplateDraftRequest {
  readonly knowledgeId: string;
  readonly expectedContentRevision: number;
  readonly expectedGovernanceVersion: number;
}

export interface SubmitProceduralReviewRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly knowledgeId: string;
  readonly contentRevision: number;
  readonly governanceVersion: number;
}

export interface ReviewProceduralTemplateRequest extends SubmitProceduralReviewRequest {
  readonly decision: 'approve' | 'reject';
  readonly reasonCode?: string;
}

export interface RevokeProceduralTemplateRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly knowledgeId: string;
  readonly contentRevision: number;
  readonly expectedGovernanceVersion: number;
}

interface ResolvedProceduralSource {
  readonly manifest: ProceduralSourceManifestEntry;
  readonly state: KnowledgeSourceState;
}

/** Versioned, host-governed authoring for read-only investigation guidance. */
export class ProceduralTemplateService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly options: ProceduralTemplateServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public async createDraft(input: CreateProceduralTemplateDraftRequest): Promise<ProceduralKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'source', 'content', 'validUntil']);
    const request = validateDraftRequest(input);
    const target = await this.resolveTarget(request.targetId, request.requestId);
    const replayIntent: KnowledgeCommandReplayIntent = { schemaVersion: 1, requestId: request.requestId,
      operation: 'draft', scope: target.scope, intentDigest: checkpointChecksum({ schemaVersion: 1,
        operation: 'create', requestId: request.requestId, actorId: target.actorId,
        targetId: request.targetId, scope: target.scope, knowledgeId: null,
        expectedContentRevision: null, expectedGovernanceVersion: null,
        source: request.source, content: request.content, contentDigest: checkpointChecksum(request.content),
        validUntil: request.validUntil ?? null }) };
    const replay = await this.options.replay?.replayCommand(replayIntent);
    if (replay) return assertProcedural(replay);
    const source = await this.resolveCurrentSource(request.targetId, request.source);
    this.validateContentSources(request.targetId, request.source, request.content);
    this.validateCapabilities(request.targetId, target.scope, request.content);
    const now = this.clock.now().toISOString();
    const revision = buildDraft({ id: this.ids.next('knowledge'), contentRevision: 1,
      scope: target.scope, source, createdAt: now, validUntil: request.validUntil, content: request.content });
    const command = { requestId: request.requestId,
      intentDigest: draftIntentDigest({ operation: 'create', requestId: request.requestId,
        actorId: target.actorId, targetId: request.targetId, scope: target.scope, source,
        content: request.content, validUntil: request.validUntil }),
      actorId: target.actorId, naturalKey: naturalKey(request.content), sourceDomainId: source.manifest.dataDomainId,
      expectedContentRevision: null, expectedGovernanceVersion: null, revision };
    const saved = this.options.replay === undefined ? await this.options.drafts.saveDraft(command)
      : await this.options.replay.saveDraftWithReplayIntent(command, replayIntent);
    return assertProcedural(saved);
  }

  public async reviseDraft(input: ReviseProceduralTemplateDraftRequest): Promise<ProceduralKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'source', 'content', 'validUntil', 'knowledgeId',
      'expectedContentRevision', 'expectedGovernanceVersion']);
    const request = validateDraftRequest(input);
    if (!isIdentifier(input.knowledgeId) || !isPositiveVersion(input.expectedContentRevision)
      || !isPositiveVersion(input.expectedGovernanceVersion)) throw invalidRecord();
    const target = await this.resolveTarget(request.targetId, request.requestId);
    const replayIntent: KnowledgeCommandReplayIntent = { schemaVersion: 1, requestId: request.requestId,
      operation: 'draft', scope: target.scope, intentDigest: checkpointChecksum({ schemaVersion: 1,
        operation: 'revise', requestId: request.requestId, actorId: target.actorId,
        targetId: request.targetId, scope: target.scope, knowledgeId: input.knowledgeId,
        expectedContentRevision: input.expectedContentRevision, expectedGovernanceVersion: input.expectedGovernanceVersion,
        source: request.source, content: request.content, contentDigest: checkpointChecksum(request.content),
        validUntil: request.validUntil ?? null }) };
    const replay = await this.options.replay?.replayCommand(replayIntent);
    if (replay) return assertProcedural(replay);
    const current = await this.inspectRevision(input.knowledgeId, input.expectedContentRevision, target.scope);
    if (current.kind !== 'procedural') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    if (current.governanceVersion !== input.expectedGovernanceVersion) {
      throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
    }
    if (current.status === 'review_pending' || current.status === 'revoked' || current.status === 'expired'
      || current.status === 'superseded' || current.status === 'conflict') {
      throw new KnowledgeContractError('KNOWLEDGE_TRANSITION_INVALID');
    }
    const source = await this.resolveCurrentSource(request.targetId, request.source);
    this.validateContentSources(request.targetId, request.source, request.content);
    this.validateCapabilities(request.targetId, target.scope, request.content);
    const now = this.clock.now().toISOString();
    const revision = buildDraft({ id: input.knowledgeId, contentRevision: current.contentRevision + 1,
      scope: target.scope, source, createdAt: now, validUntil: request.validUntil, content: request.content });
    const command = { requestId: request.requestId,
      intentDigest: draftIntentDigest({ operation: 'revise', requestId: request.requestId,
        actorId: target.actorId, targetId: request.targetId, scope: target.scope, source,
        content: request.content, validUntil: request.validUntil, knowledgeId: input.knowledgeId,
        expectedContentRevision: input.expectedContentRevision,
        expectedGovernanceVersion: input.expectedGovernanceVersion }),
      actorId: target.actorId, naturalKey: naturalKey(request.content), sourceDomainId: source.manifest.dataDomainId,
      expectedContentRevision: input.expectedContentRevision,
      expectedGovernanceVersion: input.expectedGovernanceVersion, revision };
    const saved = this.options.replay === undefined ? await this.options.drafts.saveDraft(command)
      : await this.options.replay.saveDraftWithReplayIntent(command, replayIntent);
    return assertProcedural(saved);
  }

  public async submitForReview(input: SubmitProceduralReviewRequest): Promise<ProceduralKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'knowledgeId', 'contentRevision', 'governanceVersion']);
    validateRevisionRequest(input);
    const target = await this.resolveTarget(input.targetId, input.requestId);
    const current = await this.inspectRevision(input.knowledgeId, input.contentRevision, target.scope);
    if (current.kind !== 'procedural') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    const submitted = await this.options.drafts.submitForReview({ requestId: input.requestId,
      actorId: target.actorId, knowledgeId: input.knowledgeId, kind: 'procedural',
      expectedContentRevision: input.contentRevision, expectedGovernanceVersion: input.governanceVersion });
    return assertProcedural(submitted);
  }

  public async review(input: ReviewProceduralTemplateRequest): Promise<ProceduralKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'knowledgeId', 'contentRevision', 'governanceVersion',
      'decision', 'reasonCode']);
    validateRevisionRequest(input);
    if ((input.decision !== 'approve' && input.decision !== 'reject')
      || (input.reasonCode !== undefined && !isIdentifier(input.reasonCode))) throw invalidRecord();
    const target = await this.resolveTarget(input.targetId, input.requestId);
    // Inspection exposes only immutable digest/state and does not enforce volatile source
    // eligibility. Defer not-found until receipt lookup so changed identity is a conflict.
    const current = await this.options.queries.inspectExact({ id: input.knowledgeId,
      contentRevision: input.contentRevision, scope: target.scope, now: this.clock.now().toISOString() });
    // Capability eligibility is checked when immutable content is authored and again at
    // applicability time. The governance query intentionally exposes only safe state for
    // pending drafts; the existing T2 review authority revalidates source epoch/digest.
    const replayIntent: KnowledgeCommandReplayIntent = { schemaVersion: 1, requestId: input.requestId,
      operation: 'review', scope: target.scope, intentDigest: checkpointChecksum({ schemaVersion: 1,
        operation: 'review', requestId: input.requestId, actorId: target.actorId, targetId: input.targetId,
        scope: target.scope, knowledgeId: input.knowledgeId, kind: 'procedural',
        expectedContentRevision: input.contentRevision, expectedGovernanceVersion: input.governanceVersion,
        contentDigest: current?.contentDigest ?? null, decision: input.decision, reasonCode: input.reasonCode ?? null }) };
    const replay = await this.options.replay?.replayCommand(replayIntent);
    if (replay) return assertProcedural(replay);
    if (!current || current.kind !== 'procedural') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    let checks: KnowledgeReviewCommand['checks'];
    try {
      checks = await this.options.reviewAttestations.resolveForReview({ requestId: input.requestId,
        targetId: input.targetId, knowledgeId: input.knowledgeId, decision: input.decision });
    } catch (cause) {
      if (cause instanceof KnowledgeContractError) throw cause;
      throw new KnowledgeContractError('KNOWLEDGE_STORAGE_UNAVAILABLE');
    }
    const command = parseKnowledgeReviewCommand({ schemaVersion: 1, requestId: input.requestId,
      knowledgeId: input.knowledgeId, kind: 'procedural', expectedContentRevision: input.contentRevision,
      expectedGovernanceVersion: input.governanceVersion, contentDigest: current.contentDigest,
      decision: input.decision, checks, ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) });
    const reviewed = this.options.replay === undefined ? await this.options.reviews.review(command)
      : await this.options.replay.reviewWithReplayIntent(command, replayIntent);
    return assertProcedural(reviewed);
  }

  /** Revocation changes only the exact revision; T2 owns CAS, replay, and audit atomically. */
  public async revoke(input: RevokeProceduralTemplateRequest): Promise<ProceduralKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'knowledgeId', 'contentRevision', 'expectedGovernanceVersion']);
    validateRevisionRequest({ ...input, governanceVersion: input.expectedGovernanceVersion });
    const target = await this.resolveTarget(input.targetId, input.requestId);
    const current = await this.inspectRevision(input.knowledgeId, input.contentRevision, target.scope);
    if (current.kind !== 'procedural') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    const revoked = await this.options.transitions.transitionKnowledge({ requestId: input.requestId,
      actorId: target.actorId, knowledgeId: input.knowledgeId, kind: 'procedural',
      contentRevision: input.contentRevision, expectedGovernanceVersion: input.expectedGovernanceVersion,
      nextStatus: 'revoked', occurredAt: this.clock.now().toISOString() });
    return assertProcedural(revoked);
  }

  private async resolveTarget(targetId: string, requestId: string): Promise<{ actorId: string; scope: KnowledgeScope }> {
    const context = await this.options.targets.resolveForTarget({ targetId, requestId });
    const scope = parseKnowledgeScope(context.scope);
    if (scope.targetId !== targetId || !isIdentifier(context.actorId)) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    return { actorId: context.actorId, scope };
  }

  private async inspectRevision(id: string, contentRevision: number, scope: KnowledgeScope) {
    const state = await this.options.queries.inspectExact({ id, contentRevision, scope, now: this.clock.now().toISOString() });
    if (!state) throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    return state;
  }

  private async resolveCurrentSource(targetId: string, reference: KnowledgeSourceReference): Promise<ResolvedProceduralSource> {
    const manifest = this.options.sourceRegistry.resolve({ targetId, reference });
    let state = await this.options.sources.getSource({ sourceId: manifest.sourceId, dataDomainId: manifest.dataDomainId });
    if (state === null) {
      state = await this.options.sources.registerSource({ sourceId: manifest.sourceId,
        dataDomainId: manifest.dataDomainId, sourceDigest: manifest.sourceDigest,
        registeredAt: this.clock.now().toISOString() });
    }
    if (state === null) throw new KnowledgeContractError('KNOWLEDGE_STORAGE_UNAVAILABLE');
    if (state.validity !== 'active') throw new KnowledgeContractError('KNOWLEDGE_SOURCE_REVOKED');
    if (state.sourceDigest !== manifest.sourceDigest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    return { manifest, state };
  }

  private validateContentSources(
    targetId: string,
    primarySource: KnowledgeSourceReference,
    content: ProceduralKnowledgeContent,
  ): void {
    const primary = this.options.sourceRegistry.resolve({ targetId, reference: primarySource });
    for (const reference of content.sourceReferences) {
      const resolved = this.options.sourceRegistry.resolve({ targetId, reference });
      // The frozen T1/T2 revision contract records one source epoch/digest per revision.
      // Until a multi-source revision contract exists, reject mixed provenance rather
      // than allow a secondary source to be revoked without invalidating this revision.
      if (resolved.sourceId !== primary.sourceId || resolved.sourceVersion !== primary.sourceVersion
        || resolved.sourceDigest !== primary.sourceDigest || resolved.dataDomainId !== primary.dataDomainId
        || reference.sourceId !== primarySource.sourceId || reference.sourceVersion !== primarySource.sourceVersion
        || reference.digest !== primarySource.digest) {
        throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
      }
    }
  }

  private validateCapabilities(targetId: string, scope: KnowledgeScope, content: ProceduralKnowledgeContent): void {
    for (const step of content.steps) {
      const capability = this.options.capabilityRegistry.resolveForTarget({ targetId, capabilityId: step.capabilityId });
      if (!isReadonlyCapability(capability, step.capabilityId)) {
        throw new KnowledgeContractError('KNOWLEDGE_APPROVAL_DENIED');
      }
      if (!content.applicableTo.serviceIds.every(id => capability.serviceIds.includes(id))
        || !content.applicableTo.faultTypes.every(id => capability.faultTypes.includes(id))
        || !content.applicableTo.environments.every(environment => capability.environments.includes(environment))
        || !capability.dataClasses.includes(scope.dataClass)) {
        throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
      }
    }
  }
}

function buildDraft(input: {
  id: string;
  contentRevision: number;
  scope: KnowledgeScope;
  source: ResolvedProceduralSource;
  createdAt: string;
  validUntil?: string | undefined;
  content: ProceduralKnowledgeContent;
}): ProceduralKnowledgeRevision {
  return parseKnowledgeRecord({
    schemaVersion: 1, id: input.id, kind: 'procedural', contentRevision: input.contentRevision,
    governanceVersion: 1, sourceEpoch: input.source.state.sourceEpoch, status: 'draft', createdAt: input.createdAt,
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }), scope: input.scope,
    provenance: { sourceType: input.source.manifest.sourceType, sourceId: input.source.manifest.sourceId,
      sourceVersion: input.source.manifest.sourceVersion, sourceDigest: input.source.manifest.sourceDigest,
      importedAt: input.createdAt },
    contentDigest: checkpointChecksum(input.content), content: input.content,
  }) as ProceduralKnowledgeRevision;
}

function validateDraftRequest(input: CreateProceduralTemplateDraftRequest): CreateProceduralTemplateDraftRequest {
  if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isRecord(input.source)
    || !isIdentifier(input.source.sourceId) || !isIdentifier(input.source.sourceVersion) || !isDigest(input.source.digest)
    || (input.validUntil !== undefined && !isTimestamp(input.validUntil))) throw invalidRecord();
  const source = structuredClone(input.source);
  const content = parseProceduralContent(input.content);
  return { requestId: input.requestId, targetId: input.targetId, source, content,
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) };
}

function parseProceduralContent(value: unknown): ProceduralKnowledgeContent {
  if (!isRecord(value) || !isRecord(value.scenario) || !isRecord(value.applicableTo)
    || !Array.isArray(value.applicableTo.serviceIds) || !Array.isArray(value.applicableTo.faultTypes)
    || !Array.isArray(value.applicableTo.environments) || typeof value.scenario.id !== 'string'
    || typeof value.scenario.version !== 'string' || typeof value.applicableTo.environments[0] !== 'string') {
    throw invalidRecord();
  }
  const environment = value.applicableTo.environments[0];
  if (!isTargetEnvironment(environment)) throw invalidRecord();
  const scopeBase = {
    targetId: 'procedural-validation', projectId: 'procedural-validation', deploymentId: 'procedural-validation',
    deploymentGeneration: 1, targetFingerprint: 'procedural-validation', profileId: 'procedural-validation',
    profileRevision: '1', scenarioId: value.scenario.id, scenarioVersion: value.scenario.version,
    serviceIds: value.applicableTo.serviceIds as string[], faultTypes: value.applicableTo.faultTypes as string[],
  };
  const scope: KnowledgeScope = environment === 'simulation'
    ? { ...scopeBase, environment, dataClass: 'simulated', datasetId: 'procedural-validation' }
    : { ...scopeBase, environment, dataClass: 'live' };
  const placeholder = checkpointChecksum({});
  const parsed = parseKnowledgeRecord({
    schemaVersion: 1, id: 'procedural-validation', kind: 'procedural', contentRevision: 1,
    governanceVersion: 1, sourceEpoch: 0, status: 'draft', createdAt: '2026-10-12T00:00:00.000Z', scope,
    provenance: { sourceType: 'operator_provided', sourceId: 'procedural-validation', sourceVersion: '1',
      sourceDigest: placeholder, importedAt: '2026-10-12T00:00:00.000Z' },
    contentDigest: checkpointChecksum(value), content: value,
  });
  if (parsed.kind !== 'procedural') throw invalidRecord();
  return parsed.content;
}

function naturalKey(content: ProceduralKnowledgeContent): string {
  return `procedural:${content.templateId}:${content.scenario.id}:${content.scenario.version}`;
}

function draftIntentDigest(input: {
  operation: 'create' | 'revise';
  requestId: string;
  actorId: string;
  targetId: string;
  scope: KnowledgeScope;
  source: ResolvedProceduralSource;
  content: ProceduralKnowledgeContent;
  validUntil?: string | undefined;
  knowledgeId?: string;
  expectedContentRevision?: number;
  expectedGovernanceVersion?: number;
}): string {
  return checkpointChecksum({ schemaVersion: 1, operation: input.operation, requestId: input.requestId,
    actorId: input.actorId, targetId: input.targetId, scope: input.scope,
    source: { sourceType: input.source.manifest.sourceType, sourceId: input.source.manifest.sourceId,
      sourceVersion: input.source.manifest.sourceVersion, sourceDigest: input.source.manifest.sourceDigest,
      dataDomainId: input.source.manifest.dataDomainId, sourceEpoch: input.source.state.sourceEpoch },
    content: input.content, validUntil: input.validUntil ?? null,
    ...(input.operation === 'revise' ? { knowledgeId: input.knowledgeId,
      expectedContentRevision: input.expectedContentRevision, expectedGovernanceVersion: input.expectedGovernanceVersion } : {}) });
}

function validateRevisionRequest(input: SubmitProceduralReviewRequest): void {
  if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isIdentifier(input.knowledgeId)
    || !isPositiveVersion(input.contentRevision) || !isPositiveVersion(input.governanceVersion)) throw invalidRecord();
}

function assertProcedural(revision: KnowledgeRevision): ProceduralKnowledgeRevision {
  if (revision.kind !== 'procedural') throw invalidRecord();
  return revision;
}

function isReadonlyCapability(value: unknown, expectedId: string): value is ProceduralReadonlyCapability {
  if (!isRecord(value) || Object.keys(value).some(key => !['capabilityId', 'access', 'serviceIds', 'faultTypes',
    'environments', 'dataClasses'].includes(key)) || value.capabilityId !== expectedId || value.access !== 'read_only'
    || !isIdentifierArray(value.serviceIds) || !isIdentifierArray(value.faultTypes)
    || !isNonemptyStringArray(value.environments) || value.environments.some(environment =>
      !['simulation', 'development', 'staging', 'production'].includes(environment))
    || !isNonemptyStringArray(value.dataClasses) || value.dataClasses.some(dataClass => !['simulated', 'live'].includes(dataClass))) {
    return false;
  }
  return true;
}

function isIdentifierArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isIdentifier) && new Set(value).size === value.length;
}

function isNonemptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')
    && new Set(value).size === value.length;
}

function assertExactKeys(value: unknown, allowedKeys: readonly string[]): void {
  if (!isRecord(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) throw invalidRecord();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return safeKnowledgeIdentifierSchema.safeParse(value).success;
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isTargetEnvironment(value: unknown): value is TargetEnvironment {
  return value === 'simulation' || value === 'development' || value === 'staging' || value === 'production';
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function invalidRecord(): KnowledgeContractError {
  return new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
}
