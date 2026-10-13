import { describe, expect, it, vi } from 'vitest';
import * as coordinatorModule from '../src/memory/memory-coordinator.js';
import { fixture, now, scope } from './helpers/memory-coordinator-fixture.js';
import { memoryCase, simulationMemoryScope } from './fixtures/diagnostic-memory.js';
import { BoundedMemoryHintRenderer } from '../src/memory/hint-renderer.js';
import type { MemoryCoordinatorOptions } from '../src/memory/memory-coordinator.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseKnowledgeRecord } from '../src/contracts/knowledge-memory-schema.js';
import { parseResolvedTargetSnapshotV2 } from '../src/contracts/target-schema.js';

function withProceduralKnowledge(f: Awaited<ReturnType<typeof fixture>>, requiredness: 'optional' | 'required' = 'optional') {
  const id = 'settlement-runbook';
  const sourceDigest = 'c'.repeat(64);
  const content = {
    type: 'investigation_template' as const, templateId: 'settlement-investigation',
    scenario: { id: f.snapshot.scenario.id, version: f.snapshot.scenario.version },
    applicableTo: { serviceIds: [f.snapshot.scenario.serviceId], faultTypes: [f.snapshot.scenario.id], environments: [f.snapshot.environment] },
    preconditions: ['A settlement failure alert is active.'], requiredEvidence: [],
    steps: [{ step: 1, goal: 'Compare the settlement failure rate.', capabilityId: 'metrics.query', completionCriterion: 'Record the metric window.' }],
    stopConditions: ['Stop if required evidence is unavailable.'], expectedReportFields: ['observed_rate'],
    limitations: ['Guidance only; not current evidence.'],
    sourceReferences: [{ sourceId: 'profile-source', sourceVersion: '1', digest: sourceDigest }],
  };
  const record = {
    schemaVersion: 1 as const, id, kind: 'procedural' as const, contentRevision: 1, governanceVersion: 3, sourceEpoch: 0,
    status: 'approved' as const, createdAt: now, scope,
    provenance: { sourceType: 'target_profile' as const, sourceId: 'profile-source', sourceVersion: '1', sourceDigest, importedAt: now },
    review: { reviewerId: 'operator', reviewedAt: now,
      checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
      sourceVerification: { sourceEpoch: 0, sourceDigest } },
    content, contentDigest: checkpointChecksum(content),
  };
  parseKnowledgeRecord(record);
  const reference = { id, version: '1', digest: record.contentDigest, approval: 'approved' as const };
  const proceduralRequirement = { id, version: '1', digest: record.contentDigest, requiredness, knowledgeClass: 'procedural' as const };
  const knowledgePolicy = { ...f.snapshot.knowledgePolicy,
    requirements: f.snapshot.knowledgePolicy.requirements.map(item => ({ ...item, requiredness })).concat(proceduralRequirement) };
  const unsigned = { ...f.snapshot, knowledgeRefs: [...f.snapshot.knowledgeRefs, reference], knowledgePolicy };
  Reflect.deleteProperty(unsigned, 'digest');
  const snapshot = parseResolvedTargetSnapshotV2({ ...unsigned,
    digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsigned })}` });
  const state = { knowledgeId: id, kind: 'procedural' as const, contentRevision: 1, governanceVersion: 3,
    contentDigest: record.contentDigest, status: 'approved' as const, sourceEpoch: 0, currentSourceEpoch: 0,
    sourceValidity: 'active' as const, sourceDigestMatches: true, eligibleAt: now };
  const options = { ...f.options,
    authority: { resolvePublicationContext: async () => ({ registryVersion: 1, scope, hostPolicy: knowledgePolicy }) },
    states: { inspectExact: async ({ id: requestedId }: { id: string }) => requestedId === id ? state : f.getState() },
    procedural: { search: async () => [record] },
    proceduralCapabilities: { resolveForTarget: ({ capabilityId }: { capabilityId: string }) => capabilityId === 'metrics.query'
      ? { capabilityId, access: 'read_only' as const, serviceIds: [snapshot.scenario.serviceId],
        faultTypes: [snapshot.scenario.id], environments: [snapshot.environment], dataClasses: [snapshot.dataClass] }
      : null },
  };
  return { options, snapshot, record, reference };
}

describe('four-type memory coordinator', () => {
  it('builds temporary knowledge messages without making knowledge current evidence or durable text', async () => {
    const f = await fixture();
    const coordinator = new coordinatorModule.MemoryCoordinator(f.options);
    const view = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: 'settlement' }, f.operation);
    expect(view.qualification.diagnosisReady).toBe(true);
    expect(JSON.stringify(view.messages)).toContain('A completed settlement');
    expect(JSON.stringify(view.selection)).not.toContain('completed settlement');
    expect(JSON.stringify(view.selection)).not.toContain('approved');
    expect(f.context.evidenceIds).toEqual([]);
    expect(f.context.messages).toEqual([]);
  });
  it.each(['revoked', 'superseded', 'conflict', 'draft'] as const)('filters %s before search', async status => {
    const f = await fixture(); f.setState({ ...f.getState(), status });
    const view = await new coordinatorModule.MemoryCoordinator(f.options).prepare({ context: f.context, snapshot: f.snapshot, text: 'settlement' }, f.operation);
    expect(f.searched).toEqual([]);
    expect(view.messages).toEqual([]);
    expect(view.qualification.diagnosisReady).toBe(false);
    expect(view.qualification.missingKnowledge[0]?.requiredness).toBe('required');
  });
  it.each(['epoch', 'expiry', 'digest', 'source'] as const)('filters invalid %s before search', async dimension => {
    const f = await fixture(); f.setState({ ...f.getState(), ...(dimension === 'epoch' ? { currentSourceEpoch: 1 }
      : dimension === 'expiry' ? { validUntil: now } : dimension === 'digest' ? { contentDigest: 'b'.repeat(64) }
      : { sourceValidity: 'revoked' as const }) });
    const view = await new coordinatorModule.MemoryCoordinator(f.options).prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    expect(f.searched).toEqual([]); expect(view.qualification.diagnosisReady).toBe(false);
  });
  it.each([
    { expectedKind: 'semantic' as const, actualKind: 'procedural' as const },
    { expectedKind: 'procedural' as const, actualKind: 'semantic' as const },
  ])('reports a required wrong-kind revision as missing without searching (%j)', async ({ expectedKind, actualKind }) => {
    const f = await fixture('required');
    let snapshot = f.snapshot;
    let options: MemoryCoordinatorOptions = f.options;
    let states: MemoryCoordinatorOptions['states'] = f.options.states;
    if (expectedKind === 'semantic') {
      f.setState({ ...f.getState(), kind: actualKind });
    } else {
      const procedural = withProceduralKnowledge(f, 'required');
      snapshot = procedural.snapshot;
      options = procedural.options;
      states = { inspectExact: async ({ id: requestedId }: { id: string }) => requestedId === procedural.record.id
        ? { knowledgeId: requestedId, kind: actualKind, contentRevision: 1, governanceVersion: 3,
          contentDigest: procedural.record.contentDigest, status: 'approved' as const, sourceEpoch: 0, currentSourceEpoch: 0,
          sourceValidity: 'active' as const, sourceDigestMatches: true, eligibleAt: now }
        : f.getState() };
    }
    const semanticSearch = vi.fn(options.semantic.search);
    const proceduralSearch = vi.fn(options.procedural.search);
    const view = await new coordinatorModule.MemoryCoordinator({ ...options, states,
      semantic: { search: semanticSearch }, procedural: { search: proceduralSearch } })
      .prepare({ context: f.context, snapshot, text: '' }, f.operation);

    const ref = snapshot.knowledgeRefs.find(reference => snapshot.knowledgePolicy.requirements
      .some(requirement => requirement.id === reference.id && requirement.knowledgeClass === expectedKind));
    expect(ref).toBeDefined();
    expect(view.qualification).toMatchObject({ diagnosisReady: false, missingKnowledge: [{
      reference: ref, kind: expectedKind, requiredness: 'required', reasonCode: 'KNOWLEDGE_SCOPE_MISMATCH',
    }] });
    expect(semanticSearch.mock.calls.every(([input]) => input.references.every(reference => reference.id !== ref?.id))).toBe(true);
    expect(proceduralSearch.mock.calls.every(([input]) => input.references.every(reference => reference.id !== ref?.id))).toBe(true);
  });
  it.each(['required', 'optional'] as const)('qualifies %s budget omissions deterministically', async requiredness => {
    const f = await fixture(requiredness);
    const view = await new coordinatorModule.MemoryCoordinator(f.options).prepare({ context: f.context, snapshot: f.snapshot, text: '' }, { ...f.operation, availableMemoryTokens: 1 });
    expect(view.messages).toEqual([]);
    expect(view.qualification.diagnosisReady).toBe(requiredness === 'optional');
    expect(view.qualification.missingKnowledge[0]?.reasonCode).toBe('KNOWLEDGE_BUDGET_EXCEEDED');
  });
  it('propagates Abort rather than reporting an optional omission', async () => {
    const f = await fixture('optional'); const abort = new AbortController(); abort.abort();
    await expect(new coordinatorModule.MemoryCoordinator(f.options).prepare({ context: f.context, snapshot: f.snapshot, text: '' }, { ...f.operation, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not inspect or search an explicitly disabled optional type', async () => {
    const f = await fixture('optional');
    const options = { ...f.options, states: { inspectExact: async () => { throw new Error('disabled type queried'); } } };
    const view = await new coordinatorModule.MemoryCoordinator(options).prepare({ context: f.context, snapshot: f.snapshot, text: '', preferences: { semantic: 'disabled' } }, f.operation);
    expect(view.qualification.missingKnowledge[0]?.reasonCode).toBe('KNOWLEDGE_TYPE_DISABLED');
    expect(view.scopes).toEqual([]); expect(f.searched).toEqual([]);
  });
  it.each(['semantic', 'procedural'] as const)('does not let a user preference disable required %s knowledge during prepare or revalidation', async kind => {
    const f = await fixture('required');
    const configured = kind === 'semantic' ? { snapshot: f.snapshot, options: f.options }
      : withProceduralKnowledge(f, 'required');
    const preferences = kind === 'semantic' ? { semantic: 'disabled' as const } : { procedural: 'disabled' as const };
    const coordinator = new coordinatorModule.MemoryCoordinator(configured.options);
    const requiredRef = configured.snapshot.knowledgeRefs.find(reference => configured.snapshot.knowledgePolicy.requirements
      .some(requirement => requirement.id === reference.id && requirement.knowledgeClass === kind));
    expect(requiredRef).toBeDefined();

    const view = await coordinator.prepare({ context: f.context, snapshot: configured.snapshot, text: '', preferences }, f.operation);
    expect(view.retrievedIds).toContain(requiredRef!.id);
    expect(view.selection.references.find(reference => reference.id === requiredRef?.id))
      .toMatchObject({ kind, requiredness: 'required' });
    expect(view.qualification).toMatchObject({ diagnosisReady: true, missingKnowledge: [] });

    const final = await coordinator.revalidate({ context: f.context, snapshot: configured.snapshot, view }, f.operation);
    expect(final.retrievedIds).toContain(requiredRef!.id);
    expect(final.qualification).toMatchObject({ diagnosisReady: true, missingKnowledge: [] });
  });
  it.each(['semantic', 'procedural'] as const)('does not revoke required %s knowledge during revalidation because of a user preference', async kind => {
    const f = await fixture('required');
    const configured = kind === 'semantic' ? { snapshot: f.snapshot, options: f.options }
      : withProceduralKnowledge(f, 'required');
    const coordinator = new coordinatorModule.MemoryCoordinator(configured.options);
    const requiredRef = configured.snapshot.knowledgeRefs.find(reference => configured.snapshot.knowledgePolicy.requirements
      .some(requirement => requirement.id === reference.id && requirement.knowledgeClass === kind));
    expect(requiredRef).toBeDefined();

    const view = await coordinator.prepare({ context: f.context, snapshot: configured.snapshot, text: '' }, f.operation);
    expect(view.retrievedIds).toContain(requiredRef!.id);
    view.selection.preferences = kind === 'semantic' ? { semantic: 'disabled' } : { procedural: 'disabled' };

    const final = await coordinator.revalidate({ context: f.context, snapshot: configured.snapshot, view }, f.operation);
    expect(final.retrievedIds).toContain(requiredRef!.id);
    expect(final.qualification).toMatchObject({ diagnosisReady: true, missingKnowledge: [] });
  });
  it.each(['required', 'optional'] as const)('keeps eligible Procedural guidance when %s Semantic storage fails', async requiredness => {
    const f = await fixture(requiredness); const procedural = withProceduralKnowledge(f, requiredness);
    const coordinator = new coordinatorModule.MemoryCoordinator({ ...procedural.options,
      semantic: { search: async () => { throw new Error('semantic offline'); } } });
    const view = await coordinator.prepare({ context: f.context, snapshot: procedural.snapshot, text: '' }, f.operation);
    expect(view.retrievedIds, JSON.stringify(view)).toEqual([procedural.record.id]);
    expect(JSON.stringify(view.messages)).toContain(procedural.record.content.templateId);
    expect(view.qualification.diagnosisReady).toBe(requiredness === 'optional');
    expect(view.qualification.missingKnowledge).toMatchObject([{ kind: 'semantic', requiredness, reasonCode: 'KNOWLEDGE_STORAGE_UNAVAILABLE' }]);
    expect(view.fallbackPolicy).toBeUndefined();
    expect(f.context.evidenceIds).toEqual([]);
  });
  it.each(['required', 'optional'] as const)('keeps eligible Semantic guidance when %s Procedural storage fails', async requiredness => {
    const f = await fixture(requiredness); const procedural = withProceduralKnowledge(f, requiredness);
    const coordinator = new coordinatorModule.MemoryCoordinator({ ...procedural.options,
      procedural: { search: async () => { throw new Error('procedural offline'); } } });
    const view = await coordinator.prepare({ context: f.context, snapshot: procedural.snapshot, text: '' }, f.operation);
    expect(view.retrievedIds).toEqual([f.record.id]);
    expect(JSON.stringify(view.messages)).toContain('A completed settlement');
    expect(view.qualification.diagnosisReady).toBe(requiredness === 'optional');
    expect(view.qualification.missingKnowledge).toMatchObject([{ kind: 'procedural', requiredness, reasonCode: 'KNOWLEDGE_STORAGE_UNAVAILABLE' }]);
    expect(view.fallbackPolicy).toBeUndefined();
  });
  it.each(['required', 'optional'] as const)('applies TargetKnowledgePolicy budget qualification to both types (%s)', async requiredness => {
    const f = await fixture(requiredness); const procedural = withProceduralKnowledge(f, requiredness);
    const view = await new coordinatorModule.MemoryCoordinator(procedural.options).prepare(
      { context: f.context, snapshot: procedural.snapshot, text: '' }, { ...f.operation, availableMemoryTokens: 1 });
    expect(view.messages).toEqual([]);
    expect(view.qualification.diagnosisReady).toBe(requiredness === 'optional');
    expect(view.qualification.missingKnowledge).toHaveLength(2);
    expect(view.qualification.missingKnowledge.every(item => item.reasonCode === 'KNOWLEDGE_BUDGET_EXCEEDED'
      && item.requiredness === requiredness), JSON.stringify(view)).toBe(true);
    expect(view.selection.references.map(item => item.requiredness)).toEqual([requiredness, requiredness]);
    expect(view.fallbackPolicy).toBeUndefined();
  });
  it('retains required budget omissions during final revalidation instead of newly granting readiness', async () => {
    const f = await fixture(); const coordinator = new coordinatorModule.MemoryCoordinator(f.options);
    const view = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: '' }, { ...f.operation, availableMemoryTokens: 1 });
    const final = await coordinator.revalidate({ context: f.context, snapshot: f.snapshot, view }, f.operation);
    expect(final.qualification.diagnosisReady).toBe(false); expect(final.messages).toEqual([]);
  });
  it('removes a revoked prepared view on request revalidation without searching again', async () => {
    const f = await fixture(); const coordinator = new coordinatorModule.MemoryCoordinator(f.options);
    const view = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    f.setState({ ...f.getState(), status: 'revoked', governanceVersion: 4 });
    const final = await coordinator.revalidate({ context: f.context, snapshot: f.snapshot, view }, f.operation);
    expect(final.messages).toEqual([]); expect(final.qualification.diagnosisReady).toBe(false);
    expect(f.searched).toHaveLength(1);
  });
  it('fails closed for the entire prepared knowledge view when the bound snapshot changes and omits a selected ref', async () => {
    const f = await fixture('required');
    const procedural = withProceduralKnowledge(f, 'required');
    const coordinator = new coordinatorModule.MemoryCoordinator(procedural.options);
    const view = await coordinator.prepare({ context: f.context, snapshot: procedural.snapshot, text: '' }, f.operation);
    expect(view.retrievedIds).toContain(f.reference.id);
    expect(view.retrievedIds).toContain(procedural.reference.id);
    const unrelatedMessage = { id: 'episodic-hint:preserved', role: 'assistant' as const,
      createdAt: now, blocks: [{ type: 'text' as const, text: 'Episodic guidance remains separate.' }] };
    view.messages.push(unrelatedMessage);
    const searchesBeforeRevalidation = f.searched.length;

    const unsignedSnapshot = { ...procedural.snapshot,
      knowledgeRefs: procedural.snapshot.knowledgeRefs.filter(reference => reference.id !== procedural.reference.id),
      knowledgePolicy: { ...procedural.snapshot.knowledgePolicy,
        requirements: procedural.snapshot.knowledgePolicy.requirements.filter(requirement => requirement.id !== procedural.reference.id) } };
    Reflect.deleteProperty(unsignedSnapshot, 'digest');
    const changedSnapshot = parseResolvedTargetSnapshotV2({ ...unsignedSnapshot,
      digest: `sha256:v2:${checkpointChecksum({ algorithm: 'sha256', version: 2, target: unsignedSnapshot })}` });
    const currentOptions = { ...procedural.options, authority: { resolvePublicationContext: async () => ({ registryVersion: 1,
      scope: coordinatorModule.knowledgeScopeFor(changedSnapshot), hostPolicy: changedSnapshot.knowledgePolicy }) } };

    const final = await new coordinatorModule.MemoryCoordinator(currentOptions).revalidate({
      context: f.context, snapshot: changedSnapshot, view,
    }, f.operation);

    expect(final.retrievedIds).toEqual([]);
    expect(final.messages.filter(message => message.id.startsWith('knowledge-hint:'))).toEqual([]);
    expect(final.messages).toContainEqual(unrelatedMessage);
    expect(final.qualification.diagnosisReady).toBe(false);
    const semanticGap = final.qualification.missingKnowledge.find(item => item.reference.id === f.reference.id);
    const proceduralGap = final.qualification.missingKnowledge.find(item => item.reference.id === procedural.reference.id);
    expect(semanticGap).toMatchObject({ kind: 'semantic', requiredness: 'required', reasonCode: 'KNOWLEDGE_SCOPE_MISMATCH' });
    expect(proceduralGap).toMatchObject({ kind: 'procedural', requiredness: 'required', reasonCode: 'KNOWLEDGE_SCOPE_MISMATCH' });
    expect(f.searched).toHaveLength(searchesBeforeRevalidation);
  });
  it('rejects an obsolete Target scope before any search', async () => {
    const f = await fixture();
    const options = { ...f.options, authority: { resolvePublicationContext: async () => ({ registryVersion: 2,
      scope: { ...scope, profileRevision: 'profile/v2' }, hostPolicy: f.policy }) } };
    const view = await new coordinatorModule.MemoryCoordinator(options).prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    expect(view.messages).toEqual([]); expect(view.qualification.missingKnowledge[0]?.reasonCode).toBe('KNOWLEDGE_SCOPE_MISMATCH');
    expect(f.searched).toEqual([]);
  });
  it('keeps approved Episodic recall when optional Semantic storage fails', async () => {
    const f = await fixture('optional'); const value = memoryCase({ status: 'approved' });
    const control = { schemaVersion: 1 as const, scope: simulationMemoryScope(), profilePolicyRevision: 'policy/v1', capture: 'manual' as const, recall: true };
    const context = { ...f.context, memoryControl: control };
    const options = { ...f.options, semantic: { search: async () => { throw new Error('offline'); } },
      episodic: { policy: { allows: () => true }, renderer: new BoundedMemoryHintRenderer(), recall: { prepare: async () => ({
        schemaVersion: 1 as const, scope: simulationMemoryScope(), selectionState: 'selected' as const, availability: 'ready' as const,
        selections: [{ memoryId: value.id, revision: value.revision, digest: value.digest }], hints: [{
          memoryId: value.id, revision: value.revision, digest: value.digest, sourceRunId: value.sourceRunId,
          capturedAt: value.capturedAt, validUntil: value.validUntil, summary: value.summary, limitations: value.limitations,
          evidenceRefs: value.evidenceRefs, diagnosisOnly: true as const }],
        selectedAt: now, validatedAt: now }) } } };
    const view = await new coordinatorModule.MemoryCoordinator(options).prepare({ context, snapshot: f.snapshot, text: '' }, f.operation);
    expect(JSON.stringify(view.messages)).toContain(value.summary); expect(view.fallbackPolicy).toBeUndefined();
    expect(view.qualification.diagnosisReady).toBe(true); expect(view.episodic?.state.hints).toHaveLength(1);
    expect(context.evidenceIds).toEqual([]);
  });
  it('keeps both knowledge types and Working Context when optional Episodic recall fails', async () => {
    const f = await fixture('optional'); const procedural = withProceduralKnowledge(f);
    const control = { schemaVersion: 1 as const, scope: simulationMemoryScope(), profilePolicyRevision: 'policy/v1', capture: 'manual' as const, recall: true };
    const context = { ...f.context, memoryControl: control,
      messages: [{ id: 'working-user-message', role: 'user' as const, createdAt: now,
        blocks: [{ type: 'text' as const, text: 'Current working context.' }] }], evidenceIds: ['current-evidence'] };
    const workingBefore = structuredClone({ messages: context.messages, evidenceIds: context.evidenceIds });
    const failedEpisodic = { state: { schemaVersion: 1 as const, scope: control.scope, selectionState: 'selected' as const,
      availability: 'unavailable' as const, selections: [], hints: [], reasonCode: 'MEMORY_LOOKUP_FAILED' as const },
      attempted: true, succeeded: false };
    const view = await new coordinatorModule.MemoryCoordinator(procedural.options).prepare({ context,
      snapshot: procedural.snapshot, text: '', episodic: failedEpisodic }, f.operation);
    expect(view.episodic).toMatchObject({ attempted: true, succeeded: false });
    expect(view.retrievedIds).toEqual([f.record.id, procedural.record.id]);
    expect(view.messages).toHaveLength(2);
    expect(view.qualification).toMatchObject({ diagnosisReady: true, missingKnowledge: [] });
    expect(view.fallbackPolicy).toBeUndefined();
    expect({ messages: context.messages, evidenceIds: context.evidenceIds }).toEqual(workingBefore);
  });
  it('uses working_only only when every attempted long-term retrieval fails', async () => {
    const f = await fixture('optional');
    const view = await new coordinatorModule.MemoryCoordinator({ ...f.options, semantic: { search: async () => { throw new Error('offline'); } } })
      .prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    expect(view.fallbackPolicy).toBe('working_only'); expect(view.messages).toEqual([]);
  });
  it('does not select working_only when authorization fails before any retrieval is attempted', async () => {
    const f = await fixture('optional');
    const coordinator = new coordinatorModule.MemoryCoordinator({ ...f.options,
      authority: { resolvePublicationContext: async () => { throw new Error('authority unavailable'); } } });
    const view = await coordinator.prepare({ context: f.context, snapshot: f.snapshot, text: '' }, f.operation);
    expect(f.searched).toEqual([]);
    expect(view.fallbackPolicy).toBeUndefined();
    expect(view.qualification.diagnosisReady).toBe(true);
  });
});
