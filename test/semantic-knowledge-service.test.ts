import { describe, expect, it } from 'vitest';
import type { KnowledgeScope, SemanticKnowledgeContent } from '../src/contracts/knowledge-memory.js';
import { InMemoryGovernedKnowledgeStore } from '../src/memory/in-memory-knowledge-store.js';
import { SemanticKnowledgeService } from '../src/memory/semantic-knowledge-service.js';
import { SemanticSourceRegistry } from '../src/memory/semantic-source-registry.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore } from '../src/infrastructure/sqlite/knowledge-memory-store.js';

const digest = 'a'.repeat(64);
const sourceRef = { sourceId: 'settlement-runbook', sourceVersion: 'runbook/v1', digest };
const scopeA: KnowledgeScope = {
  targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
  targetFingerprint: 'market-a-lab', profileId: 'market-a-profile', profileRevision: 'profile/v1',
  scenarioId: 'settlement-failure', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
  faultTypes: ['settlement-failure'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a',
};
const scopeB: KnowledgeScope = { ...scopeA, targetId: 'market-b-sim', projectId: 'market-b', deploymentGeneration: 2,
  targetFingerprint: 'market-b-lab', profileId: 'market-b-profile', datasetId: 'dataset-b' };
const scopeC: KnowledgeScope = { ...scopeA, targetId: 'market-c-sim', projectId: 'market-c',
  targetFingerprint: 'market-c-lab', profileId: 'market-c-profile', datasetId: 'dataset-c' };

function metricContent(metricName = 'settlement_failures_total'): Extract<SemanticKnowledgeContent, { type: 'metric_definition' }> {
  return {
    type: 'metric_definition', metricName, businessMeaning: 'Failed settlement attempts.', unit: 'count',
    labels: [{ name: 'service', meaning: 'Owning service.' }], allowedAggregations: ['sum'],
    windowSemantics: ['fixed_window'], sourceReferences: [sourceRef],
  };
}

function setup(backend: 'memory' | 'sqlite' = 'memory') {
  let now = new Date('2026-10-12T00:00:00.000Z');
  let reviewerScope = scopeA;
  let id = 0;
  let beforeAuthorityReturn = async () => {};
  let beforeTargetReturn: (targetId: string) => Promise<void> = async () => {};
  const database = backend === 'sqlite' ? SqliteDatabase.open(':memory:') : undefined;
  const options = {
    authority: { resolveFor: async () => {
      const authority = { actorId: 'operator-reviewer', scope: reviewerScope, sourceEpoch: 0,
        sourceDigest: digest, reviewedAt: now.toISOString() };
      await beforeAuthorityReturn();
      return authority;
    } },
    publicationActors: { resolveForTarget: async () => ({ actorId: 'operator-publisher' }) },
    clock: { now: () => new Date(now) },
    ids: { next: (prefix: string) => `${prefix}-${++id}` },
  };
  const store = database === undefined ? new InMemoryGovernedKnowledgeStore(options)
    : new SqliteGovernedKnowledgeStore(database, options);
  const registry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [{
    sourceType: 'controlled_runbook', sourceId: sourceRef.sourceId, sourceVersion: sourceRef.sourceVersion,
    sourceDigest: sourceRef.digest, dataDomainId: 'settlement-knowledge-domain',
    allowedTargetIds: [scopeA.targetId, scopeB.targetId, scopeC.targetId],
  }] });
  const service = new SemanticKnowledgeService({
    sourceRegistry: registry,
    targets: { resolveForTarget: async ({ targetId }) => {
      await beforeTargetReturn(targetId);
      return { actorId: `operator-${targetId}`, scope: targetId === scopeA.targetId ? scopeA
        : targetId === scopeC.targetId ? scopeC : scopeB };
    } },
    drafts: store, sources: store, queries: store, reviews: store,
    reviewAttestations: { resolveForReview: async () => ({
      sourceVerified: true, scopeVerified: true, contentReviewed: true,
    }) },
    clock: { now: () => new Date(now) },
    ids: { next: prefix => `${prefix}-${++id}` },
  });
  return {
    store, service,
    setNow(value: string) { now = new Date(value); },
    setReviewerScope(value: KnowledgeScope) { reviewerScope = value; },
    beforeAuthorityReturn(callback: () => Promise<void>) { beforeAuthorityReturn = callback; },
    beforeTargetReturn(callback: (targetId: string) => Promise<void>) { beforeTargetReturn = callback; },
    close() { database?.close(); },
  };
}

