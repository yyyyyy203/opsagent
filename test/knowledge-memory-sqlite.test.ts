import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KnowledgeScope, SemanticKnowledgeRevision } from '../src/contracts/knowledge-memory.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { targetKnowledgeReferenceFor } from '../src/contracts/knowledge-memory-schema.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore } from '../src/infrastructure/sqlite/knowledge-memory-store.js';

const digest = 'a'.repeat(64);
const scope: KnowledgeScope = {
  targetId: 'target-one', projectId: 'project-one', deploymentId: 'deploy-one', deploymentGeneration: 1,
  targetFingerprint: 'fingerprint-one', profileId: 'profile-one', profileRevision: 'profile-rev-1',
  scenarioId: 'settlement-failure', scenarioVersion: '1', serviceIds: ['settlement-service'],
  faultTypes: ['high-failure-rate'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-one',
};
const authority = { resolveFor: async () => ({ actorId: 'reviewer-one', scope, sourceEpoch: 0,
  sourceDigest: digest, reviewedAt: '2026-10-12T00:00:00.000Z' }) };

function makeRevision(id = 'sqlite-semantic', contentRevision = 1, options: {
  scope?: KnowledgeScope; validUntil?: string; term?: string; definition?: string;
} = {}): SemanticKnowledgeRevision {
  const content = { type: 'domain_glossary' as const, terms: [{ term: options.term ?? 'settlement',
    definition: options.definition ?? 'Settlement records describe a completed business settlement.',
    sourceReference: { sourceId: 'profile-source', sourceVersion: 'source-v1', digest } }] };
  return { schemaVersion: 1, id, kind: 'semantic', contentRevision, governanceVersion: 1,
    sourceEpoch: 0, status: 'draft', createdAt: '2026-10-10T00:00:00.000Z',
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }), scope: options.scope ?? scope,
    provenance: { sourceType: 'operator_provided', sourceId: 'profile-source', sourceVersion: 'source-v1',
      sourceDigest: digest, importedAt: '2026-10-10T00:00:00.000Z' },
    contentDigest: checkpointChecksum(content), content };
}

function makeStore(database: SqliteDatabase, clock: { now: () => Date } = { now: () => new Date('2026-10-12T00:00:00.000Z') }) {
  let next = 0;
  return new SqliteGovernedKnowledgeStore(database, {
    authority, clock,
    ids: { next: (prefix) => `${prefix}-${++next}` },
  });
}

async function createApproved(store: SqliteGovernedKnowledgeStore, revision = makeRevision()) {
  await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest, registeredAt: '2026-10-10T00:00:00.000Z' });
  await store.saveDraft({ requestId: `${revision.id}-draft`, actorId: 'operator-one', naturalKey: `${revision.id}-glossary`,
    sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision });
  await store.submitForReview({ requestId: `${revision.id}-submit`, actorId: 'operator-one', knowledgeId: revision.id,
    kind: revision.kind, expectedContentRevision: 1, expectedGovernanceVersion: 1 });
  return store.review({ schemaVersion: 1, requestId: `${revision.id}-review`, knowledgeId: revision.id,
    kind: revision.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: revision.contentDigest,
    decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } });
}

