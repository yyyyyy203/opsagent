import { describe, expect, it } from 'vitest';
import type { KnowledgeScope, SemanticKnowledgeRevision } from '../src/contracts/knowledge-memory.js';
import type { TargetKnowledgePolicy } from '../src/contracts/target.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore } from '../src/infrastructure/sqlite/knowledge-memory-store.js';
import { SqliteTargetKnowledgeBindingStore } from '../src/infrastructure/sqlite/target-knowledge-binding-store.js';

const sourceDigest = 'a'.repeat(64);
const scope: KnowledgeScope = {
  targetId: 'target-publication', projectId: 'project-one', deploymentId: 'deploy-one', deploymentGeneration: 1,
  targetFingerprint: 'fingerprint-one', profileId: 'profile-one', profileRevision: 'profile-rev-1',
  scenarioId: 'settlement-failure', scenarioVersion: '1', serviceIds: ['settlement-service'],
  faultTypes: ['high-failure-rate'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-one',
};
const policy: TargetKnowledgePolicy = {
  schemaVersion: 1, targetId: scope.targetId, policyVersion: 'policy-v1', policyEpoch: 1,
  defaultRequiredness: 'optional', requirements: [],
};

function makeRevision(options: { validUntil?: string } = {}): SemanticKnowledgeRevision {
  const content = { type: 'domain_glossary' as const, terms: [{ term: 'settlement',
    definition: 'Settlement records describe a completed business settlement.',
    sourceReference: { sourceId: 'profile-source', sourceVersion: 'source-v1', digest: sourceDigest } }] };
  return { schemaVersion: 1, id: 'publication-knowledge', kind: 'semantic', contentRevision: 1,
    governanceVersion: 1, sourceEpoch: 0, status: 'draft', createdAt: '2026-10-10T00:00:00.000Z',
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }), scope,
    provenance: { sourceType: 'operator_provided', sourceId: 'profile-source', sourceVersion: 'source-v1',
      sourceDigest, importedAt: '2026-10-10T00:00:00.000Z' }, contentDigest: checkpointChecksum(content), content };
}

async function approvedStore(database: SqliteDatabase,
  clock: { now: () => Date } = { now: () => new Date('2026-10-12T00:00:00.000Z') }, revision = makeRevision()) {
  let auditId = 0;
  const knowledge = new SqliteGovernedKnowledgeStore(database, {
    authority: { resolveFor: async () => ({ actorId: 'reviewer-one', scope, sourceEpoch: 0,
      sourceDigest, reviewedAt: '2026-10-12T00:00:00.000Z' }) },
    clock,
    ids: { next: (prefix) => `${prefix}-${++auditId}` },
  });
  await knowledge.registerSource({ sourceId: 'profile-source', dataDomainId: 'domain-one', sourceDigest, registeredAt: '2026-10-10T00:00:00.000Z' });
  await knowledge.saveDraft({ requestId: 'publication-draft', actorId: 'operator-one', naturalKey: 'settlement-glossary',
    sourceDomainId: 'domain-one', expectedContentRevision: null, expectedGovernanceVersion: null, revision });
  await knowledge.submitForReview({ requestId: 'publication-submit', actorId: 'operator-one', knowledgeId: revision.id,
    kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 1 });
  const approved = await knowledge.review({ schemaVersion: 1, requestId: 'publication-review', knowledgeId: revision.id,
    kind: 'semantic', expectedContentRevision: 1, expectedGovernanceVersion: 2, contentDigest: revision.contentDigest,
    decision: 'approve', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } });
  const binding = new SqliteTargetKnowledgeBindingStore(database, {
    actors: { resolveForTarget: async () => ({ actorId: 'publisher-one' }) },
    clock,
    ids: { next: (prefix) => `${prefix}-${++auditId}` },
  });
  return { knowledge, binding, approved };
}

