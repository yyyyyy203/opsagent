import { describe, expect, it } from 'vitest';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseKnowledgeDiagnosisQualification, parseKnowledgeRecord } from '../src/contracts/knowledge-memory-schema.js';

function captureError(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  return undefined;
}

const glossaryTerm = {
  term: 'settlement',
  definition: 'Captures the business meaning of settlement.',
  sourceReference: { sourceId: 'runbook:settlement', sourceVersion: '1', digest: 'b'.repeat(64) },
};
const glossaryContent = {
  type: 'domain_glossary',
  terms: [glossaryTerm],
};

const validSemanticRecord = (): Record<string, unknown> & {
  scope: Record<string, unknown>;
  content: Record<string, unknown>;
} => ({
  schemaVersion: 1,
  id: 'settlement-glossary',
  kind: 'semantic',
  contentRevision: 2,
  governanceVersion: 4,
  sourceEpoch: 3,
  status: 'approved',
  createdAt: '2026-10-01T00:00:00.000Z',
  validUntil: '2027-10-01T00:00:00.000Z',
  scope: {
    targetId: 'market-a-sim',
    projectId: 'market-a',
    deploymentId: 'lab',
    deploymentGeneration: 1,
    targetFingerprint: 'market-a-lab-dataset-a',
    profileId: 'market-a.lab.settlement',
    profileRevision: 'profile/v1',
    scenarioId: 'window_failure_rate.v1',
    scenarioVersion: '1.0.0',
    serviceIds: ['checkout'],
    faultTypes: ['settlement_failure'],
    environment: 'simulation',
    dataClass: 'simulated',
    datasetId: 'dataset-a-v1',
  },
  provenance: {
    sourceType: 'controlled_runbook',
    sourceId: 'runbook:settlement',
    sourceVersion: '1',
    sourceDigest: 'b'.repeat(64),
    importedAt: '2026-10-01T00:00:00.000Z',
  },
  contentDigest: '72f0d6ea919854436497ef329d1be19a116a095330503c278eafdc39232cead5',
  review: {
    reviewerId: 'local-operator',
    reviewedAt: '2026-10-02T00:00:00.000Z',
    checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true },
    sourceVerification: { sourceEpoch: 3, sourceDigest: 'b'.repeat(64) },
  },
  content: glossaryContent,
});

const proceduralContent = (overrides: Record<string, unknown> = {}) => ({
  type: 'investigation_template',
  templateId: 'settlement-triage',
  scenario: { id: 'window_failure_rate.v1', version: '1.0.0' },
  applicableTo: { serviceIds: ['checkout'], faultTypes: ['settlement_failure'], environments: ['simulation'] },
  preconditions: ['Target snapshot has a settlement service.'],
  requiredEvidence: [{ category: 'metric', minimumCount: 1 }],
  steps: [{ step: 1, goal: 'Read the failure window.', capabilityId: 'metrics.query', completionCriterion: 'Window values are present.' }],
  stopConditions: ['Stop when required metrics are unavailable.'],
  expectedReportFields: ['summary', 'evidence'],
  limitations: ['This is a read-only suggestion.'],
  sourceReferences: [{ sourceId: 'runbook:settlement', sourceVersion: '1', digest: 'b'.repeat(64) }],
  ...overrides,
});

const validProceduralRecord = (): Record<string, unknown> & {
  scope: Record<string, unknown>;
  content: Record<string, unknown>;
} => {
  const content = proceduralContent();
  return {
    ...validSemanticRecord(),
    id: 'settlement-procedure',
    kind: 'procedural',
    contentRevision: 1,
    governanceVersion: 1,
    status: 'draft',
    review: undefined,
    content,
    contentDigest: checkpointChecksum(content),
  };
};

