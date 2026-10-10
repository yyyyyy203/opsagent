import type {
  DiagnosticMemoryRuntime, MemoryCapabilities, MemoryPolicyPort, MemoryQueryStore,
  MemoryReadServicePort, MemoryRecallPort, MemoryStatus, RunMemoryControl, RunMemoryState,
} from '../contracts/diagnostic-memory.js';
import type { Clock } from '../contracts/common.js';
import type { VersionedCheckpointStore } from '../contracts/storage.js';
import type { InspectionQueryService } from '../contracts/read-model.js';
import { parseRunMemoryState } from '../contracts/diagnostic-memory-schema.js';
import { canonicalJson } from '../contracts/stable-json.js';

export interface MemoryQueryServiceOptions {
  profiles: DiagnosticMemoryRuntime['profiles'];
  policy: MemoryPolicyPort;
  queries: MemoryQueryStore;
  checkpoints: VersionedCheckpointStore;
  evidenceQueries: InspectionQueryService;
  recall: MemoryRecallPort;
  clock: Clock;
  enabled: () => boolean;
}

export const disabledMemoryCapabilities = (): MemoryCapabilities => ({ enabled: false, kind: 'episodic',
  reviewMode: 'local_operator', manualCapture: false, automaticCapture: false, recall: false,
  defaults: { capture: 'manual', recall: false }, vectorExperiment: 'separate' });

/** Safe bounded read facade. Raw checkpoint fields never form an HTTP response. */
export class MemoryQueryService implements MemoryReadServicePort {
  public constructor(private readonly options: MemoryQueryServiceOptions) {}
  public capabilities(profileId: string): MemoryCapabilities {
    const profile = this.options.profiles.find(p => p.scope.profileId === profileId);
    return !this.options.enabled() || profile === undefined ? disabledMemoryCapabilities() : {
      enabled: true, kind: 'episodic', reviewMode: 'local_operator', manualCapture: true,
      automaticCapture: profile.allowAutomaticCapture, recall: profile.allowRecall,
      defaults: { capture: profile.captureDefault, recall: profile.recallDefault }, vectorExperiment: 'separate',
    };
  }
  public async list(profileId: string, input: { status?: MemoryStatus; afterId?: string; limit: number }) {
    const scope = this.scope(profileId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50
      || (input.status !== undefined && !['observation', 'approved', 'rejected'].includes(input.status))
      || (input.afterId !== undefined && (input.afterId.length < 1 || input.afterId.length > 256))) throw failure('MEMORY_DATA_INVALID', 400);
    return this.options.queries.list({ scope, ...input });
  }
  public get(profileId: string, id: string) { return this.options.queries.get(id, this.scope(profileId)); }

  public async getRun(runId: string): Promise<RunMemoryState | null> {
    const source = await this.source(runId);
    const control = source.context.memoryControl;
    const memory = source.context.memory;
    if (control === undefined || memory === undefined) return null;
    const state = parseRunMemoryState(memory);
    if (!control.recall || !this.options.policy.allows(control, 'recall')) return {
      ...state, hints: [], availability: 'unavailable', reasonCode: 'MEMORY_POLICY_DENIED',
    };
    if (state.selectionState !== 'selected') return { ...state, hints: [] };
    const now = this.options.clock.now();
    // Read-only revalidation of the frozen selection. Never starts a fresh search or saves a Run.
    return this.options.recall.prepare({ runId, text: '', state }, { now: now.toISOString(),
      deadlineMs: now.getTime() + 5_000, clock: this.options.clock, availableMemoryTokens: 1_024 });
  }

  public async getCapture(runId: string) {
    const source = await this.source(runId);
    const control = source.context.memoryControl;
    if (control === undefined) return { sourceRunId: runId, state: 'unavailable' as const,
      sourceCheckpointRevision: source.revision, reasonCode: 'MEMORY_SCOPE_INVALID' as const };
    if (!this.options.policy.allows(control, 'capture')) throw failure('NOT_FOUND', 404);
    const ticket = await this.options.queries.getCapture({ runId, scope: control.scope });
    return { ...(ticket ?? { sourceRunId: runId, state: 'not_saved' as const }), sourceCheckpointRevision: source.revision };
  }

  private scope(profileId: string) {
    if (!this.options.enabled()) throw failure('MEMORY_DISABLED', 503);
    const profile = this.options.profiles.find(p => p.scope.profileId === profileId);
    if (profile === undefined) throw failure('NOT_FOUND', 404);
    return profile.scope;
  }
  private async source(runId: string) {
    if (!this.options.enabled()) throw failure('MEMORY_DISABLED', 503);
    const source = await this.options.checkpoints.load(runId);
    if (source === null) throw failure('NOT_FOUND', 404);
    const allowed = this.scope(source.context.profileId);
    const control: RunMemoryControl | undefined = source.context.memoryControl;
    if (control !== undefined && canonicalJson(control.scope) !== canonicalJson(allowed)) throw failure('NOT_FOUND', 404);
    const run = await this.options.evidenceQueries.getRun(runId);
    if (run === null || run.parentRunId !== undefined) throw failure('NOT_FOUND', 404);
    return source;
  }
}

function failure(code: string, statusCode: number): Error {
  return Object.assign(new Error('Memory query is unavailable for this request.'), { code, statusCode });
}
