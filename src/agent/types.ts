import type { AgentContext, AgentEvent } from '../contracts/index.js';
import type {
  HistoricalEvidenceRef,
  MemoryHintRenderer,
  MemoryPolicyPort,
  MemoryPreferences,
  MemoryRecallPort,
  RunMemoryControl,
} from '../contracts/diagnostic-memory.js';
import type { TrustedTargetBinding } from '../contracts/target.js';

/** Host-injected memory ports; concrete stores and policy assembly stay outside the Harness. */
export interface AgentMemoryHarness {
  recall: MemoryRecallPort;
  renderer: MemoryHintRenderer;
  policy: MemoryPolicyPort;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  modelWindowTokens: number;
  reservedOutputTokens: number;
}

/** Internal sentinel used to preserve the trusted origin of a user cancel command. */
export const USER_RUN_CANCELLATION_REASON: unique symbol = Symbol('user-run-cancellation');

export interface ReplyOptions {
  message: string;
  profileId: string;
  runId?: string;
  sessionId?: string;
  replyId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  /** Optional shared ledger used by delegated child Runs. */
  toolCallBudget?: { remaining: number };
  /** Optional inherited ledger used by a delegated child Run. */
  networkAttemptBudget?: { remaining: number };
  /** @internal Host-only trusted scope; never accept from an external request parser. */
  trustedSystemContext?: string;
  /** @internal Host-only memory scope and policy; never accept from an external request parser. */
  trustedMemoryControl?: RunMemoryControl;
  /** @internal Host-only Target snapshot binding; never accept from an external request parser. */
  trustedTargetBinding?: TrustedTargetBinding;
  /** External preferences select only capabilities allowed by the host Profile policy. */
  memoryPreferences?: MemoryPreferences;
}

export interface DiagnosisRunResult {
  runId: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  status: AgentContext['status'];
  finalText: string;
  contextVersion: number;
}

export interface DiagnosisAgent {
  reply(options: ReplyOptions): Promise<DiagnosisRunResult>;
  replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
  resumeStream(
    runId: string,
    signal?: AbortSignal,
    toolCallBudget?: { remaining: number },
    networkAttemptBudget?: { remaining: number },
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
}