describe('governed Semantic and Procedural schemas', () => {
  it('parses an approved Semantic revision with its exact complete Target scope', () => {
    const parsed = parseKnowledgeRecord(validSemanticRecord());

    expect(parsed).toMatchObject({
      id: 'settlement-glossary',
      kind: 'semantic',
      contentRevision: 2,
      governanceVersion: 4,
      sourceEpoch: 3,
      status: 'approved',
      scope: { targetId: 'market-a-sim', datasetId: 'dataset-a-v1' },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scope)).toBe(true);
    expect(Object.isFrozen(parsed.scope.serviceIds)).toBe(true);
    expect(Object.isFrozen(parsed.content)).toBe(true);
    if (parsed.kind === 'semantic' && parsed.content.type === 'domain_glossary') {
      expect(Object.isFrozen(parsed.content.terms)).toBe(true);
      expect(Reflect.set(parsed.content.terms[0]!, 'definition', 'mutated')).toBe(false);
    }
  });

  it('rejects a record whose content changed but whose immutable content digest did not', () => {
    const changed = validSemanticRecord();
    changed.content = {
      ...glossaryContent,
      terms: [{ ...glossaryTerm, definition: 'A changed definition.' }],
    };

    expect(captureError(() => parseKnowledgeRecord(changed)))
      .toMatchObject({ code: 'KNOWLEDGE_DIGEST_MISMATCH' });
  });

  it('rejects unknown fields and incomplete host-generated scope', () => {
    expect(captureError(() => parseKnowledgeRecord({ ...validSemanticRecord(), injected: true })))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });

    const incomplete = validSemanticRecord();
    incomplete.scope = Object.fromEntries(Object.entries(incomplete.scope).filter(([key]) => key !== 'targetId'));
    expect(captureError(() => parseKnowledgeRecord(incomplete)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });

    const missingProvenance = validSemanticRecord();
    delete missingProvenance.provenance;
    expect(captureError(() => parseKnowledgeRecord(missingProvenance)))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('rejects live/simulation scope confusion', () => {
    const mixed = validSemanticRecord();
    mixed.scope = { ...mixed.scope, environment: 'production' };

    expect(captureError(() => parseKnowledgeRecord(mixed)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });
  });

  it('bounds content size before it can enter a model context', () => {
    const oversized = validSemanticRecord();
    oversized.content = {
      type: 'domain_glossary',
      terms: [{ term: 'large', definition: 'x'.repeat(20_000),
        sourceReference: { sourceId: 'runbook:settlement', sourceVersion: '1', digest: 'b'.repeat(64) } }],
    };
    oversized.contentDigest = 'c'.repeat(64);

    expect(captureError(() => parseKnowledgeRecord(oversized)))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('rejects duplicate ordered steps in a Procedural investigation template', () => {
    const content = proceduralContent({ steps: [
      { step: 1, goal: 'Read the failure window.', capabilityId: 'metrics.query', completionCriterion: 'Window values are present.' },
      { step: 1, goal: 'Compare the baseline.', capabilityId: 'metrics.query', completionCriterion: 'Baseline is present.' },
    ] });
    const procedural = { ...validProceduralRecord(), content, contentDigest: checkpointChecksum(content) };

    expect(captureError(() => parseKnowledgeRecord(procedural)))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('does not allow Procedural applicability to escape its Target scope', () => {
    const content = proceduralContent({ applicableTo: {
      serviceIds: ['other-service'],
      faultTypes: ['credential_access'],
      environments: ['simulation', 'production'],
    } });

    expect(captureError(() => parseKnowledgeRecord({
      ...validProceduralRecord(), content, contentDigest: checkpointChecksum(content),
    }))).toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });
  });

  it('rejects obviously mutating verbs in Procedural capability IDs', () => {
    const content = proceduralContent({ steps: [{
      step: 1,
      goal: 'Restart the service.',
      capabilityId: 'actions.restart',
      completionCriterion: 'The service restarted.',
    }] });

    expect(captureError(() => parseKnowledgeRecord({
      ...validProceduralRecord(), content, contentDigest: checkpointChecksum(content),
    }))).toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('does not allow Semantic topology facts to name services outside their Target scope', () => {
    const content = {
      type: 'service_topology',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      services: [{ serviceId: 'other-service', displayName: 'Other service' }],
      dependencies: [],
    };
    const semantic = { ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content) };

    expect(captureError(() => parseKnowledgeRecord(semantic)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });
  });

  it('rejects endpoint addresses and credential-like values in records and free text', () => {
    const endpointInScope = validSemanticRecord();
    endpointInScope.scope = { ...endpointInScope.scope, deploymentId: 'prometheus.internal:9090' };
    expect(captureError(() => parseKnowledgeRecord(endpointInScope)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });

    const singleLabelHostPort = validSemanticRecord();
    singleLabelHostPort.scope = { ...singleLabelHostPort.scope, deploymentId: 'prometheus:9090' };
    expect(captureError(() => parseKnowledgeRecord(singleLabelHostPort)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });

    const ipv6Address = validSemanticRecord();
    ipv6Address.scope = { ...ipv6Address.scope, deploymentId: 'fd00::10' };
    expect(captureError(() => parseKnowledgeRecord(ipv6Address)))
      .toMatchObject({ code: 'KNOWLEDGE_SCOPE_INVALID' });

    const credentialInSource = validSemanticRecord();
    credentialInSource.provenance = {
      sourceType: 'controlled_runbook',
      sourceId: 'api_key=abcdefghijklmnop',
      sourceVersion: '1',
      sourceDigest: 'b'.repeat(64),
      importedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(captureError(() => parseKnowledgeRecord(credentialInSource)))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });

    for (const secretText of [
      'PROMETHEUS_TOKEN=example-secret-value',
      'token=example-secret-value',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'Authorization: Basic YWRtaW46cGFzcw==',
    ]) {
      const content = {
        type: 'domain_glossary',
        terms: [{ ...glossaryTerm, definition: secretText }],
      };
      expect(captureError(() => parseKnowledgeRecord({
        ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
      }))).toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
    }

    const content = {
      type: 'domain_glossary',
      terms: [{
        ...glossaryTerm,
        definition: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      }],
    };
    const credentialInText = {
      ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
    };
    expect(captureError(() => parseKnowledgeRecord(credentialInText)))
      .toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });

    const ordinaryAuthDescription = {
      type: 'domain_glossary',
      terms: [{ ...glossaryTerm, definition: 'Basic authentication is required by the upstream service.' }],
    };
    expect(parseKnowledgeRecord({
      ...validSemanticRecord(), content: ordinaryAuthDescription,
      contentDigest: checkpointChecksum(ordinaryAuthDescription),
    }).kind).toBe('semantic');
  });

  it('rejects a Basic credential when the authorization header uses an equals delimiter', () => {
    const content = {
      type: 'domain_glossary',
      terms: [{ ...glossaryTerm, definition: 'Authorization=Basic YWRtaW46cGFzcw==' }],
    };

    expect(captureError(() => parseKnowledgeRecord({
      ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
    }))).toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('rejects a Basic credential in JSON-serialized authorization headers', () => {
    const content = {
      type: 'domain_glossary',
      terms: [{ ...glossaryTerm, definition: '{"Authorization":"Basic YWRtaW46cGFzcw=="}' }],
    };

    expect(captureError(() => parseKnowledgeRecord({
      ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
    }))).toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('allows documentation that mentions the Basic authorization scheme without credentials', () => {
    const content = {
      type: 'domain_glossary',
      terms: [{ ...glossaryTerm, definition: 'The Authorization: Basic authentication scheme is deprecated.' }],
    };

    expect(parseKnowledgeRecord({
      ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
    }).kind).toBe('semantic');
  });

  it('rejects duplicate missing references and prevents a ready diagnosis with required gaps', () => {
    const reference = {
      reference: { id: 'settlement-glossary', version: '2', digest: 'a'.repeat(64), approval: 'approved' },
      kind: 'semantic',
      requiredness: 'required',
      reasonCode: 'KNOWLEDGE_NOT_FOUND',
    };
    const duplicate = {
      schemaVersion: 1,
      diagnosisReady: true,
      missingKnowledge: [reference, reference],
      limitationReasons: [],
    };

    expect(captureError(() => parseKnowledgeDiagnosisQualification(duplicate)))
      .toMatchObject({ code: 'KNOWLEDGE_QUALIFICATION_INVALID' });
    expect(captureError(() => parseKnowledgeDiagnosisQualification({
      ...duplicate,
      missingKnowledge: [reference],
    }))).toMatchObject({ code: 'KNOWLEDGE_QUALIFICATION_INVALID' });
  });

  it('rejects duplicate source references in a Semantic metric definition', () => {
    const reference = { sourceId: 'metrics:checkout', sourceVersion: '1', digest: 'b'.repeat(64) };
    const content = {
      type: 'metric_definition',
      metricName: 'settlement_failures_total',
      businessMeaning: 'Counts failed settlements.',
      unit: 'events',
      labels: [],
      allowedAggregations: ['rate'],
      windowSemantics: ['rolling_window'],
      sourceReferences: [reference, reference],
    };

    expect(captureError(() => parseKnowledgeRecord({
      ...validSemanticRecord(), content, contentDigest: checkpointChecksum(content),
    }))).toMatchObject({ code: 'KNOWLEDGE_RECORD_INVALID' });
  });

  it('accepts only canonical safe integer content revisions in governed Target references', () => {
    const qualification = {
      schemaVersion: 1,
      diagnosisReady: false,
      missingKnowledge: [{
        reference: { id: 'settlement-glossary', version: '1.0.0', digest: 'a'.repeat(64), approval: 'approved' },
        kind: 'semantic', requiredness: 'optional', reasonCode: 'KNOWLEDGE_NOT_FOUND',
      }],
      limitationReasons: [],
    };

    expect(captureError(() => parseKnowledgeDiagnosisQualification(qualification)))
      .toMatchObject({ code: 'KNOWLEDGE_QUALIFICATION_INVALID' });
    const unsafeInteger = structuredClone(qualification);
    unsafeInteger.missingKnowledge[0]!.reference.version = '9007199254740992';
    expect(captureError(() => parseKnowledgeDiagnosisQualification(unsafeInteger)))
      .toMatchObject({ code: 'KNOWLEDGE_QUALIFICATION_INVALID' });
  });
});
