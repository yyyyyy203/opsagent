import type { Clock } from '../contracts/common.js';
import type { DiagnosticMemoryCase, MemorySearch } from '../contracts/diagnostic-memory.js';
import type { InMemoryDiagnosticTransaction, InMemoryDiagnosticRecords } from './diagnostic-memory-state.js';
import { cloneInMemoryDiagnosticRecords, createInMemoryDiagnosticRecords,
  createInMemoryDiagnosticRepository, DiagnosticMemoryStoreCore } from './diagnostic-memory-state.js';
import { indexedMemoryWords, isRecallableMemory, memoryBm25, prepareMemorySearch } from './lexical-search.js';
import { MemoryError } from './memory-error.js';

/** Test/runtime adapter with copy-on-write transactions matching the SQLite store. */
export class InMemoryDiagnosticMemoryStore extends DiagnosticMemoryStoreCore {
  private transaction: InMemoryDiagnosticTransaction;

  public constructor(input: { clock: Clock; transaction?: InMemoryDiagnosticTransaction }) {
    super(input.clock);
    this.transaction = input.transaction ?? {
      checkpointRecords: new Map(), executionRecords: new Map(), outboxRecords: new Map(),
      memory: createInMemoryDiagnosticRecords(),
    };
  }

  public override search(input: MemorySearch): Promise<readonly DiagnosticMemoryCase[]> {
    return this.read(repo => {
      const query = prepareMemorySearch(input);
      if (query.tokens.length === 0) return [];
      // Use the same approved FTS corpus statistics as SQLite, including other scopes.
      // Eligibility is still applied before sorting and Top-K; no statistics escape.
      const indexes = [...this.transaction.memory.indexes];
      const scores = memoryBm25(indexes.map(([, text]) => indexedMemoryWords(text)), query.tokens);
      const candidates = indexes.flatMap(([id], i) => {
        const entry = this.transaction.memory.cases.get(id);
        if (entry === undefined) throw new MemoryError('MEMORY_DATA_INVALID');
        if (!isRecallableMemory(entry.value, query.scopeKey, query.now, query.excluded) || scores[i] == null) return [];
        const value = repo.getCase(id, query.scopeKey);
        if (value === null) throw new MemoryError('MEMORY_DATA_INVALID');
        const rank = scores[i];
        if (rank === undefined || rank === null) return [];
        return [{ value, rank }];
      });
      return candidates.sort((a, b) => a.rank - b.rank
        || Date.parse(b.value.capturedAt) - Date.parse(a.value.capturedAt)
        || Buffer.compare(Buffer.from(a.value.id), Buffer.from(b.value.id)))
        .slice(0, query.limit).map(c => structuredClone(c.value));
    });
  }

  protected read<T>(operation: (repo: ReturnType<typeof createInMemoryDiagnosticRepository>) => T): Promise<T> {
    return Promise.resolve().then(() => operation(createInMemoryDiagnosticRepository(this.transaction)));
  }

  protected transact<T>(operation: (repo: ReturnType<typeof createInMemoryDiagnosticRepository>) => T): Promise<T> {
    return Promise.resolve().then(() => {
      const target = this.transaction;
      const working: InMemoryDiagnosticTransaction = {
        checkpointRecords: cloneMap(target.checkpointRecords),
        executionRecords: cloneMap(target.executionRecords),
        outboxRecords: cloneMap(target.outboxRecords),
        memory: cloneInMemoryDiagnosticRecords(target.memory),
      };
      const result = operation(createInMemoryDiagnosticRepository(working));
      if (target === this.transaction) {
        replaceMap(target.checkpointRecords, working.checkpointRecords);
        replaceMap(target.executionRecords, working.executionRecords);
        replaceMap(target.outboxRecords, working.outboxRecords);
        replaceMemory(target.memory, working.memory);
      }
      return structuredClone(result);
    });
  }
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, structuredClone(value));
}

function replaceMemory(target: InMemoryDiagnosticRecords, source: InMemoryDiagnosticRecords): void {
  replaceMap(target.cases, source.cases);
  replaceMap(target.indexes, source.indexes);
  replaceMap(target.jobs, source.jobs);
  replaceMap(target.captureCommands, source.captureCommands);
  replaceMap(target.reviews, source.reviews);
  replaceMap(target.signals, source.signals);
}
