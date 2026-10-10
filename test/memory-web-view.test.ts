import { describe, expect, it } from 'vitest';
import { RunViewController, type RunViewClient } from '../apps/agent-web/src/state/run-view.js';
import { canApproveMemoryCase, canRejectMemoryCase, captureTicketLabel } from '../apps/agent-web/src/components/MemoryPanel.js';
import type { DiagnosticMemoryCase, MemoryCaptureTicket, MemoryPreferences } from '../src/contracts/diagnostic-memory.js';

describe('memory web view', () => {
  it('passes the selected per-Run capture and recall preferences to Run creation', async () => {
    let started: Parameters<RunViewClient['startRun']>[0] | undefined;
    const client = {
      listProfiles: async () => [], listRuns: async () => ({ items: [] }),
      getRun: async () => null, getMessages: async () => ({ items: [] }), listEvidence: async () => ({ items: [] }),
      getConfirmation: async () => null, startRun: async (input: Parameters<RunViewClient['startRun']>[0]) => {
        started = input;
        return { runId: input.runId, status: 'running', eventsUrl: `/runs/${input.runId}/events` };
      },
      resumeRun: async () => ({ runId: 'run', status: 'running', eventsUrl: '/events' }),
      cancelRun: async () => ({ runId: 'run', status: 'cancelled' }),
      decideConfirmation: async () => ({ outcome: 'approved', revision: 2 }),
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
