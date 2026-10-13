import type { AgentContext } from '../contracts/context.js';
import type { CoordinatedMemoryView, MemoryCoordinatorPort, MemoryOperation, MemoryPreferences,
  EpisodicMemoryCoordinatorPorts, PreparedEpisodicMemoryView, RunKnowledgeSelection, RunMemoryState } from '../contracts/diagnostic-memory.js';
import type { KnowledgeKind, KnowledgeLimitationReason, KnowledgeScope, MissingKnowledgeQualification } from '../contracts/knowledge-memory.js';
import type { KnowledgeRevisionStateQueryPort, KnowledgeRevisionStateSnapshot, KnowledgeScopedSearchStore,
  TargetKnowledgePublicationContextPort } from '../contracts/knowledge-memory-storage.js';
import type { ResolvedTargetSnapshotV2, TargetKnowledgeCapabilityPort, TargetKnowledgeReference } from '../contracts/target.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import { parseKnowledgeRecord, parseKnowledgeDiagnosisQualification } from '../contracts/knowledge-memory-schema.js';
import { parseRunMemoryState } from '../contracts/diagnostic-memory-schema.js';
import { findApplicableProceduralTemplates } from './procedural-applicability.js';
import type { ProceduralReadonlyCapabilityRegistryPort } from './procedural-template-service.js';
import { renderKnowledgeHint } from './hint-renderer.js';

export interface MemoryCoordinatorOptions {
  capabilities: TargetKnowledgeCapabilityPort;
  authority: TargetKnowledgePublicationContextPort;
  states: KnowledgeRevisionStateQueryPort;
  semantic: KnowledgeScopedSearchStore;
  procedural: KnowledgeScopedSearchStore;
  proceduralCapabilities: ProceduralReadonlyCapabilityRegistryPort;
  episodic?: EpisodicMemoryCoordinatorPorts;
}

