import type { InspectionQueryService, PublicEvidencePage, PublicEvidenceView, PublicRunDetail } from '../contracts/read-model.js';
import type { PublicConfirmation, PublicMessagePage, WebMessageQueries } from '../contracts/web-read-model.js';

interface TargetRunReadGate {
  getRun(targetId: string, runId: string): Promise<PublicRunDetail | null>;
  ownsRun(targetId: string, runId: string): Promise<boolean>;
  bindingForRun(runId: string): Promise<{ targetId: string; rootRunId: string } | null>;
}

/** Target read facade: establish immutable ownership and parent/child lineage before reading shared projections. */
export class TargetWebQueryService {
  public constructor(private readonly ports: {
    targetRuns: TargetRunReadGate;
    queries: InspectionQueryService;
    messages: WebMessageQueries;
    getConfirmation(runId: string): Promise<PublicConfirmation | null>;
  }) {}

  public async getRun(targetId: string, runId: string): Promise<PublicRunDetail | null> {
    const run = await this.ports.targetRuns.getRun(targetId, runId);
    if (run === null || await this.runTree(targetId, runId, run) === null) return null;
    return run;
  }

  public async listMessages(targetId: string, runId: string, options?: { cursor?: string; limit?: number }): Promise<PublicMessagePage | null> {
    if (!await this.ports.targetRuns.ownsRun(targetId, runId)) return null;
    return this.ports.messages.listMessages(runId, options);
  }

  public async listEvidence(targetId: string, runId: string, options?: { cursor?: string; limit?: number }): Promise<PublicEvidencePage | null> {
    const run = await this.ports.targetRuns.getRun(targetId, runId);
    if (run === null) return null;
    const allowedRunIds = await this.runTree(targetId, runId, run);
    if (allowedRunIds === null) return null;
    const page = await this.ports.queries.listEvidence(runId, options);
    if (page.items.some(item => !allowedRunIds.has(item.runId))) return null;
    return page;
  }

  public async getEvidence(targetId: string, runId: string, evidenceId: string): Promise<PublicEvidenceView | null> {
    const run = await this.ports.targetRuns.getRun(targetId, runId);
    if (run === null) return null;
    const allowedRunIds = await this.runTree(targetId, runId, run);
    if (allowedRunIds === null) return null;
    const evidence = await this.ports.queries.getEvidence(runId, evidenceId);
    return evidence !== null && allowedRunIds.has(evidence.runId) ? evidence : null;
  }

  public async getConfirmation(targetId: string, runId: string): Promise<PublicConfirmation | null> {
    if (!await this.ports.targetRuns.ownsRun(targetId, runId)) return null;
    return this.ports.getConfirmation(runId);
  }

  private async runTree(targetId: string, runId: string, run: PublicRunDetail): Promise<Set<string> | null> {
    const root = await this.ports.targetRuns.bindingForRun(runId);
    if (root === null || root.targetId !== targetId) return null;
    const allowedRunIds = new Set([runId]);
    if (run.parentRunId !== undefined) {
      const parent = await this.ports.targetRuns.bindingForRun(run.parentRunId);
      if (parent === null || parent.targetId !== targetId || parent.rootRunId !== root.rootRunId) return null;
      allowedRunIds.add(run.parentRunId);
    }
    for (const childRunId of run.childRunIds) {
      const child = await this.ports.targetRuns.bindingForRun(childRunId);
      if (child === null || child.targetId !== targetId || child.rootRunId !== root.rootRunId) return null;
      allowedRunIds.add(childRunId);
    }
    return allowedRunIds;
  }
}
