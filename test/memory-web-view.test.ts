import { describe, expect, it } from 'vitest';
import { RunViewController, type RunViewClient } from '../apps/agent-web/src/state/run-view.js';
import { canApproveMemoryCase, canPublishKnowledgeRevision, canRejectMemoryCase, captureTicketLabel,
  diagnosisQualificationLabel, isKnowledgePublishedInTarget } from '../apps/agent-web/src/components/MemoryPanel.js';
import type { DiagnosticMemoryCase, MemoryCaptureTicket, MemoryPreferences } from '../src/contracts/diagnostic-memory.js';
import type { PublicKnowledgeRevision, PublicTargetKnowledgeStatus } from '../apps/agent-web/src/api/types.js';

describe('memory web view', () => {
  it('passes the selected per-Run capture and recall preferences to Run creation', async () => {
    let started: Parameters<RunViewClient['startRun']>[0] | undefined;
    const client = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: () => Promise.resolve({ runId: 'run', profileId: 'simulation', status: 'completed', stage: 'triage',
        contextVersion: 0, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
        evidenceIds: [], missingEvidence: [], childRunIds: [] }),
      getMessages: () => Promise.resolve({ items: [] }), listEvidence: () => Promise.resolve({ items: [] }),
      getConfirmation: () => Promise.resolve(null), startRun: (input: Parameters<RunViewClient['startRun']>[0]) => {
        started = input;
        return Promise.resolve({ runId: input.runId, status: 'running', eventsUrl: `/runs/${input.runId}/events` });
      },
      resumeRun: () => Promise.resolve({ runId: 'run', status: 'running', eventsUrl: '/events' }),
      cancelRun: () => Promise.resolve({ runId: 'run', status: 'cancelled' }),
      decideConfirmation: () => Promise.resolve({ outcome: 'approved', revision: 2 }),
      openRunEvents: () => ({ close: () => undefined }),
    } satisfies RunViewClient;
    const controller = new RunViewController(client);
    const preferences: MemoryPreferences = { capture: 'manual', recall: 'disabled' };

    await controller.startRun('检查结算', 'simulation', preferences);

    expect(started?.memoryPreferences).toEqual(preferences);
    controller.close();
  });

  it('labels every capture ticket state without collapsing queued, running, and failed', () => {
    const labels: Array<[MemoryCaptureTicket['state'], string]> = [
      ['not_saved', '未保存'], ['queued', '排队中'], ['running', '生成中'],
      ['saved', '已保存候选'], ['failed', '生成失败'], ['unavailable', '不可用'],
    ];
    for (const [state, expected] of labels) {
      expect(captureTicketLabel(state)).toBe(expected);
    }
  });

  it('only enables approval for a sufficient completed case with evidence references', () => {
    const candidate = memoryCase({});
    expect(canApproveMemoryCase(candidate)).toBe(true);
    expect(canApproveMemoryCase(memoryCase({ quality: 'insufficient' }))).toBe(false);
    expect(canApproveMemoryCase(memoryCase({ sourceRunStatus: 'failed', quality: 'failed' }))).toBe(false);
    expect(canApproveMemoryCase(memoryCase({ evidenceRefs: [] }))).toBe(false);
    expect(canApproveMemoryCase(memoryCase({ status: 'approved' }))).toBe(false);
  });

  it('allows rejection only while a candidate is awaiting review', () => {
    expect(canRejectMemoryCase(memoryCase({}))).toBe(true);
    expect(canRejectMemoryCase(memoryCase({ status: 'approved' }))).toBe(false);
    expect(canRejectMemoryCase(memoryCase({ status: 'rejected' }))).toBe(false);
  });

  it('keeps approval separate from Target publication and refuses unqualified publication candidates', () => {
    const approved = knowledgeRevision({ status: 'approved' });
    const target = targetKnowledgeStatus({ references: [] });
    expect(canPublishKnowledgeRevision(approved, true, '2026-10-13T00:00:00.000Z')).toBe(true);
    expect(isKnowledgePublishedInTarget(approved, target)).toBe(false);
    expect(isKnowledgePublishedInTarget(approved, targetKnowledgeStatus({ references: [
      { id: approved.id, version: String(approved.contentRevision), digest: approved.contentDigest, approval: 'approved' },
    ] }))).toBe(true);
    expect(canPublishKnowledgeRevision(knowledgeRevision({ status: 'draft' }), true, '2026-10-13T00:00:00.000Z')).toBe(false);
    expect(canPublishKnowledgeRevision(approved, false, '2026-10-13T00:00:00.000Z')).toBe(false);
    expect(canPublishKnowledgeRevision(knowledgeRevision({ status: 'approved', validUntil: '2026-10-12T00:00:00.000Z' }),
      true, '2026-10-13T00:00:00.000Z')).toBe(false);
  });

  it('labels structured knowledge qualification without rewriting diagnosis text', () => {
    expect(diagnosisQualificationLabel(undefined)).toBe('未提供知识资格信息');
    expect(diagnosisQualificationLabel({ schemaVersion: 1, diagnosisReady: true, missingKnowledge: [], limitationReasons: [] }))
      .toBe('知识资格：满足');
    expect(diagnosisQualificationLabel({ schemaVersion: 1, diagnosisReady: false, missingKnowledge: [],
      limitationReasons: ['OPTIONAL_KNOWLEDGE_OMITTED'] })).toBe('知识资格：受限（部分知识不可用）');
  });
});

