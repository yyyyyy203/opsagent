import type {
  TargetEnvironment, TargetKnowledgePolicy, TargetKnowledgeReference,
} from './target.js';

export const KNOWLEDGE_GOVERNANCE_ERROR_CODES = [
  'KNOWLEDGE_RECORD_INVALID',
  'KNOWLEDGE_SCOPE_INVALID',
  'KNOWLEDGE_REVIEW_COMMAND_INVALID',
  'KNOWLEDGE_QUALIFICATION_INVALID',
  'KNOWLEDGE_AUDIT_INVALID',
  'KNOWLEDGE_DIGEST_MISMATCH',
  'KNOWLEDGE_NOT_FOUND',
  'KNOWLEDGE_REVISION_CONFLICT',
  'KNOWLEDGE_GOVERNANCE_CONFLICT',
  'KNOWLEDGE_TRANSITION_INVALID',
  'KNOWLEDGE_SOURCE_REVOKED',
  'KNOWLEDGE_EXPIRED',
  'KNOWLEDGE_APPROVAL_DENIED',
  'KNOWLEDGE_PUBLICATION_CONFLICT',
  'KNOWLEDGE_REQUIRED_DISABLED',
  'KNOWLEDGE_STORAGE_UNAVAILABLE',
] as const;

export type KnowledgeGovernanceErrorCode = typeof KNOWLEDGE_GOVERNANCE_ERROR_CODES[number];
export type KnowledgeKind = 'semantic' | 'procedural';
export type KnowledgeStatus =
  | 'draft' | 'review_pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'conflict' | 'superseded';

export class KnowledgeContractError extends Error {
  public constructor(public readonly code: KnowledgeGovernanceErrorCode) {
    super(code);
    this.name = 'KnowledgeContractError';
  }
}

/** Complete host-derived Target scope. It is never accepted from model or browser input. */
export interface KnowledgeScopeBase {
  readonly targetId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly deploymentGeneration: number;
  readonly targetFingerprint: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly serviceIds: readonly string[];
  readonly faultTypes: readonly string[];
}

export type KnowledgeScope = KnowledgeScopeBase & (
  | { readonly environment: 'simulation' | 'development' | 'staging'; readonly dataClass: 'simulated'; readonly datasetId: string }
  | { readonly environment: 'development' | 'staging' | 'production'; readonly dataClass: 'live'; readonly datasetId?: never }
);

export interface KnowledgeSourceReference {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly digest: string;
}

export interface KnowledgeProvenance extends Omit<KnowledgeSourceReference, 'digest'> {
  readonly sourceType: 'target_profile' | 'controlled_runbook' | 'operator_provided';
  readonly sourceDigest: string;
  readonly importedAt: string;
}

export interface KnowledgeReviewRecord {
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly checks: {
    readonly sourceVerified: boolean;
    readonly scopeVerified: boolean;
    readonly contentReviewed: boolean;
  };
  readonly sourceVerification: {
    readonly sourceEpoch: number;
    readonly sourceDigest: string;
  };
}

export interface KnowledgeRevisionBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly contentRevision: number;
  readonly governanceVersion: number;
  readonly sourceEpoch: number;
  readonly status: KnowledgeStatus;
  readonly createdAt: string;
  readonly validUntil?: string | undefined;
  readonly scope: KnowledgeScope;
  readonly provenance: KnowledgeProvenance;
  readonly contentDigest: string;
  readonly review?: KnowledgeReviewRecord | undefined;
}

export type KnowledgeEvidenceSource = KnowledgeSourceReference;

export type SemanticKnowledgeContent =
  | {
      readonly type: 'service_topology';
      readonly effectiveFrom: string;
      readonly effectiveUntil?: string | undefined;
      readonly services: readonly { readonly serviceId: string; readonly displayName: string; readonly description?: string | undefined }[];
      readonly dependencies: readonly {
        readonly fromServiceId: string;
        readonly toServiceId: string;
        readonly relation: 'depends_on' | 'calls' | 'publishes_to' | 'reads_from' | 'writes_to';
      }[];
    }
  | {
      readonly type: 'metric_definition';
      readonly metricName: string;
      readonly businessMeaning: string;
      readonly unit: string;
      readonly labels: readonly { readonly name: string; readonly meaning: string }[];
      readonly allowedAggregations: readonly ('count' | 'sum' | 'avg' | 'min' | 'max' | 'rate' | 'increase' | 'last')[];
      readonly windowSemantics: readonly ('instant' | 'fixed_window' | 'rolling_window' | 'cumulative')[];
      readonly sourceReferences: readonly KnowledgeSourceReference[];
    }
  | {
      readonly type: 'domain_glossary';
      readonly terms: readonly {
        readonly term: string;
        readonly definition: string;
        readonly sourceReference: KnowledgeSourceReference;
      }[];
    };

export interface SemanticKnowledgeRevision extends KnowledgeRevisionBase {
  readonly kind: 'semantic';
  readonly content: SemanticKnowledgeContent;
}