describe('SemanticKnowledgeService', () => {
  it('replays submission and review through storage without duplicating audit or reviving revoked knowledge', async () => {
    const { service, store } = setup();
    const draft = await service.createDraft({ requestId: 'replay-draft', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() });
    const submission = { requestId: 'replay-submit', targetId: scopeA.targetId,
      knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 };
    const pending = await service.submitForReview(submission);
    expect(await service.submitForReview(submission)).toEqual(pending);
    const review = { ...submission, requestId: 'replay-review', governanceVersion: 2, decision: 'approve' as const };
    const approved = await service.review(review);
    expect(await service.review(review)).toEqual(approved);
    const revoked = await store.transitionKnowledge({ requestId: 'replay-revoke', actorId: 'operator-admin',
      knowledgeId: draft.id, kind: 'semantic', contentRevision: 1, expectedGovernanceVersion: 3,
      nextStatus: 'revoked', occurredAt: '2026-10-12T00:00:01.000Z' });
    expect(await service.review(review)).toEqual(revoked);
    expect(await store.listPending(20)).toHaveLength(4);
    await expect(service.review({ ...review, decision: 'reject' })).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
    await expect(service.review({ ...review, requestId: 'stale-review' })).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
  });
  it('creates an immutable unapproved draft with host-derived scope and actor', async () => {
    const { service, store } = setup();
    const draft = await service.createDraft({ requestId: 'draft-a-1', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() });

    expect(draft).toMatchObject({ kind: 'semantic', status: 'draft', contentRevision: 1, governanceVersion: 1,
      scope: scopeA, provenance: { sourceType: 'controlled_runbook', sourceId: sourceRef.sourceId,
        sourceVersion: sourceRef.sourceVersion, sourceDigest: sourceRef.digest } });
    const state = await store.inspectExact({ id: draft.id, contentRevision: 1, scope: scopeA, now: '2026-10-12T00:00:00.000Z' });
    expect(state?.contentDigest).toBe(draft.contentDigest);
    expect((await store.listPending(20)).find(item => item.requestId === 'draft-a-1'))
      .toMatchObject({ actorId: `operator-${scopeA.targetId}`, afterStatus: 'draft' });
  });

  it('replays the same authoring request when the clock and generated ID advance', async () => {
    const { service, store, setNow } = setup();
    const request = { requestId: 'draft-replay-1', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() };
    const first = await service.createDraft(request);
    setNow('2026-10-12T01:00:00.000Z');
    const replay = await service.createDraft(request);

    expect(replay).toEqual(first);
    expect((await store.listPending(20)).filter(item => item.requestId === request.requestId)).toHaveLength(1);
  });

  it('writes an immutable next revision and rejects a stale content-version CAS', async () => {
    const { service } = setup();
    const first = await service.createDraft({ requestId: 'draft-revision-1', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() });
    const revisedContent = { ...metricContent(), businessMeaning: 'Failed settlement attempts after the retry window.' };
    const second = await service.reviseDraft({ requestId: 'draft-revision-2', targetId: scopeA.targetId,
      source: sourceRef, content: revisedContent, knowledgeId: first.id, expectedContentRevision: 1,
      expectedGovernanceVersion: 1 });

    expect(first.content).toEqual(metricContent());
    expect(first).toMatchObject({ contentRevision: 1, status: 'draft' });
    expect(second).toMatchObject({ id: first.id, contentRevision: 2, status: 'draft', content: revisedContent });
    await expect(service.reviseDraft({ requestId: 'draft-revision-stale', targetId: scopeA.targetId,
      source: sourceRef, content: { ...revisedContent, businessMeaning: 'Stale write.' }, knowledgeId: first.id,
      expectedContentRevision: 1, expectedGovernanceVersion: 1 }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT' });
  });

  it('requires explicit host review and imports approved knowledge cross-Target only as a new draft', async () => {
    const { service, store, setReviewerScope } = setup();
    const draft = await service.createDraft({ requestId: 'draft-a-2', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() });
    const pending = await service.submitForReview({ requestId: 'submit-a-2', targetId: scopeA.targetId,
      knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 });
    expect(pending.status).toBe('review_pending');
    setReviewerScope(scopeA);
    const approved = await service.review({ requestId: 'review-a-2', targetId: scopeA.targetId,
      knowledgeId: draft.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' });
    expect(approved.status).toBe('approved');

    const imported = await service.importApproved({ requestId: 'import-a-to-b', sourceTargetId: scopeA.targetId,
      targetId: scopeB.targetId, knowledgeId: approved.id, contentRevision: 1, destinationSource: sourceRef });
    expect(imported).toMatchObject({ kind: 'semantic', status: 'draft', contentRevision: 1, governanceVersion: 1,
      scope: scopeB, content: approved.content });
    expect(imported.id).not.toBe(approved.id);
    expect((await store.getExact({ id: approved.id, contentRevision: 1, scope: scopeA }))?.status).toBe('approved');
  });

  it('records an explicit rejection and blocks a late approval after source revocation', async () => {
    const { service, store, setReviewerScope } = setup();
    const rejectedDraft = await service.createDraft({ requestId: 'draft-reject-1', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent('settlement_rejected_total') });
    await service.submitForReview({ requestId: 'submit-reject-1', targetId: scopeA.targetId,
      knowledgeId: rejectedDraft.id, contentRevision: 1, governanceVersion: 1 });
    setReviewerScope(scopeA);
    const rejected = await service.review({ requestId: 'review-reject-1', targetId: scopeA.targetId,
      knowledgeId: rejectedDraft.id, contentRevision: 1, governanceVersion: 2,
      decision: 'reject', reasonCode: 'SOURCE_NOT_AUTHORITATIVE' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.review).toBeUndefined();

    const lateDraft = await service.createDraft({ requestId: 'draft-late-approval', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent('settlement_late_approval_total') });
    await service.submitForReview({ requestId: 'submit-late-approval', targetId: scopeA.targetId,
      knowledgeId: lateDraft.id, contentRevision: 1, governanceVersion: 1 });
    await store.transitionSource({ requestId: 'revoke-before-approve', actorId: 'operator-admin',
      sourceId: sourceRef.sourceId, dataDomainId: 'settlement-knowledge-domain', expectedSourceEpoch: 0,
      transition: 'revoked', sourceDigest: digest, occurredAt: '2026-10-12T00:00:01.000Z' });
    await expect(service.review({ requestId: 'review-late-approval', targetId: scopeA.targetId,
      knowledgeId: lateDraft.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
  });

  it('rejects caller-supplied scope/actor and a revoked or changed host source', async () => {
    const { service, store } = setup();
    await expect(service.createDraft({ requestId: 'forged-draft', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent(), actorId: 'attacker', scope: scopeB } as unknown as Parameters<typeof service.createDraft>[0]))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });

    await store.registerSource({ sourceId: sourceRef.sourceId, dataDomainId: 'settlement-knowledge-domain',
      sourceDigest: digest, registeredAt: '2026-10-12T00:00:00.000Z' });
    await store.transitionSource({ requestId: 'source-revoke-1', actorId: 'operator-admin', sourceId: sourceRef.sourceId,
      dataDomainId: 'settlement-knowledge-domain', expectedSourceEpoch: 0, transition: 'revoked',
      sourceDigest: digest, occurredAt: '2026-10-12T00:00:01.000Z' });

    await expect(service.createDraft({ requestId: 'draft-revoked-source', targetId: scopeA.targetId,
      source: sourceRef, content: metricContent() })).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
  });
});

describe.each(['memory', 'sqlite'] as const)('%s Semantic final authority boundary', backend => {
  it.each(['target', 'revision'] as const)('rejects a changed import origin %s under the same request ID', async change => {
    const fixture = setup(backend);
    const { service, store, setReviewerScope } = fixture;
    try {
      const first = await service.createDraft({ requestId: 'origin-first', targetId: scopeA.targetId,
        source: sourceRef, content: metricContent() });
      await service.submitForReview({ requestId: 'origin-first-submit', targetId: scopeA.targetId,
        knowledgeId: first.id, contentRevision: 1, governanceVersion: 1 });
      await service.review({ requestId: 'origin-first-review', targetId: scopeA.targetId,
        knowledgeId: first.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' });
      const request = { requestId: 'origin-import', sourceTargetId: scopeA.targetId, targetId: scopeB.targetId,
        knowledgeId: first.id, contentRevision: 1, destinationSource: sourceRef };
      const imported = await service.importApproved(request);
      expect(await service.importApproved(request)).toEqual(imported);
      const originScope = change === 'target' ? scopeC : scopeA;
      const second = change === 'target'
        ? await service.createDraft({ requestId: 'origin-second', targetId: originScope.targetId,
          source: sourceRef, content: metricContent() })
        : await service.reviseDraft({ requestId: 'origin-second', targetId: originScope.targetId,
          source: sourceRef, content: metricContent(), knowledgeId: first.id,
          expectedContentRevision: 1, expectedGovernanceVersion: 3 });
      await service.submitForReview({ requestId: 'origin-second-submit', targetId: originScope.targetId,
        knowledgeId: second.id, contentRevision: second.contentRevision, governanceVersion: 1 });
      setReviewerScope(originScope);
      await service.review({ requestId: 'origin-second-review', targetId: originScope.targetId,
        knowledgeId: second.id, contentRevision: second.contentRevision, governanceVersion: 2, decision: 'approve' });
      expect(second.contentDigest).toBe(first.contentDigest);
      await expect(service.importApproved({ ...request, sourceTargetId: originScope.targetId,
        knowledgeId: second.id, contentRevision: second.contentRevision }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
      expect((await store.listPending(20)).filter(event => event.requestId === request.requestId)).toHaveLength(1);
    } finally { fixture.close(); }
  });

  it.each(['create', 'import'] as const)('rejects create/import request collisions with %s first', async firstOperation => {
    const fixture = setup(backend);
    const { service, store } = fixture;
    try {
      const origin = await service.createDraft({ requestId: 'collision-origin', targetId: scopeA.targetId,
        source: sourceRef, content: metricContent() });
      await service.submitForReview({ requestId: 'collision-submit', targetId: scopeA.targetId,
        knowledgeId: origin.id, contentRevision: 1, governanceVersion: 1 });
      await service.review({ requestId: 'collision-review', targetId: scopeA.targetId,
        knowledgeId: origin.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' });
      const create = () => service.createDraft({ requestId: 'collision-request', targetId: scopeB.targetId,
        source: sourceRef, content: metricContent() });
      const importDraft = () => service.importApproved({ requestId: 'collision-request', sourceTargetId: scopeA.targetId,
        targetId: scopeB.targetId, knowledgeId: origin.id, contentRevision: 1, destinationSource: sourceRef });
      await (firstOperation === 'create' ? create() : importDraft());
      await expect(firstOperation === 'create' ? importDraft() : create())
        .rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
      expect((await store.listPending(20)).filter(event => event.requestId === 'collision-request')).toHaveLength(1);
    } finally { fixture.close(); }
  });
  it.each([
    ['expiry', 'KNOWLEDGE_EXPIRED'],
    ['epoch', 'KNOWLEDGE_SOURCE_REVOKED'],
  ] as const)('rechecks import %s after awaiting destination host identity', async (change, code) => {
    const fixture = setup(backend);
    const { service, store, setNow } = fixture;
    try {
      const draft = await service.createDraft({ requestId: 'import-race-draft', targetId: scopeA.targetId,
        source: sourceRef, content: metricContent(), validUntil: '2026-10-12T00:00:01.000Z' });
      await service.submitForReview({ requestId: 'import-race-submit', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 });
      await service.review({ requestId: 'import-race-review', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' });
      fixture.beforeTargetReturn(async targetId => {
        if (targetId !== scopeB.targetId) return;
        if (change === 'expiry') setNow('2026-10-12T00:00:01.000Z');
        else await store.transitionSource({ requestId: 'import-race-source', actorId: 'operator-admin',
          sourceId: sourceRef.sourceId, dataDomainId: 'settlement-knowledge-domain', expectedSourceEpoch: 0,
          transition: 'revalidated', sourceDigest: digest, occurredAt: '2026-10-12T00:00:00.500Z' });
      });
      await expect(service.importApproved({ requestId: 'import-race', sourceTargetId: scopeA.targetId,
        targetId: scopeB.targetId, knowledgeId: draft.id, contentRevision: 1, destinationSource: sourceRef }))
        .rejects.toMatchObject({ code });
      expect((await store.listPending(20)).filter(event => event.requestId === 'import-race')).toEqual([]);
    } finally { fixture.close(); }
  });
  it.each([
    ['expiry', 'KNOWLEDGE_EXPIRED'],
    ['epoch', 'KNOWLEDGE_SOURCE_REVOKED'],
    ['digest', 'KNOWLEDGE_SOURCE_REVOKED'],
  ] as const)('rejects %s changes while host review authority is awaited', async (change, code) => {
    const fixture = setup(backend);
    const { service, store, setNow } = fixture;
    try {
      const draft = await service.createDraft({ requestId: 'race-draft', targetId: scopeA.targetId,
        source: sourceRef, content: metricContent(), validUntil: '2026-10-12T00:00:01.000Z' });
      await service.submitForReview({ requestId: 'race-submit', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 });
      fixture.beforeAuthorityReturn(async () => {
        if (change === 'expiry') setNow('2026-10-12T00:00:01.000Z');
        else await store.transitionSource({ requestId: 'race-source', actorId: 'operator-admin',
          sourceId: sourceRef.sourceId, dataDomainId: 'settlement-knowledge-domain', expectedSourceEpoch: 0,
          transition: change === 'epoch' ? 'revalidated' : 'digest_mismatch',
          sourceDigest: change === 'epoch' ? digest : 'b'.repeat(64), occurredAt: '2026-10-12T00:00:00.500Z' });
      });
      await expect(service.review({ requestId: 'race-review', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' }))
        .rejects.toMatchObject({ code });
      expect(await store.inspectExact({ id: draft.id, contentRevision: 1, scope: scopeA,
        now: '2026-10-12T00:00:01.000Z' })).toMatchObject({ status: 'review_pending', governanceVersion: 2 });
      expect((await store.listPending(20)).filter(event => event.requestId === 'race-review')).toEqual([]);
      expect(await store.getExact({ id: draft.id, contentRevision: 1, scope: scopeA })).toBeNull();
    } finally { fixture.close(); }
  });

  it.each([
    ['expiry', 'KNOWLEDGE_EXPIRED'],
    ['epoch', 'KNOWLEDGE_SOURCE_REVOKED'],
    ['digest', 'KNOWLEDGE_DIGEST_MISMATCH'],
  ] as const)('refuses importing approved content after current %s changes without a cleanup worker', async (change, code) => {
    const fixture = setup(backend);
    const { service, store, setNow } = fixture;
    try {
      const draft = await service.createDraft({ requestId: 'import-draft', targetId: scopeA.targetId,
        source: sourceRef, content: metricContent(), validUntil: '2026-10-12T00:00:01.000Z' });
      await service.submitForReview({ requestId: 'import-submit', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 });
      await service.review({ requestId: 'import-review', targetId: scopeA.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 2, decision: 'approve' });
      if (change === 'expiry') setNow('2026-10-12T00:00:01.000Z');
      else await store.transitionSource({ requestId: 'import-source', actorId: 'operator-admin',
        sourceId: sourceRef.sourceId, dataDomainId: 'settlement-knowledge-domain', expectedSourceEpoch: 0,
        transition: change === 'epoch' ? 'revalidated' : 'digest_mismatch',
        sourceDigest: change === 'epoch' ? digest : 'b'.repeat(64), occurredAt: '2026-10-12T00:00:00.500Z' });
      await expect(service.importApproved({ requestId: 'import-invalid', sourceTargetId: scopeA.targetId,
        targetId: scopeB.targetId, knowledgeId: draft.id, contentRevision: 1, destinationSource: sourceRef }))
        .rejects.toMatchObject({ code });
      expect((await store.listPending(20)).filter(event => event.requestId === 'import-invalid')).toEqual([]);
    } finally { fixture.close(); }
  });
});
