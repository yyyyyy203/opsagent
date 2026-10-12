import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore, appendSqliteKnowledgeAuditWithinTransaction } from '../src/infrastructure/sqlite/knowledge-memory-store.js';
import { KnowledgeAuditDispatcher } from '../src/memory/knowledge-audit-dispatcher.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import type { KnowledgeScope, SemanticKnowledgeRevision } from '../src/contracts/knowledge-memory.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';

const event = {
  schemaVersion: 1 as const, auditId: 'audit-outbox-1', requestId: 'source-change-1', commandDigest: 'a'.repeat(64),
  occurredAt: '2026-10-12T00:00:00.000Z', actorId: 'operator-one', type: 'source_transition' as const,
  sourceId: 'profile-source', dataDomainId: 'domain-one', beforeSourceEpoch: 0, afterSourceEpoch: 1,
  validity: 'revoked' as const, reasonCode: 'SOURCE_WITHDRAWN' as const,
};

describe('knowledge audit outbox dispatcher', () => {
  it('keeps sink failures pending, records an attempt, and replays after a database restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-knowledge-outbox-'));
    const path = join(root, 'state.sqlite');
    let database: SqliteDatabase | undefined = SqliteDatabase.open(path);
    try {
      database.raw.transaction(() => appendSqliteKnowledgeAuditWithinTransaction(database!, event))();
      const firstStore = new SqliteGovernedKnowledgeStore(database, {
        authority: { resolveFor: async () => { throw new Error('unused'); } },
      });
      const failed = new KnowledgeAuditDispatcher({
        outbox: firstStore, sink: { deliver: async () => { throw new Error('sink unavailable'); } },
        clock: { now: () => new Date('2026-10-12T00:01:00.000Z') }, batchSize: 1,
      });
      expect(await failed.drainOnce()).toEqual({ attempted: 1, delivered: 0, failed: 1, pending: true });
      expect(await firstStore.listPending(5)).toEqual([event]);
      expect((database.raw.prepare('SELECT attempts FROM diagnostic_knowledge_outbox WHERE audit_id = ?').get(event.auditId) as { attempts: number }).attempts).toBe(1);

      database.close();
      database = undefined;
      database = SqliteDatabase.open(path);
      const reopenedStore = new SqliteGovernedKnowledgeStore(database, {
        authority: { resolveFor: async () => { throw new Error('unused'); } },
      });
      const received: string[] = [];
      const recovered = new KnowledgeAuditDispatcher({
        outbox: reopenedStore, sink: { deliver: async (audit) => { received.push(audit.auditId); } },
        clock: { now: () => new Date('2026-10-12T00:02:00.000Z') }, batchSize: 1,
      });
      expect(await recovered.drainOnce()).toEqual({ attempted: 1, delivered: 1, failed: 0, pending: false });
      expect(received).toEqual([event.auditId]);
      expect(await reopenedStore.listPending(5)).toEqual([]);
      expect(await reopenedStore.list({ limit: 5 })).toEqual([event]);
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds batch size and serializes concurrent drain calls', async () => {
    const pending = [event];
    let deliveryCount = 0;
    const dispatcher = new KnowledgeAuditDispatcher({
      outbox: {
        listPending: async (limit) => pending.slice(0, limit),
        markDelivered: async ({ auditId }) => { if (auditId === event.auditId) pending.splice(0, 1); },
        appendWithinTransaction: () => { throw new Error('unused'); },
        recordDeliveryFailure: async () => {},
      },
      sink: { deliver: async () => { deliveryCount += 1; await Promise.resolve(); } },
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') }, batchSize: 1,
    });
    const results = await Promise.all([dispatcher.drainOnce(), dispatcher.drainOnce()]);
    expect(deliveryCount).toBe(1);
    expect(results.map((result) => result.attempted)).toEqual([1, 0]);
  });

  it('retries the same audit id when sink delivery succeeds but the local acknowledgement fails', async () => {
    const pending = [event];
    const deliveredIds: string[] = [];
    let acknowledgementAttempts = 0;
    let failureAttempts = 0;
    const dispatcher = new KnowledgeAuditDispatcher({
      outbox: {
        listPending: async (limit) => pending.slice(0, limit),
        markDelivered: async ({ auditId }) => {
          acknowledgementAttempts += 1;
          if (acknowledgementAttempts === 1) throw new Error('injected acknowledgement failure');
          const index = pending.findIndex((item) => item.auditId === auditId);
          if (index >= 0) pending.splice(index, 1);
        },
        appendWithinTransaction: () => { throw new Error('unused'); },
        recordDeliveryFailure: async (auditId) => {
          failureAttempts += 1;
          expect(auditId).toBe(event.auditId);
        },
      },
      sink: { deliver: async (audit) => { deliveredIds.push(audit.auditId); } },
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') }, batchSize: 1,
    });

    expect(await dispatcher.drainOnce()).toEqual({ attempted: 1, delivered: 0, failed: 1, pending: true });
    expect(await dispatcher.drainOnce()).toEqual({ attempted: 1, delivered: 1, failed: 0, pending: false });
    expect(deliveredIds).toEqual([event.auditId, event.auditId]);
    expect(acknowledgementAttempts).toBe(2);
    expect(failureAttempts).toBe(1);
  });

  it('wires knowledge writes and the dispatcher through the existing persistence bundle', async () => {
    const scope: KnowledgeScope = {
      targetId: 'bundle-target', projectId: 'bundle-project', deploymentId: 'bundle-deployment', deploymentGeneration: 1,
      targetFingerprint: 'bundle-fingerprint', profileId: 'bundle-profile', profileRevision: 'profile-rev-1',
      scenarioId: 'settlement-failure', scenarioVersion: '1', serviceIds: ['settlement-service'],
      faultTypes: ['high-failure-rate'], environment: 'simulation', dataClass: 'simulated', datasetId: 'bundle-dataset',
    };
    const digest = 'b'.repeat(64);
    const content = { type: 'domain_glossary' as const, terms: [{ term: 'settlement', definition: 'Settlement records.',
      sourceReference: { sourceId: 'bundle-source', sourceVersion: 'v1', digest } }] };
    const revision: SemanticKnowledgeRevision = {
      schemaVersion: 1, id: 'bundle-knowledge', kind: 'semantic', contentRevision: 1, governanceVersion: 1,
      sourceEpoch: 0, status: 'draft', createdAt: '2026-10-10T00:00:00.000Z', scope,
      provenance: { sourceType: 'operator_provided', sourceId: 'bundle-source', sourceVersion: 'v1',
        sourceDigest: digest, importedAt: '2026-10-10T00:00:00.000Z' }, contentDigest: checkpointChecksum(content), content,
    };
    const delivered: string[] = [];
    const bundle = createSqlitePersistence({
      path: ':memory:', clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
      knowledgeReviewAuthority: { resolveFor: async () => ({ actorId: 'reviewer', scope, sourceEpoch: 0,
        sourceDigest: digest, reviewedAt: '2026-10-12T00:00:00.000Z' }) },
      knowledgePublicationActors: { resolveForTarget: async () => ({ actorId: 'publisher' }) },
      knowledgeAuditSink: { deliver: async (audit) => { delivered.push(audit.auditId); } },
    });
    try {
      await bundle.knowledge.registerSource({ sourceId: 'bundle-source', dataDomainId: 'bundle-domain', sourceDigest: digest,
        registeredAt: '2026-10-10T00:00:00.000Z' });
      await bundle.knowledge.saveDraft({ requestId: 'bundle-draft', actorId: 'operator', naturalKey: 'bundle-glossary',
        sourceDomainId: 'bundle-domain', expectedContentRevision: null, expectedGovernanceVersion: null, revision });
      expect(bundle.knowledgeAuditDispatcher).toBeDefined();
      expect(await bundle.knowledgeAuditDispatcher!.drainOnce()).toMatchObject({ delivered: 1, failed: 0, pending: false });
      expect(delivered).toHaveLength(1);
      expect(await bundle.knowledge.listPending(10)).toEqual([]);
    } finally { bundle.close(); }
  });
});
