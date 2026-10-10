import { createHash } from 'node:crypto';
import type { AgentContext } from '../contracts/context.js';
import type {
  HistoricalEvidenceRef,
  MemoryCaptureIntent,
  MemoryCaptureRequest,
  MemoryEventFactory,
} from '../contracts/diagnostic-memory.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import { parseRunMemoryControl } from '../contracts/diagnostic-memory-schema.js';

export interface CreateMemoryCaptureIntentInput {
  candidateId: string;
  now: string;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  events: MemoryEventFactory;
}

/** Creates a model-free intent; the durable transaction remains the root-Run authority. */
export function createMemoryCaptureIntent(
  context: AgentContext,
  input: CreateMemoryCaptureIntentInput,
): MemoryCaptureIntent | null {
  if (context.status !== 'completed' || context.memoryControl === undefined
    || !isIdentifier(context.runId) || !isIdentifier(input.candidateId)
    || !isTimestamp(input.now) || !Number.isSafeInteger(context.contextVersion)
    || context.contextVersion < 1) return null;

  let control;
  try {
    control = parseRunMemoryControl(context.memoryControl);
  } catch {
    return null;
  }
  if (control.capture !== 'automatic' || control.scope.profileId !== context.profileId) return null;

  const requiredSources = [...new Set(input.requiredSources)];
  if (requiredSources.length > 4 || requiredSources.some((source) => !isEvidenceSource(source))) return null;

  let sourceCheckpointChecksum: string;
  try {
    sourceCheckpointChecksum = checkpointChecksum(context);
  } catch {
    return null;
  }

  const request: MemoryCaptureRequest = {
    candidateId: input.candidateId,
    sourceRunId: context.runId,
    scope: control.scope,
    extractorVersion: 'episodic-v1',
    origin: 'automatic',
    requestId: `memory-auto-${createHash('sha256').update(`${context.runId}\u0000episodic-v1`, 'utf8').digest('hex')}`,
    sourceRunStatus: 'completed',
    sourceContextVersion: context.contextVersion,
    sourceCheckpointChecksum,
    requiredSources,
    requestedAt: new Date(Date.parse(input.now)).toISOString(),
  };

  return {
    request,
    scheduledEvent: input.events.create('MEMORY_UPDATE_SCHEDULED', context.runId, {
      candidateType: 'episodic', sourceRunId: context.runId,
    }),
    rejectedEvent: input.events.create('MEMORY_UPDATE_FAILED', context.runId, {
      candidateId: input.candidateId,
      error: {
        code: 'UNAVAILABLE',
        message: 'Memory capture capacity is unavailable.',
        retryable: false,
        details: { category: 'MEMORY_CAPACITY_EXCEEDED' },
      },
    }),
    failedEvent: input.events.create('MEMORY_UPDATE_FAILED', context.runId, {
      candidateId: input.candidateId,
      error: {
        code: 'UNAVAILABLE',
        message: 'Memory capture failed.',
        retryable: false,
        details: { category: 'MEMORY_CAPTURE_FAILED' },
      },
    }),
  };
}

function isIdentifier(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}

function isTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isEvidenceSource(value: string): value is HistoricalEvidenceRef['source'] {
  return value === 'metric' || value === 'log' || value === 'trace' || value === 'change';
}
