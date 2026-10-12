import { describe, expect, it } from 'vitest';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import type { KnowledgeScope, SemanticKnowledgeRevision } from '../src/contracts/knowledge-memory.js';
import type { TargetKnowledgePolicy } from '../src/contracts/target.js';
import { targetKnowledgeReferenceFor } from '../src/contracts/knowledge-memory-schema.js';
import { InMemoryGovernedKnowledgeStore } from '../src/memory/in-memory-knowledge-store.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const scope: KnowledgeScope = {
  targetId: 'target-one', projectId: 'project-one', deploymentId: 'deploy-one', deploymentGeneration: 1,
  targetFingerprint: 'fingerprint-one', profileId: 'profile-one', profileRevision: 'profile-rev-1',
  scenarioId: 'settlement-failure', scenarioVersion: '1', serviceIds: ['settlement-service'],
  faultTypes: ['high-failure-rate'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-one',
};
const authority = {
  resolveFor: async () => ({
    actorId: 'reviewer-one', scope, sourceEpoch: 0, sourceDigest: digestA, reviewedAt: '2026-10-12T00:00:00.000Z',
  }),
};

function makeRevision(input: { id: string; contentRevision?: number; scope?: KnowledgeScope; validUntil?: string }): SemanticKnowledgeRevision {
  const content = {
    type: 'domain_glossary' as const,
    terms: [{
      term: `settlement-${input.id}`,
      definition: 'Settlement records describe a completed business settlement.',
      sourceReference: { sourceId: 'profile-source', sourceVersion: 'source-v1', digest: digestA },
    }],
  };
  return {
    schemaVersion: 1, id: input.id, kind: 'semantic', contentRevision: input.contentRevision ?? 1,
    governanceVersion: 1, sourceEpoch: 0, status: 'draft', createdAt: '2026-10-10T00:00:00.000Z',
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }), scope: input.scope ?? scope,
    provenance: {
      sourceType: 'operator_provided', sourceId: 'profile-source', sourceVersion: 'source-v1',
      sourceDigest: digestA, importedAt: '2026-10-10T00:00:00.000Z',
    },
    contentDigest: checkpointChecksum(content), content,
  };
}

function makeStore(clock: { now: () => Date } = { now: () => new Date('2026-10-12T00:00:00.000Z') }) {
  let next = 0;
  const store = new InMemoryGovernedKnowledgeStore({
    authority,
    publicationActors: { resolveForTarget: async () => ({ actorId: 'publisher-one' }) },
    clock,
    ids: { next: (prefix) => `${prefix}-${++next}` },
  });
  return store;
}

async function approve(store: InMemoryGovernedKnowledgeStore, revision: SemanticKnowledgeRevision, requestPrefix = revision.id) {
  await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digestA, registeredAt: '2026-10-10T00:00:00.000Z' });
  await store.saveDraft({
    requestId: `${requestPrefix}-draft`, actorId: 'operator-one', naturalKey: 'settlement-glossary', sourceDomainId: 'domain-one',
    expectedContentRevision: null, expectedGovernanceVersion: null, revision,
  });
  await store.submitForReview({
    requestId: `${requestPrefix}-submit`, actorId: 'operator-one', knowledgeId: revision.id,
    kind: revision.kind, expectedContentRevision: revision.contentRevision, expectedGovernanceVersion: 1,
  });
  return store.review({
    schemaVersion: 1, requestId: `${requestPrefix}-review`, knowledgeId: revision.id, kind: revision.kind,
    expectedContentRevision: revision.contentRevision, expectedGovernanceVersion: 2,
    contentDigest: revision.contentDigest, decision: 'approve',
    checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
  });
}

