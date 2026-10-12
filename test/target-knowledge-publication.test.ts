import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, scope, time } from './helpers/target-publication-fixture.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteTargetIdentityStore } from '../src/infrastructure/sqlite/target-identity-store.js';
import { SqliteTargetKnowledgeBindingStore } from '../src/infrastructure/sqlite/target-knowledge-binding-store.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import * as bootstrapExports from '../src/bootstrap/index.js';
import * as applicationExports from '../src/index.js';

it('exports the publication application service and host factory from public entry points', () => {
  expect(bootstrapExports).toHaveProperty('createTargetKnowledgePublicationService');
  expect(applicationExports).toHaveProperty('TargetKnowledgePublicationService');
});

describe.each(['sqlite', 'memory'] as const)('%s authoritative knowledge publication', backend => {
  it('host publication service rejects extra caller authority/configuration and publishes exact references', async () => {
    const f = await fixture(backend);
    try {
      const module = await import('../src/bootstrap/diagnostic-memory.js');
      expect(module).toHaveProperty('createTargetKnowledgePublicationService');
      const service = module.createTargetKnowledgePublicationService({ contexts: f.resolver, queries: f.store, publications: f.publisher });
      const r = await f.approved(1);
      const c = await f.command([r]);
      const request = { requestId: 'service-publish', targetId: scope.targetId, references: c.command.references, expectedPublicationVersion: 0 };
      await expect(service.publish({ ...request, actorId: 'forged' })).rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
      await expect(service.publish({ ...request, scope })).rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
      await expect(service.publish({ ...request, policy: c.command.policy })).rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
      await expect(service.publish({ ...request, endpoint: 'https://untrusted.invalid' })).rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
      await expect(service.publish({ ...request, references: [{ ...request.references[0]!, digest: 'f'.repeat(64) }] }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_DIGEST_MISMATCH' });
      expect(await service.publish(request)).toMatchObject({ publicationVersion: 1, references: request.references });
      await expect(service.publish({ ...request, requestId: 'stale-service-cas' })).rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_CONFLICT' });
      expect((await f.store.list({ targetId: scope.targetId, limit: 50 })).find(a => a.type === 'binding_publication'))
        .toMatchObject({ actorId: 'publisher', scopeDigest: checkpointChecksum(scope) });
      await f.store.transitionKnowledge({ requestId: 'revoke-after-service-publish', actorId: 'operator', knowledgeId: r.id,
        kind: r.kind, contentRevision: 1, expectedGovernanceVersion: 3, nextStatus: 'revoked', occurredAt: time });
      const beforeReplay = await f.store.listPending(50);
      expect(await service.publish(request)).toMatchObject({ publicationVersion: 1 });
      expect(await f.store.listPending(50)).toEqual(beforeReplay);
      expect(await f.store.getExact({ id: r.id, contentRevision: 1, scope })).toBeNull();
    } finally { f.database.close(); }
  });
  it.each(['semantic', 'procedural'] as const)('%s approval is distinct from publication; old snapshots never upgrade and superseded refs are unavailable', async kind => {
    const f = await fixture(backend);
    try {
      const r1 = await f.approved(1, undefined, kind);
      await f.publisher.publishGoverned(await f.command([r1]));
      const old = await f.snapshot();
      const r2 = await f.approved(2, undefined, kind);
      expect(await f.store.getExact({ id: r1.id, contentRevision: 1, scope })).not.toBeNull();
      expect((await f.snapshot()).knowledgeRefs).toEqual(old.knowledgeRefs);
      await f.publisher.publishGoverned(await f.command([r2], 1, 'publish-r2'));
      const next = await f.snapshot();
      expect(next.knowledgeRefs[0]?.version).toBe('2');
      expect(next.publicationVersion).toBe(2);
      expect(next.profile.revision).toBe(old.profile.revision);
      expect(old.knowledgeRefs[0]?.version).toBe('1');
      expect(old.publicationVersion).toBe(1);
      expect(await f.store.inspectExact({ id: r1.id, contentRevision: 1, scope, now: time })).toMatchObject({ status: 'superseded' });
      expect(await f.store.getExact({ id: r1.id, contentRevision: 1, scope })).toBeNull();
      expect(await f.store.search({ kind, scope, references: old.knowledgeRefs, query: 'settlement', limit: 10, now: time })).toEqual([]);
    } finally { f.database.close(); }
  });
  it('reads publication and host policy in one authoritative selection', async () => {
    const f = await fixture(backend);
    try {
      expect(f.binding).toHaveProperty('inspectPublishedSelection');
      const policy = await f.identity.compareAndSet({ targetId: scope.targetId, policyVersion: 'policy/v1', requirements: [], expectedPolicyEpoch: null, publishedAt: time });
      const selection = await f.binding.inspectPublishedSelection(scope.targetId);
      expect(selection.hostPolicy).toEqual(policy);
      expect(selection.binding.publication).toBeNull();
    } finally { f.database.close(); }
  });
  it.each(['scope', 'policy', 'source', 'epoch', 'expiry', 'governance'] as const)('rejects the %s race after async actor resolution', async race => {
    const f = await fixture(backend);
    try {
      const r = await f.approved(1, '2026-10-14T00:00:00.000Z');
      const c = await f.command([r]);
      f.actor(async () => {
        if (race === 'scope') await createStaticTargetResolver(f.resolverOptions);
        if (race === 'policy') await f.identity.compareAndSet({ targetId: scope.targetId, policyVersion: 'changed/v2', requirements: [], expectedPolicyEpoch: null, publishedAt: time });
        if (race === 'source' || race === 'epoch') await f.store.transitionSource({ requestId: 'source-change', actorId: 'operator', sourceId: 'runbook',
          dataDomainId: 'domain-one', expectedSourceEpoch: 0, transition: race === 'source' ? 'revoked' : 'revalidated',
          sourceDigest: r.provenance.sourceDigest, occurredAt: time });
        if (race === 'expiry') f.advance('2026-10-14T00:00:00.000Z');
        if (race === 'governance') await f.store.transitionKnowledge({ requestId: 'revoke', actorId: 'operator', knowledgeId: r.id,
          kind: r.kind, contentRevision: 1, expectedGovernanceVersion: 3, nextStatus: 'revoked', occurredAt: time });
      });
      const code = { scope: 'KNOWLEDGE_SCOPE_INVALID', policy: 'KNOWLEDGE_PUBLICATION_CONFLICT', source: 'KNOWLEDGE_SOURCE_REVOKED',
        epoch: 'KNOWLEDGE_SOURCE_REVOKED', expiry: 'KNOWLEDGE_EXPIRED', governance: 'KNOWLEDGE_APPROVAL_DENIED' }[race];
      await expect(f.publisher.publishGoverned(c)).rejects.toMatchObject({ code });
      expect(await f.binding.get(scope.targetId)).toBeNull();
      expect((await f.store.list({ targetId: scope.targetId, limit: 50 })).filter(a => a.type === 'binding_publication')).toEqual([]);
    } finally { f.database.close(); }
  });
  it('allows one CAS winner; receipts never reactivate revoked revisions', async () => {
    const f = await fixture(backend);
    try {
      const r = await f.approved(1);
      const c = await f.command([r]);
      const results = await Promise.allSettled([f.publisher.publishGoverned(c), f.publisher.publishGoverned({ ...c, command: { ...c.command, requestId: 'other-publish' } })]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      const before = await f.store.listPending(50);
      expect(await f.publisher.publishGoverned(c)).toMatchObject({ publicationVersion: 1 });
      expect(await f.store.listPending(50)).toEqual(before);
      await f.store.transitionKnowledge({ requestId: 'revoke', actorId: 'operator', knowledgeId: r.id, kind: r.kind,
        contentRevision: 1, expectedGovernanceVersion: 3, nextStatus: 'revoked', occurredAt: time });
      await f.publisher.publishGoverned(c);
      expect(await f.store.inspectExact({ id: r.id, contentRevision: 1, scope, now: time })).toMatchObject({ status: 'revoked' });
      await expect(f.publisher.publishGoverned(await f.command([r], 1, 'reactivate'))).rejects.toBeDefined();
    } finally { f.database.close(); }
  });
  it('source revocation immediately disables the old binding even when replacement publication fails', async () => {
    const f = await fixture(backend);
    try {
      const r1 = await f.approved(1);
      const first = await f.publisher.publishGoverned(await f.command([r1]));
      const r2 = await f.approved(2);
      const replacement = await f.command([r2], 1, 'replacement');
      f.actor(async () => { await f.store.transitionSource({ requestId: 'withdraw-source', actorId: 'operator',
        sourceId: r1.provenance.sourceId, dataDomainId: 'domain-one', expectedSourceEpoch: 0,
        transition: 'revoked', sourceDigest: r1.provenance.sourceDigest, occurredAt: time }); });
      await expect(f.publisher.publishGoverned(replacement)).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
      expect(await f.binding.get(scope.targetId)).toEqual(first);
      expect(await f.store.getExact({ id: r1.id, contentRevision: 1, scope })).toBeNull();
      expect(await f.store.search({ kind: 'semantic', scope, references: first.references, query: 'settlement', limit: 10, now: time })).toEqual([]);
    } finally { f.database.close(); }
  });
  it.each(['audit', 'outbox'] as const)('rolls back binding/supersede/index/history on %s failure', async table => {
    const f = await fixture(backend);
    try {
      const r1 = await f.approved(1);
      const first = await f.publisher.publishGoverned(await f.command([r1]));
      const r2 = await f.approved(2);
      const pending = await f.store.listPending(50);
      if (backend === 'sqlite') f.database.raw.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON diagnostic_knowledge_${table === 'audit' ? 'audits' : 'outbox'}
        WHEN ${table === 'audit' ? "json_extract(NEW.audit_json, '$.type') = 'binding_publication'"
          : "NEW.audit_id IN (SELECT audit_id FROM diagnostic_knowledge_audits WHERE json_extract(audit_json, '$.type') = 'binding_publication')"}
        BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`);
      else {
        const append = f.memory.appendWithinTransaction.bind(f.memory);
        vi.spyOn(f.memory, 'appendWithinTransaction').mockImplementation(event => {
          if (event.type === 'binding_publication' && table === 'audit') throw new Error('injected publication failure');
          append(event);
          if (event.type === 'binding_publication') throw new Error('injected publication failure');
        });
      }
      await expect(f.publisher.publishGoverned(await f.command([r2], 1, 'publish-r2'))).rejects.toThrow('injected publication failure');
      expect(await f.binding.get(scope.targetId)).toEqual(first);
      expect(await f.store.getExact({ id: r1.id, contentRevision: 1, scope })).not.toBeNull();
      expect(await f.store.listPending(50)).toEqual(pending);
      expect(await f.store.search({ kind: 'semantic', scope, references: first.references, query: 'settlement', limit: 10, now: time })).toHaveLength(1);
      if (backend === 'sqlite') expect(f.database.raw.prepare('SELECT COUNT(*) AS n FROM diagnostic_knowledge_publications').get()).toEqual({ n: 1 });
    } finally { vi.restoreAllMocks(); f.database.close(); }
  });
});

it('reopens SQLite publication; Catalog initial candidates cannot overwrite it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't4b-publication-'));
  const f = await fixture('sqlite', join(directory, 'state.sqlite'));
  try {
    const r = await f.approved(1);
    const published = await f.publisher.publishGoverned(await f.command([r]));
    const old = await f.snapshot();
    f.database.close();
    const database = SqliteDatabase.open(join(directory, 'state.sqlite'));
    try {
      const identity = new SqliteTargetIdentityStore(database);
      const binding = new SqliteTargetKnowledgeBindingStore(database, { actors: { resolveForTarget: async () => ({ actorId: 'operator' }) } });
      const resolver = await createStaticTargetResolver({ ...f.resolverOptions, identityRegistry: identity, knowledgePolicies: identity, knowledgePublications: binding });
      const next = await resolver.resolve({ targetId: scope.targetId, capturedAt: time, signal: new AbortController().signal });
      expect(await binding.get(scope.targetId)).toEqual(published);
      expect(next.knowledgeRefs).toEqual(old.knowledgeRefs);
      expect(next.publicationVersion).toBe(1);
    } finally { database.close(); }
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
