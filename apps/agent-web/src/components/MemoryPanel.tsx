import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ReactElement } from 'react';
import { ApiClient, ApiClientError } from '../api/client.js';
import type {
  DiagnosticMemoryCase,
  MemoryCaptureTicket,
  MemoryCapabilities,
  MemoryPreferences,
  MemoryStatus,
  KnowledgeKind,
  PublicKnowledgeRevision,
  PublicTargetKnowledgeStatus,
  TargetCatalogDto,
  TargetReadinessDto,
  TargetKnowledgeReference,
  PublicRunDetail,
  RunMemoryState,
} from '../api/types.js';
import { canPublishKnowledgeRevision, isKnowledgePublishedInTarget,
  knowledgeLimitationLabel, targetReadinessLabel } from './knowledge-view.js';

export { canPublishKnowledgeRevision, diagnosisQualificationLabel, isKnowledgePublishedInTarget } from './knowledge-view.js';

export interface MemoryPanelProps {
  profileId: string;
  targetId?: string;
  runId?: string;
  runTerminal?: boolean;
  preferences: MemoryPreferences;
  onPreferencesChange: (preferences: MemoryPreferences) => void;
  onOpenEvidence?: (runId: string, evidenceId: string) => void;
  client?: ApiClient;
}

type MemoryTab = 'cases' | 'semantic' | 'procedural';

