import type { KnowledgeGovernanceAuditV1, KnowledgeGovernanceAuditQueryPort, KnowledgeGovernanceAuditOutboxPort } from './knowledge-governance-audit.js';
import type {
  KnowledgeExactQuery, KnowledgeGovernanceReviewPort, KnowledgeQueryPort, KnowledgeReviewAuthorityPort,
  KnowledgeReviewCommand, KnowledgeRevision, KnowledgeKind, KnowledgeStatus,
  TargetKnowledgeBindingPublisher, TargetKnowledgePublication, TargetKnowledgePublishCommand,
} from './knowledge-memory.js';
import type { KnowledgeScope } from './knowledge-memory.js';
import type { TargetKnowledgeReference, TargetKnowledgePolicy } from './target.js';

export type KnowledgeSourceValidity = 'active' | 'revoked' | 'digest_mismatch' | 'permission_revoked';
export type KnowledgeSourceTransition = 'revoked' | 'digest_mismatch' | 'permission_revoked' | 'revalidated';

export interface KnowledgeSourceState {
  readonly sourceId: string;
  readonly dataDomainId: string;
  readonly sourceEpoch: number;
  readonly sourceDigest: string;
  readonly validity: KnowledgeSourceValidity;
  readonly updatedAt: string;
}

/** Registration is host-owned and accepts only a source already admitted by the source registry. */
export interface KnowledgeSourceRegistration {
  readonly sourceId: string;
  readonly dataDomainId: string;
  readonly sourceDigest: string;
  readonly registeredAt: string;
}

export interface KnowledgeSourceTransitionCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly sourceId: string;
  readonly dataDomainId: string;
  readonly expectedSourceEpoch: number;
  readonly transition: KnowledgeSourceTransition;
  readonly sourceDigest: string;
  readonly occurredAt: string;
}

export interface KnowledgeDraftWriteCommand {
  readonly requestId: string;
  /** Optional caller-stable intent digest; lets an orchestrator replay across generated ID/time changes. */
  readonly intentDigest?: string;
  readonly actorId: string;
  readonly naturalKey: string;
  readonly sourceDomainId: string;
  /** Both expected values are null for the first revision and required for a later revision. */
  readonly expectedContentRevision: number | null;
  readonly expectedGovernanceVersion: number | null;
  readonly revision: KnowledgeRevision;
}

export interface KnowledgeSubmissionCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly knowledgeId: string;
  readonly kind: KnowledgeKind;
  readonly expectedContentRevision: number;
  readonly expectedGovernanceVersion: number;
}

export interface KnowledgeGovernanceTransitionCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly knowledgeId: string;
  readonly kind: KnowledgeKind;
  readonly contentRevision: number;
  readonly expectedGovernanceVersion: number;
  readonly nextStatus: 'revoked' | 'expired' | 'conflict' | 'superseded';
  readonly occurredAt: string;
}

