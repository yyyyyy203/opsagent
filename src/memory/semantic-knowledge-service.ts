import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../contracts/common.js';
import {
  KnowledgeContractError,
  type KnowledgeGovernanceReviewPort,
  type KnowledgeQueryPort,
  type KnowledgeReviewCommand,
  type KnowledgeRevision,
  type KnowledgeScope,
  type SemanticKnowledgeContent,
  type SemanticKnowledgeRevision,
} from '../contracts/knowledge-memory.js';
import { parseKnowledgeRecord, parseKnowledgeScope, parseKnowledgeReviewCommand,
  safeKnowledgeIdentifierSchema } from '../contracts/knowledge-memory-schema.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import type {
  KnowledgeDraftStore,
  KnowledgeRevisionStateQueryPort,
  KnowledgeSourceGovernanceStore,
  KnowledgeSourceState,
} from '../contracts/knowledge-memory-storage.js';
import type { KnowledgeSourceReference } from '../contracts/knowledge-memory.js';
import type { SemanticSourceRegistry, SemanticSourceManifestEntry } from './semantic-source-registry.js';

interface ResolvedSemanticSource {
  readonly manifest: SemanticSourceManifestEntry;
  readonly source: KnowledgeSourceState;
}

export interface SemanticTargetContextPort {
  /** Scope and author identity are derived by the host, never supplied by the caller. */
  resolveForTarget(input: { readonly targetId: string; readonly requestId: string }): Promise<{
    readonly actorId: string;
    readonly scope: KnowledgeScope;
  }>;
}

export interface SemanticReviewAttestationPort {
  /** Human review checks are resolved by a host-owned operator flow, not command JSON or an LLM. */
  resolveForReview(input: {
    readonly requestId: string;
    readonly targetId: string;
    readonly knowledgeId: string;
    readonly decision: 'approve' | 'reject';
  }): Promise<KnowledgeReviewCommand['checks']>;
}

export interface SemanticKnowledgeServiceOptions {
  readonly sourceRegistry: SemanticSourceRegistry;
  readonly targets: SemanticTargetContextPort;
  readonly drafts: KnowledgeDraftStore;
  readonly sources: KnowledgeSourceGovernanceStore & Pick<KnowledgeDraftStore, 'registerSource'>;
  readonly queries: KnowledgeQueryPort & KnowledgeRevisionStateQueryPort;
  readonly reviews: KnowledgeGovernanceReviewPort;
  readonly reviewAttestations: SemanticReviewAttestationPort;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface CreateSemanticDraftRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly source: KnowledgeSourceReference;
  readonly content: SemanticKnowledgeContent;
  readonly validUntil?: string;
}

export interface ReviseSemanticDraftRequest extends CreateSemanticDraftRequest {
  readonly knowledgeId: string;
  readonly expectedContentRevision: number;
  readonly expectedGovernanceVersion: number;
}

export interface ImportApprovedSemanticRequest {
  readonly requestId: string;
  readonly sourceTargetId: string;
  readonly targetId: string;
  readonly knowledgeId: string;
  readonly contentRevision: number;
  readonly destinationSource: KnowledgeSourceReference;
}

export interface SubmitSemanticReviewRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly knowledgeId: string;
  readonly contentRevision: number;
  readonly governanceVersion: number;
}

export interface ReviewSemanticKnowledgeRequest extends SubmitSemanticReviewRequest {
  readonly decision: 'approve' | 'reject';
  readonly reasonCode?: string;
}

