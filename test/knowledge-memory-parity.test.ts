import { describe, expect, it } from 'vitest';
import type { KnowledgeReviewCommand, KnowledgeScope, SemanticKnowledgeRevision, TargetKnowledgePublishCommand } from '../src/contracts/knowledge-memory.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore } from '../src/infrastructure/sqlite/knowledge-memory-store.js';
import { SqliteTargetKnowledgeBindingStore } from '../src/infrastructure/sqlite/target-knowledge-binding-store.js';
import { InMemoryGovernedKnowledgeStore } from '../src/memory/in-memory-knowledge-store.js';
import type { KnowledgeDraftWriteCommand } from '../src/contracts/knowledge-memory-storage.js';

const digest = 'a'.repeat(64);
const scope: KnowledgeScope = {
  targetId: 'parity-target', projectId: 'project-one', deploymentId: 'deploy-one', deploymentGeneration: 1,
  targetFingerprint: 'fingerprint-one', profileId: 'profile-one', profileRevision: 'profile-rev-1',
  scenarioId: 'settlement-failure', scenarioVersion: '1', serviceIds: ['settlement-service'],
  faultTypes: ['high-failure-rate'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-one',
};
function fixture(backend: 'sqlite' | 'memory') {
  const database = SqliteDatabase.open(':memory:');
  let now = '2026-10-11T00:00:00.000Z';
  let next = 0;
  const clock = { now: () => new Date(now) };
  const ids = { next: (prefix: string) => `${prefix}-${++next}` };
  const authority = { resolveFor: async () => ({ actorId: 'reviewer', scope, sourceEpoch: 0,
    sourceDigest: digest, reviewedAt: clock.now().toISOString() }) };
  const actors = { resolveForTarget: async () => ({ actorId: 'publisher' }) };
  const memory = new InMemoryGovernedKnowledgeStore({ authority, publicationActors: actors, clock, ids });
  const store = backend === 'memory' ? memory : new SqliteGovernedKnowledgeStore(database, { authority, clock, ids });
  const binding = backend === 'memory' ? memory : new SqliteTargetKnowledgeBindingStore(database, { actors, clock, ids });
  return { store, binding, database, advance: (value: string) => { now = value; } };
}
function draft(id: string, definition = 'Settlement completed.', validUntil?: string): SemanticKnowledgeRevision {
  const content = { type: 'domain_glossary' as const, terms: [{ term: 'settlement', definition,
    sourceReference: { sourceId: 'profile-source', sourceVersion: 'v1', digest } }] };
  return { schemaVersion: 1, id, kind: 'semantic', contentRevision: 1, governanceVersion: 1, sourceEpoch: 0,
    status: 'draft', scope, createdAt: '2026-10-10T00:00:00.000Z',
    ...(validUntil === undefined ? {} : { validUntil }),
    provenance: { sourceType: 'operator_provided', sourceId: 'profile-source', sourceVersion: 'v1',
      sourceDigest: digest, importedAt: '2026-10-10T00:00:00.000Z' }, contentDigest: checkpointChecksum(content), content };
}
function approval(revision: SemanticKnowledgeRevision): KnowledgeReviewCommand {
  return { schemaVersion: 1, requestId: `${revision.id}-approve`, knowledgeId: revision.id, kind: 'semantic',
    expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: revision.contentDigest,
    decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } };
}
async function save(store: ReturnType<typeof fixture>['store'], revision: SemanticKnowledgeRevision) {
  await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest,
    registeredAt: '2026-10-10T00:00:00.000Z' });
  return store.saveDraft({ requestId: `${revision.id}-draft`, actorId: 'operator', naturalKey: revision.id,
    sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision });
}
async function approve(store: ReturnType<typeof fixture>['store'], revision: SemanticKnowledgeRevision) {
  await save(store, revision);
  await store.submitForReview({ requestId: `${revision.id}-submit`, actorId: 'operator', knowledgeId: revision.id,
    kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 1 });
  return store.review(approval(revision));
}
function publishCommand(revision: SemanticKnowledgeRevision): TargetKnowledgePublishCommand {
  return { requestId: 'publish', targetId: scope.targetId, scope,
    references: [{ id: revision.id, version: '1', digest: revision.contentDigest, approval: 'approved' }],
    policy: { schemaVersion: 1, targetId: scope.targetId, policyVersion: 'v1', policyEpoch: 1,
      defaultRequiredness: 'optional', requirements: [] }, expectedPublicationVersion: 0,
    publishedAt: '2026-10-11T00:00:00.000Z' };
}
function searchInput(revisions: readonly SemanticKnowledgeRevision[], query = 'settlement') {
  return { kind: 'semantic' as const, scope, references: revisions.map((revision) => ({ id: revision.id,
    version: '1', digest: revision.contentDigest, approval: 'approved' as const })), query, limit: 10,
    now: '2026-10-12T01:00:00.000Z' };
}

