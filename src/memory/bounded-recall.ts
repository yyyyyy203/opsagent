import type { DiagnosticMemoryCase, MemoryEvidenceValidator, MemoryHint, MemoryOperation, MemoryQueryStore, MemoryRecallPort, MemorySelection, RunMemoryState } from '../contracts/diagnostic-memory.js';
import { parseDiagnosticMemoryCase, parseRunMemoryState } from '../contracts/diagnostic-memory-schema.js';
import { isRecallableMemory } from './lexical-search.js';
import { memoryInstant, memoryLimit } from './diagnostic-memory-state.js';
import { memoryScopeKey } from './memory-scope.js';
import { MemoryError } from './memory-error.js';

export interface BoundedMemoryRecallOptions {
  queries: MemoryQueryStore;
  evidence: MemoryEvidenceValidator;
  maxHints?: number;
  maxBytes?: number;
  maxTokens?: number;
}

export class BoundedMemoryRecall implements MemoryRecallPort {
  private readonly maxHints: number;
  private readonly maxBytes: number;
  private readonly maxTokens: number;
  public constructor(private readonly options: BoundedMemoryRecallOptions) {
    this.maxHints = memoryLimit(options.maxHints ?? 5, 5);
    this.maxBytes = memoryLimit(options.maxBytes ?? 4096, 4096);
    this.maxTokens = memoryLimit(options.maxTokens ?? 1024, 1024);
  }

  public async prepare(input: { runId: string; text: string; state: RunMemoryState }, operation: MemoryOperation): Promise<RunMemoryState> {
    operation.signal?.throwIfAborted();
    const previous = parseRunMemoryState(input.state);
    const now = memoryInstant(operation.now);
    if (typeof input.runId !== 'string' || input.runId.trim().length === 0 || input.runId.length > 256) {
      throw new MemoryError('MEMORY_DATA_INVALID');
    }
    const remaining = operation.availableMemoryTokens;
    const byteBudget = Number.isSafeInteger(remaining) && remaining! > 0
      ? Math.min(this.maxBytes, this.maxTokens, remaining!) : 0;
    let selected = previous.selectionState === 'selected';
    let selections = previous.selections;
    const result = (hints: readonly MemoryHint[], availability: RunMemoryState['availability'], reasonCode?: RunMemoryState['reasonCode']): RunMemoryState => ({
      schemaVersion: 1, scope: previous.scope, selectionState: selected ? 'selected' : 'unselected',
      availability, selections: structuredClone(selections), hints: structuredClone(hints),
      ...(previous.selectedAt === undefined ? selected ? { selectedAt: now } : {} : { selectedAt: previous.selectedAt }),
      validatedAt: now, ...(reasonCode === undefined ? {} : { reasonCode }),
    });
    const deadline = createRecallDeadline(operation);
    try {
      if (byteBudget <= 0 || deadline.isExpired()) return result([], 'empty');
      let candidates: readonly DiagnosticMemoryCase[];
      if (!selected) {
        // Even a failed first query is frozen: later rounds cannot retry a full search.
        selected = true;
        candidates = await deadline.run(() => this.options.queries.search({ scope: previous.scope, text: input.text,
          excludeRunIds: [input.runId], limit: 5, now }));
      } else {
        candidates = await deadline.run(() => this.options.queries.revalidate({ scope: previous.scope, selections, now }));
      }
      if (candidates.length > 10) throw new MemoryError('MEMORY_DATA_INVALID');
      const scopeKey = memoryScopeKey(previous.scope);
      const excluded = new Set([input.runId]);
      const frozen = new Map(selections.map(s => [s.memoryId, s]));
      const first = previous.selectionState === 'unselected';
      const seen = new Set<string>();
      const eligible = candidates.map(c => parseDiagnosticMemoryCase(c)).filter(c => {
        if (!isRecallableMemory(c, scopeKey, now, excluded)) return false;
        const selection = frozen.get(c.id);
        if (!first && (selection?.revision !== c.revision || selection.digest !== c.digest)) return false;
        if (seen.has(c.id)) throw new MemoryError('MEMORY_DATA_INVALID');
        seen.add(c.id);
        return true;
      });
      if (first) {
        candidates = eligible.slice(0, 5);
        selections = candidates.map(selectionOf);
      } else {
        // Adapter order must not reorder the saved snapshot.
        const values = new Map(eligible.map(c => [c.id, c]));
        candidates = selections.flatMap(s => values.has(s.memoryId) ? [values.get(s.memoryId)!] : []);
      }
      const hints: MemoryHint[] = [];
      for (const value of candidates) {
        if (value.evidenceRefs.length === 0) continue;
        const valid = await deadline.run(() => this.options.evidence.validate({ sourceRunId: value.sourceRunId,
          refs: value.evidenceRefs, scope: previous.scope }, deadline.operation));
        if (!valid) continue;
        const hint = hintOf(value);
        // UTF-8 bytes conservatively upper-bound tokens without a model tokenizer.
        if (hints.length < this.maxHints && Buffer.byteLength(JSON.stringify([...hints, hint]), 'utf8') <= byteBudget) hints.push(hint);
      }
      if (deadline.isExpired()) return result([], 'empty');
      return parseRunMemoryState(result(hints, hints.length > 0 ? 'ready' : 'empty'));
    } catch (error) {
      operation.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof RecallDeadlineExpired) return result([], 'empty');
      return result([], 'unavailable', 'MEMORY_LOOKUP_FAILED');
    } finally {
      deadline.dispose();
    }
  }
}