describe('SQLite governed knowledge storage', () => {
  it('persists immutable revisions, current governance state, FTS eligibility, and audits across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-knowledge-sqlite-'));
    const path = join(root, 'state.sqlite');
    const firstDatabase = SqliteDatabase.open(path);
    let database: SqliteDatabase | undefined = firstDatabase;
    try {
      const store = makeStore(firstDatabase);
      const approved = await createApproved(store);
      const reference = targetKnowledgeReferenceFor({ id: approved.id, contentRevision: 1,
        contentDigest: approved.contentDigest, status: approved.status });
      expect((await store.search({ kind: 'semantic', scope, references: [reference], query: 'settlement completed',
        limit: 5, now: '2026-10-12T00:00:00.000Z' })).map((item) => item.id)).toEqual([approved.id]);
      expect((await store.list({ targetId: scope.targetId, limit: 20 })).map((event) => event.type)).toHaveLength(3);
      firstDatabase.close();
      database = undefined;

      database = SqliteDatabase.open(path);
      const reopened = makeStore(database);
      expect(await reopened.getExact({ id: approved.id, contentRevision: 1, scope })).toMatchObject({ status: 'approved', governanceVersion: 3 });
      expect((await reopened.listPending(20))).toHaveLength(3);
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('commits source revocation atomically and invalidates otherwise approved FTS results', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = makeStore(database);
      const approved = await createApproved(store, makeRevision('sqlite-revoke'));
      const reference = { id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const };
      const sourceCommand = { requestId: 'sqlite-revoke-source', actorId: 'operator-one', sourceId: 'profile-source',
        dataDomainId: 'domain-one', expectedSourceEpoch: 0, transition: 'revoked', sourceDigest: digest,
        occurredAt: '2000-01-01T00:00:00.000Z' } as const;
      await store.transitionSource(sourceCommand);
      expect(await store.search({ kind: 'semantic', scope, references: [reference], query: 'settlement', limit: 5,
        now: '2026-10-12T00:00:00.000Z' })).toEqual([]);
      expect(await store.getExact({ id: approved.id, contentRevision: 1, scope })).toBeNull();
      expect((await store.listPending(20))).toHaveLength(4);
      expect(await store.inspectExact({ id: approved.id, contentRevision: 1, scope, now: '2026-10-12T00:00:00.000Z' }))
        .toMatchObject({ status: 'approved', sourceValidity: 'revoked', sourceEpoch: 0 });
      const sourceAudit = (await store.listPending(20)).find((event) => event.requestId === sourceCommand.requestId);
      expect(sourceAudit?.commandDigest).toBe(checkpointChecksum({ operation: 'source_transition', command: sourceCommand }));
      expect(sourceAudit?.occurredAt).toBe('2026-10-12T00:00:00.000Z');
      const approval = { schemaVersion: 1 as const, requestId: 'sqlite-revoke-review', knowledgeId: approved.id,
        kind: approved.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: approved.contentDigest,
        decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
      const auditCount = (await store.listPending(20)).length;
      await expect(store.review(approval)).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
      expect((await store.listPending(20)).length).toBe(auditCount);
    } finally { database.close(); }
  });

  it('stamps review audit envelopes with the injected clock, not authority-provided time', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = makeStore(database, { now: () => new Date('2026-10-12T00:05:00.000Z') });
      const approved = await createApproved(store, makeRevision('sqlite-review-audit-clock'));
      const audit = (await store.listPending(20)).find((event) => event.requestId === `${approved.id}-review`);
      expect(audit?.occurredAt).toBe('2026-10-12T00:05:00.000Z');
    } finally { database.close(); }
  });

  it('persists a new content revision without mutating an older approved revision', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = makeStore(database);
      const first = await createApproved(store, makeRevision('sqlite-revisions'));
      const second = await store.saveDraft({ requestId: 'sqlite-revision-two', actorId: 'operator-one',
        naturalKey: `${first.id}-glossary`, sourceDomainId: 'domain-one', expectedContentRevision: 1,
        expectedGovernanceVersion: first.governanceVersion, revision: makeRevision(first.id, 2) });
      expect(second).toMatchObject({ id: first.id, contentRevision: 2, status: 'draft', governanceVersion: 1 });
      expect(await store.getExact({ id: first.id, contentRevision: 1, scope })).toEqual(first);
      expect(await store.getExact({ id: first.id, contentRevision: 2, scope })).toBeNull();
      expect(await store.inspectExact({ id: first.id, contentRevision: 2, scope, now: '2026-10-12T00:00:00.000Z' }))
        .toMatchObject({ status: 'draft', governanceVersion: 1 });
    } finally { database.close(); }
  });

  it('rolls back review state if audit append fails', async () => {
    const database = SqliteDatabase.open(':memory:');
    let generated = 0;
    try {
      const store = new SqliteGovernedKnowledgeStore(database, { authority,
        clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
        ids: { next: () => { generated += 1; return 'duplicate-audit-id'; } },
      });
      const draft = makeRevision('sqlite-rollback');
      await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest, registeredAt: '2026-10-10T00:00:00.000Z' });
      await store.saveDraft({ requestId: 'rollback-draft', actorId: 'operator-one', naturalKey: 'settlement-glossary',
        sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft });
      await expect(store.submitForReview({ requestId: 'rollback-submit', actorId: 'operator-one', knowledgeId: draft.id,
        kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 1 })).rejects.toThrow();
      expect(await store.inspectExact({ id: draft.id, contentRevision: 1, scope, now: '2026-10-12T00:00:00.000Z' }))
        .toMatchObject({ status: 'draft', governanceVersion: 1 });
      expect(await store.listPending(20)).toHaveLength(1);
      expect(generated).toBe(2);
    } finally { database.close(); }
  });

  it('replays an old approval receipt with the current revoked state and does not append another audit', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = makeStore(database);
      const approved = await createApproved(store, makeRevision('sqlite-replay'));
      const approval = {
        schemaVersion: 1 as const, requestId: 'sqlite-replay-review', knowledgeId: approved.id, kind: approved.kind,
        expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: approved.contentDigest,
        decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
      };
      const revoked = await store.transitionKnowledge({ requestId: 'sqlite-replay-revoke', actorId: 'operator-one',
        knowledgeId: approved.id, kind: approved.kind, contentRevision: 1, expectedGovernanceVersion: approved.governanceVersion,
        nextStatus: 'revoked', occurredAt: '2000-01-01T00:00:00.000Z' });
      expect((await store.listPending(20)).find((event) => event.requestId === 'sqlite-replay-revoke')?.occurredAt)
        .toBe('2026-10-12T00:00:00.000Z');
      const auditCount = (await store.list({ targetId: scope.targetId, limit: 20 })).length;

      await expect(store.review(approval)).resolves.toMatchObject({ status: 'revoked', governanceVersion: revoked.governanceVersion });
      expect((await store.list({ targetId: scope.targetId, limit: 20 })).length).toBe(auditCount);
    } finally { database.close(); }
  });

  it('uses timezone-aware expiry and excludes stale or out-of-scope FTS rows from ranking statistics', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = makeStore(database);
      const first = await createApproved(store, makeRevision('sqlite-rank-a', 1, {
        term: 'alpha alpha alpha alpha alpha', definition: 'beta',
      }));
      const second = await createApproved(store, makeRevision('sqlite-rank-b', 1, {
        term: 'alpha', definition: 'beta beta beta beta beta',
      }));
      const references = [first, second].map((revision) => ({ id: revision.id, version: '1',
        digest: revision.contentDigest, approval: 'approved' as const }));
      const query = { kind: 'semantic' as const, scope, references, query: 'alpha beta', limit: 5,
        now: '2026-10-12T00:00:00.000Z' };
      const expectedOrder = (await store.search(query)).map((revision) => revision.id);
      expect(expectedOrder).toEqual(['sqlite-rank-a', 'sqlite-rank-b']);

      for (let index = 0; index < 4; index += 1) {
        database.raw.prepare(`INSERT INTO diagnostic_knowledge_fts
          (knowledge_id, content_revision, kind, target_id, scope_key, source_id, source_domain_id, content)
          VALUES (?, 1, 'semantic', 'other-target', 'other-scope', 'other-source', 'other-domain', ?)`)
          .run(`unreferenced-${index}`, 'alpha alpha alpha alpha alpha');
      }
      expect((await store.search(query)).map((revision) => revision.id)).toEqual(expectedOrder);

      const foreignScope: KnowledgeScope = { ...scope, targetId: 'foreign-target', projectId: 'foreign-project',
        datasetId: 'foreign-dataset' };
      let foreignId = 0;
      const foreignStore = new SqliteGovernedKnowledgeStore(database, { authority: { resolveFor: async () => ({
        actorId: 'reviewer-one', scope: foreignScope, sourceEpoch: 0, sourceDigest: digest,
        reviewedAt: '2026-10-12T00:00:00.000Z',
      }) }, clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
      ids: { next: (prefix) => `foreign-${prefix}-${++foreignId}` } });
      const foreign = await createApproved(foreignStore, makeRevision('sqlite-foreign', 1, { scope: foreignScope }));
      database.raw.prepare('UPDATE diagnostic_knowledge_fts SET target_id = ?, scope_key = ? WHERE knowledge_id = ?')
        .run(scope.targetId, checkpointChecksum(scope), foreign.id);
      await expect(store.search({ kind: 'semantic', scope,
        references: [{ id: foreign.id, version: '1', digest: foreign.contentDigest, approval: 'approved' }],
        query: 'settlement', limit: 5, now: '2026-10-12T00:00:00.000Z' })).resolves.toEqual([]);

      const expired = await createApproved(store, makeRevision('sqlite-expired-offset', 1, {
        validUntil: '2026-10-12T02:30:00+02:00',
      }));
      await expect(store.search({ kind: 'semantic', scope,
        references: [{ id: expired.id, version: '1', digest: expired.contentDigest, approval: 'approved' }],
        query: 'settlement', limit: 5, now: '2026-10-12T00:45:00.000Z' })).resolves.toEqual([]);
    } finally { database.close(); }
  });

  it('does not replay an approval as usable after its validity expires', async () => {
    const database = SqliteDatabase.open(':memory:');
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    try {
      const store = makeStore(database, { now: () => new Date(currentTime) });
      const approved = await createApproved(store, makeRevision('sqlite-replay-expired', 1, {
        validUntil: '2026-10-12T02:30:00+02:00',
      }));
      const approval = { schemaVersion: 1 as const, requestId: 'sqlite-replay-expired-review', knowledgeId: approved.id,
        kind: approved.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: approved.contentDigest,
        decision: 'approve' as const, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
      const auditCount = (await store.listPending(20)).length;
      currentTime = new Date('2026-10-12T00:45:00.000Z');

      await expect(store.review(approval)).rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
      expect((await store.listPending(20)).length).toBe(auditCount);
    } finally { database.close(); }
  });

  it('rejects first approval when the injected clock is past validUntil despite a stale authority timestamp', async () => {
    const database = SqliteDatabase.open(':memory:');
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    try {
      const store = makeStore(database, { now: () => new Date(currentTime) });
      const draft = makeRevision('sqlite-approval-expired', 1, { validUntil: '2026-10-12T00:30:00.000Z' });
      await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest,
        registeredAt: '2026-10-10T00:00:00.000Z' });
      await store.saveDraft({ requestId: 'sqlite-approval-expired-draft', actorId: 'operator-one', naturalKey: 'approval-expired',
        sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft });
      await store.submitForReview({ requestId: 'sqlite-approval-expired-submit', actorId: 'operator-one', knowledgeId: draft.id,
        kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 1 });
      const auditCount = (await store.list({ targetId: scope.targetId, limit: 20 })).length;
      currentTime = new Date('2026-10-12T00:45:00.000Z');

      await expect(store.review({ schemaVersion: 1, requestId: 'sqlite-approval-expired-review', knowledgeId: draft.id,
        kind: draft.kind, expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: draft.contentDigest,
        decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
      expect(await store.inspectExact({ id: draft.id, contentRevision: 1, scope, now: currentTime.toISOString() }))
        .toMatchObject({ status: 'review_pending', governanceVersion: 2 });
      expect((await store.list({ targetId: scope.targetId, limit: 20 })).length).toBe(auditCount);
    } finally { database.close(); }
  });
});