/** Coordinates independent read ports; Working Context remains the sole Run state. */
export class MemoryCoordinator implements MemoryCoordinatorPort {
  public constructor(private readonly options: MemoryCoordinatorOptions) {}
  public async prepare(input: { context: AgentContext; snapshot: ResolvedTargetSnapshotV2; text: string;
    preferences?: Pick<MemoryPreferences, 'semantic' | 'procedural'>; episodic?: PreparedEpisodicMemoryView },
    operation: MemoryOperation): Promise<CoordinatedMemoryView> {
    operation.signal?.throwIfAborted();
    const snapshot = input.snapshot;
    const scope = knowledgeScopeFor(snapshot);
    const selection: RunKnowledgeSelection = { schemaVersion: 1, snapshotDigest: snapshot.digest, references: [],
      ...(input.preferences === undefined ? {} : { preferences: structuredClone(input.preferences) }) };
    const missing: MissingKnowledgeQualification[] = [];
    const view: CoordinatedMemoryView = { selection, qualification: qualification(missing), messages: [], retrievedIds: [], scopes: [] };
    const now = () => operation.clock?.now().toISOString() ?? operation.now;
    const check = () => { operation.signal?.throwIfAborted();
      if (Date.parse(now()) >= operation.deadlineMs) throw new KnowledgeDeadline(); };
    let remaining = Math.min(4096, Math.max(0, operation.availableMemoryTokens ?? 0));
    const episodic = await this.prepareEpisodic(input, operation, view, remaining);
    remaining = episodic.remaining;
    let attempted = episodic.attempted ? 1 : 0;
    let failed = episodic.failed ? 1 : 0;
    let allowed = false;
    let flags = { semanticEnabled: false, proceduralEnabled: false };
    try {
      check();
      const authority = await bounded(this.options.authority.resolvePublicationContext({ targetId: snapshot.targetId,
        capturedAt: now(), signal: operation.signal ?? new AbortController().signal }), operation);
      allowed = checkpointChecksum(authority.scope) === checkpointChecksum(scope)
        && checkpointChecksum(authority.hostPolicy) === checkpointChecksum(snapshot.knowledgePolicy);
      flags = await bounded(this.options.capabilities.getForTarget(snapshot.targetId), operation);
    } catch (error) {
      operation.signal?.throwIfAborted();
      const reason = error instanceof KnowledgeDeadline ? 'KNOWLEDGE_DEADLINE_EXCEEDED' : 'KNOWLEDGE_STORAGE_UNAVAILABLE';
      for (const ref of snapshot.knowledgeRefs) missing.push(gap(snapshot, ref, 'semantic', reason));
      view.qualification = qualification(missing);
      if (attempted > 0 && failed === attempted) view.fallbackPolicy = 'working_only';
      return view;
    }
    const identities: RunKnowledgeSelection['references'][number][] = [];
    for (const kind of ['semantic', 'procedural'] as const) {
      const eligible: TargetKnowledgeReference[] = [];
      for (const ref of snapshot.knowledgeRefs) {
        const requirement = snapshot.knowledgePolicy.requirements.find(r => sameRef(r, ref));
        if ((requirement?.knowledgeClass ?? 'semantic') !== kind) continue;
        const hostDisabled = !(kind === 'semantic' ? flags.semanticEnabled : flags.proceduralEnabled);
        const userDisabled = requirement?.requiredness !== 'required' && input.preferences?.[kind] === 'disabled';
        const disabled = hostDisabled || userDisabled;
        if (requirement?.knowledgeClass === kind && (!allowed || disabled)) {
          identities.push({ id: ref.id, version: ref.version, digest: ref.digest, kind, requiredness: requirement.requiredness });
          missing.push(gap(snapshot, ref, kind, !allowed ? 'KNOWLEDGE_SCOPE_MISMATCH' : 'KNOWLEDGE_TYPE_DISABLED')); continue;
        }
        let state: KnowledgeRevisionStateSnapshot | null;
        try { check(); state = await bounded(this.options.states.inspectExact({ id: ref.id, contentRevision: Number(ref.version), scope, now: now() }), operation); }
        catch (error) { operation.signal?.throwIfAborted();
          if (kind === (requirement?.knowledgeClass ?? 'semantic')) missing.push(gap(snapshot, ref, kind,
            error instanceof KnowledgeDeadline ? 'KNOWLEDGE_DEADLINE_EXCEEDED' : 'KNOWLEDGE_STORAGE_UNAVAILABLE'));
          continue; }
        identities.push({ id: ref.id, version: ref.version, digest: ref.digest, kind, requiredness: requirement?.requiredness ?? 'optional' });
        if (state !== null && state?.kind !== kind) {
          missing.push(gap(snapshot, ref, kind, 'KNOWLEDGE_SCOPE_MISMATCH'));
          continue;
        }
        const reason = !allowed ? 'KNOWLEDGE_SCOPE_MISMATCH'
          : hostDisabled || userDisabled
            ? 'KNOWLEDGE_TYPE_DISABLED' : invalidState(state, ref, now());
        if (reason !== undefined) { missing.push(gap(snapshot, ref, kind, reason)); continue; }
        eligible.push(ref);
      }
      if (eligible.length === 0) continue;
      view.scopes.push(kind); attempted++;
      try {
        check();
        const records = await bounded(this.options[kind].search({ kind, scope, references: eligible, query: input.text.slice(0, 2000), limit: 64, now: now() }), operation);
        for (const ref of eligible) {
          const raw = records.find(r => r.id === ref.id && String(r.contentRevision) === ref.version && r.kind === kind);
          if (raw === undefined) { missing.push(gap(snapshot, ref, kind, 'KNOWLEDGE_NOT_FOUND')); continue; }
          const record = parseKnowledgeRecord(raw);
          const current = await bounded(this.options.states.inspectExact({ id: ref.id, contentRevision: Number(ref.version), scope, now: now() }), operation);
          const reason = invalidState(current, ref, now());
          if (reason !== undefined) { missing.push(gap(snapshot, ref, kind, reason)); continue; }
          if (checkpointChecksum(record.scope) !== checkpointChecksum(scope) || record.contentDigest !== ref.digest
            || record.status !== 'approved' || record.governanceVersion !== current!.governanceVersion
            || record.sourceEpoch !== current!.sourceEpoch) { missing.push(gap(snapshot, ref, kind, 'KNOWLEDGE_SCOPE_MISMATCH')); continue; }
          let content: unknown = record.content;
          if (record.kind === 'procedural') {
            const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
              candidates: [{ revision: record, state: current! }], capabilityRegistry: this.options.proceduralCapabilities, now: now() });
            if (suggestions.length === 0) { missing.push(gap(snapshot, ref, kind, 'KNOWLEDGE_SCOPE_MISMATCH')); continue; }
            content = suggestions[0];
          }
          const message = renderKnowledgeHint({ kind, id: ref.id, version: ref.version, digest: ref.digest, content }, now());
          const cost = Buffer.byteLength(JSON.stringify(message), 'utf8');
          if (cost > remaining) { missing.push(gap(snapshot, ref, kind, 'KNOWLEDGE_BUDGET_EXCEEDED')); continue; }
          remaining -= cost; view.messages.push(message); view.retrievedIds.push(ref.id);
        }
      } catch (error) {
        operation.signal?.throwIfAborted(); failed++;
        for (const ref of eligible) if (!view.retrievedIds.includes(ref.id) && !missing.some(m => sameRef(m.reference, ref))) {
          missing.push(gap(snapshot, ref, kind, error instanceof KnowledgeDeadline ? 'KNOWLEDGE_DEADLINE_EXCEEDED' : 'KNOWLEDGE_STORAGE_UNAVAILABLE'));
        }
      }
    }
    selection.references = identities;
    view.qualification = qualification(missing);
    if (attempted > 0 && failed === attempted && view.messages.length === 0) view.fallbackPolicy = 'working_only';
    return view;
  }
  private async prepareEpisodic(input: { context: AgentContext; snapshot: ResolvedTargetSnapshotV2; text: string;
    episodic?: PreparedEpisodicMemoryView }, operation: MemoryOperation, view: CoordinatedMemoryView, remaining: number):
    Promise<{ attempted: boolean; failed: boolean; remaining: number }> {
    const control = input.context.memoryControl;
    if (input.episodic !== undefined) {
      const prepared = input.episodic;
      if (control === undefined || !control.recall) return { attempted: false, failed: false, remaining };
      try {
        const state = parseRunMemoryState(prepared.state);
        if (checkpointChecksum(state.scope) !== checkpointChecksum(control.scope)) {
          return { attempted: prepared.attempted, failed: prepared.attempted, remaining };
        }
        const succeeded = prepared.succeeded && state.availability !== 'unavailable';
        view.episodic = { state, attempted: prepared.attempted, succeeded };
        if (prepared.attempted) view.scopes.push('episodic');
        return { attempted: prepared.attempted, failed: prepared.attempted && !succeeded, remaining };
      } catch (error) {
        if (isAbortError(error)) throw error;
        operation.signal?.throwIfAborted();
        return { attempted: prepared.attempted, failed: prepared.attempted, remaining };
      }
    }
    const ports = this.options.episodic;
    if (ports === undefined || control === undefined || !control.recall) return { attempted: false, failed: false, remaining };
    try {
      if (!ports.policy.allows(control, 'recall')) return { attempted: false, failed: false, remaining };
    } catch (error) {
      if (isAbortError(error)) throw error;
      operation.signal?.throwIfAborted();
      return { attempted: false, failed: false, remaining };
    }

    try {
      operation.signal?.throwIfAborted();
      const previous: RunMemoryState = input.context.memory ?? {
        schemaVersion: 1, scope: control.scope, selectionState: 'unselected', availability: 'empty', selections: [], hints: [],
      };
      const state = parseRunMemoryState(await bounded(ports.recall.prepare({ runId: input.context.runId,
        text: input.text, state: previous }, operation), operation));
      if (checkpointChecksum(state.scope) !== checkpointChecksum(control.scope)) throw new TypeError('Episodic scope mismatch.');
      const succeeded = state.availability !== 'unavailable';
      view.episodic = { state, attempted: true, succeeded };
      view.scopes.push('episodic');
      if (succeeded) {
        try {
          const message = ports.renderer.render(state, { ...operation, availableMemoryTokens: remaining });
          if (message !== null) {
            const cost = Buffer.byteLength(JSON.stringify(message), 'utf8');
            remaining = Math.max(0, remaining - cost);
            view.messages.push(message);
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          operation.signal?.throwIfAborted();
        }
      }
      return { attempted: true, failed: !succeeded, remaining };
    } catch (error) {
      if (isAbortError(error)) throw error;
      operation.signal?.throwIfAborted();
      return { attempted: true, failed: true, remaining };
    }
  }
  public async revalidate(input: { context: AgentContext; snapshot: ResolvedTargetSnapshotV2; view: CoordinatedMemoryView }, operation: MemoryOperation): Promise<CoordinatedMemoryView> {
    operation.signal?.throwIfAborted();
    const view = structuredClone(input.view);
    const missing = [...view.qualification.missingKnowledge];
    const snapshotMismatch = view.selection.snapshotDigest !== input.snapshot.digest
      || view.selection.references.some(identity => !input.snapshot.knowledgeRefs.some(ref => sameRef(identity, ref)));
    if (snapshotMismatch) {
      view.messages = view.messages.filter(message => !message.id.startsWith('knowledge-hint:'));
      view.retrievedIds = [];
      const missingByReference = new Map(missing.map(item => [knowledgeReferenceKey(item.reference), item]));
      for (const identity of view.selection.references) {
        const currentReference = input.snapshot.knowledgeRefs.find(ref => sameRef(identity, ref));
        const reference = currentReference ?? { id: identity.id, version: identity.version, digest: identity.digest, approval: 'approved' as const };
        const requirement = input.snapshot.knowledgePolicy.requirements.find(candidate => sameRef(candidate, reference));
        const item: MissingKnowledgeQualification = {
          reference,
          kind: requirement?.knowledgeClass ?? identity.kind,
          requiredness: requirement?.requiredness ?? identity.requiredness,
          reasonCode: 'KNOWLEDGE_SCOPE_MISMATCH',
        };
        missingByReference.set(knowledgeReferenceKey(reference), item);
      }
      for (const reference of input.snapshot.knowledgeRefs) {
        const requirement = input.snapshot.knowledgePolicy.requirements.find(candidate => sameRef(candidate, reference));
        const item = gap(input.snapshot, reference, requirement?.knowledgeClass ?? 'semantic', 'KNOWLEDGE_SCOPE_MISMATCH');
        missingByReference.set(knowledgeReferenceKey(reference), item);
      }
      view.qualification = qualification([...missingByReference.values()]);
      return view;
    }
    const scope = knowledgeScopeFor(input.snapshot);
    const now = operation.clock?.now().toISOString() ?? operation.now;
    let general: KnowledgeLimitationReason | undefined;
    let flags = { semanticEnabled: false, proceduralEnabled: false };
    try {
      const authority = await bounded(this.options.authority.resolvePublicationContext({ targetId: input.snapshot.targetId,
        capturedAt: now, signal: operation.signal ?? new AbortController().signal }), operation);
      if (checkpointChecksum(authority.scope) !== checkpointChecksum(scope)
        || checkpointChecksum(authority.hostPolicy) !== checkpointChecksum(input.snapshot.knowledgePolicy)
        || view.selection.snapshotDigest !== input.snapshot.digest) general = 'KNOWLEDGE_SCOPE_MISMATCH';
      flags = await bounded(this.options.capabilities.getForTarget(input.snapshot.targetId), operation);
    } catch (error) { operation.signal?.throwIfAborted(); general = error instanceof KnowledgeDeadline ? 'KNOWLEDGE_DEADLINE_EXCEEDED' : 'KNOWLEDGE_STORAGE_UNAVAILABLE'; }
    for (const identity of view.selection.references) {
      if (!view.retrievedIds.includes(identity.id)) continue;
      const ref = input.snapshot.knowledgeRefs.find(r => sameRef(identity, r));
      if (ref === undefined) continue;
      let reason = general;
      const hostDisabled = !(identity.kind === 'semantic' ? flags.semanticEnabled : flags.proceduralEnabled);
      const userDisabled = identity.requiredness !== 'required' && view.selection.preferences?.[identity.kind] === 'disabled';
      if (reason === undefined && (hostDisabled || userDisabled)) reason = 'KNOWLEDGE_TYPE_DISABLED';
      if (reason === undefined) {
        try { reason = invalidState(await bounded(this.options.states.inspectExact({ id: ref.id,
          contentRevision: Number(ref.version), scope, now }), operation), ref, now); }
        catch (error) { operation.signal?.throwIfAborted(); reason = error instanceof KnowledgeDeadline ? 'KNOWLEDGE_DEADLINE_EXCEEDED' : 'KNOWLEDGE_STORAGE_UNAVAILABLE'; }
      }
      if (reason !== undefined) {
        missing.push(gap(input.snapshot, ref, identity.kind, reason));
        view.retrievedIds = view.retrievedIds.filter(id => id !== ref.id);
        view.messages = view.messages.filter(message => message.id !== `knowledge-hint:${identity.kind}:${ref.id}:${ref.version}:${ref.digest}`);
      }
    }
    view.qualification = qualification(missing);
    return view;
  }
}

