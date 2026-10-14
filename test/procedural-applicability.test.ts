import { describe, expect, it } from 'vitest';
import type { KnowledgeScope, ProceduralKnowledgeContent, ProceduralKnowledgeRevision } from '../src/contracts/knowledge-memory.js';
import type { KnowledgeRevisionStateSnapshot } from '../src/contracts/knowledge-memory-storage.js';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseKnowledgeRecord } from '../src/contracts/knowledge-memory-schema.js';
import { parseResolvedTargetSnapshotV2 } from '../src/contracts/target-schema.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import { createStaticTargetResolver } from '../src/profiles/target-resolver.js';
import { multiProjectConnectionRegistry, multiProjectProfiles, multiProjectTargetCatalog } from '../src/profiles/target-samples.js';
import { WINDOW_FAILURE_RATE_INSTALLATION } from '../src/profiles/scenarios/window-failure-rate-v1.js';
import { findApplicableProceduralTemplates } from '../src/memory/procedural-applicability.js';
import { createTargetIdentityTestPorts } from './helpers/target-identity-test-ports.js';

const now = '2026-10-12T00:00:00.000Z';
const sourceDigest = 'a'.repeat(64);
const source = { sourceId: 'settlement-runbook', sourceVersion: 'runbook/v1', digest: sourceDigest };
const scope: KnowledgeScope = {
  targetId: 'market-a-sim', projectId: 'market-a', deploymentId: 'lab', deploymentGeneration: 1,
  targetFingerprint: 'market-a-lab-dataset-a', profileId: 'market-a.lab.settlement', profileRevision: 'profile/v1',
  scenarioId: 'window_failure_rate.v1', scenarioVersion: '1.1.0', serviceIds: ['checkout'],
  faultTypes: ['window_failure_rate.v1'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a-v1',
};

async function targetFixture(references: readonly { id: string; version: string; digest: string; approval: 'approved' }[]) {
  const resolver = await createStaticTargetResolver({ ...createTargetIdentityTestPorts(),
    catalog: multiProjectTargetCatalog, connections: multiProjectConnectionRegistry,
    profileResolver: new StaticProfileResolver(multiProjectProfiles),
    installedScenarios: [WINDOW_FAILURE_RATE_INSTALLATION], installedAdapters: [{ id: 'prometheus-mcp.v1', kind: 'metrics' }],
    validationTime: now,
    knowledgePublications: { inspectBinding: async () => ({ scopeKey: checkpointChecksum(scope), publication: {
      targetId: scope.targetId, publicationVersion: 1, references,
      policy: { schemaVersion: 1, targetId: scope.targetId, policyVersion: 'policy/v1', policyEpoch: 1,
        defaultRequiredness: 'optional', requirements: [] }, publishedAt: now,
    } }) },
  });
  const snapshot = parseResolvedTargetSnapshotV2(await resolver.resolve({
    targetId: scope.targetId, capturedAt: now, signal: new AbortController().signal,
  }));
  return { snapshot, scope };
}

function content(overrides: Partial<ProceduralKnowledgeContent> = {}): ProceduralKnowledgeContent {
  return {
    type: 'investigation_template', templateId: 'failure-rate-investigation',
    scenario: { id: 'window_failure_rate.v1', version: '1.1.0' },
    applicableTo: { serviceIds: ['checkout'], faultTypes: ['window_failure_rate.v1'], environments: ['simulation'] },
    preconditions: ['The failure-rate threshold was crossed.'],
    requiredEvidence: [{ category: 'metric', minimumCount: 2 }],
    steps: [{ step: 1, goal: 'Read the failure-rate metric.', capabilityId: 'metrics.query',
      completionCriterion: 'The window, value, and sample count are recorded.' }],
    stopConditions: ['Stop if the source is unavailable.'], expectedReportFields: ['rate', 'samples'],
    limitations: ['Suggestion only.'], sourceReferences: [source], ...overrides,
  };
}

function approvedRevision(scope: KnowledgeScope, procedure = content(), id = 'procedure-1', validUntil?: string): ProceduralKnowledgeRevision {
  return parseKnowledgeRecord({
    schemaVersion: 1, id, kind: 'procedural', contentRevision: 1, governanceVersion: 3, sourceEpoch: 0,
    status: 'approved', createdAt: '2026-10-11T00:00:00.000Z', ...(validUntil === undefined ? {} : { validUntil }),
    scope, provenance: { sourceType: 'controlled_runbook', sourceId: source.sourceId, sourceVersion: source.sourceVersion,
      sourceDigest, importedAt: '2026-10-11T00:00:00.000Z' },
    contentDigest: checkpointChecksum(procedure), review: { reviewerId: 'operator', reviewedAt: '2026-10-11T01:00:00.000Z',
      checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
      sourceVerification: { sourceEpoch: 0, sourceDigest } }, content: procedure,
  }) as ProceduralKnowledgeRevision;
}

function state(revision: ProceduralKnowledgeRevision, overrides: Partial<KnowledgeRevisionStateSnapshot> = {}): KnowledgeRevisionStateSnapshot {
  return {
    knowledgeId: revision.id, kind: 'procedural', contentRevision: revision.contentRevision,
    governanceVersion: revision.governanceVersion, contentDigest: revision.contentDigest, status: revision.status,
    sourceEpoch: revision.sourceEpoch, currentSourceEpoch: revision.sourceEpoch, sourceValidity: 'active',
    sourceDigestMatches: true, ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
    eligibleAt: now, ...overrides,
  };
}

function capabilityRegistry(overrides: Partial<{
  access: 'read_only' | 'write'; serviceIds: readonly string[]; faultTypes: readonly string[];
  environments: readonly ('simulation' | 'development' | 'staging' | 'production')[];
  dataClasses: readonly ('simulated' | 'live')[];
}> = {}) {
  return { resolveForTarget: ({ capabilityId }: { targetId: string; capabilityId: string }) => capabilityId === 'metrics.query'
    ? { capabilityId, access: 'read_only' as const, serviceIds: ['checkout'], faultTypes: ['window_failure_rate.v1'],
      environments: ['simulation'] as const, dataClasses: ['simulated'] as const, ...overrides }
    : null };
}

async function suggestionsFor(
  revision: ProceduralKnowledgeRevision,
  options: {
    references?: readonly { id: string; version: string; digest: string; approval: 'approved' }[];
    currentState?: KnowledgeRevisionStateSnapshot;
    registry?: ReturnType<typeof capabilityRegistry>;
  } = {},
) {
  const { snapshot } = await targetFixture(options.references ?? [{ id: revision.id,
    version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' }]);
  return findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
    candidates: [{ revision, state: options.currentState ?? state(revision) }],
    capabilityRegistry: options.registry ?? capabilityRegistry(), now });
}

const scopeMismatchCases: readonly {
  dimension: string;
  candidateScope: KnowledgeScope;
  procedure: ProceduralKnowledgeContent;
}[] = [
  {
    dimension: 'Scenario version',
    candidateScope: { ...scope, scenarioVersion: '2.0.0' },
    procedure: content({ scenario: { id: scope.scenarioId, version: '2.0.0' } }),
  },
  {
    dimension: 'service',
    candidateScope: { ...scope, serviceIds: ['other-service'] },
    procedure: content({ applicableTo: { ...content().applicableTo, serviceIds: ['other-service'] } }),
  },
  {
    dimension: 'fault type',
    candidateScope: { ...scope, faultTypes: ['other-fault'] },
    procedure: content({ applicableTo: { ...content().applicableTo, faultTypes: ['other-fault'] } }),
  },
  {
    dimension: 'environment',
    candidateScope: { ...scope, environment: 'development' },
    procedure: content({ applicableTo: { ...content().applicableTo, environments: ['development'] } }),
  },
];

describe('ProceduralApplicability', () => {
  it('returns a fixed suggestion only for an exact approved snapshot ref and preserves evidence requirements', async () => {
    const revision = approvedRevision(scope);
    const { snapshot } = await targetFixture([{ id: revision.id, version: '1', digest: revision.contentDigest, approval: 'approved' }]);
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [{ revision, state: state(revision), relevanceScore: 0.25 }],
      capabilityRegistry: capabilityRegistry(), now });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ schemaVersion: 1, reference: {
      id: revision.id, version: '1', digest: revision.contentDigest,
    }, requiredEvidence: [{ category: 'metric', minimumCount: 2 }], steps: [{ step: 1, capabilityId: 'metrics.query' }] });
    expect(suggestions[0]).not.toHaveProperty('toolCall');
    expect(suggestions[0]).not.toHaveProperty('approved');
  });

  it('never returns an approved candidate that is absent from the immutable Target reference allowlist', async () => {
    const revision = approvedRevision(scope);
    const { snapshot } = await targetFixture([]);
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [{ revision, state: state(revision), relevanceScore: 1 }],
      capabilityRegistry: capabilityRegistry(), now });

    expect(suggestions).toEqual([]);
  });

  it('filters before relevance ranking, so a high score cannot bypass ref, revocation, expiry, source, or scope gates', async () => {
    const eligible = approvedRevision(scope, content(), 'eligible');
    const wrongScope = approvedRevision({ ...scope, datasetId: 'other-dataset' }, content(), 'wrong-scope');
    const revoked = approvedRevision(scope, content(), 'revoked');
    const expired = approvedRevision(scope, content(), 'expired', '2026-10-11T23:59:59.000Z');
    const sourceStale = approvedRevision(scope, content(), 'source-stale');
    const { snapshot } = await targetFixture([eligible, wrongScope, revoked, expired, sourceStale].map(revision => ({
      id: revision.id, version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' as const,
    })));
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [
        { revision: eligible, state: state(eligible), relevanceScore: 0.2 },
        { revision: wrongScope, state: state(wrongScope), relevanceScore: 0.99 },
        { revision: revoked, state: state(revoked, { status: 'revoked' }), relevanceScore: 1 },
        { revision: expired, state: state(expired), relevanceScore: 1 },
        { revision: sourceStale, state: state(sourceStale, { sourceValidity: 'revoked' }), relevanceScore: 1 },
      ], capabilityRegistry: capabilityRegistry(), now });

    expect(suggestions.map(item => item.reference.id)).toEqual(['eligible']);
  });

  it('requires the current governance version and ignores malformed state snapshots without failing other candidates', async () => {
    const eligible = approvedRevision(scope, content(), 'eligible-state');
    const staleGovernance = approvedRevision(scope, content({ templateId: 'stale-governance' }), 'stale-governance');
    const { snapshot } = await targetFixture([eligible, staleGovernance].map(revision => ({ id: revision.id,
      version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' as const })));
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [
        { revision: staleGovernance, state: state(staleGovernance, { governanceVersion: 2 }), relevanceScore: 1 },
        { revision: eligible, state: null as unknown as KnowledgeRevisionStateSnapshot, relevanceScore: 0.5 },
        { revision: eligible, state: state(eligible), relevanceScore: 0.25 },
      ], capabilityRegistry: capabilityRegistry(), now });

    expect(suggestions.map(item => item.reference.id)).toEqual(['eligible-state']);
  });

  it('does not return a template when the Target cannot collect required evidence or its exact capability is write-capable', async () => {
    const metricRequired = approvedRevision(scope, content(), 'metric-template');
    const logRequired = approvedRevision(scope, content({ templateId: 'log-template',
      requiredEvidence: [{ category: 'log', minimumCount: 1 }] }), 'log-template');
    const { snapshot } = await targetFixture([metricRequired, logRequired].map(revision => ({ id: revision.id,
      version: '1', digest: revision.contentDigest, approval: 'approved' as const })));
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [
        { revision: metricRequired, state: state(metricRequired), relevanceScore: 0.8 },
        { revision: logRequired, state: state(logRequired), relevanceScore: 0.9 },
      ], capabilityRegistry: capabilityRegistry({ access: 'write' }), now });

    expect(suggestions).toEqual([]);
  });

  it('rejects malformed/high-similarity capability references and returns deterministic score ties', async () => {
    const first = approvedRevision(scope, content(), 'tie-a');
    const second = approvedRevision(scope, content({ templateId: 'tie-b' }), 'tie-b');
    const bad = approvedRevision(scope, content({ templateId: 'bad-capability', steps: [
      { ...content().steps[0]!, capabilityId: 'shell.read' },
    ] }), 'bad-capability');
    const { snapshot } = await targetFixture([first, second, bad].map(revision => ({ id: revision.id, version: '1',
      digest: revision.contentDigest, approval: 'approved' as const })));
    const suggestions = findApplicableProceduralTemplates({ targetSnapshot: snapshot, targetScope: scope,
      candidates: [
        { revision: second, state: state(second), relevanceScore: 0.5 },
        { revision: bad, state: state(bad), relevanceScore: 1 },
        { revision: first, state: state(first), relevanceScore: 0.5 },
      ], capabilityRegistry: capabilityRegistry(), now });

    expect(suggestions.map(item => item.reference.id)).toEqual(['tie-a', 'tie-b']);
  });

  it('rejects a Target reference with the wrong content revision', async () => {
    const revision = approvedRevision(scope);
    const suggestions = await suggestionsFor(revision, { references: [{ id: revision.id, version: '2',
      digest: revision.contentDigest, approval: 'approved' }] });

    expect(suggestions).toEqual([]);
  });

  it('rejects a Target reference with the wrong content digest', async () => {
    const revision = approvedRevision(scope);
    const suggestions = await suggestionsFor(revision, { references: [{ id: revision.id,
      version: String(revision.contentRevision), digest: 'b'.repeat(64), approval: 'approved' }] });

    expect(suggestions).toEqual([]);
  });

  it('rejects a Target-approved reference when the current revision approval is revoked', async () => {
    const approved = approvedRevision(scope);
    const revoked = parseKnowledgeRecord({ ...approved, status: 'revoked', governanceVersion: 4 }) as ProceduralKnowledgeRevision;

    expect(await suggestionsFor(revoked)).toEqual([]);
  });

  it.each(scopeMismatchCases)('rejects a candidate with a different $dimension from the Target', async ({
    candidateScope, procedure,
  }) => {
    const revision = approvedRevision(candidateScope, procedure, `mismatched-${procedure.templateId}`);

    expect(await suggestionsFor(revision)).toEqual([]);
  });

  it('rejects a candidate scoped to a different data class', async () => {
    const simulatedScope = scope;
    const { datasetId, ...liveScopeBase } = simulatedScope;
    void datasetId;
    const liveScope: KnowledgeScope = { ...liveScopeBase, environment: 'staging', dataClass: 'live' };
    const procedure = content({ applicableTo: { ...content().applicableTo, environments: ['staging'] } });
    const revision = approvedRevision(liveScope, procedure, 'live-procedure');

    expect(await suggestionsFor(revision)).toEqual([]);
  });

  it('rejects a capability registered for a different data class', async () => {
    const revision = approvedRevision(scope);

    expect(await suggestionsFor(revision, { registry: capabilityRegistry({ dataClasses: ['live'] }) })).toEqual([]);
  });

  it('rejects a stale current source epoch', async () => {
    const revision = approvedRevision(scope);

    expect(await suggestionsFor(revision, { currentState: state(revision, {
      currentSourceEpoch: revision.sourceEpoch + 1,
    }) })).toEqual([]);
  });

  it('rejects a current source digest mismatch', async () => {
    const revision = approvedRevision(scope);

    expect(await suggestionsFor(revision, { currentState: state(revision, { sourceDigestMatches: false }) })).toEqual([]);
  });
});