export function MemoryPanel({ profileId, targetId, runId, runTerminal, preferences, onPreferencesChange, onOpenEvidence, client }: MemoryPanelProps): ReactElement {
  const api = useMemo(() => client ?? new ApiClient({ baseUrl: apiBaseUrl() }), [client]);
  const [capabilities, setCapabilities] = useState<MemoryCapabilities | null>(null);
  const [cases, setCases] = useState<readonly DiagnosticMemoryCase[]>([]);
  const [runMemory, setRunMemory] = useState<RunMemoryState | null>(null);
  const [captureTicket, setCaptureTicket] = useState<MemoryCaptureTicket | null>(null);
  const [run, setRun] = useState<PublicRunDetail | null>(null);
  const [filter, setFilter] = useState<MemoryStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<MemoryTab>('cases');
  const pendingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCases([]);
    setCapabilities(null);
    void (async () => {
      try {
        const nextCapabilities = targetId === undefined ? await api.memoryCapabilities(profileId)
          : await api.targetMemoryCapabilities(targetId);
        if (!active) return;
        setCapabilities(nextCapabilities);
        if (!nextCapabilities.enabled) {
          setCases([]);
          setLoading(false);
          return;
        }
        const nextCases = targetId === undefined
          ? await api.listMemoryCases(profileId, { limit: 50, ...(filter === '' ? {} : { status: filter }) })
          : await api.listTargetMemoryCases(targetId, { limit: 50, ...(filter === '' ? {} : { status: filter }) });
        if (active) setCases(nextCases);
      } catch (error) {
        if (active) setNotice(errorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, filter, profileId, refresh, targetId]);

  useEffect(() => { setNotice(null); }, [filter, profileId, targetId]);

  useEffect(() => {
    let active = true;
    setRun(null);
    setRunMemory(null);
    setCaptureTicket(null);
    if (runId === undefined || capabilities?.enabled !== true) return () => { active = false; };
    const details = targetId === undefined
      ? Promise.all([api.getRun(runId), api.getRunMemory(runId), api.getRunMemoryCapture(runId)])
      : Promise.all([api.getTargetRun(targetId, runId), api.getTargetRunMemory(targetId, runId), api.getTargetRunMemoryCapture(targetId, runId)]);
    void details
      .then(([nextRun, nextMemory, nextTicket]) => {
        if (!active) return;
        setRun(nextRun);
        setRunMemory(nextMemory);
        setCaptureTicket(nextTicket);
      })
      .catch((error: unknown) => { if (active) setNotice(errorMessage(error)); });
    return () => { active = false; };
  }, [api, capabilities?.enabled, runId, runTerminal, refresh, targetId]);

  async function capture(): Promise<void> {
    if (runId === undefined || !canCapture(capabilities, run) || pendingRef.current) return;
    pendingRef.current = true;
    setPending('capture');
    setNotice(null);
    const requestId = newRequestId();
    try {
      const current = targetId === undefined ? await api.getRunMemoryCapture(runId)
        : await api.getTargetRunMemoryCapture(targetId, runId);
      setCaptureTicket(current);
      if (current.state === 'saved') return;
      if (current.sourceCheckpointRevision === undefined) throw new Error('本次巡检缺少可核验的 Checkpoint 版本。');
      if (targetId === undefined) await api.captureRunMemory(runId, { requestId, expectedCheckpointRevision: current.sourceCheckpointRevision });
      else await api.captureTargetRunMemory(targetId, runId, { requestId, expectedCheckpointRevision: current.sourceCheckpointRevision });
      setCaptureTicket(targetId === undefined ? await api.getRunMemoryCapture(runId)
        : await api.getTargetRunMemoryCapture(targetId, runId));
      setRefresh((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setNotice('本次巡检状态已更新，已刷新版本；请检查后再发起沉淀。');
        try { setCaptureTicket(targetId === undefined ? await api.getRunMemoryCapture(runId)
          : await api.getTargetRunMemoryCapture(targetId, runId)); } catch { /* keep the original conflict visible */ }
      } else setNotice(errorMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  async function review(item: DiagnosticMemoryCase, decision: 'approved' | 'rejected'): Promise<void> {
    if (pendingRef.current || (decision === 'approved' && !canApproveMemoryCase(item))) return;
    pendingRef.current = true;
    setPending(item.id);
    setNotice(null);
    try {
      const command = { expectedRevision: item.revision, requestId: newRequestId(), decision,
        claimCheck: decision === 'approved' ? 'supported' as const : 'unsupported' as const };
      if (targetId === undefined) await api.reviewMemory(item.id, { ...command, profileId });
      else await api.reviewTargetMemory(targetId, item.id, command);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setNotice('案例版本已变化，已刷新最新状态；请确认后重新操作。');
        setRefresh((value) => value + 1);
      } else setNotice(errorMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  const currentCapture = captureTicket?.sourceRunId === runId ? captureTicket : null;
  const memoryEnabled = capabilities?.enabled === true;
  return <section className="panel memory-panel" aria-label="诊断记忆">
    <div className="panel-heading"><div><p className="eyebrow">DIAGNOSTIC MEMORY</p><h2>记忆与知识</h2></div><span className="count-badge">{cases.length}</span></div>
    <div className="memory-tabs" role="tablist" aria-label="记忆类型">
      <button type="button" role="tab" aria-selected={activeTab === 'cases'} onClick={() => setActiveTab('cases')}>历史案例</button>
      <button type="button" role="tab" aria-selected={activeTab === 'semantic'} onClick={() => setActiveTab('semantic')}>系统知识</button>
      <button type="button" role="tab" aria-selected={activeTab === 'procedural'} onClick={() => setActiveTab('procedural')}>调查模板</button>
    </div>
    {activeTab === 'cases' && <>
    <fieldset className="memory-preferences" disabled={!memoryEnabled}>
      <legend>本次巡检的记忆策略</legend>
      <label className="field-label" htmlFor="memory-capture">本次沉淀</label>
      <select id="memory-capture" value={preferences.capture ?? 'profile'} onChange={(event) => onPreferencesChange({
        ...preferences, capture: event.target.value as NonNullable<MemoryPreferences['capture']>,
      })}>
        <option value="manual">手动沉淀</option>
        <option value="automatic" disabled={!capabilities?.automaticCapture}>自动沉淀</option>
        <option value="skip">不自动沉淀</option>
        <option value="profile">使用 Profile 默认值</option>
      </select>
      <label className="memory-toggle"><input type="checkbox" checked={preferences.recall === 'enabled'}
        disabled={!capabilities?.recall} onChange={(event) => onPreferencesChange({
          ...preferences, recall: event.target.checked ? 'enabled' : 'disabled',
        })} />使用已审核历史参考</label>
    </fieldset>

    {capabilities !== null && !capabilities.enabled && <p className="memory-disabled-note" role="status">记忆服务未启用；请管理员一次性启用后使用。</p>}
    {capabilities?.enabled === true && !capabilities.recall && <p className="field-hint">历史参考当前不可用，沉淀与案例审核仍可使用。</p>}
    {runId !== undefined && <div className="memory-capture">
      <div className="memory-subheading"><strong>当前巡检</strong>{run !== null && <span>{run.status}</span>}</div>
      {currentCapture !== null && <p className="memory-capture-status" role="status">{captureTicketLabel(currentCapture.state)}</p>}
      {runMemory?.hints.length ? <div className="memory-hints"><strong>历史参考已载入</strong>{runMemory.hints.map((hint) => <p key={`${hint.memoryId}:${hint.revision}`}>{hint.summary}</p>)}</div>
        : runMemory !== null && runMemory.availability === 'empty' && runMemory.selectionState === 'selected'
          ? <p className="field-hint">没有可用的历史参考</p> : null}
      <button type="button" className="secondary-button" onClick={() => void capture()}
        disabled={!canCapture(capabilities, run) || currentCapture?.state === 'saved' || pending !== null}>
        {pending === 'capture' ? '正在沉淀…' : '沉淀本次巡检'}
      </button>
    </div>}

    {notice !== null && <p className="memory-notice" role="status">{notice}</p>}
    <div className="memory-case-filter"><label htmlFor="memory-case-status">案例状态</label>
      <select id="memory-case-status" value={filter} onChange={(event) => setFilter(event.target.value as MemoryStatus | '')} disabled={!memoryEnabled}>
        <option value="">全部</option><option value="observation">待审核</option><option value="approved">已批准</option><option value="rejected">已拒绝</option>
      </select>
    </div>
    {loading ? <p className="list-empty">正在读取案例…</p>
      : cases.length === 0 ? <p className="list-empty">暂无历史案例。</p>
        : <div className="memory-case-list">{cases.map((item) => <article className="memory-case" key={item.id}>
          <div className="memory-case-heading"><strong>{memoryStatusLabel(item.status)}</strong><span>{qualityLabel(item.quality)}</span></div>
          <p className="memory-case-summary">{item.summary}</p>
          <p className="memory-case-meta">来源 Run <code>{item.sourceRunId}</code> · {item.sourceRunStatus}</p>
          {item.sourceRunStatus !== 'completed' && <p className="memory-archive-note">失败调查，仅供归档，不可批准召回</p>}
          {item.scope.dataClass === 'simulated' && <p className="memory-simulation-note">仅模拟环境可用，不可晋级</p>}
          {Date.parse(item.validUntil) <= Date.now() && <p className="memory-expired-note">已过期，不能作为历史参考</p>}
          <p className="memory-case-meta">有效期至 <time dateTime={item.validUntil}>{formatDate(item.validUntil)}</time></p>
          {item.evidenceRefs.map((reference) => <button type="button" className="memory-evidence-link" key={`${reference.ownerRunId}:${reference.evidenceId}`}
            disabled={!reference.evidenceId || !reference.ownerRunId} onClick={() => onOpenEvidence?.(reference.ownerRunId, reference.evidenceId)}>
            {reference.source} 引用 · {reference.evidenceId}
          </button>)}
          <div className="memory-case-actions">
            {item.status === 'observation' && <>
              <button type="button" className="secondary-button" onClick={() => void review(item, 'approved')}
                disabled={!canApproveMemoryCase(item) || pending !== null}>批准历史参考</button>
              <button type="button" className="secondary-button" onClick={() => void review(item, 'rejected')}
                disabled={!canRejectMemoryCase(item) || pending !== null}>拒绝候选</button>
            </>}
            {item.status === 'approved' && <button type="button" className="secondary-button" onClick={() => void review(item, 'rejected')} disabled={pending !== null}>撤销历史参考</button>}
            {pending === item.id && <span role="status">正在提交…</span>}
          </div>
        </article>)}</div>}
    {!loading && capabilities?.enabled === true && <button className="text-button" type="button" onClick={() => setRefresh((value) => value + 1)}>刷新案例</button>}
    </>}
    {(activeTab === 'semantic' || activeTab === 'procedural') && <KnowledgeGovernancePanel api={api} kind={activeTab}
      {...(targetId === undefined ? {} : { selectedTargetId: targetId })} />}
  </section>;
}

function KnowledgeGovernancePanel({ api, kind, selectedTargetId }: { api: ApiClient; kind: KnowledgeKind; selectedTargetId?: string }): ReactElement {
  const [targets, setTargets] = useState<readonly TargetCatalogDto[]>([]);
  const [targetId, setTargetId] = useState('');
  const [readiness, setReadiness] = useState<TargetReadinessDto | null>(null);
  const [targetStatus, setTargetStatus] = useState<PublicTargetKnowledgeStatus | null>(null);
  const [revisions, setRevisions] = useState<readonly PublicKnowledgeRevision[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<readonly TargetKnowledgeReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [sourceVersion, setSourceVersion] = useState('');
  const [sourceDigest, setSourceDigest] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [contentText, setContentText] = useState('');
  const [reviseId, setReviseId] = useState('');
  const capabilityEnabled = kind === 'semantic' ? targetStatus?.capabilities.semanticEnabled === true
    : targetStatus?.capabilities.proceduralEnabled === true;

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listTargets().then(nextTargets => {
      if (!active) return;
      setTargets(nextTargets);
      setTargetId(current => selectedTargetId !== undefined ? selectedTargetId
        : nextTargets.some(target => target.targetId === current) ? current : nextTargets[0]?.targetId ?? '');
      setNotice(nextTargets.length === 0 ? '宿主没有提供可选择的 Target；不能在页面手工填写知识作用域。' : null);
    }).catch(() => { if (active) setNotice('Target 知识管理当前不可用；请确认宿主是否配置了 Target 和知识管理能力。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, selectedTargetId]);

  useEffect(() => {
    if (targetId === '') {
      setReadiness(null); setTargetStatus(null); setRevisions([]); setSelectedReferences([]);
      return () => undefined;
    }
    let active = true;
    setLoading(true);
    setTargetStatus(null); setRevisions([]); setSelectedReferences([]);
    void Promise.all([api.getTargetReadiness(targetId), api.getTargetKnowledgeStatus(targetId),
      api.listTargetKnowledge(targetId, kind, { limit: 50 })])
      .then(([nextReadiness, nextStatus, page]) => {
        if (!active) return;
        setReadiness(nextReadiness); setTargetStatus(nextStatus); setRevisions(page.items);
        setSelectedReferences(nextStatus.references.map(reference => ({ ...reference })));
        setNotice(null);
      }).catch(() => {
        if (active) { setReadiness(null); setTargetStatus(null); setRevisions([]);
          setNotice('无法读取此 Target 的知识状态；内容不会跨 Target 展示。'); }
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, kind, refresh, targetId]);

  async function runCommand(key: string, command: () => Promise<unknown>, success: string): Promise<void> {
    if (pending !== null || targetId === '') return;
    setPending(key); setNotice(null);
    try { await command(); setNotice(success); setRefresh(value => value + 1); }
    catch (error) {
      setNotice(error instanceof ApiClientError && error.status === 409
        ? '知识版本或发布版本已变化；已刷新最新状态，请核对后重新操作。'
        : knowledgeErrorMessage(error));
      setRefresh(value => value + 1);
    } finally { setPending(null); }
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (targetId === '') return;
    let content: unknown;
    try { content = JSON.parse(contentText) as unknown; }
    catch { setNotice('内容必须是合法 JSON；服务端还会按知识类型执行严格 Schema 校验。'); return; }
    const input = { requestId: newRequestId(), source: { sourceId, sourceVersion, digest: sourceDigest },
      ...(validUntil === '' ? {} : { validUntil: new Date(validUntil).toISOString() }), content };
    const current = revisions.find(revision => revision.id === reviseId);
    if (reviseId !== '' && current === undefined) { setNotice('待修订版本已不在当前列表中，请刷新后再选择。'); return; }
    await runCommand('draft', () => current === undefined
      ? api.createTargetKnowledgeDraft(targetId, kind, input as Parameters<ApiClient['createTargetKnowledgeDraft']>[2])
      : api.reviseTargetKnowledge(targetId, kind, current.id, { ...input as Parameters<ApiClient['createTargetKnowledgeDraft']>[2],
        expectedContentRevision: current.contentRevision, expectedGovernanceVersion: current.governanceVersion }),
    current === undefined ? '草稿已创建。' : '草稿新版本已创建。');
  }

  function startRevision(revision: PublicKnowledgeRevision): void {
    if (revision.status !== 'draft') return;
    setReviseId(revision.id); setSourceId(revision.source.id); setSourceVersion(revision.source.version);
    setSourceDigest(revision.source.digest); setValidUntil(revision.validUntil?.slice(0, 16) ?? '');
    setContentText(JSON.stringify(revision.content, null, 2));
  }

  function togglePublicationReference(revision: PublicKnowledgeRevision): void {
    if (!canPublishKnowledgeRevision(revision, capabilityEnabled, new Date().toISOString())) return;
    const reference = { id: revision.id, version: String(revision.contentRevision), digest: revision.contentDigest, approval: 'approved' as const };
    setSelectedReferences(current => current.some(item => sameReference(item, reference))
      ? current.filter(item => !sameReference(item, reference)) : [...current, reference]);
  }

  async function publish(): Promise<void> {
    if (targetStatus === null || !publicationSelectionChanged(targetStatus.references, selectedReferences)) return;
    await runCommand('publish', () => api.publishTargetKnowledge(targetId, { requestId: newRequestId(),
      expectedPublicationVersion: targetStatus.publicationVersion, references: selectedReferences }),
    '已发布到当前 Target；新 Run 會按当前知识绑定读取，已开始的 Run 保持原快照。');
  }

  const selectedTarget = targets.find(target => target.targetId === targetId);
  return <div className="knowledge-manager" role="tabpanel" aria-label={kind === 'semantic' ? '系统知识' : '调查模板'}>
    <div className="knowledge-target-picker"><label htmlFor="knowledge-target">目标系统</label>
      <select id="knowledge-target" value={targetId} disabled={selectedTargetId !== undefined}
        onChange={event => { setTargetId(event.target.value); setNotice(null); }}>
        {targets.length === 0 && <option value="">没有可选 Target</option>}
        {targets.map(target => <option key={target.targetId} value={target.targetId}>{target.displayName} · {target.environment}</option>)}
      </select>
    </div>
    {selectedTarget !== undefined && <div className="knowledge-readiness" role="status">
      <strong>{readiness === null ? '读取 Target 就绪状态…' : targetReadinessLabel(readiness)}</strong>
      <span>{selectedTarget.projectName} · {selectedTarget.scenario.serviceName} · {selectedTarget.scenario.id}@{selectedTarget.scenario.version}</span>
    </div>}
    {targetStatus !== null && <>
      <div className="knowledge-publication-status" role="status">
        <strong>{targetStatus.publicationState === 'active' ? 'Target 已有独立发布的知识绑定'
          : targetStatus.publicationState === 'scope_changed' ? '作用域已变化，旧发布不可用于当前 Target' : '当前 Target 尚无已发布知识'}</strong>
        <span>发布版本 {targetStatus.publicationVersion} · {kind === 'semantic' ? '系统知识' : '调查模板'}能力{capabilityEnabled ? '已启用' : '未启用'}</span>
      </div>
      {targetStatus.requiredKnowledge.length > 0 && <p className="knowledge-warning">必需知识：{targetStatus.requiredKnowledge.map(item => `${item.id}@${item.version}`).join('、')}</p>}
      <p className="knowledge-governance-note">批准不等于启用。审核只改变治理状态；只有单独发布成功后才会绑定到 Target。已开始的 Run 保持启动时快照，不会因这次发布改变。</p>
    </>}
    {notice !== null && <p className="memory-notice" role="status">{notice}</p>}
    <form className="knowledge-draft-form" onSubmit={event => void saveDraft(event)}>
      <div className="memory-subheading"><strong>{reviseId === '' ? '创建草稿' : `修订草稿 ${reviseId}`}</strong>
        {reviseId !== '' && <button type="button" className="text-button" onClick={() => { setReviseId(''); setContentText(''); }}>取消修订</button>}</div>
      <label htmlFor="knowledge-source-id">来源 ID</label><input id="knowledge-source-id" value={sourceId} onChange={event => setSourceId(event.target.value)} required maxLength={256} />
      <label htmlFor="knowledge-source-version">来源版本</label><input id="knowledge-source-version" value={sourceVersion} onChange={event => setSourceVersion(event.target.value)} required maxLength={256} />
      <label htmlFor="knowledge-source-digest">来源 SHA-256</label><input id="knowledge-source-digest" value={sourceDigest} onChange={event => setSourceDigest(event.target.value)} required pattern="[a-fA-F0-9]{64}" maxLength={64} />
      <label htmlFor="knowledge-valid-until">有效期（可选）</label><input id="knowledge-valid-until" type="datetime-local" value={validUntil} onChange={event => setValidUntil(event.target.value)} />
      <label htmlFor="knowledge-content">{kind === 'semantic' ? '系统知识内容 JSON' : '调查模板内容 JSON'}</label>
      <textarea id="knowledge-content" value={contentText} onChange={event => setContentText(event.target.value)} rows={7} required spellCheck={false}
        placeholder={kind === 'semantic' ? '{"type":"metric_definition", ...}' : '{"type":"investigation_template", ...}'} />
      <button type="submit" className="secondary-button" disabled={pending !== null || targetId === ''}>{pending === 'draft' ? '保存中…' : reviseId === '' ? '创建草稿' : '保存修订'}</button>
    </form>
    {loading ? <p className="list-empty">正在读取当前 Target 知识…</p>
      : revisions.length === 0 ? <p className="list-empty">当前 Target 暂无此类知识版本。</p>
        : <div className="memory-case-list">{revisions.map(revision => {
          const published = targetStatus !== null && isKnowledgePublishedInTarget(revision, targetStatus);
          const staged = selectedReferences.some(reference => reference.id === revision.id
            && reference.version === String(revision.contentRevision) && reference.digest === revision.contentDigest);
          const eligible = canPublishKnowledgeRevision(revision, capabilityEnabled, new Date().toISOString());
          return <article className="memory-case knowledge-revision" key={`${revision.id}:${revision.contentRevision}`}>
            <div className="memory-case-heading"><strong>{knowledgeStatusLabel(revision.status)}</strong><span>{revision.kind === 'semantic' ? '系统知识' : '调查模板'}</span></div>
            <p className="memory-case-summary">{knowledgeTitle(revision)}</p>
            <p className="memory-case-meta">知识 ID <code>{revision.id}</code> · 内容修订 {revision.contentRevision} · 治理版本 {revision.governanceVersion}</p>
            <p className="memory-case-meta">来源：{revision.source.type} / {revision.source.id}@{revision.source.version} · 摘要 {revision.contentDigest.slice(0, 12)}…</p>
            <p className="memory-case-meta">适用：Profile {revision.applicability.profileRevision} · {revision.applicability.scenarioId}@{revision.applicability.scenarioVersion} · 服务 {revision.applicability.serviceIds.join('、')} · 故障 {revision.applicability.faultTypes.join('、')} · {revision.applicability.environment}/{revision.applicability.dataClass}{revision.applicability.datasetId === undefined ? '' : ` · 数据集 ${revision.applicability.datasetId}`}</p>
            {revision.review !== undefined && <p className="memory-case-meta">审核时间 {formatDate(revision.review.reviewedAt)} · 来源/作用域/内容检查均{revision.review.checks.sourceVerified && revision.review.checks.scopeVerified && revision.review.checks.contentReviewed ? '通过' : '未全部通过'}</p>}
            {revision.validUntil !== undefined && <p className="memory-case-meta">有效期至 {formatDate(revision.validUntil)}</p>}
            {published && <p className="knowledge-enabled-label">已发布到当前 Target</p>}
            {revision.status === 'approved' && !published && <p className="knowledge-not-enabled-label">已批准 · 尚未发布到当前 Target</p>}
            {(revision.status === 'revoked' || revision.status === 'expired' || revision.status === 'conflict' || revision.status === 'superseded')
              && <p className="knowledge-warning">该版本仅供审计查看，不能重新发布。</p>}
            <details><summary>查看结构化内容</summary><pre>{JSON.stringify(revision.content, null, 2)}</pre></details>
            {revision.status === 'draft' && <div className="memory-case-actions">
              <button type="button" className="secondary-button" onClick={() => startRevision(revision)} disabled={pending !== null}>修订草稿</button>
              <button type="button" className="secondary-button" onClick={() => void runCommand(revision.id, () => api.submitTargetKnowledgeForReview(targetId, kind, revision.id, {
                requestId: newRequestId(), contentRevision: revision.contentRevision, governanceVersion: revision.governanceVersion,
              }), '已提交审核。')} disabled={pending !== null}>{pending === revision.id ? '提交中…' : '提交审核'}</button>
            </div>}
            {revision.status === 'review_pending' && <div className="memory-case-actions">
              <button type="button" className="secondary-button" onClick={() => void runCommand(revision.id, () => api.reviewTargetKnowledge(targetId, kind, revision.id, {
                requestId: newRequestId(), contentRevision: revision.contentRevision, governanceVersion: revision.governanceVersion, decision: 'approve',
              }), '审核已批准；尚未发布到 Target。')} disabled={pending !== null}>批准</button>
              <button type="button" className="secondary-button" onClick={() => void runCommand(revision.id, () => api.reviewTargetKnowledge(targetId, kind, revision.id, {
                requestId: newRequestId(), contentRevision: revision.contentRevision, governanceVersion: revision.governanceVersion, decision: 'reject', reasonCode: 'operator_rejected',
              }), '候选已拒绝。')} disabled={pending !== null}>拒绝</button>
            </div>}
            {eligible && <button type="button" className="secondary-button" onClick={() => togglePublicationReference(revision)} disabled={pending !== null}>
              {staged ? '从下一次发布移除' : '选入下一次发布'}
            </button>}
            {revision.status === 'approved' && !published && <button type="button" className="text-button" onClick={() => void runCommand(revision.id, () => api.revokeTargetKnowledge(targetId, kind, revision.id, {
              requestId: newRequestId(), contentRevision: revision.contentRevision, expectedGovernanceVersion: revision.governanceVersion,
            }), '知识版本已撤销。')} disabled={pending !== null || staged}>撤销该知识版本</button>}
          </article>;
        })}</div>}
    {targetStatus !== null && publicationSelectionChanged(targetStatus.references, selectedReferences) && <div className="knowledge-publish-box">
      <p>待发布绑定：{selectedReferences.length} 个版本。发布不会修改 Profile、阈值、数据源端点或工具权限。</p>
      <button type="button" className="secondary-button" onClick={() => void publish()} disabled={pending !== null || !capabilityEnabled}>
        {pending === 'publish' ? '发布中…' : '独立发布到此 Target'}
      </button>
    </div>}
    {targetStatus !== null && <button className="text-button" type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新知识</button>}
  </div>;
}

function knowledgeStatusLabel(status: PublicKnowledgeRevision['status']): string {
  return ({ draft: '草稿', review_pending: '审核中', approved: '已批准', rejected: '已拒绝', revoked: '已撤销',
    expired: '已过期', conflict: '存在冲突', superseded: '已替代' } as const)[status];
}
function knowledgeTitle(revision: PublicKnowledgeRevision): string {
  if ('templateId' in revision.content) return revision.content.templateId;
  switch (revision.content.type) {
    case 'metric_definition': return `${revision.content.metricName} · ${revision.content.businessMeaning}`;
    case 'service_topology': return `服务拓扑 · ${revision.content.services.map(service => service.displayName).join('、')}`;
    case 'domain_glossary': return `业务术语 · ${revision.content.terms.map(term => term.term).join('、')}`;
  }
  return '知识内容';
}
function sameReference(left: TargetKnowledgeReference, right: TargetKnowledgeReference): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.approval === right.approval;
}
function publicationSelectionChanged(current: readonly TargetKnowledgeReference[], next: readonly TargetKnowledgeReference[]): boolean {
  return current.length !== next.length || current.some(reference => !next.some(candidate => sameReference(reference, candidate)));
}
function knowledgeErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.code)) {
    return `知识操作未完成：${knowledgeLimitationLabel(error.code)}（${error.code}）。`;
  }
  return '知识操作未完成；请检查当前 Target、版本和来源状态。';
}

export function captureTicketLabel(state: MemoryCaptureTicket['state']): string {
  switch (state) {
    case 'not_saved': return '未保存';
    case 'queued': return '排队中';
    case 'running': return '生成中';
    case 'saved': return '已保存候选';
    case 'failed': return '生成失败';
    case 'unavailable': return '不可用';
  }
}

export function canApproveMemoryCase(item: DiagnosticMemoryCase): boolean {
  return item.status === 'observation' && item.quality === 'sufficient' && item.sourceRunStatus === 'completed'
    && item.evidenceRefs.length > 0 && item.evidenceRefs.every((reference) => reference.ownerRunId.trim().length > 0
      && reference.evidenceId.trim().length > 0 && /^[a-f\d]{64}$/iu.test(reference.rawSha256));
}

export function canRejectMemoryCase(item: DiagnosticMemoryCase): boolean {
  return item.status === 'observation';
}

function canCapture(capabilities: MemoryCapabilities | null, run: PublicRunDetail | null): boolean {
  return capabilities?.enabled === true && capabilities.manualCapture && run !== null
    && (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
}

function memoryStatusLabel(status: DiagnosticMemoryCase['status']): string {
  return status === 'observation' ? '待审核' : status === 'approved' ? '已批准' : '已拒绝';
}
function qualityLabel(quality: DiagnosticMemoryCase['quality']): string {
  return quality === 'sufficient' ? '证据充分' : quality === 'insufficient' ? '证据不足' : '生成失败';
}
function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('zh-CN');
}
function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function apiBaseUrl(): string {
  return typeof import.meta.env.VITE_AGENT_API_URL === 'string' && import.meta.env.VITE_AGENT_API_URL.length > 0
    ? import.meta.env.VITE_AGENT_API_URL : 'http://127.0.0.1:4100';
}
function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'MEMORY_CAPACITY_EXCEEDED') {
    return '记忆存储容量已满，请清理旧案例后重试。';
  }
  return error instanceof Error ? error.message : '记忆请求失败。';
}