function selectionOf(value: DiagnosticMemoryCase): MemorySelection {
  return { memoryId: value.id, revision: value.revision, digest: value.digest };
}
function hintOf(value: DiagnosticMemoryCase): MemoryHint {
  return { ...selectionOf(value), sourceRunId: value.sourceRunId, capturedAt: value.capturedAt,
    validUntil: value.validUntil, summary: value.summary, limitations: value.limitations,
    evidenceRefs: value.evidenceRefs, diagnosisOnly: true };
}
/** Private sentinel: dependency TimeoutError values must remain ordinary failures. */
class RecallDeadlineExpired extends Error {
  public constructor() {
    super('Memory recall deadline exceeded.');
    this.name = 'RecallDeadlineExpired';
  }
}

interface RecallDeadline {
  operation: MemoryOperation;
  run<T>(call: () => Promise<T>): Promise<T>;
  isExpired(): boolean;
  dispose(): void;
}

/** One timer and cancellation signal cover search plus every evidence check. */
function createRecallDeadline(operation: MemoryOperation): RecallDeadline {
  const startMs = operation.clock?.now().getTime() ?? Date.parse(operation.now);
  const remainingMs = Number.isFinite(startMs) && Number.isFinite(operation.deadlineMs)
    ? operation.deadlineMs - startMs : 0;
  const controller = new AbortController();
  const deadlineError = new RecallDeadlineExpired();
  let deadlineExpired = remainingMs <= 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let rejectInterruption: ((reason: Error) => void) | undefined;
  const interruption = new Promise<never>((_, reject) => { rejectInterruption = reject; });
  if (operation.signal !== undefined) {
    onAbort = () => {
      controller.abort(operation.signal?.reason);
      rejectInterruption?.(new DOMException('Memory operation aborted.', 'AbortError'));
    };
    operation.signal.addEventListener('abort', onAbort, { once: true });
    if (operation.signal.aborted) onAbort();
  }
  if (!deadlineExpired) {
    timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(deadlineError);
      rejectInterruption?.(deadlineError);
    }, Math.min(remainingMs, 2_147_483_647));
  }
  const isExpired = (): boolean => deadlineExpired || (operation.clock !== undefined
    && operation.clock.now().getTime() >= operation.deadlineMs);
  const sharedOperation: MemoryOperation = { ...operation, signal: controller.signal };
  return {
    operation: sharedOperation,
    isExpired,
    dispose: () => {
      clearTimeout(timer);
      if (onAbort !== undefined) operation.signal?.removeEventListener('abort', onAbort);
    },
    run: async <T>(call: () => Promise<T>): Promise<T> => {
      operation.signal?.throwIfAborted();
      if (isExpired()) throw deadlineError;
      const pending = Promise.resolve().then(() => {
        operation.signal?.throwIfAborted();
        if (isExpired()) throw deadlineError;
        return call();
      });
      const value = await Promise.race([pending, interruption]);
      operation.signal?.throwIfAborted();
      if (isExpired()) throw deadlineError;
      return value;
    },
  };
}