/** Semantic authoring/review orchestration. It has no model, network, or filesystem dependency. */
export class SemanticKnowledgeService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly options: SemanticKnowledgeServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public async createDraft(input: CreateSemanticDraftRequest): Promise<SemanticKnowledgeRevision> {
    return this.createDraftFromOrigin(input);
  }

  private async createDraftFromOrigin(
    input: CreateSemanticDraftRequest,
    origin?: SemanticKnowledgeRevision,
  ): Promise<SemanticKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'source', 'content', 'validUntil']);
    const request = validateDraftRequest(input);
    const target = await this.resolveTarget(request.targetId, request.requestId);
    const source = await this.resolveCurrentSource(request.targetId, request.source);
    this.validateContentSources(request.targetId, request.content);
    // Destination preparation may await host ports. Revalidate the original approval
    // after those waits; copying content never carries approval into the new scope.
    if (origin !== undefined) await this.assertCurrentlyApproved(origin);
    const now = this.clock.now().toISOString();
    const revision = buildDraft({
      id: this.ids.next('knowledge'), contentRevision: 1, scope: target.scope, source,
      createdAt: now, validUntil: request.validUntil, content: request.content,
    });
    const saved = await this.options.drafts.saveDraft({
      requestId: request.requestId, actorId: target.actorId, naturalKey: semanticNaturalKey(revision.content),
      intentDigest: semanticDraftIntentDigest({ operation: origin === undefined ? 'create' : 'import',
        ...(origin === undefined ? {} : { origin }), requestId: request.requestId,
        actorId: target.actorId, targetId: request.targetId, scope: target.scope, source,
        content: request.content, validUntil: request.validUntil }),
      sourceDomainId: source.source.dataDomainId, expectedContentRevision: null, expectedGovernanceVersion: null, revision,
    });
    return assertSemantic(saved);
  }

  public async reviseDraft(input: ReviseSemanticDraftRequest): Promise<SemanticKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'source', 'content', 'validUntil', 'knowledgeId',
      'expectedContentRevision', 'expectedGovernanceVersion']);
    const request = validateDraftRequest(input);
    if (!isIdentifier(input.knowledgeId) || !isPositiveVersion(input.expectedContentRevision)
      || !isPositiveVersion(input.expectedGovernanceVersion)) throw invalidRecord();
    const target = await this.resolveTarget(request.targetId, request.requestId);
    const current = await this.inspectRevision(input.knowledgeId, input.expectedContentRevision, target.scope);
    if (current.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    if (current.governanceVersion !== input.expectedGovernanceVersion) {
      throw new KnowledgeContractError('KNOWLEDGE_GOVERNANCE_CONFLICT');
    }
    if (current.status === 'review_pending') throw new KnowledgeContractError('KNOWLEDGE_TRANSITION_INVALID');
    if (current.status === 'revoked' || current.status === 'expired' || current.status === 'superseded'
      || current.status === 'conflict') throw new KnowledgeContractError('KNOWLEDGE_TRANSITION_INVALID');
    const source = await this.resolveCurrentSource(request.targetId, request.source);
    this.validateContentSources(request.targetId, request.content);
    const now = this.clock.now().toISOString();
    const revision = buildDraft({
      id: current.knowledgeId, contentRevision: current.contentRevision + 1, scope: target.scope, source,
      createdAt: now, validUntil: request.validUntil, content: request.content,
    });
    const saved = await this.options.drafts.saveDraft({
      requestId: request.requestId, actorId: target.actorId, naturalKey: semanticNaturalKey(request.content),
      intentDigest: semanticDraftIntentDigest({ operation: 'revise', requestId: request.requestId,
        actorId: target.actorId, targetId: request.targetId, scope: target.scope, source,
        content: request.content, validUntil: request.validUntil, knowledgeId: input.knowledgeId,
        expectedContentRevision: input.expectedContentRevision,
        expectedGovernanceVersion: input.expectedGovernanceVersion }),
      sourceDomainId: source.source.dataDomainId, expectedContentRevision: input.expectedContentRevision,
      expectedGovernanceVersion: input.expectedGovernanceVersion, revision,
    });
    return assertSemantic(saved);
  }

  public async importApproved(input: ImportApprovedSemanticRequest): Promise<SemanticKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'sourceTargetId', 'targetId', 'knowledgeId', 'contentRevision', 'destinationSource']);
    if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isIdentifier(input.sourceTargetId)
      || !isIdentifier(input.knowledgeId) || !isPositiveVersion(input.contentRevision) || input.targetId === input.sourceTargetId) {
      throw invalidRecord();
    }
    const sourceTarget = await this.resolveTarget(input.sourceTargetId, input.requestId);
    const state = await this.inspectRevision(input.knowledgeId, input.contentRevision, sourceTarget.scope);
    if (state.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    this.assertRevisionStateApproved(state);
    const current = await this.options.queries.getExact({ id: input.knowledgeId,
      contentRevision: input.contentRevision, scope: sourceTarget.scope });
    if (!current) {
      const latest = await this.inspectRevision(input.knowledgeId, input.contentRevision, sourceTarget.scope);
      this.assertRevisionStateApproved(latest);
      throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    }
    if (current.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    await this.assertCurrentlyApproved(current);
    return this.createDraftFromOrigin({ requestId: input.requestId, targetId: input.targetId,
      source: input.destinationSource, content: current.content,
      ...(current.validUntil === undefined ? {} : { validUntil: current.validUntil }) }, current);
  }

  public async submitForReview(input: SubmitSemanticReviewRequest): Promise<SemanticKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'knowledgeId', 'contentRevision', 'governanceVersion']);
    if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isIdentifier(input.knowledgeId)
      || !isPositiveVersion(input.contentRevision) || !isPositiveVersion(input.governanceVersion)) throw invalidRecord();
    const target = await this.resolveTarget(input.targetId, input.requestId);
    const current = await this.inspectRevision(input.knowledgeId, input.contentRevision, target.scope);
    if (current.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    const submitted = await this.options.drafts.submitForReview({ requestId: input.requestId, actorId: target.actorId,
      knowledgeId: input.knowledgeId, kind: 'semantic', expectedContentRevision: input.contentRevision,
      expectedGovernanceVersion: input.governanceVersion });
    return assertSemantic(submitted);
  }

  public async review(input: ReviewSemanticKnowledgeRequest): Promise<SemanticKnowledgeRevision> {
    assertExactKeys(input, ['requestId', 'targetId', 'knowledgeId', 'contentRevision', 'governanceVersion', 'decision', 'reasonCode']);
    if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isIdentifier(input.knowledgeId)
      || !isPositiveVersion(input.contentRevision) || !isPositiveVersion(input.governanceVersion)
      || (input.decision !== 'approve' && input.decision !== 'reject')
      || (input.reasonCode !== undefined && !isIdentifier(input.reasonCode))) throw invalidRecord();
    const target = await this.resolveTarget(input.targetId, input.requestId);
    const current = await this.inspectRevision(input.knowledgeId, input.contentRevision, target.scope);
    if (current.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    const checks = await this.options.reviewAttestations.resolveForReview({ requestId: input.requestId,
      targetId: input.targetId, knowledgeId: input.knowledgeId, decision: input.decision });
    const command = parseKnowledgeReviewCommand({ schemaVersion: 1, requestId: input.requestId,
      knowledgeId: input.knowledgeId, kind: 'semantic', expectedContentRevision: input.contentRevision,
      expectedGovernanceVersion: input.governanceVersion, contentDigest: current.contentDigest,
      decision: input.decision, checks, ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) });
    return assertSemantic(await this.options.reviews.review(command));
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

  private async resolveCurrentSource(targetId: string, reference: KnowledgeSourceReference): Promise<ResolvedSemanticSource> {
    const manifest = this.options.sourceRegistry.resolve({ targetId, reference });
    let source = await this.options.sources.getSource({ sourceId: manifest.sourceId, dataDomainId: manifest.dataDomainId });
    if (source === null) {
      source = await this.options.sources.registerSource({ sourceId: manifest.sourceId,
        dataDomainId: manifest.dataDomainId, sourceDigest: manifest.sourceDigest, registeredAt: this.clock.now().toISOString() });
    }
    if (source === null) throw new KnowledgeContractError('KNOWLEDGE_STORAGE_UNAVAILABLE');
    if (source.validity !== 'active') throw new KnowledgeContractError('KNOWLEDGE_SOURCE_REVOKED');
    if (source.sourceDigest !== manifest.sourceDigest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    return { manifest, source };
  }

  private validateContentSources(targetId: string, content: SemanticKnowledgeContent): void {
    const references = content.type === 'metric_definition' ? content.sourceReferences
      : content.type === 'domain_glossary' ? content.terms.map(term => term.sourceReference) : [];
    for (const reference of references) this.options.sourceRegistry.resolve({ targetId, reference });
  }

  private async assertCurrentlyApproved(revision: SemanticKnowledgeRevision): Promise<void> {
    const state = await this.options.queries.inspectExact({ id: revision.id, contentRevision: revision.contentRevision,
      scope: revision.scope, now: this.clock.now().toISOString() });
    if (!state) throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    if (state.contentDigest !== revision.contentDigest) throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    this.assertRevisionStateApproved(state);
    if (revision.status !== 'approved') throw new KnowledgeContractError('KNOWLEDGE_TRANSITION_INVALID');
  }

  private assertRevisionStateApproved(state: Awaited<ReturnType<KnowledgeRevisionStateQueryPort['inspectExact']>> extends infer T
    ? Exclude<T, null> : never): void {
    const now = this.clock.now().getTime();
    if (state.status === 'expired' || (state.validUntil !== undefined && Date.parse(state.validUntil) <= now)) {
      throw new KnowledgeContractError('KNOWLEDGE_EXPIRED');
    }
    if (state.sourceValidity === 'digest_mismatch' || !state.sourceDigestMatches) {
      throw new KnowledgeContractError('KNOWLEDGE_DIGEST_MISMATCH');
    }
    if (state.sourceValidity !== 'active' || state.currentSourceEpoch !== state.sourceEpoch) {
      throw new KnowledgeContractError('KNOWLEDGE_SOURCE_REVOKED');
    }
    if (state.status !== 'approved') throw new KnowledgeContractError('KNOWLEDGE_TRANSITION_INVALID');
  }
}

