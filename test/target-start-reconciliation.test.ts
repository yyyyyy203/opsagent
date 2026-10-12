import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteDurableStateStore } from '../src/infrastructure/sqlite/durable-state-store.js';
import { migrateSqlite } from '../src/infrastructure/sqlite/migrations.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import type { Clock } from '../src/contracts/common.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Target start reconciliation schema', () => {
  it('extends the unreleased v7 migration with durable owner, epoch, lease, and state claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-start-'));
    roots.push(root);
    const database = SqliteDatabase.open(join(root, 'start.sqlite'));

    try {
      expect(database.raw.pragma('user_version', { simple: true })).toBe(7);
      const columns = database.raw.prepare('PRAGMA table_info(target_run_start_claims)').all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual([
        'request_id', 'run_id', 'target_id', 'request_digest', 'owner_id', 'claim_epoch', 'lease_until', 'state',
      ]);
    } finally {
      database.close();
    }
  });

  it('rolls back all v7 DDL and preserves schema version when migration fails partway through', () => {
    const database = new Database(':memory:');
    try {
      database.pragma('user_version = 6');
      database.exec('CREATE TABLE target_identity_audit (preexisting INTEGER)');

      expect(() => migrateSqlite(database)).toThrow();

      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((table) => table.name);
      expect(tableNames).toContain('target_identity_audit');
      expect(tableNames).not.toContain('target_run_requests');
      expect(tableNames).not.toContain('target_snapshots');
      expect(tableNames).not.toContain('run_target_bindings');
      expect(tableNames).not.toContain('target_identity_registry_state');
      expect(database.pragma('user_version', { simple: true })).toBe(6);
    } finally {
      database.close();
    }
  });

  it('preserves an uncommitted owner lease across restart and fences it after expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-start-restart-'));
    roots.push(root);
    const path = join(root, 'start.sqlite');
    const clock: Clock = { now: () => new Date('2026-10-11T10:00:00.000Z') };
    const identity = { requestId: 'restart-request', runId: 'restart-run', targetId: 'market-a-sim',
      requestDigest: `sha256:v1:${'a'.repeat(64)}` };
    const first = createSqlitePersistence({ path, clock });
    let originalEpoch = 0;
    try {
      await first.targetBindings.reserveRequest({ ...identity, createdAt: '2026-10-11T10:00:00.000Z' });
      const claimed = await first.targetStarts.claimStart({ ...identity, ownerId: 'owner-before-restart',
        now: '2026-10-11T10:00:00.000Z', leaseUntil: '2026-10-11T10:00:01.000Z' });
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw new Error('expected initial start claim');
      originalEpoch = claimed.claim.epoch;
    } finally {
      first.close();
    }

    const restarted = createSqlitePersistence({ path, clock });
    try {
      expect(await restarted.targetStarts.claimStart({ ...identity, ownerId: 'owner-after-restart',
        now: '2026-10-11T10:00:00.500Z', leaseUntil: '2026-10-11T10:01:00.000Z' })).toEqual({ status: 'busy' });
      expect(await restarted.targetStarts.reconcileStart(identity)).toEqual({ status: 'unknown' });
      const takeover = await restarted.targetStarts.claimStart({ ...identity, ownerId: 'owner-after-restart',
        now: '2026-10-11T10:00:02.000Z', leaseUntil: '2026-10-11T10:01:00.000Z' });
      expect(takeover.status).toBe('claimed');
      if (takeover.status !== 'claimed') throw new Error('expected fenced takeover');
      expect(takeover.claim.epoch).toBe(originalEpoch + 1);
      expect(await restarted.targetStarts.reconcileStart(identity)).toEqual({ status: 'unknown' });
    } finally {
      restarted.close();
    }
  });

  it('reports unknown rather than throwing when a persisted request identity is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-target-start-corrupt-request-'));
    roots.push(root);
    const database = SqliteDatabase.open(join(root, 'start.sqlite'));
    const clock: Clock = { now: () => new Date('2026-10-11T10:00:00.000Z') };
    const store = new SqliteDurableStateStore(database, clock);
    const identity = { requestId: 'corrupt-request', runId: 'corrupt-run', targetId: 'market-a-sim',
      requestDigest: `sha256:v1:${'b'.repeat(64)}` };

    try {
      await store.reserveRequest({ ...identity, createdAt: '2026-10-11T10:00:00.000Z' });
      database.raw.prepare('UPDATE target_run_requests SET request_digest = ? WHERE request_id = ?')
        .run('invalid-digest', identity.requestId);

      await expect(store.reconcileStart(identity)).resolves.toEqual({ status: 'unknown' });
    } finally {
      database.close();
    }
  });
});