export function knowledgeScopeFor(snapshot: ResolvedTargetSnapshotV2): KnowledgeScope {
  return { targetId: snapshot.targetId, projectId: snapshot.projectId, deploymentId: snapshot.deploymentId,
    deploymentGeneration: snapshot.deploymentGeneration, targetFingerprint: snapshot.targetFingerprint,
    profileId: snapshot.profile.profileId, profileRevision: snapshot.profile.revision,
    scenarioId: snapshot.scenario.id, scenarioVersion: snapshot.scenario.version,
    serviceIds: [snapshot.scenario.serviceId], faultTypes: [snapshot.scenario.id], environment: snapshot.environment,
    dataClass: snapshot.dataClass, ...(snapshot.dataClass === 'simulated' ? { datasetId: snapshot.datasetId! } : {}) } as KnowledgeScope;
}
function sameRef(left: { id: string; version: string; digest: string }, right: TargetKnowledgeReference): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}
function knowledgeReferenceKey(reference: { id: string; version: string; digest: string }): string {
  return JSON.stringify([reference.id, reference.version, reference.digest]);
}
function gap(snapshot: ResolvedTargetSnapshotV2, reference: TargetKnowledgeReference, kind: KnowledgeKind, reasonCode: KnowledgeLimitationReason): MissingKnowledgeQualification {
  const requirement = snapshot.knowledgePolicy.requirements.find(r => sameRef(r, reference));
  return { reference, kind: requirement?.knowledgeClass ?? kind, requiredness: requirement?.requiredness ?? 'optional', reasonCode };
}
function qualification(missing: MissingKnowledgeQualification[]) {
  return parseKnowledgeDiagnosisQualification({ schemaVersion: 1, diagnosisReady: !missing.some(m => m.requiredness === 'required'),
    missingKnowledge: missing, limitationReasons: [...new Set(missing.map(m => m.requiredness === 'required' ? m.reasonCode : 'OPTIONAL_KNOWLEDGE_OMITTED'))] });
}
function invalidState(state: KnowledgeRevisionStateSnapshot | null, ref: TargetKnowledgeReference, now: string): KnowledgeLimitationReason | undefined {
  if (state === null) return 'KNOWLEDGE_NOT_FOUND';
  if (state.knowledgeId !== ref.id || String(state.contentRevision) !== ref.version || state.contentDigest !== ref.digest) return 'KNOWLEDGE_DIGEST_MISMATCH';
  if (state.status !== 'approved') return state.status === 'revoked' ? 'KNOWLEDGE_REVOKED'
    : state.status === 'superseded' ? 'KNOWLEDGE_SUPERSEDED' : state.status === 'conflict' ? 'KNOWLEDGE_CONFLICT'
      : state.status === 'expired' ? 'KNOWLEDGE_EXPIRED' : 'KNOWLEDGE_NOT_APPROVED';
  if (state.sourceValidity !== 'active' || !state.sourceDigestMatches || state.sourceEpoch !== state.currentSourceEpoch) return 'KNOWLEDGE_SOURCE_REVOKED';
  if (state.validUntil !== undefined && Date.parse(state.validUntil) <= Date.parse(now)) return 'KNOWLEDGE_EXPIRED';
  return undefined;
}
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
class KnowledgeDeadline extends Error {}
function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Memory operation aborted.');
  error.name = 'AbortError';
  return error;
}
async function bounded<T>(promise: Promise<T>, operation: MemoryOperation): Promise<T> {
  operation.signal?.throwIfAborted();
  const delay = operation.deadlineMs - (operation.clock?.now().getTime() ?? Date.parse(operation.now));
  if (delay <= 0) throw new KnowledgeDeadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KnowledgeDeadline()), delay);
    abort = () => reject(asAbortError(operation.signal?.reason)); operation.signal?.addEventListener('abort', abort, { once: true });
  })]); } finally { if (timer !== undefined) clearTimeout(timer); if (abort !== undefined) operation.signal?.removeEventListener('abort', abort); }
}
