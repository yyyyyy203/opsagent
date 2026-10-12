import { describe, expect, it } from 'vitest';
import { parseKnowledgeGovernanceAuditV1 } from '../src/contracts/knowledge-governance-audit.js';

const timestamp = '2026-10-12T10:00:00.000Z';

function captureError(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  return undefined;
}

describe('KnowledgeGovernanceAuditV1 contract', () => {
  it('preserves a real review transition without inventing a source Run', () => {
    const event = parseKnowledgeGovernanceAuditV1({
      schemaVersion: 1,
      auditId: 'audit-review-1',
      requestId: 'review-1',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'knowledge_transition',
      knowledgeId: 'settlement-glossary',
      knowledgeKind: 'semantic',
      contentRevision: 2,
      governanceVersion: 4,
      beforeStatus: 'review_pending',
      afterStatus: 'approved',
      targetId: 'market-a-sim',
      scopeDigest: 'a'.repeat(64),
      sourceEpoch: 3,
      contentDigest: 'b'.repeat(64),
    });

    expect(event).toMatchObject({ type: 'knowledge_transition', beforeStatus: 'review_pending', afterStatus: 'approved' });
    expect(event).not.toHaveProperty('sourceRunId');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Reflect.set(event, 'afterStatus', 'rejected')).toBe(false);
  });

  it('represents source revocation without fabricating a knowledge identity', () => {
    const event = parseKnowledgeGovernanceAuditV1({
      schemaVersion: 1,
      auditId: 'audit-source-1',
      requestId: 'source-revoke-1',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'source_transition',
      sourceId: 'runbook:settlement',
      dataDomainId: 'market-a',
      beforeSourceEpoch: 3,
      afterSourceEpoch: 4,
      validity: 'revoked',
      reasonCode: 'SOURCE_WITHDRAWN',
    });

    expect(event).toMatchObject({ type: 'source_transition', afterSourceEpoch: 4, validity: 'revoked' });
    expect(event).not.toHaveProperty('knowledgeId');
  });

  it('represents Target binding publication independently from content approval', () => {
    const event = parseKnowledgeGovernanceAuditV1({
      schemaVersion: 1,
      auditId: 'audit-publication-1',
      requestId: 'publish-1',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'binding_publication',
      targetId: 'market-a-sim',
      scopeDigest: 'a'.repeat(64),
      beforePublicationVersion: 7,
      afterPublicationVersion: 8,
      policyVersion: 'knowledge-policy/v2',
      referenceDigest: 'c'.repeat(64),
    });

    expect(event).toMatchObject({ type: 'binding_publication', beforePublicationVersion: 7, afterPublicationVersion: 8 });
  });

  it('rejects old MEMORY_UPDATE-only Run identifiers and unknown fields', () => {
    const withoutRun = {
      schemaVersion: 1,
      auditId: 'audit-source-1',
      requestId: 'source-revoke-1',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'source_transition',
      sourceId: 'runbook:settlement',
      dataDomainId: 'market-a',
      beforeSourceEpoch: 3,
      afterSourceEpoch: 4,
      validity: 'revoked',
      reasonCode: 'SOURCE_WITHDRAWN',
    };

    expect(captureError(() => parseKnowledgeGovernanceAuditV1({ ...withoutRun, sourceRunId: 'invented-run' })))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
    expect(captureError(() => parseKnowledgeGovernanceAuditV1({ ...withoutRun, unexpected: true })))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
  });

  it('rejects illegal status transitions', () => {
    const approved = {
      schemaVersion: 1,
      auditId: 'audit-review-1',
      requestId: 'review-2',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'knowledge_transition',
      knowledgeId: 'settlement-glossary',
      knowledgeKind: 'semantic',
      contentRevision: 2,
      governanceVersion: 4,
      beforeStatus: 'revoked',
      afterStatus: 'approved',
      targetId: 'market-a-sim',
      scopeDigest: 'a'.repeat(64),
      sourceEpoch: 3,
      contentDigest: 'b'.repeat(64),
    };

    expect(captureError(() => parseKnowledgeGovernanceAuditV1(approved)))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
  });

  it('rejects contradictory source validity and revocation reason pairs', () => {
    const event = {
      schemaVersion: 1,
      auditId: 'audit-source-contradictory',
      requestId: 'source-revalidate-1',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'source_transition',
      sourceId: 'runbook:settlement',
      dataDomainId: 'market-a',
      beforeSourceEpoch: 3,
      afterSourceEpoch: 4,
      validity: 'revoked',
      reasonCode: 'SOURCE_REVALIDATED',
    };

    expect(captureError(() => parseKnowledgeGovernanceAuditV1(event)))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
  });

  it('rejects network addresses and credential-like audit identifiers', () => {
    const event = {
      schemaVersion: 1,
      auditId: 'audit-source-sensitive',
      requestId: 'source-revoke-sensitive',
      commandDigest: 'd'.repeat(64),
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'source_transition',
      sourceId: 'prometheus.internal:9090',
      dataDomainId: 'market-a',
      beforeSourceEpoch: 3,
      afterSourceEpoch: 4,
      validity: 'revoked',
      reasonCode: 'SOURCE_WITHDRAWN',
    };
    expect(captureError(() => parseKnowledgeGovernanceAuditV1(event)))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
    expect(captureError(() => parseKnowledgeGovernanceAuditV1({
      ...event, sourceId: 'prometheus:9090',
    }))).toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
    expect(captureError(() => parseKnowledgeGovernanceAuditV1({
      ...event, sourceId: 'runbook:settlement', actorId: 'Bearer abcdefghijklmnopqrstuvwx',
    }))).toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
  });

  it('requires an idempotency key and command digest on every governance audit event', () => {
    const event = {
      schemaVersion: 1,
      auditId: 'audit-source-idempotency',
      occurredAt: timestamp,
      actorId: 'local-operator',
      type: 'source_transition',
      sourceId: 'runbook:settlement',
      dataDomainId: 'market-a',
      beforeSourceEpoch: 3,
      afterSourceEpoch: 4,
      validity: 'revoked',
      reasonCode: 'SOURCE_WITHDRAWN',
    };

    expect(captureError(() => parseKnowledgeGovernanceAuditV1(event)))
      .toMatchObject({ code: 'KNOWLEDGE_AUDIT_INVALID' });
  });
});