function buildDraft(input: {
  id: string;
  contentRevision: number;
  scope: KnowledgeScope;
  source: ResolvedSemanticSource;
  createdAt: string;
  validUntil?: string | undefined;
  content: SemanticKnowledgeContent;
}): SemanticKnowledgeRevision {
  return parseKnowledgeRecord({
    schemaVersion: 1, id: input.id, kind: 'semantic', contentRevision: input.contentRevision,
    governanceVersion: 1, sourceEpoch: input.source.source.sourceEpoch, status: 'draft', createdAt: input.createdAt,
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
    scope: input.scope,
    provenance: { sourceType: input.source.manifest.sourceType, sourceId: input.source.manifest.sourceId,
      sourceVersion: input.source.manifest.sourceVersion, sourceDigest: input.source.manifest.sourceDigest,
      importedAt: input.createdAt },
    contentDigest: checkpointChecksum(input.content), content: input.content,
  }) as SemanticKnowledgeRevision;
}

function validateDraftRequest(input: CreateSemanticDraftRequest): CreateSemanticDraftRequest {
  if (!isIdentifier(input.requestId) || !isIdentifier(input.targetId) || !isRecord(input.source)
    || !isIdentifier(input.source.sourceId) || !isIdentifier(input.source.sourceVersion) || !isDigest(input.source.digest)
    || (input.validUntil !== undefined && !isTimestamp(input.validUntil))) throw invalidRecord();
  const source = structuredClone(input.source);
  const content = parseSemanticContent(input.content);
  return { requestId: input.requestId, targetId: input.targetId, source, content,
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) };
}

