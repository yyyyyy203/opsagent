import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_GOVERNANCE_ERROR_CODES,
  isKnowledgeTransitionAllowed,
} from '../src/contracts/knowledge-memory.js';
import type { TargetKnowledgePublishCommand } from '../src/contracts/knowledge-memory.js';
import type { KnowledgeGovernanceAuditV1 } from '../src/contracts/knowledge-governance-audit.js';
import { contentRevisionFromTargetReference, parseKnowledgeReviewCommand, targetKnowledgeReferenceFor } from '../src/contracts/knowledge-memory-schema.js';

function captureError(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  return undefined;
}

describe('governed knowledge contracts', () => {
  it('requires request IDs and command digests for idempotent publication and audit contracts', () => {
    type RequiredProperty<T, K extends keyof T> = Pick<T, K> extends Required<Pick<T, K>> ? true : false;
    const requiredFields: [
      RequiredProperty<TargetKnowledgePublishCommand, 'requestId'>,
      RequiredProperty<TargetKnowledgePublishCommand, 'expectedPublicationVersion'>,
      RequiredProperty<KnowledgeGovernanceAuditV1, 'requestId'>,
      RequiredProperty<KnowledgeGovernanceAuditV1, 'commandDigest'>,
    ] = [true, true, true, true];

    expect(requiredFields).toEqual([true, true, true, true]);
  });

  it('keeps terminal governance states from being re-approved in place', () => {
    expect(isKnowledgeTransitionAllowed('approved', 'revoked')).toBe(true);
    expect(isKnowledgeTransitionAllowed('approved', 'superseded')).toBe(true);
    expect(isKnowledgeTransitionAllowed('revoked', 'approved')).toBe(false);
    expect(isKnowledgeTransitionAllowed('rejected', 'approved')).toBe(false);
  });

  it('requires content and governance versions for an idempotent review CAS', () => {
    const valid = {
      schemaVersion: 1,
      requestId: 'review-1',
      knowledgeId: 'settlement-glossary',
      kind: 'semantic',
      expectedContentRevision: 2,
      expectedGovernanceVersion: 4,
      contentDigest: 'a'.repeat(64),
      decision: 'approve',
      checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
    };

    expect(parseKnowledgeReviewCommand(valid)).toMatchObject({
      expectedContentRevision: 2,
      expectedGovernanceVersion: 4,
      requestId: 'review-1',
    });
    expect(captureError(() => parseKnowledgeReviewCommand({ ...valid, expectedGovernanceVersion: undefined })))
      .toMatchObject({ code: 'KNOWLEDGE_REVIEW_COMMAND_INVALID' });
  });

  it('does not accept caller-supplied reviewer, scope, or source epoch in a review command', () => {
    const valid = {
      schemaVersion: 1,
      requestId: 'review-1',
      knowledgeId: 'settlement-glossary',
      kind: 'semantic',
      expectedContentRevision: 2,
      expectedGovernanceVersion: 4,
      contentDigest: 'a'.repeat(64),
      decision: 'approve',
      checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
    };

    expect(captureError(() => parseKnowledgeReviewCommand({ ...valid, reviewerId: 'forged-operator' })))
      .toMatchObject({ code: 'KNOWLEDGE_REVIEW_COMMAND_INVALID' });
    expect(captureError(() => parseKnowledgeReviewCommand({ ...valid, sourceEpoch: 99 })))
      .toMatchObject({ code: 'KNOWLEDGE_REVIEW_COMMAND_INVALID' });
  });

  it('maps the Target reference version to the content revision, never the governance version', () => {
    const approvedRevision = {
      id: 'settlement-glossary',
      contentRevision: 2,
      governanceVersion: 19,
      contentDigest: 'a'.repeat(64),
      status: 'approved',
    } as const;
    const ref = targetKnowledgeReferenceFor(approvedRevision);

    expect(ref).toEqual({
      id: 'settlement-glossary',
      version: '2',
      digest: 'a'.repeat(64),
      approval: 'approved',
    });
    expect(contentRevisionFromTargetReference(ref)).toBe(2);
  });

  it('publishes a fixed set of governance error codes', () => {
    expect(KNOWLEDGE_GOVERNANCE_ERROR_CODES).toEqual(expect.arrayContaining([
      'KNOWLEDGE_RECORD_INVALID',
      'KNOWLEDGE_SCOPE_INVALID',
      'KNOWLEDGE_DIGEST_MISMATCH',
      'KNOWLEDGE_GOVERNANCE_CONFLICT',
      'KNOWLEDGE_PUBLICATION_CONFLICT',
    ]));
  });
});
