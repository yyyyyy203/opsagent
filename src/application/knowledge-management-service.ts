import type { Clock, IdGenerator } from '../contracts/common.js';
import { randomIdGenerator, systemClock } from '../contracts/common.js';
import { KnowledgeContractError, type KnowledgeKind, type KnowledgeRevision, type KnowledgeScope, type KnowledgeStatus } from '../contracts/knowledge-memory.js';
import { TargetConfigurationError, type TargetKnowledgePolicy, type TargetKnowledgeReference, type TargetKnowledgeRequirement } from '../contracts/target.js';
import type { KnowledgePublicationInspectionPort, KnowledgeGovernanceTransitionStore,
  KnowledgeRevisionStateQueryPort, KnowledgeScopedListPort, KnowledgeSourceGovernanceContextPort,
  KnowledgeSourceGovernanceStore, KnowledgeSourceState } from '../contracts/knowledge-memory-storage.js';
import type { TargetKnowledgeCapabilityPort, TargetKnowledgePolicyStore } from '../contracts/target.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import type { SemanticKnowledgeService, CreateSemanticDraftRequest, ReviseSemanticDraftRequest,
  SubmitSemanticReviewRequest, ReviewSemanticKnowledgeRequest } from '../memory/semantic-knowledge-service.js';
import type { ProceduralTemplateService, CreateProceduralTemplateDraftRequest,
  ReviseProceduralTemplateDraftRequest, RevokeProceduralTemplateRequest } from '../memory/procedural-template-service.js';
import type { TargetKnowledgePublicationService } from './target-knowledge-publication-service.js';

export interface KnowledgeManagementTargetContextPort {
  resolveForTarget(input: { readonly targetId: string; readonly requestId: string }): Promise<{
    readonly actorId: string;
    readonly scope: KnowledgeScope;
  }>;
}