function parseSemanticContent(value: unknown): SemanticKnowledgeContent {
  const parsed = parseKnowledgeRecord({ schemaVersion: 1, id: 'semantic-validation', kind: 'semantic',
    contentRevision: 1, governanceVersion: 1, sourceEpoch: 0, status: 'draft', createdAt: '2026-10-12T00:00:00.000Z',
    scope: {
      targetId: 'semantic-validation', projectId: 'semantic-validation', deploymentId: 'semantic-validation', deploymentGeneration: 1,
      targetFingerprint: 'semantic-validation', profileId: 'semantic-validation', profileRevision: '1',
      scenarioId: 'semantic-validation', scenarioVersion: '1', serviceIds: ['semantic-validation'], faultTypes: ['semantic-validation'],
      environment: 'simulation', dataClass: 'simulated', datasetId: 'semantic-validation',
    },
    provenance: { sourceType: 'operator_provided', sourceId: 'semantic-validation', sourceVersion: '1',
      sourceDigest: checkpointChecksum({}), importedAt: '2026-10-12T00:00:00.000Z' },
    contentDigest: checkpointChecksum(value), content: value,
  });
  if (parsed.kind !== 'semantic') throw invalidRecord();
  return parsed.content;
}

function semanticNaturalKey(content: SemanticKnowledgeContent): string {
  const identity = content.type === 'metric_definition' ? content.metricName
    : content.type === 'domain_glossary' ? content.terms.map(term => term.term.toLocaleLowerCase('en-US')).sort()
      : 'service-topology';
  return `semantic:${content.type}:${checkpointChecksum(identity)}`;
}

function semanticDraftIntentDigest(input: {
  operation: 'create' | 'revise' | 'import';
  origin?: SemanticKnowledgeRevision;
  requestId: string;
  actorId: string;
  targetId: string;
  scope: KnowledgeScope;
  source: ResolvedSemanticSource;
  content: SemanticKnowledgeContent;
  validUntil?: string | undefined;
  knowledgeId?: string;
  expectedContentRevision?: number;
  expectedGovernanceVersion?: number;
}): string {
  return checkpointChecksum({
    schemaVersion: 1,
    operation: input.operation,
    requestId: input.requestId,
    actorId: input.actorId,
    targetId: input.targetId,
    scope: input.scope,
    source: {
      sourceType: input.source.manifest.sourceType, sourceId: input.source.manifest.sourceId,
      sourceVersion: input.source.manifest.sourceVersion, sourceDigest: input.source.manifest.sourceDigest,
      dataDomainId: input.source.manifest.dataDomainId, sourceEpoch: input.source.source.sourceEpoch,
    },
    content: input.content,
    validUntil: input.validUntil ?? null,
    ...(input.origin === undefined ? {} : { origin: {
      targetId: input.origin.scope.targetId, scope: input.origin.scope,
      knowledgeId: input.origin.id, contentRevision: input.origin.contentRevision,
      contentDigest: input.origin.contentDigest,
    } }),
    ...(input.operation === 'revise' ? {
      knowledgeId: input.knowledgeId,
      expectedContentRevision: input.expectedContentRevision,
      expectedGovernanceVersion: input.expectedGovernanceVersion,
    } : {}),
  });
}

function assertSemantic(revision: KnowledgeRevision): SemanticKnowledgeRevision {
  if (revision.kind !== 'semantic') throw invalidRecord();
  return revision;
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

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes('T');
}

function invalidRecord(): KnowledgeContractError {
  return new KnowledgeContractError('KNOWLEDGE_RECORD_INVALID');
}
