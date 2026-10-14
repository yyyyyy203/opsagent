import { expect } from 'vitest';
import type { KnowledgeScope, KnowledgeRevision } from '../../src/contracts/knowledge-memory.js';
import type { GovernedKnowledgePublicationCommand } from '../../src/contracts/knowledge-memory-storage.js';
import { checkpointChecksum } from '../../src/contracts/stable-json.js';
import { SqliteDatabase } from '../../src/infrastructure/sqlite/database.js';
import { SqliteTargetIdentityStore } from '../../src/infrastructure/sqlite/target-identity-store.js';
import { InMemoryTargetIdentityStore } from '../../src/storage/in-memory-target-identity-store.js';
import { SqliteTargetKnowledgeBindingStore } from '../../src/infrastructure/sqlite/target-knowledge-binding-store.js';
import { SqliteGovernedKnowledgeStore } from '../../src/infrastructure/sqlite/knowledge-memory-store.js';
import { InMemoryGovernedKnowledgeStore } from '../../src/memory/in-memory-knowledge-store.js';
import { createStaticTargetResolver } from '../../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../../src/profiles/profile-resolver.js';
import { multiProjectTargetCatalog, multiProjectConnectionRegistry, multiProjectProfiles } from '../../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../../src/profiles/scenarios/window-failure-rate-v1.js';

export const time = '2026-10-13T00:00:00.000Z';
const sourceDigest = 'a'.repeat(64);
export const scope: KnowledgeScope = {
  targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
  targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
  scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.1.0', serviceIds: ['checkout'],
  faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
};
export async function fixture(backend: 'sqlite' | 'memory', path = ':memory:') {
  const database = SqliteDatabase.open(path);
  let now = time;
  let serial = 0;
  let duringActor: () => Promise<void> = async () => undefined;
  const clock = { now: () => new Date(now) };
  const ids = { next: (prefix: string) => `${prefix}-${++serial}` };
  const identity = backend === 'sqlite' ? new SqliteTargetIdentityStore(database, { clock }) : new InMemoryTargetIdentityStore({ clock });
  const authority = { resolveFor: async () => ({ actorId: 'reviewer', scope, sourceEpoch: 0, sourceDigest, reviewedAt: now }) };
  const actors = { resolveForTarget: async () => { await duringActor(); return { actorId: 'publisher' }; } };
  const memory = new InMemoryGovernedKnowledgeStore({ authority, publicationActors: actors, clock, ids, publicationFence: identity });
  const store = backend === 'sqlite' ? new SqliteGovernedKnowledgeStore(database, { authority, clock, ids }) : memory;
  const binding = backend === 'sqlite' ? new SqliteTargetKnowledgeBindingStore(database, { actors, clock, ids }) : memory;
  expect(binding).toHaveProperty('publishGoverned');
  const publisher = binding;
  const resolverOptions = { catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles), installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION],
    installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' as const }], identityRegistry: identity,
    knowledgePolicies: identity, knowledgePublications: binding,
    knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: true, proceduralEnabled: true }) }, validationTime: time };
  const resolver = await createStaticTargetResolver(resolverOptions);
  async function approved(n: number, validUntil?: string, kind: 'semantic' | 'procedural' = 'semantic') {
    const content = kind === 'semantic' ? { type: 'domain_glossary' as const, terms: [{ term: 'settlement', definition: `Settlement revision ${n}.`,
      sourceReference: { sourceId: 'runbook', sourceVersion: 'v1', digest: sourceDigest } }] }
      : { type: 'investigation_template' as const, templateId: 'settlement-template',
        scenario: { id: scope.scenarioId, version: scope.scenarioVersion },
        applicableTo: { serviceIds: ['checkout'], faultTypes: [scope.scenarioId], environments: ['simulation' as const] },
        preconditions: ['Check telemetry.'], requiredEvidence: [{ category: 'metric' as const, minimumCount: 1 }],
        steps: [{ step: 1, goal: `Inspect settlement ${n}.`, capabilityId: 'metrics.read', completionCriterion: 'Window checked.' }],
        stopConditions: ['Stop when unavailable.'], expectedReportFields: ['limitations'], limitations: ['Advice only.'],
        sourceReferences: [{ sourceId: 'runbook', sourceVersion: 'v1', digest: sourceDigest }] };
    const revision = { schemaVersion: 1, id: 'publication-knowledge', kind,
      contentRevision: n, governanceVersion: 1, sourceEpoch: 0, status: 'draft', scope, content,
      contentDigest: checkpointChecksum(content), createdAt: time, ...(validUntil === undefined ? {} : { validUntil }),
      provenance: { sourceType: 'controlled_runbook', sourceId: 'runbook', sourceVersion: 'v1', sourceDigest, importedAt: time } } as KnowledgeRevision;
    await store.registerSource({ sourceId: 'runbook', dataDomainId: 'domain-one', sourceDigest, registeredAt: time });
    await store.saveDraft({ requestId: `draft-${n}`, actorId: 'operator', naturalKey: 'glossary', sourceDomainId: 'domain-one',
      expectedContentRevision: n === 1 ? null : n - 1, expectedGovernanceVersion: n === 1 ? null : 3, revision });
    await store.submitForReview({ requestId: `submit-${n}`, actorId: 'operator', knowledgeId: revision.id,
      kind, expectedContentRevision: n, expectedGovernanceVersion: 1 });
    return store.review({ schemaVersion: 1, requestId: `review-${n}`, knowledgeId: revision.id, kind,
      expectedContentRevision: n, expectedGovernanceVersion: 2, contentDigest: revision.contentDigest, decision: 'approve',
      checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } });
  }
  async function command(revisions: readonly KnowledgeRevision[], version = 0, requestId = 'publish'): Promise<GovernedKnowledgePublicationCommand> {
    const context = await resolver.resolvePublicationContext({ targetId: scope.targetId, capturedAt: now, signal: new AbortController().signal });
    const references = revisions.map(r => ({ id: r.id, version: String(r.contentRevision), digest: r.contentDigest, approval: 'approved' as const }));
    return { command: { requestId, targetId: scope.targetId, scope: context.scope, references,
      policy: context.hostPolicy ?? { schemaVersion: 1, targetId: scope.targetId, policyEpoch: 0,
        policyVersion: 'default/v1', defaultRequiredness: 'optional', requirements: [] },
      expectedPublicationVersion: version, publishedAt: time }, context,
      expectedRevisions: revisions.map((r, i) => ({ reference: references[i]!, governanceVersion: r.governanceVersion, sourceEpoch: r.sourceEpoch })) };
  }
  const snapshot = () => resolver.resolve({ targetId: scope.targetId, capturedAt: now, signal: new AbortController().signal });
  return { database, identity, store, binding, publisher, memory, resolver, resolverOptions, approved, command, snapshot,
    actor: (fn: () => Promise<void>) => { duringActor = fn; }, advance: (value: string) => { now = value; } };
}