function memoryCase(overrides: Partial<DiagnosticMemoryCase>): DiagnosticMemoryCase {
  return {
    schemaVersion: 1, id: 'case-1', revision: 1, extractorVersion: 'episodic-v1',
    scope: { profileId: 'simulation', profileRevision: '1', serviceId: 'checkout', faultType: 'settlement_failure',
      targetFingerprint: 'fixture', environment: 'simulation', dataClass: 'simulated', datasetId: 'memory-web' },
    sourceRunId: 'run-1', sourceRunStatus: 'completed', capturedAt: '2026-10-10T00:00:00.000Z',
    validUntil: '2026-11-09T00:00:00.000Z', status: 'observation', quality: 'sufficient',
    summary: '结算失败率升高，连接池等待增加。', symptomCodes: ['SETTLEMENT_FAILURE_HIGH'], limitations: [],
    evidenceRefs: [{ evidenceId: 'evidence-1', ownerRunId: 'run-1', source: 'metric',
      capturedAt: '2026-10-10T00:00:00.000Z', rawSha256: 'a'.repeat(64) }],
    diagnosisOnly: true, eligibleForPromotion: false, digest: 'b'.repeat(64), ...overrides,
  };
}

function knowledgeRevision(overrides: Partial<PublicKnowledgeRevision>): PublicKnowledgeRevision {
  return { schemaVersion: 1, id: 'semantic-1', kind: 'semantic', contentRevision: 2, governanceVersion: 3,
    sourceEpoch: 1, status: 'approved', createdAt: '2026-10-10T00:00:00.000Z', contentDigest: 'a'.repeat(64),
    content: { type: 'metric_definition', metricName: 'checkout_failures_total', businessMeaning: '失败计数', unit: 'count',
      labels: [], allowedAggregations: ['sum'], windowSemantics: ['fixed_window'],
      sourceReferences: [{ sourceId: 'prometheus', sourceVersion: 'v1', digest: 'b'.repeat(64) }] },
    applicability: { profileRevision: '1', scenarioId: 'settlement', scenarioVersion: '1', serviceIds: ['checkout'],
      faultTypes: ['settlement_failure'], environment: 'simulation', dataClass: 'simulated', datasetId: 'dataset-a' },
    source: { type: 'controlled_runbook', id: 'runbook-1', version: '1', digest: 'b'.repeat(64), importedAt: '2026-10-10T00:00:00.000Z' },
    review: { reviewedAt: '2026-10-10T00:00:00.000Z', checks: { sourceVerified: true, scopeVerified: true, contentReviewed: true } },
    ...overrides };
}

function targetKnowledgeStatus(overrides: Partial<PublicTargetKnowledgeStatus>): PublicTargetKnowledgeStatus {
  return { targetId: 'target-a', capabilities: { semanticEnabled: true, proceduralEnabled: true }, requiredKnowledge: [],
    publicationVersion: 0, publicationState: 'empty', references: [], ...overrides };
}