describe.each(['sqlite', 'memory'] as const)('%s governed knowledge regressions', (backend) => {
  it.each(['content', 'actor', 'scope', 'source', 'source-domain', 'source-epoch', 'expected-versions',
    'natural-key', 'valid-until', 'content-revision'] as const)(
    'binds draft replay to stable %s even when the supplied intent digest is unchanged', async field => {
      const { store, database } = fixture(backend);
      try {
        await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest,
          registeredAt: '2026-10-10T00:00:00.000Z' });
        const command: KnowledgeDraftWriteCommand = { requestId: 'stable-draft', intentDigest: 'c'.repeat(64),
          actorId: 'operator', naturalKey: 'stable-item', sourceDomainId: 'domain-one',
          expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft('stable-draft-id') };
        await store.saveDraft(command);
        let changed: KnowledgeDraftWriteCommand = structuredClone(command);
        if (field === 'content') changed = { ...changed, revision: draft('stable-draft-id', 'Changed definition.') };
        if (field === 'actor') changed = { ...changed, actorId: 'different-operator' };
        if (field === 'scope') changed = { ...changed, revision: { ...changed.revision,
          scope: { ...scope, targetId: 'another-target' } } };
        if (field === 'source') changed = { ...changed, revision: { ...changed.revision,
          provenance: { ...changed.revision.provenance, sourceId: 'another-source' } } };
        if (field === 'source-domain') changed = { ...changed, sourceDomainId: 'another-domain' };
        if (field === 'source-epoch') changed = { ...changed, revision: { ...changed.revision, sourceEpoch: 1 } };
        if (field === 'expected-versions') changed = { ...changed, expectedContentRevision: 1, expectedGovernanceVersion: 1 };
        if (field === 'natural-key') changed = { ...changed, naturalKey: 'another-item' };
        if (field === 'valid-until') changed = { ...changed, revision: { ...changed.revision, validUntil: '2026-10-13T00:00:00.000Z' } };
        if (field === 'content-revision') changed = { ...changed, revision: { ...changed.revision, contentRevision: 2 } };
        await expect(store.saveDraft(changed)).rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
        expect(await store.listPending(20)).toHaveLength(1);
      } finally { database.close(); }
    });

  it('replays a stable initial draft across generated identity and import/creation times only', async () => {
    const { store, database } = fixture(backend);
    try {
      await store.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest: digest,
        registeredAt: '2026-10-10T00:00:00.000Z' });
      const command: KnowledgeDraftWriteCommand = { requestId: 'generated-replay', intentDigest: 'c'.repeat(64),
        actorId: 'operator', naturalKey: 'stable-item', sourceDomainId: 'domain-one',
        expectedContentRevision: null, expectedGovernanceVersion: null, revision: draft('generated-first') };
      const saved = await store.saveDraft(command);
      expect(await store.saveDraft({ ...command, revision: { ...command.revision, id: 'generated-second',
        createdAt: '2026-10-11T00:00:00.000Z', provenance: { ...command.revision.provenance,
          importedAt: '2026-10-11T00:00:00.000Z' } } })).toEqual(saved);
      expect(await store.listPending(20)).toHaveLength(1);
    } finally { database.close(); }
  });
  it('replays approval after revocation as the current revoked revision without another audit', async () => {
    const { store, database } = fixture(backend);
    try {
      const revision = draft('receipt');
      const approved = await approve(store, revision);
      const before = await store.list({ limit: 20 });
      const revoked = await store.transitionKnowledge({ requestId: 'revoke', actorId: 'operator', knowledgeId: revision.id,
        kind: 'semantic', contentRevision: 1, expectedGovernanceVersion: approved.governanceVersion,
        nextStatus: 'revoked', occurredAt: '2026-10-11T01:00:00.000Z' });
      expect(await store.review(approval(revision))).toEqual(revoked);
      expect(revoked).toMatchObject({ status: 'revoked', governanceVersion: 4 });
      expect(await store.list({ limit: 20 })).toEqual([...before, expect.objectContaining({ requestId: 'revoke' })]);
      expect(await store.listPending(20)).toHaveLength(4);
      expect(await store.getExact({ id: revision.id, contentRevision: 1, scope })).toBeNull();
      expect(await store.search(searchInput([revision]))).toEqual([]);
    } finally { database.close(); }
  });

  it('compares offset expiry timestamps by instant', async () => {
    const { store, database } = fixture(backend);
    try {
      const revision = draft('offset-expiry', 'Settlement completed.', '2026-10-12T02:00:00+02:00');
      await approve(store, revision);
      expect(await store.search(searchInput([revision]))).toEqual([]);
    } finally { database.close(); }
  });

  it('checks publication expiry at the injected clock despite backdated publishedAt', async () => {
    const { store, binding, database, advance } = fixture(backend);
    try {
      const revision = draft('publication-expiry', 'Settlement completed.', '2026-10-12T00:00:00.000Z');
      await approve(store, revision);
      advance('2026-10-12T01:00:00.000Z');
      await expect(binding.publish(publishCommand(revision))).rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
      expect(await binding.get(scope.targetId)).toBeNull();
      expect(await store.listPending(20)).toHaveLength(3);
    } finally { database.close(); }
  });

  it('advances audit pagination after the exact auditId and returns no rows for unknown cursors', async () => {
    const { store, database } = fixture(backend);
    try {
      await approve(store, draft('audit-cursor'));
      const audits = await store.list({ limit: 20 });
      expect(await store.list({ afterAuditId: audits[0]!.auditId, limit: 20 })).toEqual(audits.slice(1));
      expect(await store.list({ afterAuditId: audits[1]!.auditId, targetId: scope.targetId, limit: 20 })).toEqual(audits.slice(2));
      expect(await store.list({ afterAuditId: 'unknown', limit: 20 })).toEqual([]);
      expect(await store.list({ afterAuditId: audits[2]!.auditId, limit: 20 })).toEqual([]);
    } finally { database.close(); }
  });

  it('rejects stale non-latest draft submission without state or audit changes', async () => {
    const { store, database } = fixture(backend);
    try {
      const revision = draft('stale-draft');
      await save(store, revision);
      await store.saveDraft({ requestId: 'draft-two', actorId: 'operator', naturalKey: revision.id,
        sourceDomainId: 'domain-one', expectedContentRevision: 1, expectedGovernanceVersion: 1,
        revision: { ...revision, contentRevision: 2 } });
      await expect(store.submitForReview({ requestId: 'stale-submit', actorId: 'operator', knowledgeId: revision.id,
        kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 1 })).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' });
      expect(await store.inspectExact({ id: revision.id, contentRevision: 1, scope, now: searchInput([]).now }))
        .toMatchObject({ status: 'draft', governanceVersion: 1 });
      expect(await store.listPending(20)).toHaveLength(2);
    } finally { database.close(); }
  });

  it('uses token boundaries so settle cannot match settlement', async () => {
    const { store, database } = fixture(backend);
    try {
      const revision = draft('token-boundary');
      await approve(store, revision);
      expect(await store.search(searchInput([revision], 'settle'))).toEqual([]);
      expect((await store.search(searchInput([revision], 'settlement'))).map((item) => item.id)).toEqual([revision.id]);
    } finally { database.close(); }
  });

  it('ranks term frequency and document length before binary id ties like SQLite', async () => {
    const { store, database } = fixture(backend);
    try {
      const revisions = [draft('a-long', `settlement ${'unrelated '.repeat(50)}`),
        draft('z-frequent', 'settlement settlement settlement'), draft('a-tie', 'completed'), draft('Z-tie', 'completed')];
      for (const revision of revisions) await approve(store, revision);
      expect((await store.search(searchInput(revisions))).map((item) => item.id))
        .toEqual(['z-frequent', 'Z-tie', 'a-tie', 'a-long']);
      expect((await store.search({ ...searchInput(revisions), limit: 2 })).map((item) => item.id)).toEqual(['z-frequent', 'Z-tie']);
    } finally { database.close(); }
  });

  it.each(['outside-allowlist', 'expired'])('excludes %s documents from score statistics', async (reason) => {
    const { store, database } = fixture(backend);
    try {
      const admissible = [draft('a-settlement', 'settlement completed filler'), draft('z-completed', 'completed completed filler')];
      for (const revision of admissible) await approve(store, revision);
      const excluded = [];
      for (let index = 0; index < 8; index += 1) {
        const revision = draft(`excluded-${index}`, 'unrelated filler', reason === 'expired' ? '2026-10-12T00:00:00.000Z' : undefined);
        await approve(store, revision);
        excluded.push(revision);
      }
      const references = reason === 'expired' ? [...admissible, ...excluded] : admissible;
      expect((await store.search(searchInput(references, 'settlement completed'))).map((revision) => revision.id))
        .toEqual(['a-settlement', 'z-completed']);
    } finally { database.close(); }
  });

  it.each([
    [{ id: 'ref', version: '1', requiredness: 'required' }, { id: 'ref', version: '1', requiredness: 'optional' }],
    [{ id: 'ref', version: '0', requiredness: 'required' }],
    [{ id: 'ref', version: '1', requiredness: 'invalid' }],
    [{ id: 'ref', version: '1', requiredness: 'required', knowledgeClass: 'invalid' }],
  ])('validates policy requirements before publishing: %j', async (...requirements) => {
    const { binding, database, store } = fixture(backend);
    try {
      const command = publishCommand(draft('policy'));
      await expect(binding.publish({ ...command, references: [], policy: { ...command.policy,
        requirements: requirements as unknown as TargetKnowledgePublishCommand['policy']['requirements'] } }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_CONFLICT' });
      expect(await binding.get(scope.targetId)).toBeNull();
      expect(await store.listPending(20)).toEqual([]);
    } finally { database.close(); }
  });
});

describe('SQLite authoritative search metadata', () => {
  it.each(['scope', 'kind', 'scope-and-kind'])('rejects retained FTS metadata tampering: %s', async (change) => {
    const { store, database } = fixture('sqlite');
    try {
      const revision = draft('tampered-fts');
      await approve(store, revision);
      const requestedScope = change.includes('scope') ? { ...scope, targetId: 'other-target', profileRevision: 'other-revision' } : scope;
      const kind = change.includes('kind') ? 'procedural' : 'semantic';
      database.raw.prepare('UPDATE diagnostic_knowledge_fts SET target_id = ?, scope_key = ?, kind = ? WHERE knowledge_id = ?')
        .run(requestedScope.targetId, checkpointChecksum(requestedScope), kind, revision.id);
      expect(await store.search({ ...searchInput([revision]), scope: requestedScope, kind })).toEqual([]);
    } finally { database.close(); }
  });
});
