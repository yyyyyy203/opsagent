export type RunStatus = 'running' | 'awaiting_confirmation' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type DiagnosisStage = 'triage' | 'evidence_collection' | 'hypothesis' | 'risk_gate' | 'action' | 'verification' | 'postmortem';

import type { KnowledgeDiagnosisQualificationV1, KnowledgeKind, KnowledgeStatus, ProceduralKnowledgeContent,
  SemanticKnowledgeContent } from '../../../../src/contracts/knowledge-memory.js';
import type { TargetCatalogDto, TargetKnowledgePolicy, TargetKnowledgeReference, TargetReadinessDto } from '../../../../src/contracts/target.js';

export type {
  DiagnosticMemoryCase,
  MemoryCaptureTicket,
  MemoryCapabilities,
  MemoryPreferences,
  MemoryStatus,
  RunMemoryState,
} from '../../../../src/contracts/diagnostic-memory.js';
export type { KnowledgeDiagnosisQualificationV1, KnowledgeKind, KnowledgeStatus, ProceduralKnowledgeContent,
  SemanticKnowledgeContent, TargetKnowledgeReference, TargetKnowledgePolicy, TargetCatalogDto, TargetReadinessDto };

export interface PublicKnowledgeRevision {
  schemaVersion: 1;
  id: string;
  kind: KnowledgeKind;
  contentRevision: number;
  governanceVersion: number;
  sourceEpoch: number;
  status: KnowledgeStatus;
  createdAt: string;
  validUntil?: string;
  contentDigest: string;
  content: SemanticKnowledgeContent | ProceduralKnowledgeContent;
  applicability: {
    profileRevision: string;
    scenarioId: string;
    scenarioVersion: string;
    serviceIds: readonly string[];
    faultTypes: readonly string[];
    environment: string;
    dataClass: 'simulated' | 'live';
    datasetId?: string;
  };
  source: { type: string; id: string; version: string; digest: string; importedAt: string };
  review?: { reviewedAt: string; checks: { sourceVerified: boolean; scopeVerified: boolean; contentReviewed: boolean } };
}

export interface PublicTargetKnowledgeStatus {
  targetId: string;
  capabilities: { semanticEnabled: boolean; proceduralEnabled: boolean };
  requiredKnowledge: readonly { id: string; version: string; knowledgeClass?: KnowledgeKind }[];
  publicationVersion: number;
  publicationState: 'empty' | 'active' | 'scope_changed';
  references: readonly TargetKnowledgeReference[];
}

export interface TargetKnowledgeDraftInput {
  requestId: string;
  source: { sourceId: string; sourceVersion: string; digest: string };
  validUntil?: string;
  content: SemanticKnowledgeContent | ProceduralKnowledgeContent;
}

export interface TargetKnowledgePublicationResult {
  targetId: string;
  publicationVersion: number;
  references: readonly TargetKnowledgeReference[];
  policy: TargetKnowledgePolicy;
  publishedAt: string;
}

export interface PublicRunSummary {
  runId: string;
  profileId: string;
  status: RunStatus;
  stage: DiagnosisStage;
  revision?: number;
  contextVersion: number;
  createdAt: string;
  updatedAt: string;
  parentRunId?: string;
}

export interface RunUsageSummary {
  completeness: 'complete' | 'partial' | 'unavailable';
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface PublicRunDetail extends PublicRunSummary {
  knowledgeQualification?: KnowledgeDiagnosisQualificationV1;
  evidenceIds: readonly string[];
  missingEvidence: readonly string[];
  childRunIds: readonly string[];
  usage?: RunUsageSummary;
  failure?: { code: string; message: string; retryable: boolean };
}

export interface PublicRunPage {
  items: readonly PublicRunSummary[];
  nextCursor?: string;
}

export interface PublicProfile {
  id: string;
  name: string;
  description: string;
  capabilities: { readOnly: boolean };
}

export type PublicMessageBlock =
  | { type: 'text'; blockId: string; text: string }
  | { type: 'reasoning_summary'; blockId: string; summary: string }
  | { type: 'tool_call'; blockId: string; call: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; blockId: string; result: { toolCallId: string; toolName: string; status: string; error?: { code: string; message: string; retryable: boolean } } }
  | { type: 'evidence_ref'; blockId: string; evidenceId: string; summary: string; source: string; retrievable: boolean }
  | { type: 'context_summary'; blockId: string; summary: { confirmedFacts: readonly string[]; hypotheses: readonly string[]; missingEvidence: readonly string[] } }
  | { type: 'confirmation_request'; blockId: string; confirmationId: string; toolCallIds: readonly string[]; riskSummary: string; expiresAt: string }
  | { type: 'confirmation_result'; blockId: string; confirmationId: string; decision: string; actor: string; toolCallIds: readonly string[]; decidedAt: string }
  | { type: 'diagnosis'; blockId: string; outcome: string; rootCauseCandidates: readonly { summary: string; confidence: string }[]; evidenceIds: readonly string[]; missingEvidence: readonly string[]; limitations: readonly string[] }
  | { type: 'action_proposal'; blockId: string; actionId: string; toolCallId: string; risk: string; expectedEffect: string; verificationPlan: string }
  | { type: 'artifact_ref'; blockId: string; artifactId: string; uri: string; mediaType: string; sizeBytes: number; sha256: string; accessPolicy: string }
  | { type: 'image_ref'; blockId: string; imageId: string; uri: string; mediaType: string; sizeBytes: number; sha256: string; accessPolicy: string }
  | { type: 'action_result'; blockId: string; actionId: string; toolCallId: string; result: unknown; idempotencyKey: string; verificationEvidenceIds: readonly string[]; uncertainty: boolean }
  | { type: 'error'; blockId: string; error: { code: string; message: string; retryable: boolean } }
  | { type: 'unknown'; blockId?: string };

export interface PublicMessage {
  schemaVersion: 2;
  id: string;
  runId: string;
  sessionId?: string;
  replyId?: string;
  stepId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  status: 'streaming' | 'completed' | 'failed' | 'interrupted';
  visibility: 'model' | 'user' | 'audit';
  blocks: readonly PublicMessageBlock[];
  createdAt: string;
  completedAt?: string;
}

export interface PublicMessageItem {
  message: PublicMessage;
  version: number;
  truncated: boolean;
}

export interface PublicMessagePage {
  items: readonly PublicMessageItem[];
  nextCursor?: string;
}

export interface PublicEvidenceView {
  evidenceId: string;
  runId: string;
  source: string;
  state: 'available' | 'committed' | 'partial';
  capturedAt: string;
  summary: Record<string, unknown>;
  coverage?: number;
  truncated?: boolean;
  recordCount?: number;
  sourceBytes?: number;
  storedBytes?: number;
  chunkCount?: number;
  timeRange?: { start: string; end: string };
  rawSha256?: string;
  traceIdCount: number;
  retrievable: boolean;
}

export interface PublicEvidencePage {
  items: readonly PublicEvidenceView[];
  nextCursor?: string;
}

export interface PublicConfirmation {
  runId: string;
  toolCallId: string;
  expectedRevision: number;
  summary: string;
  expiresAt?: string;
}

export interface ConfirmationDecisionInput {
  toolCallId: string;
  confirmed: boolean;
  expectedRevision: number;
  reason?: string;
}

export interface ConfirmationDecisionResult {
  outcome: 'approved' | 'rejected' | 'expired';
  revision: number;
}

export interface PublicEventFrame {
  id?: string;
  event: string;
  data: unknown;
}
