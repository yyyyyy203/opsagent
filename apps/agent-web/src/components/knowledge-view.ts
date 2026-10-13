import type { KnowledgeDiagnosisQualificationV1, PublicKnowledgeRevision, PublicTargetKnowledgeStatus } from '../api/types.js';
import type { TargetReadinessDto as PublicTargetReadiness } from '../../../../src/contracts/target.js';

export function canPublishKnowledgeRevision(revision: PublicKnowledgeRevision, capabilityEnabled: boolean, now: string): boolean {
  if (!capabilityEnabled || revision.status !== 'approved' || !/^[a-f\d]{64}$/iu.test(revision.contentDigest)) return false;
  if (revision.review === undefined || !revision.review.checks.sourceVerified || !revision.review.checks.scopeVerified
    || !revision.review.checks.contentReviewed) return false;
  if (revision.validUntil === undefined) return true;
  const validUntil = Date.parse(revision.validUntil);
  const currentTime = Date.parse(now);
  return Number.isFinite(validUntil) && Number.isFinite(currentTime) && validUntil > currentTime;
}

export function isKnowledgePublishedInTarget(revision: PublicKnowledgeRevision, target: PublicTargetKnowledgeStatus): boolean {
  return target.references.some(reference => reference.id === revision.id
    && reference.version === String(revision.contentRevision) && reference.digest === revision.contentDigest
    && reference.approval === 'approved');
}

export function diagnosisQualificationLabel(qualification: KnowledgeDiagnosisQualificationV1 | undefined): string {
  if (qualification === undefined) return '未提供知识资格信息';
  if (qualification.diagnosisReady) return '知识资格：满足';
  const requiredMissing = qualification.missingKnowledge.some(item => item.requiredness === 'required');
  if (requiredMissing) return '知识资格：受限（必需知识缺失）';
  return '知识资格：受限（部分知识不可用）';
}

export function knowledgeLimitationLabel(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    KNOWLEDGE_NOT_FOUND: '知识版本不存在', KNOWLEDGE_NOT_APPROVED: '知识尚未审核通过',
    KNOWLEDGE_REVOKED: '知识已撤销', KNOWLEDGE_EXPIRED: '知识已过期',
    KNOWLEDGE_SUPERSEDED: '知识版本已被替代', KNOWLEDGE_CONFLICT: '知识存在冲突',
    KNOWLEDGE_SCOPE_MISMATCH: '知识不适用于当前 Target', KNOWLEDGE_DIGEST_MISMATCH: '知识摘要校验失败',
    KNOWLEDGE_SOURCE_REVOKED: '知识来源已撤销', KNOWLEDGE_TYPE_DISABLED: '此类知识当前未启用',
    KNOWLEDGE_STORAGE_UNAVAILABLE: '知识存储暂不可用', KNOWLEDGE_DEADLINE_EXCEEDED: '读取知识超过时限',
    KNOWLEDGE_BUDGET_EXCEEDED: '知识读取预算不足', KNOWLEDGE_REQUIRED_DISABLED: '必需知识能力未启用',
    OPTIONAL_KNOWLEDGE_OMITTED: '部分可选知识未载入',
  };
  return labels[code] ?? '知识资格受限';
}

export function targetReadinessLabel(readiness: PublicTargetReadiness): string {
  if (readiness.status === 'ready') return '当前 Target 可启动巡检';
  if (readiness.status === 'disabled') return '当前 Target 已停用';
  if (readiness.reasonCode === 'KNOWLEDGE_REQUIRED_DISABLED') return '必需知识能力未启用，当前不能启动巡检';
  if (readiness.status === 'unavailable') return '当前宿主尚未开放 Target 巡检';
  return 'Target 配置或必需能力未就绪';
}
