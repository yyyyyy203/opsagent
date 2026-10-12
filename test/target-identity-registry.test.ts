import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Clock, type TargetIdentityCandidate, type TargetIdentityCatalogPublication,
  type TargetKnowledgePolicyWrite } from '../src/contracts/index.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { SqliteTargetIdentityStore } from '../src/infrastructure/sqlite/target-identity-store.js';
import { InMemoryTargetIdentityStore } from '../src/storage/in-memory-target-identity-store.js';
import { applyTargetIdentityCatalog, defaultTargetKnowledgePolicy, emptyTargetIdentitySnapshot }
  from '../src/storage/target-identity-state.js';

const roots: string[] = [];
const publishedAt = '2026-10-11T10:00:00.000Z';
const auditTime = '2026-10-11T10:01:00.000Z';
const clock: Clock = { now: () => new Date(auditTime) };

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentops-target-identity-'));
  roots.push(root);
  return join(root, 'identity.sqlite');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('Target identity persistence', () => {
  it('adds v7 identity, knowledge-policy, and start-claim tables without changing earlier versions', async () => {
    const database = SqliteDatabase.open(await databasePath());

    try {
      expect(database.raw.pragma('user_version', { simple: true })).toBe(8);
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'target_identity_registry_state', 'target_identity_audit', 'target_knowledge_policies', 'target_run_start_claims'
        )
        ORDER BY name
      `).all()).toEqual([
        { name: 'target_identity_audit' },
        { name: 'target_identity_registry_state' },
        { name: 'target_knowledge_policies' },
        { name: 'target_run_start_claims' },
      ]);
    } finally {
      database.close();
    }
  });

  it('persists accepted identities, policy overrides, and append-only audit across reopen', async () => {
    const path = await databasePath();
    const first = SqliteDatabase.open(path);
    const firstStore = new SqliteTargetIdentityStore(first, { clock });
    let publication: TargetIdentityCatalogPublication | undefined;
    try {
      publication = await firstStore.publishCatalog({
        expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt,
      });
      await firstStore.compareAndSet(policyWrite({ expectedPolicyEpoch: null }));
    } finally {
      first.close();
    }

    const reopened = SqliteDatabase.open(path);
    const store = new SqliteTargetIdentityStore(reopened, { clock });
    try {
      expect(await store.readSnapshot()).toMatchObject({
        version: 1,
        targets: [{ targetId: 'target-a', status: 'active', profileId: 'profile-a' }],
        fingerprints: [{ targetFingerprint: 'fingerprint-a', deploymentGeneration: 1 }],
        sources: [{ sourceId: 'prometheus', dataDomainId: 'domain-a', sourceGeneration: 2 }],
      });
      expect(await store.get('target-a')).toMatchObject({ targetId: 'target-a', policyEpoch: 1, policyVersion: 'policy-a' });
      const audit = await store.listAudit('target-a');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        sequence: 1, targetId: 'target-a', action: 'registered', registryVersion: 1,
        recordedAt: auditTime,
      });
      expect(audit[0]?.identityDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(publication).toMatchObject({ version: 1, acceptedTargetIds: ['target-a'], rejected: [] });
    } finally {
      reopened.close();
    }
  });

  it('rejects conflicting fingerprint, source generation/domain, and profile ownership without replacing accepted history', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteTargetIdentityStore(database, { clock });
    try {
      await store.publishCatalog({ expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt });

      const targetConflict = await store.publishCatalog({
        expectedVersion: 1,
        presentTargetIds: ['target-a'],
        candidates: [candidate({ projectId: 'project-reassigned', deploymentId: 'deployment-reassigned',
          targetFingerprint: 'fingerprint-reassigned' })],
        publishedAt,
      });
      expect(targetConflict.rejected).toEqual([{ targetId: 'target-a', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);

      const fingerprintConflict = await store.publishCatalog({
        expectedVersion: 2,
        presentTargetIds: ['target-a', 'target-b'],
        candidates: [candidate({ targetId: 'target-b', profileId: 'profile-b', deploymentGeneration: 2,
          sourceIdentities: [sourceIdentity({ dataDomainId: 'domain-b', sourceGeneration: 3 })] })],
        publishedAt,
      });
      expect(fingerprintConflict.rejected).toEqual([{ targetId: 'target-b', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);

      const sourceConflict = await store.publishCatalog({
        expectedVersion: 3,
        presentTargetIds: ['target-a', 'target-c'],
        candidates: [candidate({ targetId: 'target-c', profileId: 'profile-c', targetFingerprint: 'fingerprint-c',
          projectId: 'project-c', deploymentId: 'deployment-c',
          sourceIdentities: [sourceIdentity({ dataDomainId: 'domain-changed' })] })],
        publishedAt,
      });
      expect(sourceConflict.rejected).toEqual([{ targetId: 'target-c', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);

      const rollbackConflict = await store.publishCatalog({
        expectedVersion: 4,
        presentTargetIds: ['target-a'],
        candidates: [candidate({ sourceIdentities: [sourceIdentity({ sourceGeneration: 1 })] })],
        publishedAt,
      });
      expect(rollbackConflict.rejected).toEqual([{ targetId: 'target-a', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);

      const ownerConflict = await store.publishCatalog({
        expectedVersion: 5,
        presentTargetIds: ['target-a', 'target-d'],
        candidates: [candidate({ targetId: 'target-d', targetFingerprint: 'fingerprint-d', profileId: 'profile-a',
          projectId: 'project-d', deploymentId: 'deployment-d',
          sourceIdentities: [sourceIdentity({ sourceId: 'logs', dataDomainId: 'logs-domain', sourceGeneration: 1 })] })],
        publishedAt,
      });
      expect(ownerConflict.rejected).toEqual([{ targetId: 'target-d', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);

      const snapshot = await store.readSnapshot();
      expect(snapshot.targets).toEqual([{
        targetId: 'target-a', projectId: 'project-a', deploymentId: 'deployment-a', deploymentGeneration: 1,
        scenarioId: 'window_failure_rate.v1', primaryServiceId: 'checkout', profileId: 'profile-a', status: 'active',
      }]);
      expect(snapshot.fingerprints).toHaveLength(1);
      expect(snapshot.sources).toEqual([sourceIdentity()]);
      expect(snapshot.profileOwners).toEqual([{ profileId: 'profile-a', targetId: 'target-a' }]);
      expect(await store.listAudit()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('audits a new source identity fingerprint for an existing Target deterministically', () => {
    const initial = applyTargetIdentityCatalog(emptyTargetIdentitySnapshot(), {
      expectedVersion: 0,
      presentTargetIds: ['target-a'],
      candidates: [candidate()],
      publishedAt,
    });
    const updateInput = {
      expectedVersion: 1,
      presentTargetIds: ['target-a'],
      candidates: [candidate({
        targetFingerprint: 'fingerprint-b',
        sourceIdentities: [sourceIdentity({ sourceGeneration: 3 })],
      })],
      publishedAt: auditTime,
    };

    const updated = applyTargetIdentityCatalog(initial.snapshot, updateInput);
    const replayed = applyTargetIdentityCatalog(initial.snapshot, updateInput);

    expect(updated).toEqual(replayed);
    expect(updated.publication.acceptedTargetIds).toEqual(['target-a']);
    expect(updated.audit).toEqual([expect.objectContaining({
      targetId: 'target-a', action: 'updated', registryVersion: 2, recordedAt: auditTime,
    })]);
  });

  it('rejects URL-shaped source data-domain IDs before they enter the durable registry', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteTargetIdentityStore(database, { clock });
    const secretEndpoint = 'https://internal.example.invalid/private';
    try {
      const result = await store.publishCatalog({
        expectedVersion: 0,
        presentTargetIds: ['target-a'],
        candidates: [candidate({ sourceIdentities: [sourceIdentity({ dataDomainId: secretEndpoint })] })],
        publishedAt,
      });

      expect(result.acceptedTargetIds).toEqual([]);
      expect(result.rejected).toEqual([{ targetId: 'target-a', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);
      expect(await store.readSnapshot()).toEqual({ ...emptyTargetIdentitySnapshot(), version: 1 });
      expect(await store.listAudit()).toEqual([]);
      const persisted = database.raw.prepare('SELECT snapshot_json FROM target_identity_registry_state').get() as {
        snapshot_json: string;
      };
      expect(persisted.snapshot_json).not.toContain(secretEndpoint);
    } finally {
      database.close();
    }
  });

  it('keeps tombstones permanent and rejects stale registry versions', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteTargetIdentityStore(database, { clock });
    try {
      await store.publishCatalog({ expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt });
      await expect(store.publishCatalog({
        expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt,
      })).rejects.toMatchObject({ code: 'TARGET_IDENTITY_CONFLICT' });

      await store.publishCatalog({ expectedVersion: 1, presentTargetIds: [], candidates: [], publishedAt });
      const reuse = await store.publishCatalog({ expectedVersion: 2, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt });
      expect(reuse.rejected).toEqual([{ targetId: 'target-a', reasonCode: 'TARGET_IDENTITY_CONFLICT' }]);
      expect((await store.readSnapshot()).targets[0]).toMatchObject({ targetId: 'target-a', status: 'tombstoned', tombstonedAt: publishedAt });
      expect((await store.listAudit('target-a')).map(record => record.action)).toEqual(['registered', 'tombstoned']);

      expect(() => database.raw.prepare('UPDATE target_identity_audit SET target_id = ? WHERE sequence = 1').run('changed'))
        .toThrow(/append-only/u);
      expect(() => database.raw.prepare('DELETE FROM target_identity_audit WHERE sequence = 1').run())
        .toThrow(/append-only/u);
      expect((await store.listAudit('target-a')).map(record => record.sequence)).toEqual([1, 2]);
    } finally {
      database.close();
    }
  });

  it('linearizes registry compare-and-set across two SQLite connections', async () => {
    const path = await databasePath();
    const leftDatabase = SqliteDatabase.open(path);
    const rightDatabase = SqliteDatabase.open(path);
    const left = new SqliteTargetIdentityStore(leftDatabase, { clock });
    const right = new SqliteTargetIdentityStore(rightDatabase, { clock });
    try {
      const attempts = await Promise.allSettled([
        left.publishCatalog({ expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt }),
        right.publishCatalog({ expectedVersion: 0, presentTargetIds: ['target-b'], candidates: [candidate({
          targetId: 'target-b', targetFingerprint: 'fingerprint-b', profileId: 'profile-b',
          projectId: 'project-b', deploymentId: 'deployment-b',
          sourceIdentities: [sourceIdentity({ sourceId: 'logs', dataDomainId: 'logs-domain', sourceGeneration: 1 })],
        })], publishedAt }),
      ]);

      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find(result => result.status === 'rejected');
      expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'TARGET_IDENTITY_CONFLICT' } });
      expect((await left.readSnapshot()).version).toBe(1);
    } finally {
      leftDatabase.close();
      rightDatabase.close();
    }
  });

  it('defaults missing knowledge policy to optional and enforces epoch CAS and validation', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteTargetIdentityStore(database, { clock });
    try {
      expect(await store.get('target-a')).toBeNull();
      expect(defaultTargetKnowledgePolicy('target-a')).toEqual({
        schemaVersion: 1, targetId: 'target-a', policyVersion: 'default/v1', policyEpoch: 0,
        defaultRequiredness: 'optional', requirements: [],
      });

      const first = await store.compareAndSet(policyWrite({ expectedPolicyEpoch: null }));
      expect(first).toMatchObject({ policyEpoch: 1, defaultRequiredness: 'optional' });
      await expect(store.compareAndSet(policyWrite({ expectedPolicyEpoch: null })))
        .rejects.toMatchObject({ code: 'TARGET_IDENTITY_CONFLICT' });
      const second = await store.compareAndSet(policyWrite({ expectedPolicyEpoch: 1, policyVersion: 'policy-b' }));
      expect(second).toMatchObject({ policyEpoch: 2, policyVersion: 'policy-b' });
      await expect(store.compareAndSet(policyWrite({ expectedPolicyEpoch: 1, policyVersion: 'policy-c' })))
        .rejects.toMatchObject({ code: 'TARGET_IDENTITY_CONFLICT' });
      await expect(store.compareAndSet(policyWrite({ expectedPolicyEpoch: 2, digest: 'not-a-digest' })))
        .rejects.toMatchObject({ code: 'TARGET_CATALOG_INVALID' });
      const versioned = await store.compareAndSet(policyWrite({
        expectedPolicyEpoch: 2,
        policyVersion: 'team/policy.v1',
        requirements: [{ id: 'runbook-a', version: 'team/runbook.v1', digest: 'c'.repeat(64),
          requiredness: 'required', knowledgeClass: 'semantic' }],
      }));
      expect(versioned).toMatchObject({ policyEpoch: 3, policyVersion: 'team/policy.v1',
        requirements: [{ version: 'team/runbook.v1' }] });
      expect(await store.get('target-a')).toEqual(versioned);
    } finally {
      database.close();
    }
  });

  it('does not persist unknown endpoint or credential fields from runtime inputs', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteTargetIdentityStore(database, { clock });
    const secret = 'endpoint-secret-sentinel-7e2f';
    try {
      const unsafeCandidate = {
        ...candidate(), endpoint: `https://${secret}.internal`, apiKey: secret,
        sourceIdentities: [{ ...sourceIdentity(), endpoint: `https://${secret}.internal`, secretRef: secret }],
      } as unknown as TargetIdentityCandidate;
      await store.publishCatalog({ expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [unsafeCandidate], publishedAt });
      const rotatedCandidate = {
        ...candidate(), endpoint: 'https://rotated-endpoint.internal', apiKey: 'rotated-secret',
        sourceIdentities: [{ ...sourceIdentity(), endpoint: 'https://rotated-endpoint.internal', secretRef: 'rotated-secret' }],
      } as unknown as TargetIdentityCandidate;
      const rotation = await store.publishCatalog({
        expectedVersion: 1, presentTargetIds: ['target-a'], candidates: [rotatedCandidate], publishedAt,
      });
      expect(rotation.acceptedTargetIds).toEqual(['target-a']);
      expect(await store.listAudit('target-a')).toHaveLength(1);

      const unsafePolicy = {
        ...policyWrite({ expectedPolicyEpoch: null }), apiKey: secret,
        requirements: [{ ...policyWrite({ expectedPolicyEpoch: null }).requirements[0], endpoint: secret, secretRef: secret }],
      } as unknown as TargetKnowledgePolicyWrite;
      await store.compareAndSet(unsafePolicy);

      const persisted = JSON.stringify({
        registry: database.raw.prepare('SELECT snapshot_json FROM target_identity_registry_state').get(),
        policies: database.raw.prepare('SELECT policy_json FROM target_knowledge_policies').get(),
        audit: database.raw.prepare('SELECT * FROM target_identity_audit').all(),
      });
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain('endpoint');
      expect(persisted).not.toContain('secretRef');
      expect(persisted).not.toContain('apiKey');
    } finally {
      database.close();
    }
  });

  it('shares both ports in memory and stamps audit from the injected clock', async () => {
    const store = new InMemoryTargetIdentityStore({ clock });
    const publication = await store.publishCatalog({
      expectedVersion: 0, presentTargetIds: ['target-a'], candidates: [candidate()], publishedAt,
    });
    const policy = await store.compareAndSet(policyWrite({ expectedPolicyEpoch: null }));

    expect(publication.acceptedTargetIds).toEqual(['target-a']);
    expect((await store.readSnapshot()).version).toBe(1);
    expect(await store.get(policy.targetId)).toEqual(policy);
    expect((await store.listAudit())[0]?.recordedAt).toBe(auditTime);
  });

  it('exposes both durable ports from the host persistence bundle', async () => {
    const bundle = createSqlitePersistence({ path: await databasePath(), clock });
    try {
      expect(typeof bundle.targetIdentityRegistry.publishCatalog).toBe('function');
      expect(typeof bundle.targetKnowledgePolicies.compareAndSet).toBe('function');
      expect(bundle.targetIdentityRegistry).toBe(bundle.targetKnowledgePolicies);
    } finally {
      bundle.close();
    }
  });
});

