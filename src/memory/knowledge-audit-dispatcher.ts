import type { Clock } from '../contracts/common.js';
import type { KnowledgeGovernanceAuditOutboxPort, KnowledgeGovernanceAuditV1 } from '../contracts/knowledge-governance-audit.js';
import type { KnowledgeGovernanceAuditAttemptPort } from '../contracts/knowledge-memory-storage.js';

export interface KnowledgeAuditSink {
  /** The receiving system must deduplicate retries using auditId. */
  deliver(event: KnowledgeGovernanceAuditV1): Promise<void>;
}

export interface KnowledgeAuditDispatcherOptions {
  outbox: KnowledgeGovernanceAuditOutboxPort & KnowledgeGovernanceAuditAttemptPort;
  sink: KnowledgeAuditSink;
  clock: Clock;
  batchSize?: number;
}

export interface KnowledgeAuditDispatchResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly pending: boolean;
}

/** Explicit, bounded dispatcher. The host controls its single startup/shutdown lifecycle. */
export class KnowledgeAuditDispatcher {
  private readonly batchSize: number;
  private drainTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: KnowledgeAuditDispatcherOptions) {
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) {
      throw new RangeError('batchSize must be between 1 and 500');
    }
  }

  /** Processes at most one bounded page; failed rows remain pending for a later tick/restart. */
  public drainOnce(): Promise<KnowledgeAuditDispatchResult> {
    const current = this.drainTail.then(() => this.drainBatch(), () => this.drainBatch());
    this.drainTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async drainBatch(): Promise<KnowledgeAuditDispatchResult> {
    const records = await this.options.outbox.listPending(this.batchSize);
    let delivered = 0;
    let failed = 0;
    for (const event of records) {
      try {
        await this.options.sink.deliver(event);
        await this.options.outbox.markDelivered({ auditId: event.auditId, deliveredAt: this.options.clock.now().toISOString() });
        delivered += 1;
      } catch {
        failed += 1;
        await this.options.outbox.recordDeliveryFailure(event.auditId);
      }
    }
    const pending = (await this.options.outbox.listPending(1)).length > 0;
    return { attempted: records.length, delivered, failed, pending };
  }
}
