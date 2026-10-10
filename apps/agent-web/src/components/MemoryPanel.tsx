import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiClient, ApiClientError } from '../api/client.js';
import type {
  DiagnosticMemoryCase,
  MemoryCaptureTicket,
  MemoryCapabilities,
  MemoryPreferences,
  MemoryStatus,
  PublicRunDetail,
  RunMemoryState,
} from '../api/types.js';

export interface MemoryPanelProps {
  profileId: string;
  runId?: string;
  preferences: MemoryPreferences;
  onPreferencesChange: (preferences: MemoryPreferences) => void;
  onOpenEvidence?: (runId: string, evidenceId: string) => void;
  client?: ApiClient;
}

export function MemoryPanel({ profileId, runId, preferences, onPreferencesChange, onOpenEvidence, client }: MemoryPanelProps): ReactElement {
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
  const pendingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const nextCapabilities = await api.memoryCapabilities(profileId);
        if (!active) return;
        setCapabilities(nextCapabilities);
        if (!nextCapabilities.enabled) {
          setCases([]);
          setLoading(false);
          return;
        }
        const nextCases = await api.listMemoryCases(profileId, { limit: 50, ...(filter === '' ? {} : { status: filter }) });
        if (active) setCases(nextCases);
      } catch (error) {
        if (active) setNotice(errorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, filter, profileId, refresh]);

  useEffect(() => { setNotice(null); }, [filter, profileId]);

  useEffect(() => {
    let active = true;
    setRun(null);
    setRunMemory(null);
    setCaptureTicket(null);
    if (runId === undefined || capabilities?.enabled !== true) return () => { active = false; };
    void Promise.all([api.getRun(runId), api.getRunMemory(runId), api.getRunMemoryCapture(runId)])
      .then(([nextRun, nextMemory, nextTicket]) => {
        if (!active) return;
        setRun(nextRun);
        setRunMemory(nextMemory);
        setCaptureTicket(nextTicket);
      })
      .catch((error: unknown) => { if (active) setNotice(errorMessage(error)); });
    return () => { active = false; };
  }, [api, capabilities?.enabled, runId, refresh]);

  async function capture(): Promise<void> {
    if (runId === undefined || !canCapture(capabilities, run) || pendingRef.current) return;
    pendingRef.current = true;
    setPending('capture');
    setNotice(null);
    const requestId = newRequestId();
    try {
      const current = await api.getRunMemoryCapture(runId);
      setCaptureTicket(current);
      if (current.state === 'saved') return;
      if (current.sourceCheckpointRevision === undefined) throw new Error('本次巡检缺少可核验的 Checkpoint 版本。');
      await api.captureRunMemory(runId, { requestId, expectedCheckpointRevision: current.sourceCheckpointRevision });
      setCaptureTicket(await api.getRunMemoryCapture(runId));
      setRefresh((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setNotice('本次巡检状态已更新，已刷新版本；请检查后再发起沉淀。');
        try { setCaptureTicket(await api.getRunMemoryCapture(runId)); } catch { /* keep the original conflict visible */ }
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
      const command = { profileId, expectedRevision: item.revision, requestId: newRequestId(), decision,
        claimCheck: decision === 'approved' ? 'supported' as const : 'unsupported' as const };
      await api.reviewMemory(item.id, command);
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
    <div className="panel-heading"><div><p className="eyebrow">DIAGNOSTIC MEMORY</p><h2>历史参考与案例</h2></div><span className="count-badge">{cases.length}</span></div>

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
  </section>;
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
    && item.evidenceRefs.length > 0 && item.evidenceRefs.every((reference) => reference.ownerRunId === item.sourceRunId
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
