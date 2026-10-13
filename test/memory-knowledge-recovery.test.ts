import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, now } from './helpers/memory-coordinator-fixture.js';
import { MemoryCoordinator } from '../src/memory/memory-coordinator.js';
import { parseAgentContext } from '../src/storage/durable-codec.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { InMemoryInspectionQueryService } from '../src/storage/in-memory-inspection-query.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('safe knowledge checkpoint and read-model recovery', () => {
  it('roundtrips only versioned reference identities and qualification and rejects persisted knowledge text', async () => {
    const f = await fixture(); const coordinator = new MemoryCoordinator(f.options);
    const view = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    const context = { ...f.context, knowledgeSelection: view.selection, knowledgeQualification: view.qualification };
    const restored = parseAgentContext(context);
    expect(restored.knowledgeSelection).toEqual(view.selection);
    expect(JSON.stringify(restored)).not.toContain('A completed settlement');
    expect(() => parseAgentContext({ ...context, knowledgeSelection: { ...view.selection, content: 'unsafe' } })).toThrow();
    expect(parseAgentContext(f.context, 4).knowledgeSelection).toBeUndefined();
  });
  it.each(['sqlite', 'memory'] as const)('projects final qualification safely through %s queries', async backend => {
    const f = await fixture(); f.setState({ ...f.getState(), status: 'revoked' });
    const view = await new MemoryCoordinator(f.options).prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    const context = { ...f.context, status: 'completed' as const, knowledgeSelection: view.selection, knowledgeQualification: view.qualification };
    const persistence = createSqlitePersistence({ path: ':memory:', clock: { now: () => new Date(now) } });
    const memory = new InMemoryDurableState({ now: () => new Date(now) });
    const state = backend === 'sqlite' ? persistence : memory;
    try {
      await state.checkpoints.save(context, null);
      const query = backend === 'sqlite' ? persistence.queries : new InMemoryInspectionQueryService(new InMemoryEventMessageStore(), memory.checkpoints, memory.evidence);
      const detail = await query.getRun(context.runId);
      expect(detail?.knowledgeQualification).toMatchObject({ schemaVersion: 1, diagnosisReady: false,
        missingKnowledge: [{ reasonCode: 'KNOWLEDGE_REVOKED', requiredness: 'required' }] });
      expect(detail?.evidenceIds).toEqual([]); expect(detail?.missingEvidence).toEqual([]);
      expect(JSON.stringify(detail)).not.toContain('A completed settlement');
      const restored = await state.checkpoints.load(context.runId);
      expect(restored?.context.knowledgeSelection?.references[0]?.version).toBe('1');
    } finally { persistence.close(); }
  });

  it('reopens a real SQLite checkpoint and revalidates the frozen reference after revocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-knowledge-recovery-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const f = await fixture();
    const coordinator = new MemoryCoordinator(f.options);
    const originalView = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    const safeCheckpoint = { ...f.context, status: 'paused' as const,
      knowledgeSelection: originalView.selection, knowledgeQualification: originalView.qualification };
    const first = createSqlitePersistence({ path, clock: { now: () => new Date(now) } });
    try { await first.checkpoints.save(safeCheckpoint, null); }
    finally { first.close(); }

    f.setState({ ...f.getState(), status: 'revoked' });
    const reopened = createSqlitePersistence({ path, clock: { now: () => new Date(now) } });
    try {
      const restored = await reopened.checkpoints.load(f.context.runId);
      expect(restored?.context.knowledgeSelection).toEqual(originalView.selection);
      expect(JSON.stringify(restored?.context)).not.toContain('A completed settlement');

      const recoveredView = await coordinator.prepare({ context: restored!.context, snapshot: f.snapshot, text: '' }, f.operation);
      expect(recoveredView.selection.references).toEqual(originalView.selection.references);
      expect(recoveredView.qualification).toMatchObject({ diagnosisReady: false,
        missingKnowledge: [{ reasonCode: 'KNOWLEDGE_REVOKED', requiredness: 'required' }] });
      expect(recoveredView.messages).toEqual([]);
      expect(f.searched).toEqual([['glossary']]);
      expect(JSON.stringify(recoveredView.selection)).not.toMatch(/approval|approved/i);
    } finally { reopened.close(); }
  });
});
