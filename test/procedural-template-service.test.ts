import { describe, expect, it } from 'vitest';
import type { KnowledgeGovernanceAuditV1 } from '../src/contracts/knowledge-governance-audit.js';
import type { KnowledgeScope, ProceduralKnowledgeContent } from '../src/contracts/knowledge-memory.js';
import { InMemoryGovernedKnowledgeStore } from '../src/memory/in-memory-knowledge-store.js';
import { ProceduralTemplateService } from '../src/memory/procedural-template-service.js';
import { SemanticSourceRegistry } from '../src/memory/semantic-source-registry.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteGovernedKnowledgeStore } from '../src/infrastructure/sqlite/knowledge-memory-store.js';

const digest = 'a'.repeat(64);
const source = { sourceId: 'settlement-runbook', sourceVersion: 'runbook/v1', digest };
const secondarySource = { sourceId: 'operator-runbook', sourceVersion: 'operator/v1', digest: 'b'.repeat(64) };
const scope: KnowledgeScope = {
  targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
  targetFingerprint: 'market-a-lab', profileId: 'market-a-profile', profileRevision: 'profile/v1',
  scenarioId: 'settlement-failure', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
  faultTypes: ['settlement-failure'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a',
};

function templateContent(templateId = 'settlement-investigation'): ProceduralKnowledgeContent {
  return {
    type: 'investigation_template', templateId,
    scenario: { id: scope.scenarioId, version: scope.scenarioVersion },
    applicableTo: { serviceIds: [...scope.serviceIds], faultTypes: [...scope.faultTypes], environments: ['simulation'] },
    preconditions: ['A settlement failure alert is active.'],
    requiredEvidence: [{ category: 'metric', minimumCount: 2 }],
    steps: [{ step: 1, goal: 'Compare the failure rate over the configured window.', capabilityId: 'metrics.query',
      completionCriterion: 'The metric window and sample count are recorded.' }],
    stopConditions: ['Stop when the required evidence is unavailable.'],
    expectedReportFields: ['observed_rate', 'sample_count'],
    limitations: ['This template is guidance, not a diagnosis.'],
    sourceReferences: [source],
  };
}

function setup(backend: 'memory' | 'sqlite' = 'memory') {
  let now = new Date('2026-10-12T00:00:00.000Z');
  let nextId = 0;
  const database = backend === 'sqlite' ? SqliteDatabase.open(':memory:') : undefined;
  const storeOptions = {
    authority: { resolveFor: async () => ({ actorId: 'operator-reviewer', scope, sourceEpoch: 0,
      sourceDigest: digest, reviewedAt: now.toISOString() }) },
    publicationActors: { resolveForTarget: async () => ({ actorId: 'operator-publisher' }) },
    clock: { now: () => new Date(now) },
    ids: { next: (prefix: string) => `${prefix}-${++nextId}` },
  };
  const store = database === undefined ? new InMemoryGovernedKnowledgeStore(storeOptions)
    : new SqliteGovernedKnowledgeStore(database, storeOptions);
  const sourceRegistry = new SemanticSourceRegistry({ schemaVersion: 1, sources: [{
    sourceType: 'controlled_runbook', sourceId: source.sourceId, sourceVersion: source.sourceVersion,
    sourceDigest: digest, dataDomainId: 'settlement-domain', allowedTargetIds: [scope.targetId],
  }, {
    sourceType: 'operator_provided', sourceId: secondarySource.sourceId, sourceVersion: secondarySource.sourceVersion,
    sourceDigest: secondarySource.digest, dataDomainId: 'settlement-domain', allowedTargetIds: [scope.targetId],
  }] });
  const capabilityRegistry = {
    resolveForTarget: ({ targetId, capabilityId }: { targetId: string; capabilityId: string }) => {
      if (targetId !== scope.targetId || capabilityId !== 'metrics.query') return null;
      return { capabilityId, access: 'read_only' as const, serviceIds: [...scope.serviceIds],
        faultTypes: [...scope.faultTypes], environments: ['simulation'] as const, dataClasses: ['simulated'] as const };
    },
  };
  const service = new ProceduralTemplateService({
    sourceRegistry,
    capabilityRegistry,
    targets: { resolveForTarget: async ({ targetId }) => ({ actorId: `operator-${targetId}`, scope }) },
    drafts: store,
    sources: store,
    queries: store,
    reviews: store,
    transitions: store,
    reviewAttestations: { resolveForReview: async () => ({
      sourceVerified: true, scopeVerified: true, contentReviewed: true,
    }) },
    clock: { now: () => new Date(now) },
    ids: { next: prefix => `${prefix}-${++nextId}` },
  });
  return {
    store, service,
    setNow(value: string) { now = new Date(value); },
    close() { database?.close(); },
  };
}

describe.each(['memory', 'sqlite'] as const)('%s ProceduralTemplateService', backend => {
  it('creates an immutable host-scoped draft and rejects unknown or write-capable registry entries', async () => {
    const fixture = setup(backend);
    try {
      const draft = await fixture.service.createDraft({ requestId: 'template-draft', targetId: scope.targetId,
        source, content: templateContent() });
      expect(draft).toMatchObject({ kind: 'procedural', status: 'draft', contentRevision: 1,
        governanceVersion: 1, scope, provenance: { sourceType: 'controlled_runbook', sourceId: source.sourceId } });
      expect((await fixture.store.listPending(20)).find(item => item.requestId === 'template-draft'))
        .toMatchObject({ actorId: `operator-${scope.targetId}`, afterStatus: 'draft' });
      expect(await fixture.service.createDraft({ requestId: 'template-draft', targetId: scope.targetId,
        source, content: templateContent() })).toEqual(draft);

      await expect(fixture.service.createDraft({ requestId: 'unknown-capability', targetId: scope.targetId,
        source, content: { ...templateContent('unknown-capability'), steps: [
          { ...templateContent().steps[0]!, capabilityId: 'shell.read' },
        ] } })).rejects.toMatchObject({ code: 'KNOWLEDGE_APPROVAL_DENIED' });
      await expect(fixture.service.createDraft({ requestId: 'secondary-source', targetId: scope.targetId,
        source, content: { ...templateContent('secondary-source'), sourceReferences: [secondarySource] } }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });
      const forged = { requestId: 'forged-context', targetId: scope.targetId, source, content: templateContent(),
        actorId: 'attacker', scope: { ...scope, targetId: 'other' } } as unknown as Parameters<typeof fixture.service.createDraft>[0];
      await expect(fixture.service.createDraft(forged))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
    } finally { fixture.close(); }
  });

  it('reuses dual-version review CAS and keeps an older approved revision active until explicitly revoked', async () => {
    const fixture = setup(backend);
    try {
      const first = await fixture.service.createDraft({ requestId: 'template-r1', targetId: scope.targetId,
        source, content: templateContent() });
      const pending = await fixture.service.submitForReview({ requestId: 'template-submit-r1', targetId: scope.targetId,
        knowledgeId: first.id, contentRevision: 1, governanceVersion: 1 });
      const approved = await fixture.service.review({ requestId: 'template-approve-r1', targetId: scope.targetId,
        knowledgeId: first.id, contentRevision: 1, governanceVersion: pending.governanceVersion, decision: 'approve' });
      expect(approved.status).toBe('approved');

      const second = await fixture.service.reviseDraft({ requestId: 'template-r2', targetId: scope.targetId,
        source, content: { ...templateContent(), limitations: ['A newer review is pending.'] },
        knowledgeId: first.id, expectedContentRevision: 1, expectedGovernanceVersion: approved.governanceVersion });
      expect(second).toMatchObject({ contentRevision: 2, status: 'draft' });
      expect(await fixture.store.getExact({ id: first.id, contentRevision: 1, scope }))
        .toMatchObject({ status: 'approved', contentRevision: 1 });
      await expect(fixture.service.reviseDraft({ requestId: 'template-r2-stale', targetId: scope.targetId,
        source, content: templateContent('stale-revision'), knowledgeId: first.id,
        expectedContentRevision: 1, expectedGovernanceVersion: approved.governanceVersion }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT' });

      const revokeCommand = { requestId: 'template-revoke-r1', targetId: scope.targetId,
        knowledgeId: first.id, contentRevision: 1, expectedGovernanceVersion: approved.governanceVersion };
      const revoked = await fixture.service.revoke(revokeCommand);
      expect(revoked).toMatchObject({ status: 'revoked', governanceVersion: approved.governanceVersion + 1 });
      fixture.setNow('2026-10-12T00:00:05.000Z');
      expect(await fixture.service.revoke(revokeCommand)).toEqual(revoked);
      await expect(fixture.service.revoke({ requestId: 'template-stale-revoke', targetId: scope.targetId,
        knowledgeId: first.id, contentRevision: 1, expectedGovernanceVersion: approved.governanceVersion }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_GOVERNANCE_CONFLICT' });
      const audit = await fixture.store.listPending(20);
      const knowledgeTransitions = audit.filter((item): item is Extract<KnowledgeGovernanceAuditV1,
        { type: 'knowledge_transition' }> => item.type === 'knowledge_transition');
      expect(knowledgeTransitions.map(item => item.afterStatus)).toEqual(['draft', 'review_pending', 'approved', 'draft', 'revoked']);
      expect(audit.filter(item => item.requestId === revokeCommand.requestId)).toHaveLength(1);
      const revokeAudit = knowledgeTransitions.find(item => item.requestId === revokeCommand.requestId);
      expect(revokeAudit).toMatchObject({ afterStatus: 'revoked', occurredAt: '2026-10-12T00:00:00.000Z' });
    } finally { fixture.close(); }
  });

  it('records rejection through shared governance and blocks approval after primary source revocation', async () => {
    const fixture = setup(backend);
    try {
      const draft = await fixture.service.createDraft({ requestId: 'template-reject-draft', targetId: scope.targetId,
        source, content: templateContent() });
      const pending = await fixture.service.submitForReview({ requestId: 'template-reject-submit', targetId: scope.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: 1 });
      const rejected = await fixture.service.review({ requestId: 'template-reject', targetId: scope.targetId,
        knowledgeId: draft.id, contentRevision: 1, governanceVersion: pending.governanceVersion,
        decision: 'reject', reasonCode: 'INCOMPATIBLE_SCOPE' });
      expect(rejected.status).toBe('rejected');
      expect(rejected.review).toBeUndefined();

      const revokedDraft = await fixture.service.createDraft({ requestId: 'template-source-race', targetId: scope.targetId,
        source, content: templateContent('source-race') });
      const sourcePending = await fixture.service.submitForReview({ requestId: 'template-source-submit',
        targetId: scope.targetId, knowledgeId: revokedDraft.id, contentRevision: 1, governanceVersion: 1 });
      await fixture.store.transitionSource({ requestId: 'template-source-revoke', actorId: 'operator-admin',
        sourceId: source.sourceId, dataDomainId: 'settlement-domain', expectedSourceEpoch: 0,
        transition: 'revoked', sourceDigest: digest, occurredAt: '2026-10-12T00:00:01.000Z' });
      await expect(fixture.service.review({ requestId: 'template-source-approve', targetId: scope.targetId,
        knowledgeId: revokedDraft.id, contentRevision: 1, governanceVersion: sourcePending.governanceVersion,
        decision: 'approve' })).rejects.toMatchObject({ code: 'KNOWLEDGE_SOURCE_REVOKED' });
    } finally { fixture.close(); }
  });
});