describe('governed knowledge storage', () => {
  it('requires current registered provenance and persists immutable draft, submission, and review transitions', async () => {
    const store = makeStore();
    const draft = makeRevision({ id: 'semantic-one' });
    await expect(store.saveDraft({
      requestId: 'draft-before-source', actorId: 'operator-one', naturalKey: 'settlement-glossary', sourceDomainId: 'domain-one',
      expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft,
    })).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });

    const approved = await approve(store, draft);
    expect(approved).toMatchObject({ status: 'approved', governanceVersion: 3, contentRevision: 1, id: 'semantic-one' });
    expect(approved.review).toMatchObject({ reviewerId: 'reviewer-one', sourceVerification: { sourceEpoch: 0, sourceDigest: digestA } });
    expect((await store.getExact({ id: approved.id, contentRevision: 1, scope }))?.status).toBe('approved');
    expect((await store.list({ limit: 20 })).map((event) => event.type)).toEqual([
      'knowledge_transition', 'knowledge_transition', 'knowledge_transition',
    ]);
  });

  it('uses both expected versions and idempotent request receipts without replaying a state transition', async () => {
    const store = makeStore();
    const draft = makeRevision({ id: 'semantic-cas' });
    const approved = await approve(store, draft, 'cas');
    const command = {
      schemaVersion: 1 as const, requestId: 'cas-review', knowledgeId: draft.id, kind: 'semantic' as const,
      expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
    };
    expect(await store.review(command)).toEqual(approved);
    expect((await store.list({ limit: 20 })).length).toBe(3);
    await expect(store.review({ ...command, contentDigest: digestB })).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });

    await expect(store.submitForReview({
      requestId: 'stale-submit', actorId: 'operator-one', knowledgeId: draft.id, kind: 'semantic',
      expectedContentRevision: 1, expectedGovernanceVersion: 1,
    })).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
  });

  it('replays an approval receipt as the current revoked state without adding a second audit', async () => {
    const store = makeStore();
    const draft = makeRevision({ id: 'semantic-replay-revoked' });
    await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digestA,
      registeredAt: '2026-10-10T00:00:00.000Z' });
    await store.saveDraft({ requestId: 'replay-draft', actorId: 'operator-one', naturalKey: 'replay-glossary',
      sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft });
    await store.submitForReview({ requestId: 'replay-submit', actorId: 'operator-one', knowledgeId: draft.id,
      kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 1 });
    const approval = { schemaVersion: 1 as const, requestId: 'replay-approval', knowledgeId: draft.id, kind: draft.kind,
      expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
    const approved = await store.review(approval);
    const revoked = await store.transitionKnowledge({ requestId: 'replay-revoke', actorId: 'operator-one', knowledgeId: draft.id,
      kind: draft.kind, contentRevision: 1, expectedGovernanceVersion: approved.governanceVersion,
      nextStatus: 'revoked', occurredAt: '2026-10-12T00:00:00.000Z' });
    const auditCount = (await store.list({ limit: 20 })).length;

    await expect(store.review(approval)).resolves.toMatchObject({ status: 'revoked', governanceVersion: revoked.governanceVersion });
    expect((await store.list({ limit: 20 })).length).toBe(auditCount);
  });

  it('does not replay an approval as usable after its source is revoked', async () => {
    const store = makeStore();
    const draft = makeRevision({ id: 'semantic-replay-source-revoked' });
    const approved = await approve(store, draft, 'replay-source');
    const approval = { schemaVersion: 1 as const, requestId: 'replay-source-review', knowledgeId: draft.id,
      kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
    await store.transitionSource({ requestId: 'replay-source-withdraw', actorId: 'operator-one', sourceId: 'profile-source',
      dataDomainId: 'domain-one', expectedSourceEpoch: approved.sourceEpoch, transition: 'revoked', sourceDigest: digestA,
      occurredAt: '2000-01-01T00:00:00.000Z' });
    const audits = await store.list({ limit: 20 });
    const sourceAudit = audits.find((event) => event.requestId === 'replay-source-withdraw');

    expect(sourceAudit?.occurredAt).toBe('2026-10-12T00:00:00.000Z');
    await expect(store.review(approval)).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
    expect((await store.list({ limit: 20 })).length).toBe(audits.length);
  });

  it('does not replay an approval after its validity expires', async () => {
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    const store = makeStore({ now: () => new Date(currentTime) });
    const draft = makeRevision({ id: 'semantic-replay-expired', validUntil: '2026-10-12T02:30:00+02:00' });
    const approved = await approve(store, draft, 'replay-expired');
    const approval = { schemaVersion: 1 as const, requestId: 'replay-expired-review', knowledgeId: draft.id,
      kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
    const auditCount = (await store.list({ limit: 20 })).length;
    currentTime = new Date('2026-10-12T00:45:00.000Z');

    await expect(store.review(approval)).rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
    expect((await store.getExact({ id: approved.id, contentRevision: 1, scope }))).toBeNull();
    expect((await store.list({ limit: 20 })).length).toBe(auditCount);
  });

  it('rejects first approval when the injected clock is past validUntil despite a stale authority timestamp', async () => {
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    const store = makeStore({ now: () => new Date(currentTime) });
    const draft = makeRevision({ id: 'semantic-approval-expired', validUntil: '2026-10-12T00:30:00.000Z' });
    await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digestA,
      registeredAt: '2026-10-10T00:00:00.000Z' });
    await store.saveDraft({ requestId: 'approval-expired-draft', actorId: 'operator-one', naturalKey: 'approval-expired',
      sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft });
    await store.submitForReview({ requestId: 'approval-expired-submit', actorId: 'operator-one', knowledgeId: draft.id,
      kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 1 });
    const auditCount = (await store.list({ limit: 20 })).length;
    currentTime = new Date('2026-10-12T00:45:00.000Z');

    await expect(store.review({ schemaVersion: 1, requestId: 'approval-expired-review', knowledgeId: draft.id,
      kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
    expect(await store.inspectExact({ id: draft.id, contentRevision: 1, scope, now: currentTime.toISOString() }))
      .toMatchObject({ status: 'review_pending', governanceVersion: 2 });
    expect((await store.list({ limit: 20 })).length).toBe(auditCount);
  });

  it('keeps earlier content revisions immutable while creating a separately governed draft revision', async () => {
    const store = makeStore();
    const first = await approve(store, makeRevision({ id: 'semantic-revisions', contentRevision: 1 }), 'revision-one');
    const secondDraft = makeRevision({ id: first.id, contentRevision: 2 });
    const second = await store.saveDraft({
      requestId: 'revision-two-draft', actorId: 'operator-one', naturalKey: 'settlement-glossary', sourceDomainId: 'domain-one',
      expectedContentRevision: 1, expectedGovernanceVersion: first.governanceVersion, revision: secondDraft,
    });
    expect(second).toMatchObject({ id: first.id, contentRevision: 2, status: 'draft', governanceVersion: 1 });
    expect(await store.getExact({ id: first.id, contentRevision: 1, scope })).toEqual(first);
    expect(await store.getExact({ id: first.id, contentRevision: 2, scope })).toBeNull();
    expect(await store.inspectExact({ id: first.id, contentRevision: 2, scope, now: '2026-10-12T00:00:00.000Z' }))
      .toMatchObject({ status: 'draft', governanceVersion: 1 });
  });

  it('searches only exact approved references in the exact scope and drops stale source-index entries', async () => {
    const store = makeStore();
    const approved = await approve(store, makeRevision({ id: 'semantic-search' }), 'search');
    const reference = targetKnowledgeReferenceFor({
      id: approved.id, contentRevision: approved.contentRevision, contentDigest: approved.contentDigest, status: approved.status,
    });
    const base = { kind: 'semantic' as const, scope, references: [reference], query: 'settlement completed', limit: 5, now: '2026-10-12T00:00:00.000Z' };
    expect((await store.search(base)).map((item) => item.id)).toEqual([approved.id]);
    expect(await store.search({ ...base, references: [], query: 'settlement' })).toEqual([]);
    expect(await store.search({ ...base, scope: { ...scope, targetId: 'other-target' } })).toEqual([]);

    const sourceCommand = {
      requestId: 'source-revoke', actorId: 'operator-one', sourceId: 'profile-source', dataDomainId: 'domain-one',
      expectedSourceEpoch: 0, transition: 'revoked' as const, sourceDigest: digestA, occurredAt: '2026-10-12T00:00:00.000Z',
    };
    await store.transitionSource(sourceCommand);
    expect(await store.search(base)).toEqual([]);
    expect(await store.getExact({ id: approved.id, contentRevision: 1, scope })).toBeNull();
    expect(await store.inspectExact({ id: approved.id, contentRevision: 1, scope, now: '2026-10-12T00:00:00.000Z' }))
      .toMatchObject({ status: 'approved', sourceEpoch: 0, sourceValidity: 'revoked', sourceDigestMatches: true });
    const sourceAudit = (await store.listPending(20)).find((event) => event.requestId === sourceCommand.requestId);
    expect(sourceAudit?.commandDigest).toBe(checkpointChecksum({ operation: 'source_transition', command: sourceCommand }));
  });

  it('rejects review if source epoch changes after submission and does not revive old approvals', async () => {
    const store = makeStore();
    const draft = makeRevision({ id: 'semantic-source-race' });
    await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digestA, registeredAt: '2026-10-10T00:00:00.000Z' });
    await store.saveDraft({
      requestId: 'race-draft', actorId: 'operator-one', naturalKey: 'settlement-glossary', sourceDomainId: 'domain-one',
      expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft,
    });
    await store.submitForReview({
      requestId: 'race-submit', actorId: 'operator-one', knowledgeId: draft.id, kind: draft.kind,
      expectedContentRevision: 1, expectedGovernanceVersion: 1,
    });
    await store.transitionSource({
      requestId: 'race-revoke', actorId: 'operator-one', sourceId: 'profile-source', dataDomainId: 'domain-one',
      expectedSourceEpoch: 0, transition: 'revoked', sourceDigest: digestA, occurredAt: '2026-10-12T00:00:00.000Z',
    });
    await expect(store.review({
      schemaVersion: 1, requestId: 'race-review', knowledgeId: draft.id, kind: draft.kind,
      expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
      decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
    })).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
    expect(await store.search({
      kind: 'semantic', scope, references: [{ id: draft.id, version: '1', digest: draft.contentDigest, approval: 'approved' }],
      query: 'settlement', limit: 5, now: '2026-10-12T00:00:00.000Z',
    })).toEqual([]);
  });

  it('revokes an approved revision with governance-version CAS, audit, and immediate search exclusion', async () => {
    const store = makeStore();
    const approved = await approve(store, makeRevision({ id: 'semantic-revoke' }), 'revoke');
    const command = {
      requestId: 'revoke-approved', actorId: 'operator-one', knowledgeId: approved.id, kind: approved.kind,
      contentRevision: approved.contentRevision, expectedGovernanceVersion: approved.governanceVersion,
      nextStatus: 'revoked' as const, occurredAt: '2026-10-12T00:00:00.000Z',
    };
    const revoked = await store.transitionKnowledge(command);
    expect(revoked).toMatchObject({ status: 'revoked', governanceVersion: 4 });
    expect(await store.transitionKnowledge(command)).toEqual(revoked);
    expect((await store.list({ limit: 20 })).map((event) => event.type)).toHaveLength(4);
    expect(await store.search({
      kind: 'semantic', scope,
      references: [{ id: revoked.id, version: '1', digest: revoked.contentDigest, approval: 'approved' }],
      query: 'settlement', limit: 5, now: '2026-10-12T00:00:00.000Z',
    })).toEqual([]);
  });

  it('rolls back in-memory state when the independent audit append fails', async () => {
    const store = new InMemoryGovernedKnowledgeStore({
      authority,
      publicationActors: { resolveForTarget: async () => ({ actorId: 'publisher-one' }) },
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
      ids: { next: () => 'duplicate-audit-id' },
    });
    const draft = makeRevision({ id: 'memory-rollback' });
    await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digestA,
      registeredAt: '2026-10-10T00:00:00.000Z' });
    await store.saveDraft({ requestId: 'memory-rollback-draft', actorId: 'operator-one', naturalKey: 'settlement-glossary',
      sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft });
    await expect(store.submitForReview({ requestId: 'memory-rollback-submit', actorId: 'operator-one', knowledgeId: draft.id,
      kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 1 })).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
    expect(await store.inspectExact({ id: draft.id, contentRevision: 1, scope, now: '2026-10-12T00:00:00.000Z' }))
      .toMatchObject({ status: 'draft', governanceVersion: 1 });
    expect(await store.listPending(20)).toHaveLength(1);
  });

  it('never returns expired revisions from the FTS retrieval path', async () => {
    const store = makeStore();
    const approved = await approve(store, makeRevision({ id: 'semantic-expired', validUntil: '2026-10-13T00:00:00.000Z' }), 'expired');
    expect(await store.search({
      kind: 'semantic', scope,
      references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' }],
      query: 'settlement', limit: 5, now: '2026-10-14T00:00:00.000Z',
    })).toEqual([]);
  });

  it('uses exact token boundaries and parses offset timestamps when checking expiry', async () => {
    const store = makeStore();
    const approved = await approve(store, makeRevision({ id: 'semantic-token-expiry', validUntil: '2026-10-12T02:30:00+02:00' }), 'token-expiry');
    const base = { kind: 'semantic' as const, scope,
      references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
      limit: 5, now: '2026-10-12T00:15:00.000Z' };
    expect(await store.search({ ...base, query: 'settle' })).toEqual([]);
    expect((await store.search({ ...base, query: 'settlement' })).map((revision) => revision.id)).toEqual([approved.id]);
    expect(await store.search({ ...base, query: 'settlement', now: '2026-10-12T00:45:00.000Z' })).toEqual([]);
  });

  it('uses the injected clock for the publication audit and refuses backdated eligibility', async () => {
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    const store = makeStore({ now: () => new Date(currentTime) });
    const approved = await approve(store, makeRevision({ id: 'semantic-publication-clock', validUntil: '2026-10-12T02:30:00+02:00' }), 'publication-clock');
    const policy: TargetKnowledgePolicy = { schemaVersion: 1, targetId: scope.targetId, policyVersion: 'policy-v1',
      policyEpoch: 1, defaultRequiredness: 'optional', requirements: [] };
    const command = { requestId: 'publish-clock', targetId: scope.targetId, scope,
      references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
      policy, expectedPublicationVersion: 0, publishedAt: '2000-01-01T00:00:00.000Z' };
    const publication = await store.publish(command);
    expect((await store.list({ limit: 20 })).find((event) => event.requestId === command.requestId)?.occurredAt)
      .toBe('2026-10-12T00:00:00.000Z');
    currentTime = new Date('2026-10-12T00:45:00.000Z');

    await expect(store.publish({ ...command, requestId: 'publish-clock-expired', expectedPublicationVersion: 1 }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
    expect(await store.get(scope.targetId)).toEqual(publication);
    expect((await store.list({ limit: 20 })).some((event) => event.requestId === 'publish-clock-expired')).toBe(false);
  });
});
