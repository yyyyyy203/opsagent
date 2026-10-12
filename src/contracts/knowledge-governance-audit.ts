import { z } from 'zod';
import { isKnowledgeTransitionAllowed, KnowledgeContractError, type KnowledgeStatus } from './knowledge-memory.js';
import { safeKnowledgeIdentifierSchema } from './knowledge-memory-schema.js';

const identifier = safeKnowledgeIdentifierSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().max(64).datetime({ offset: true });
const positiveVersion = z.number().int().positive().safe();
const epoch = z.number().int().nonnegative().safe();
const reasonCode = z.enum(['SOURCE_WITHDRAWN', 'SOURCE_DIGEST_MISMATCH', 'SOURCE_PERMISSION_REVOKED', 'SOURCE_REVALIDATED']);
const sourceReasonByValidity = {
  revoked: 'SOURCE_WITHDRAWN',
  digest_mismatch: 'SOURCE_DIGEST_MISMATCH',
  permission_revoked: 'SOURCE_PERMISSION_REVOKED',
  revalidated: 'SOURCE_REVALIDATED',
} as const;

/** Audit envelope links one host command to its canonical digest for safe idempotent replay. */
const auditBaseSchema = z.object({
  schemaVersion: z.literal(1),
  auditId: identifier,
  requestId: identifier,
  commandDigest: digest,
  occurredAt: timestamp,
  actorId: identifier,
});

const knowledgeTransitionSchema = auditBaseSchema.extend({
  type: z.literal('knowledge_transition'),
  knowledgeId: identifier,
  knowledgeKind: z.enum(['semantic', 'procedural']),
  contentRevision: positiveVersion,
  governanceVersion: positiveVersion,
  beforeStatus: z.enum(['draft', 'review_pending', 'approved', 'rejected', 'revoked', 'expired', 'conflict', 'superseded']).optional(),
  afterStatus: z.enum(['draft', 'review_pending', 'approved', 'rejected', 'revoked', 'expired', 'conflict', 'superseded']),
  targetId: identifier,
  scopeDigest: digest,
  sourceEpoch: epoch,
  contentDigest: digest,
}).strict().superRefine((value, ctx) => {
  if (value.beforeStatus === undefined) {
    if (value.afterStatus !== 'draft' || value.governanceVersion !== 1) {
      ctx.addIssue({ code: 'custom', path: ['afterStatus'], message: 'A new knowledge identity must begin at draft governance version 1.' });
    }
    return;
  }
  if (!isKnowledgeTransitionAllowed(value.beforeStatus, value.afterStatus)) {
    ctx.addIssue({ code: 'custom', path: ['afterStatus'], message: 'Knowledge governance transition is not allowed.' });
  }
});

const sourceTransitionSchema = auditBaseSchema.extend({
  type: z.literal('source_transition'),
  sourceId: identifier,
  dataDomainId: identifier,
  beforeSourceEpoch: epoch,
  afterSourceEpoch: positiveVersion,
  validity: z.enum(['revoked', 'digest_mismatch', 'permission_revoked', 'revalidated']),
  reasonCode,
}).strict().superRefine((value, ctx) => {
  if (value.afterSourceEpoch !== value.beforeSourceEpoch + 1) {
    ctx.addIssue({ code: 'custom', path: ['afterSourceEpoch'], message: 'Source epoch must advance exactly once per transition.' });
  }
  if (value.reasonCode !== sourceReasonByValidity[value.validity]) {
    ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Source transition reason must match its validity state.' });
  }
});

const bindingPublicationSchema = auditBaseSchema.extend({
  type: z.literal('binding_publication'),
  targetId: identifier,
  scopeDigest: digest,
  beforePublicationVersion: epoch,
  afterPublicationVersion: positiveVersion,
  policyVersion: identifier,
  referenceDigest: digest,
}).strict().superRefine((value, ctx) => {
  if (value.afterPublicationVersion !== value.beforePublicationVersion + 1) {
    ctx.addIssue({ code: 'custom', path: ['afterPublicationVersion'], message: 'Publication version must advance exactly once.' });
  }
});

export const knowledgeGovernanceAuditV1Schema = z.union([
  knowledgeTransitionSchema,
  sourceTransitionSchema,
  bindingPublicationSchema,
]);

export type KnowledgeGovernanceAuditV1 = Readonly<z.infer<typeof knowledgeGovernanceAuditV1Schema>>;
export type KnowledgeGovernanceAuditTransitionStatus = KnowledgeStatus;

export function parseKnowledgeGovernanceAuditV1(value: unknown): KnowledgeGovernanceAuditV1 {
  const parsed = knowledgeGovernanceAuditV1Schema.safeParse(value);
  if (!parsed.success) throw new KnowledgeContractError('KNOWLEDGE_AUDIT_INVALID');
  return Object.freeze(structuredClone(parsed.data));
}

export interface KnowledgeGovernanceAuditOutboxPort {
  /** Must be called inside the same storage transaction that changes knowledge/source/binding state. */
  appendWithinTransaction(event: KnowledgeGovernanceAuditV1): void;
  listPending(limit: number): Promise<readonly KnowledgeGovernanceAuditV1[]>;
  markDelivered(input: { auditId: string; deliveredAt: string }): Promise<void>;
}

export interface KnowledgeGovernanceAuditQueryPort {
  list(input: {
    targetId?: string;
    afterAuditId?: string;
    limit: number;
  }): Promise<readonly KnowledgeGovernanceAuditV1[]>;
}