export interface KnowledgeDraftStore {
  registerSource(input: KnowledgeSourceRegistration): Promise<KnowledgeSourceState>;
  saveDraft(command: KnowledgeDraftWriteCommand, replayIntent?: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision>;
  submitForReview(command: KnowledgeSubmissionCommand): Promise<KnowledgeRevision>;
}

/** Host-computed stable command identity. Execution preconditions are not retry identity. */
export interface KnowledgeCommandReplayIntent {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly operation: 'draft' | 'review';
  readonly intentDigest: string;
  readonly scope: KnowledgeScope;
}

export interface KnowledgeCommandReplayPort {
  /** null means never applied; conflicting or unprovable legacy intent fails closed. */
  replayCommand(intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision | null>;
}

/** Opt-in adapter capability. Existing command ports remain source-compatible. */
export interface KnowledgeProceduralReplayCapability extends KnowledgeCommandReplayPort {
  saveDraftWithReplayIntent(command: KnowledgeDraftWriteCommand,
    intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision>;
  reviewWithReplayIntent(command: KnowledgeReviewCommand,
    intent: KnowledgeCommandReplayIntent): Promise<KnowledgeRevision>;
}

export interface KnowledgeGovernanceTransitionStore {
  transitionKnowledge(command: KnowledgeGovernanceTransitionCommand): Promise<KnowledgeRevision>;
}

export interface KnowledgeSourceGovernanceStore {
  getSource(input: { sourceId: string; dataDomainId: string }): Promise<KnowledgeSourceState | null>;
  transitionSource(command: KnowledgeSourceTransitionCommand): Promise<KnowledgeSourceState>;
}

export interface KnowledgeScopedSearchRequest {
  readonly kind: KnowledgeKind;
  readonly scope: KnowledgeScope;
  readonly references: readonly TargetKnowledgeReference[];
  readonly query: string;
  readonly limit: number;
  readonly now: string;
}

/** Search must treat the supplied references as an allowlist, never as a hint. */
export interface KnowledgeScopedSearchStore {
  search(input: KnowledgeScopedSearchRequest): Promise<readonly KnowledgeRevision[]>;
}

/** Read-only, host-scoped revision listing for governance UI; never accepts a caller-built scope. */
export interface KnowledgeScopedListRequest {
  readonly scope: KnowledgeScope;
  readonly kind: KnowledgeKind;
  readonly status?: KnowledgeStatus;
  readonly after?: { readonly id: string; readonly contentRevision: number };
  readonly limit: number;
}

export interface KnowledgeScopedListPort {
  listScopedRevisions(input: KnowledgeScopedListRequest): Promise<readonly KnowledgeRevision[]>;
}

export type KnowledgeSourceEpochQueryPort = Pick<KnowledgeQueryPort, 'getSourceEpoch'>;

export interface KnowledgePublicationActorPort {
  resolveForTarget(input: { targetId: string; requestId: string }): Promise<{ actorId: string }>;
}

/** Ephemeral host context. Never accepted from a publication request or persisted in a Run. */
export interface TargetKnowledgePublicationContext {
  readonly registryVersion: number;
  readonly scope: KnowledgeScope;
  readonly hostPolicy: TargetKnowledgePolicy | null;
}

export interface TargetKnowledgePublicationContextPort {
  resolvePublicationContext(input: { targetId: string; capturedAt: string; signal: AbortSignal }): Promise<TargetKnowledgePublicationContext>;
}

/** Synchronous authoritative fence reader for transaction-scoped test adapters. */
export interface KnowledgePublicationFencePort {
  inspectPublicationFence(targetId: string): { registryVersion: number; policy: TargetKnowledgePolicy | null };
}

export interface GovernedKnowledgePublicationCommand {
  readonly command: TargetKnowledgePublishCommand;
  readonly context: TargetKnowledgePublicationContext;
  readonly expectedRevisions: readonly {
    readonly reference: TargetKnowledgeReference;
    readonly governanceVersion: number;
    readonly sourceEpoch: number;
  }[];
}

/** Narrow composite operation: validate, publish, supersede, index, audit and outbox atomically. */
export interface GovernedKnowledgePublicationPort {
  publishGoverned(input: GovernedKnowledgePublicationCommand): Promise<TargetKnowledgePublication>;
}

export interface KnowledgePublicationVersionPort {
  getPublicationVersion(targetId: string): number;
}

/** Minimal public aggregate; implementations may expose each port independently. */
export interface GovernedKnowledgeStorage extends KnowledgeDraftStore, KnowledgeSourceGovernanceStore,
  KnowledgeScopedSearchStore, KnowledgeScopedListPort, KnowledgeGovernanceTransitionStore, KnowledgeQueryPort, KnowledgeGovernanceReviewPort,
  TargetKnowledgeBindingPublisher, KnowledgeGovernanceAuditOutboxPort, KnowledgeGovernanceAuditQueryPort {}

export interface KnowledgeRevisionStateSnapshot {
  readonly knowledgeId: string;
  readonly kind: KnowledgeKind;
  readonly contentRevision: number;
  readonly governanceVersion: number;
  /** Immutable payload digest; exposed to governance services without returning draft content. */
  readonly contentDigest: string;
  readonly status: KnowledgeStatus;
  /** Source epoch captured by the immutable revision. */
  readonly sourceEpoch: number;
  /** Current host source epoch at inspection time; null means the source is missing. */
  readonly currentSourceEpoch: number | null;
  readonly sourceValidity: KnowledgeSourceValidity | 'missing';
  readonly sourceDigestMatches: boolean;
  readonly validUntil?: string | undefined;
  readonly eligibleAt: string;
}

export interface KnowledgeRevisionStateQueryPort {
  inspectExact(input: KnowledgeExactQuery & { readonly now: string }): Promise<KnowledgeRevisionStateSnapshot | null>;
}

export interface KnowledgePublicationSnapshot {
  readonly publication: TargetKnowledgePublication | null;
  readonly scopeKey: string | null;
}

export interface KnowledgePublicationInspectionPort {
  inspectBinding(targetId: string): Promise<KnowledgePublicationSnapshot>;
  /** Formal adapters read the policy and overlay from one authoritative snapshot. */
  inspectPublishedSelection?(targetId: string): Promise<{
    binding: KnowledgePublicationSnapshot;
    hostPolicy: TargetKnowledgePolicy | null;
  }>;
}

/** Formal host storage used by the Target knowledge-management application assembly. */
export interface TargetKnowledgeRevisionStorage extends KnowledgeProceduralReplayCapability,
  KnowledgeDraftStore, KnowledgeSourceGovernanceStore, KnowledgeScopedSearchStore, KnowledgeScopedListPort,
  KnowledgeGovernanceTransitionStore, KnowledgeQueryPort, KnowledgeGovernanceReviewPort, KnowledgeRevisionStateQueryPort {}

/** Publication storage is a separate adapter so review approval cannot mutate the active Target binding. */
export interface TargetKnowledgePublicationStorage extends GovernedKnowledgePublicationPort,
  TargetKnowledgeBindingPublisher, KnowledgePublicationInspectionPort {}

export interface KnowledgeGovernanceAuditAttemptPort {
  /** Records delivery failure without removing the event from the pending outbox. */
  recordDeliveryFailure(auditId: string): Promise<void>;
}

export type { KnowledgeReviewAuthorityPort, KnowledgeReviewCommand, KnowledgeRevision, KnowledgeStatus, KnowledgeGovernanceAuditV1, TargetKnowledgePublishCommand };