export interface ProceduralKnowledgeContent {
  readonly type: 'investigation_template';
  readonly templateId: string;
  readonly scenario: { readonly id: string; readonly version: string };
  readonly applicableTo: {
    readonly serviceIds: readonly string[];
    readonly faultTypes: readonly string[];
    readonly environments: readonly TargetEnvironment[];
  };
  readonly preconditions: readonly string[];
  readonly requiredEvidence: readonly { readonly category: 'metric' | 'log' | 'trace' | 'change'; readonly minimumCount: number }[];
  readonly steps: readonly {
    readonly step: number;
    readonly goal: string;
    readonly capabilityId: string;
    readonly completionCriterion: string;
  }[];
  readonly stopConditions: readonly string[];
  readonly expectedReportFields: readonly string[];
  readonly limitations: readonly string[];
  readonly sourceReferences: readonly KnowledgeSourceReference[];
}

export interface ProceduralKnowledgeRevision extends KnowledgeRevisionBase {
  readonly kind: 'procedural';
  readonly content: ProceduralKnowledgeContent;
}

export type KnowledgeRevision = SemanticKnowledgeRevision | ProceduralKnowledgeRevision;

export interface KnowledgeReviewCommand {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly knowledgeId: string;
  readonly kind: KnowledgeKind;
  readonly expectedContentRevision: number;
  readonly expectedGovernanceVersion: number;
  readonly contentDigest: string;
  readonly decision: 'approve' | 'reject';
  readonly checks: KnowledgeReviewRecord['checks'];
  readonly reasonCode?: string | undefined;
}

/** Trusted review facts are supplied only by the host, never by command payloads. */
export interface KnowledgeReviewAuthority {
  actorId: string;
  scope: KnowledgeScope;
  sourceEpoch: number;
  sourceDigest: string;
  reviewedAt: string;
}

/** Resolves trusted review facts from the host's operator/session and current source state. */
export interface KnowledgeReviewAuthorityPort {
  resolveFor(input: { knowledgeId: string; kind: KnowledgeKind }): Promise<KnowledgeReviewAuthority>;
}

export interface KnowledgeGovernanceReviewPort {
  review(command: KnowledgeReviewCommand): Promise<KnowledgeRevision>;
}

export interface KnowledgeExactQuery {
  id: string;
  contentRevision: number;
  scope: KnowledgeScope;
}

export interface KnowledgeQueryPort {
  getExact(input: KnowledgeExactQuery): Promise<KnowledgeRevision | null>;
  getSourceEpoch(input: { sourceId: string; dataDomainId: string }): Promise<number | null>;
}

export interface TargetKnowledgePublication {
  targetId: string;
  publicationVersion: number;
  references: readonly TargetKnowledgeReference[];
  policy: TargetKnowledgePolicy;
  publishedAt: string;
}

export interface TargetKnowledgePublishCommand {
  /** Same ID + same canonical command digest replays the original result; a different digest is a conflict. */
  readonly requestId: string;
  readonly targetId: string;
  readonly scope: KnowledgeScope;
  readonly references: readonly TargetKnowledgeReference[];
  readonly policy: TargetKnowledgePolicy;
  readonly expectedPublicationVersion: number;
  readonly publishedAt: string;
}

/** Publishes only knowledge references and usage policy; never Target endpoints or diagnostic rules. */
export interface TargetKnowledgeBindingPublisher {
  get(targetId: string): Promise<TargetKnowledgePublication | null>;
  publish(command: TargetKnowledgePublishCommand): Promise<TargetKnowledgePublication>;
}

export type KnowledgeLimitationReason =
  | 'KNOWLEDGE_NOT_FOUND'
  | 'KNOWLEDGE_NOT_APPROVED'
  | 'KNOWLEDGE_REVOKED'
  | 'KNOWLEDGE_EXPIRED'
  | 'KNOWLEDGE_SUPERSEDED'
  | 'KNOWLEDGE_CONFLICT'
  | 'KNOWLEDGE_SCOPE_MISMATCH'
  | 'KNOWLEDGE_DIGEST_MISMATCH'
  | 'KNOWLEDGE_SOURCE_REVOKED'
  | 'KNOWLEDGE_TYPE_DISABLED'
  | 'KNOWLEDGE_STORAGE_UNAVAILABLE'
  | 'KNOWLEDGE_DEADLINE_EXCEEDED'
  | 'KNOWLEDGE_BUDGET_EXCEEDED'
  | 'KNOWLEDGE_REQUIRED_DISABLED'
  | 'OPTIONAL_KNOWLEDGE_OMITTED';

export interface MissingKnowledgeQualification {
  readonly reference: TargetKnowledgeReference;
  readonly kind: KnowledgeKind;
  readonly requiredness: 'optional' | 'required';
  readonly reasonCode: KnowledgeLimitationReason;
}

/** Knowledge qualification is separate from current evidence coverage and ToolResponse. */
export interface KnowledgeDiagnosisQualificationV1 {
  readonly schemaVersion: 1;
  readonly diagnosisReady: boolean;
  readonly missingKnowledge: readonly MissingKnowledgeQualification[];
  readonly limitationReasons: readonly KnowledgeLimitationReason[];
}

const allowedKnowledgeTransitions: Readonly<Record<KnowledgeStatus, readonly KnowledgeStatus[]>> = {
  draft: ['review_pending', 'conflict'],
  review_pending: ['approved', 'rejected', 'conflict'],
  approved: ['revoked', 'expired', 'conflict', 'superseded'],
  rejected: [],
  revoked: [],
  expired: [],
  conflict: [],
  superseded: [],
};

export function isKnowledgeTransitionAllowed(from: KnowledgeStatus, to: KnowledgeStatus): boolean {
  return allowedKnowledgeTransitions[from].includes(to);
}