export interface KnowledgeManagementServiceOptions {
  readonly targets: KnowledgeManagementTargetContextPort;
  readonly revisions: KnowledgeScopedListPort & KnowledgeRevisionStateQueryPort & KnowledgeGovernanceTransitionStore
    & KnowledgeSourceGovernanceStore;
  readonly publications: KnowledgePublicationInspectionPort;
  readonly policies: TargetKnowledgePolicyStore;
  readonly capabilities: TargetKnowledgeCapabilityPort;
  readonly semantic: SemanticKnowledgeService;
  readonly procedural: ProceduralTemplateService;
  readonly publicationService: TargetKnowledgePublicationService;
  /** Host-owned source identity resolution for source governance commands. */
  readonly sourceGovernance: KnowledgeSourceGovernanceContextPort;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface KnowledgeTargetStatus {
  readonly targetId: string;
  readonly capabilities: { readonly semanticEnabled: boolean; readonly proceduralEnabled: boolean };
  readonly requiredKnowledge: readonly {
    readonly id: string;
    readonly version: string;
    readonly knowledgeClass?: KnowledgeKind;
  }[];
  readonly publicationVersion: number;
  readonly publicationState: 'empty' | 'active' | 'scope_changed';
  readonly references: readonly TargetKnowledgeReference[];
}

/** Application boundary for Target-scoped knowledge management; request data never supplies scope or actor. */
export class KnowledgeManagementService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly options: KnowledgeManagementServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
  }

  public async list(input: { targetId: string; kind: KnowledgeKind; status?: KnowledgeStatus;
    after?: { id: string; contentRevision: number }; limit: number }): Promise<readonly KnowledgeRevision[]> {
    const requestId = this.ids.next('knowledge-read');
    const context = await this.options.targets.resolveForTarget({ targetId: input.targetId, requestId });
    if (context.scope.targetId !== input.targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    return this.options.revisions.listScopedRevisions({ scope: context.scope, kind: input.kind,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.after === undefined ? {} : { after: input.after }), limit: input.limit });
  }

  public async targetStatus(targetId: string): Promise<KnowledgeTargetStatus> {
    const requestId = this.ids.next('knowledge-status');
    const context = await this.options.targets.resolveForTarget({ targetId, requestId });
    if (context.scope.targetId !== targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    const [capabilities, policy, binding] = await Promise.all([
      this.options.capabilities.getForTarget(targetId),
      this.options.policies.get(targetId),
      this.options.publications.inspectBinding(targetId),
    ]);
    const scopeMatches = binding.scopeKey === null || binding.scopeKey === checkpointChecksum(context.scope);
    const publication = scopeMatches ? binding.publication : null;
    return {
      targetId,
      capabilities,
      requiredKnowledge: (policy?.requirements ?? []).filter(item => item.requiredness === 'required')
        .map(item => ({ id: item.id, version: item.version,
          ...(item.knowledgeClass === undefined ? {} : { knowledgeClass: item.knowledgeClass }) })),
      publicationVersion: publication?.publicationVersion ?? 0,
      publicationState: !scopeMatches ? 'scope_changed' : publication === null ? 'empty' : 'active',
      references: publication?.references.map(reference => structuredClone(reference)) ?? [],
    };
  }

  public createSemanticDraft(targetId: string, input: Omit<CreateSemanticDraftRequest, 'targetId'>) {
    return this.options.semantic.createDraft({ ...input, targetId });
  }

  public reviseSemanticDraft(targetId: string, input: Omit<ReviseSemanticDraftRequest, 'targetId'>) {
    return this.options.semantic.reviseDraft({ ...input, targetId });
  }

  public createProceduralDraft(targetId: string, input: Omit<CreateProceduralTemplateDraftRequest, 'targetId'>) {
    return this.options.procedural.createDraft({ ...input, targetId });
  }

  public reviseProceduralDraft(targetId: string, input: Omit<ReviseProceduralTemplateDraftRequest, 'targetId'>) {
    return this.options.procedural.reviseDraft({ ...input, targetId });
  }

  public submitForReview(targetId: string, kind: KnowledgeKind, input: Omit<SubmitSemanticReviewRequest, 'targetId'>) {
    return kind === 'semantic'
      ? this.options.semantic.submitForReview({ ...input, targetId })
      : this.options.procedural.submitForReview({ ...input, targetId });
  }

  public review(targetId: string, kind: KnowledgeKind, input: Omit<ReviewSemanticKnowledgeRequest, 'targetId'>) {
    return kind === 'semantic'
      ? this.options.semantic.review({ ...input, targetId })
      : this.options.procedural.review({ ...input, targetId });
  }

  public async revoke(targetId: string, kind: KnowledgeKind, input: {
    requestId: string; knowledgeId: string; contentRevision: number; expectedGovernanceVersion: number;
  }): Promise<KnowledgeRevision> {
    if (kind === 'procedural') {
      const request: RevokeProceduralTemplateRequest = { ...input, targetId };
      return this.options.procedural.revoke(request);
    }
    const context = await this.options.targets.resolveForTarget({ targetId, requestId: input.requestId });
    if (context.scope.targetId !== targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    const current = await this.options.revisions.inspectExact({ id: input.knowledgeId,
      contentRevision: input.contentRevision, scope: context.scope, now: this.clock.now().toISOString() });
    if (current === null || current.kind !== 'semantic') throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
    return this.options.revisions.transitionKnowledge({ requestId: input.requestId, actorId: context.actorId,
      knowledgeId: input.knowledgeId, kind, contentRevision: input.contentRevision,
      expectedGovernanceVersion: input.expectedGovernanceVersion, nextStatus: 'revoked',
      occurredAt: this.clock.now().toISOString() });
  }

  public publish(targetId: string, input: { requestId: string; expectedPublicationVersion: number;
    references: readonly TargetKnowledgeReference[] }) {
    return this.options.publicationService.publish({ ...input, targetId });
  }

  /** Operator revokes a knowledge source; scope, actor, data domain and digest are all host-resolved. */
  public async revokeSource(targetId: string, input: { requestId: string; sourceId: string; sourceVersion: string;
    expectedSourceEpoch: number }): Promise<KnowledgeSourceState> {
    const context = await this.options.targets.resolveForTarget({ targetId, requestId: input.requestId });
    if (context.scope.targetId !== targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    const source = await this.options.sourceGovernance.resolve({
      targetId, sourceId: input.sourceId, sourceVersion: input.sourceVersion });
    return this.options.revisions.transitionSource({
      requestId: input.requestId, actorId: context.actorId, sourceId: input.sourceId,
      dataDomainId: source.dataDomainId, expectedSourceEpoch: input.expectedSourceEpoch,
      transition: 'revoked', sourceDigest: source.sourceDigest, occurredAt: this.clock.now().toISOString(),
    });
  }

  /** Operator overwrites the host knowledge policy; required entries must reference published knowledge. */
  public async updatePolicy(targetId: string, input: { requestId: string; policyVersion: string;
    expectedPolicyEpoch: number | null; requirements: readonly TargetKnowledgeRequirement[] }): Promise<TargetKnowledgePolicy> {
    const context = await this.options.targets.resolveForTarget({ targetId, requestId: input.requestId });
    if (context.scope.targetId !== targetId) throw new KnowledgeContractError('KNOWLEDGE_SCOPE_INVALID');
    const binding = await this.options.publications.inspectBinding(targetId);
    const published = binding.publication?.references ?? [];
    for (const requirement of input.requirements) {
      const matches = published.some(reference => reference.id === requirement.id
        && reference.version === requirement.version && reference.digest === requirement.digest);
      if (!matches) throw new KnowledgeContractError('KNOWLEDGE_NOT_FOUND');
      if (requirement.requiredness === 'required' && requirement.knowledgeClass === undefined) {
        throw new KnowledgeContractError('KNOWLEDGE_REQUIRED_DISABLED');
      }
    }
    try {
      return await this.options.policies.compareAndSet({
        targetId, policyVersion: input.policyVersion, requirements: input.requirements,
        expectedPolicyEpoch: input.expectedPolicyEpoch, publishedAt: this.clock.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof TargetConfigurationError) {
        throw new KnowledgeContractError(error.code === 'TARGET_IDENTITY_CONFLICT'
          ? 'KNOWLEDGE_PUBLICATION_CONFLICT' : 'KNOWLEDGE_RECORD_INVALID');
      }
      throw error;
    }
  }
}
