import type { KnowledgeRevisionStateSnapshot } from '../../src/contracts/knowledge-memory-storage.js';
import type { SemanticKnowledgeRevision, KnowledgeScope } from '../../src/contracts/knowledge-memory.js';
import { checkpointChecksum } from '../../src/contracts/stable-json.js';
import { createStaticTargetResolver } from '../../src/profiles/target-resolver.js';
import { StaticProfileResolver } from '../../src/profiles/profile-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../../src/profiles/scenarios/window-failure-rate-v1.js';
import { createTargetIdentityTestPorts } from './target-identity-test-ports.js';
import type { AgentContext } from '../../src/contracts/context.js';

export const now = '2026-10-12T00:00:00.000Z';
export const scope: KnowledgeScope = {
  targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
  targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
  scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.0.0', serviceIds: ['checkout'],
  faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
};
export function revision(id = 'glossary'): SemanticKnowledgeRevision {
  const source = { sourceId: 'profile-source', sourceVersion: '1', digest: 'a'.repeat(64) };
  const content = { type: 'domain_glossary' as const,
    terms: [{ term: 'settlement', definition: 'A completed settlement', sourceReference: source }] };
  return { schemaVersion: 1, id, kind: 'semantic', contentRevision: 1, governanceVersion: 3,
    sourceEpoch: 0, status: 'approved', createdAt: now, scope,
    provenance: { sourceType: 'target_profile', sourceId: source.sourceId, sourceVersion: '1', sourceDigest: source.digest, importedAt: now },
    review: { reviewerId: 'operator', reviewedAt: now, checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
      sourceVerification: { sourceEpoch: 0, sourceDigest: source.digest } }, content, contentDigest: checkpointChecksum(content) };
}
export async function fixture(requiredness: 'required' | 'optional' = 'required') {
  const record = revision();
  const reference = { id: record.id, version: '1', digest: record.contentDigest, approval: 'approved' as const };
  const policy = { schemaVersion: 1 as const, targetId: scope.targetId, policyVersion: 'policy/v1', policyEpoch: 1,
    defaultRequiredness: 'optional' as const, requirements: [{
      id: reference.id, version: '1', digest: reference.digest, requiredness, knowledgeClass: 'semantic' as const }] };
  const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(), catalog: multiProjectTargetCatalog,
    connections: multiProjectConnectionRegistry, profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION], installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }], validationTime: now,
    knowledgeCapabilities: { getForTarget: async () => ({ semanticEnabled: true, proceduralEnabled: true }) },
    knowledgePublications: { inspectBinding: async () => ({ scopeKey: checkpointChecksum(scope), publication: {
      targetId: scope.targetId, publicationVersion: 1, references: [reference], policy, publishedAt: now } }) } });
  const snapshot = await resolver.resolve({ targetId: scope.targetId, capturedAt: now, signal: new AbortController().signal });
  const context: AgentContext = { runId: 'run-1', profileId: scope.profileId, status: 'running', stage: 'triage',
    messages: [], pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds: [], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: now, maxIterations: 3, iteration: 0, maxToolCalls: 5, toolCallsUsed: 0, maxDurationMs: 60000 } };
  let state: KnowledgeRevisionStateSnapshot | null = { knowledgeId: record.id, kind: 'semantic', contentRevision: 1,
    governanceVersion: 3, contentDigest: record.contentDigest, status: 'approved', sourceEpoch: 0, currentSourceEpoch: 0,
    sourceValidity: 'active', sourceDigestMatches: true, eligibleAt: now };
  const searched: string[][] = [];
  const options = {
    capabilities: { getForTarget: async () => ({ semanticEnabled: true, proceduralEnabled: true }) },
    authority: { resolvePublicationContext: async () => ({ registryVersion: 1, scope, hostPolicy: policy }) },
    states: { inspectExact: async () => state },
    semantic: { search: async (input: { references: readonly { id: string }[] }) => {
      searched.push(input.references.map(ref => ref.id)); return [record]; } },
    procedural: { search: async () => [] },
    proceduralCapabilities: { resolveForTarget: () => null },
  };
  const operation = { now, clock: { now: () => new Date(now) }, deadlineMs: Date.parse(now) + 60000,
    availableMemoryTokens: 8192, signal: new AbortController().signal };
  return { record, reference, policy, snapshot, context, searched, options, operation,
    setState: (value: KnowledgeRevisionStateSnapshot | null) => { state = value; }, getState: () => state! };
}
