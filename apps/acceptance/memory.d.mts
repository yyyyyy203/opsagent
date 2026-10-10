export interface MemoryAcceptanceResult {
  status: 'passed' | 'failed';
  code?: string;
  checks: Record<string, boolean>;
  strategyMatrix: readonly {
    capture: 'manual' | 'automatic' | 'skip';
    recall: boolean;
    captureOutcome: 'saved_manually' | 'saved_automatically' | 'not_saved';
    recalled: boolean;
  }[];
  modelRequestsSent: number;
  externalRequestsSent: number;
  externalRequestsBlocked: number;
}

export function runMemoryAcceptance(options?: {
  request?: typeof fetch;
}): Promise<MemoryAcceptanceResult>;

export function safeAcceptanceFailureCode(error: unknown): string;

export function createOfflineFetchBoundary(delegate: typeof fetch): {
  fetch: typeof fetch;
  counts(): { externalRequestsSent: number; externalRequestsBlocked: number };
};
