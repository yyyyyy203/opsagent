import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { migrateSqlite } from '../src/infrastructure/sqlite/migrations.js';

describe('governed knowledge migration', () => {
  it('appends knowledge storage after v7 without changing earlier migration behavior', () => {
    const raw = new Database(':memory:');
    try {
      migrateSqlite(raw, 6);
      expect(raw.pragma('user_version', { simple: true })).toBe(6);
      migrateSqlite(raw, 7);
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      migrateSqlite(raw, 8);
      expect(raw.pragma('user_version', { simple: true })).toBe(8);
      for (const table of [
        'diagnostic_knowledge_items', 'diagnostic_knowledge_revisions', 'diagnostic_knowledge_revision_states',
        'diagnostic_knowledge_sources', 'diagnostic_knowledge_reviews', 'target_knowledge_bindings',
        'diagnostic_knowledge_publications', 'diagnostic_knowledge_fts', 'diagnostic_knowledge_audits',
        'diagnostic_knowledge_outbox',
      ]) {
        expect(raw.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table)).toEqual({ name: table });
      }
    } finally { raw.close(); }
  });

  it('upgrades an existing v7 database to v8 and can reopen it', () => {
    const raw = new Database(':memory:');
    try {
      migrateSqlite(raw, 7);
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      migrateSqlite(raw);
      expect(raw.pragma('user_version', { simple: true })).toBe(8);
    } finally { raw.close(); }
  });

  it('rolls back all v8 DDL and keeps version 7 if an object conflicts', () => {
    const raw = new Database(':memory:');
    try {
      migrateSqlite(raw, 7);
      raw.exec('CREATE TABLE diagnostic_knowledge_outbox (collision TEXT)');
      expect(() => migrateSqlite(raw)).toThrow();
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'diagnostic_knowledge_items'").get()).toBeUndefined();
    } finally { raw.close(); }
  });

  it('opens a fresh database with v8 applied through the normal persistence entry point', () => {
    const database = SqliteDatabase.open(':memory:');
    try { expect(database.raw.pragma('user_version', { simple: true })).toBe(8); }
    finally { database.close(); }
  });

  it('stores source identity, current-head CAS, and ordered append-only audit metadata', () => {
    const raw = new Database(':memory:');
    try {
      migrateSqlite(raw);
      const itemColumns = raw.pragma('table_info(diagnostic_knowledge_items)') as { name: string }[];
      const revisionColumns = raw.pragma('table_info(diagnostic_knowledge_revisions)') as { name: string }[];
      const auditColumns = raw.pragma('table_info(diagnostic_knowledge_audits)') as { name: string }[];
      expect(itemColumns.map((column) => column.name)).toContain('latest_content_revision');
      expect(revisionColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['source_id', 'source_domain_id', 'source_digest']));
      expect(auditColumns.map((column) => column.name)).toContain('sequence');
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='diagnostic_knowledge_audits_no_update'").get()).toEqual({ name: 'diagnostic_knowledge_audits_no_update' });
    } finally { raw.close(); }
  });

  it('rolls back a failed v8 open and can reopen after the conflicting schema object is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-knowledge-migration-'));
    const path = join(root, 'state.sqlite');
    try {
      const raw = new Database(path);
      migrateSqlite(raw, 7);
      raw.exec('CREATE TABLE diagnostic_knowledge_outbox (collision TEXT)');
      raw.close();
      expect(() => SqliteDatabase.open(path)).toThrow();

      const repair = new Database(path);
      expect(repair.pragma('user_version', { simple: true })).toBe(7);
      repair.exec('DROP TABLE diagnostic_knowledge_outbox');
      repair.close();
      const recovered = SqliteDatabase.open(path);
      try { expect(recovered.raw.pragma('user_version', { simple: true })).toBe(8); }
      finally { recovered.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