function candidate(overrides: Partial<TargetIdentityCandidate> = {}): TargetIdentityCandidate {
  return {
    targetId: 'target-a', projectId: 'project-a', deploymentId: 'deployment-a', deploymentGeneration: 1,
    scenarioId: 'window_failure_rate.v1', primaryServiceId: 'checkout', profileId: 'profile-a',
    targetFingerprint: 'fingerprint-a', dataClass: 'live', sourceIdentities: [sourceIdentity()], ...overrides,
  };
}

function sourceIdentity(overrides: Partial<TargetIdentityCandidate['sourceIdentities'][number]> = {}) {
  return {
    sourceId: 'prometheus', dataDomainId: 'domain-a', sourceGeneration: 2,
    permissionScopeDigest: 'a'.repeat(64), ...overrides,
  };
}

function policyWrite(overrides: Partial<TargetKnowledgePolicyWrite> & { digest?: string } = {}): TargetKnowledgePolicyWrite {
  const { digest = 'b'.repeat(64), ...writeOverrides } = overrides;
  return {
    targetId: 'target-a', policyVersion: 'policy-a', expectedPolicyEpoch: null,
    publishedAt, requirements: [{ id: 'runbook-a', version: '1.0.0', digest, requiredness: 'required', knowledgeClass: 'semantic' }],
    ...writeOverrides,
  };
}
