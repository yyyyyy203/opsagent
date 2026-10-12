import type { KnowledgeGovernanceAuditV1, KnowledgeGovernanceAuditQueryPort, KnowledgeGovernanceAuditOutboxPort } from './knowledge-governance-audit.js';
import type {
  KnowledgeExactQuery, KnowledgeGovernanceReviewPort, KnowledgeQueryPort, KnowledgeReviewAuthorityPort,
  KnowledgeReviewCommand, KnowledgeRevision, KnowledgeKind, KnowledgeStatus,
  TargetKnowledgeBindingPublisher, TargetKnowledgePublication, TargetKnowledgePublishCommand,
} from './knowledge-memory.js';
import type { KnowledgeScope } from './knowledge-memory.js';
import type { TargetKnowledgeReference } from './target.js';

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
  saveDraft(command: KnowledgeDraftWriteCommand): Promise<KnowledgeRevision>;
  submitForReview(command: KnowledgeSubmissionCommand): Promise<KnowledgeRevision>;
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

export type KnowledgeSourceEpochQueryPort = Pick<KnowledgeQueryPort, 'getSourceEpoch'>;

export interface KnowledgePublicationActorPort {
  resolveForTarget(input: { targetId: string; requestId: string }): Promise<{ actorId: string }>;
}

/** Minimal public aggregate; implementations may expose each port independently. */
export interface GovernedKnowledgeStorage extends KnowledgeDraftStore, KnowledgeSourceGovernanceStore,
  KnowledgeScopedSearchStore, KnowledgeGovernanceTransitionStore, KnowledgeQueryPort, KnowledgeGovernanceReviewPort,
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
}

export interface KnowledgeGovernanceAuditAttemptPort {
  /** Records delivery failure without removing the event from the pending outbox. */
  recordDeliveryFailure(auditId: string): Promise<void>;
}

export type { KnowledgeReviewAuthorityPort, KnowledgeReviewCommand, KnowledgeRevision, KnowledgeStatus, KnowledgeGovernanceAuditV1, TargetKnowledgePublishCommand };