describe('SQLite Target knowledge binding publication', () => {
  it('uses expectedPublicationVersion CAS and atomically records the binding, history, and audit', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const { knowledge, binding, approved } = await approvedStore(database);
      const command = {
        requestId: 'publish-one', targetId: scope.targetId, scope,
        references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
        policy, expectedPublicationVersion: 0, publishedAt: '2000-01-01T00:00:00.000Z',
      };
      const publication = await binding.publish(command);
      expect(publication).toMatchObject({ targetId: scope.targetId, publicationVersion: 1, references: command.references });
      expect(publication.publishedAt).toBe('2026-10-12T00:00:00.000Z');
      expect(await binding.get(scope.targetId)).toEqual(publication);
      expect(await binding.publish(command)).toEqual(publication);
      expect((await knowledge.list({ targetId: scope.targetId, limit: 20 }))
        .find((event) => event.type === 'binding_publication')?.occurredAt).toBe('2026-10-12T00:00:00.000Z');
      await expect(binding.publish({ ...command, requestId: 'publish-stale' })).rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_CONFLICT' });
      expect((await knowledge.list({ targetId: scope.targetId, limit: 20 })).map((event) => event.type)).toHaveLength(4);
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_publications').get() as { count: number }).count).toBe(1);
    } finally { database.close(); }
  });

  it('rejects an invalid exact reference or a scope from another Target before publishing', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const { binding, approved } = await approvedStore(database);
      const command = {
        requestId: 'publish-invalid', targetId: scope.targetId, scope,
        references: [{ id: approved.id, version: '1', digest: 'f'.repeat(64), approval: 'approved' as const }],
        policy, expectedPublicationVersion: 0, publishedAt: '2026-10-12T00:00:00.000Z',
      };
      await expect(binding.publish(command)).rejects.toMatchObject({ code: 'KNOWLEDGE_DIGEST_MISMATCH' });
      await expect(binding.publish({ ...command, requestId: 'publish-wrong-scope', references: [],
        scope: { ...scope, targetId: 'other-target' } })).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });
      expect(await binding.get(scope.targetId)).toBeNull();
    } finally { database.close(); }
  });

  it('allows only one concurrent publication at the same expected version', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const { binding, approved } = await approvedStore(database);
      const command = {
        requestId: 'publish-race-a', targetId: scope.targetId, scope,
        references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
        policy, expectedPublicationVersion: 0, publishedAt: '2026-10-12T00:00:00.000Z',
      };
      const results = await Promise.allSettled([
        binding.publish(command),
        binding.publish({ ...command, requestId: 'publish-race-b' }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { code: 'KNOWLEDGE_PUBLICATION_CONFLICT' } });
      expect(await binding.get(scope.targetId)).toMatchObject({ publicationVersion: 1 });
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_publications').get() as { count: number }).count).toBe(1);
    } finally { database.close(); }
  });

  it('rolls back publication history, binding, audit, and outbox if audit append fails', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const { binding, approved } = await approvedStore(database);
      const command = {
        requestId: 'publish-audit-failure', targetId: scope.targetId, scope,
        references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
        policy, expectedPublicationVersion: 0, publishedAt: '2026-10-12T00:00:00.000Z',
      };
      const beforeAudits = (database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_audits').get() as { count: number }).count;
      const beforeOutbox = (database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_outbox').get() as { count: number }).count;
      database.raw.exec(`CREATE TRIGGER fail_knowledge_audit_insert BEFORE INSERT ON diagnostic_knowledge_audits
        BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);

      await expect(binding.publish(command)).rejects.toThrow('injected audit failure');
      expect(await binding.get(scope.targetId)).toBeNull();
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM target_knowledge_bindings').get() as { count: number }).count).toBe(0);
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_publications').get() as { count: number }).count).toBe(0);
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_audits').get() as { count: number }).count).toBe(beforeAudits);
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_outbox').get() as { count: number }).count).toBe(beforeOutbox);
    } finally { database.close(); }
  });

  it('uses the injected clock rather than a backdated command time for publication eligibility', async () => {
    const database = SqliteDatabase.open(':memory:');
    let currentTime = new Date('2026-10-12T00:00:00.000Z');
    try {
      const { binding, approved } = await approvedStore(database, { now: () => new Date(currentTime) },
        makeRevision({ validUntil: '2026-10-12T02:30:00+02:00' }));
      currentTime = new Date('2026-10-12T00:45:00.000Z');
      const command = {
        requestId: 'publish-expired-backdated', targetId: scope.targetId, scope,
        references: [{ id: approved.id, version: '1', digest: approved.contentDigest, approval: 'approved' as const }],
        policy, expectedPublicationVersion: 0, publishedAt: '2000-01-01T00:00:00.000Z',
      };

      await expect(binding.publish(command)).rejects.toMatchObject({ code: 'KNOWLEDGE_EXPIRED' });
      expect(await binding.get(scope.targetId)).toBeNull();
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_knowledge_publications').get() as { count: number }).count).toBe(0);
    } finally { database.close(); }
  });
});
