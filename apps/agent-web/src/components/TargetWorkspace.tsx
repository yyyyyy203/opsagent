import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { ApiClient } from '../api/client.js';
import type { MemoryPreferences, PublicProfile, TargetCatalogDto, TargetReadinessDto } from '../api/types.js';
import type { RunViewClient } from '../state/run-view.js';
import { RunViewController } from '../state/run-view.js';
import { ConfirmationCard } from './ConfirmationCard.js';
import { EvidencePanel } from './EvidencePanel.js';
import { MessageList } from './MessageList.js';
import { MemoryPanel } from './MemoryPanel.js';
import { RunList } from './RunList.js';
import { RunStatus } from './RunStatus.js';
import { SubagentPanel } from './SubagentPanel.js';
import { TaskComposer } from './TaskComposer.js';

export function TargetWorkspace({ api, onUnavailable }: { api: ApiClient; onUnavailable?: () => void }): ReactElement {
  const [targets, setTargets] = useState<readonly TargetCatalogDto[]>([]);
  const [targetId, setTargetId] = useState('');
  const [readiness, setReadiness] = useState<TargetReadinessDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listTargets().then(next => {
      if (!active) return;
      setTargets(next);
      setTargetId(current => next.some(item => item.targetId === current) ? current : next[0]?.targetId ?? '');
      setNotice(next.length === 0 ? '宿主尚未提供 Target。可以切换到模拟巡检模式。' : null);
    }).catch(() => {
      if (!active) return;
      setNotice('Target 工作台当前不可用；请确认宿主已配置 Target Runtime。');
      onUnavailable?.();
    })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, onUnavailable]);

  useEffect(() => {
    if (targetId === '') { setReadiness(null); return () => undefined; }
    let active = true;
    setReadiness(null);
    void api.getTargetReadiness(targetId).then(value => { if (active) setReadiness(value); })
      .catch(() => { if (active) setReadiness(null); });
    return () => { active = false; };
  }, [api, targetId]);

  const target = targets.find(item => item.targetId === targetId);
  return <>
    <section className="panel target-workspace-heading">
      <div className="panel-heading"><div><p className="eyebrow">TARGET WORKSPACE</p><h2>项目巡检</h2></div>
        <label className="target-picker"><span>项目 / 部署 / 场景</span>
          <select aria-label="选择巡检 Target" value={targetId} disabled={loading || targets.length === 0}
            onChange={event => { setTargetId(event.target.value); setNotice(null); }}>
            {targets.length === 0 && <option value="">没有可用 Target</option>}
            {targets.map(item => <option value={item.targetId} key={item.targetId}>
              {item.projectName} · {item.displayName} · {item.environment} · {item.scenario.id}@{item.scenario.version}
            </option>)}
          </select>
        </label>
      </div>
      {target !== undefined && <div className="target-selection-summary" role="status">
        <strong>{readiness === null ? '读取 Target 就绪状态…' : readiness.status === 'ready' ? '可以启动巡检'
          : readiness.reasonCode ?? readiness.status}</strong>
        <span>{target.projectId} / {target.deploymentId} · {target.scenario.serviceName} · {target.scenario.id}@{target.scenario.version}</span>
      </div>}
      {notice !== null && <p className="memory-notice" role="status">{notice}</p>}
      {target !== undefined && readiness !== null && readiness.status !== 'ready'
        && <p className="memory-disabled-note">此 Target 当前不能启动新 Run，已有历史仍可查看。</p>}
    </section>
    {target === undefined ? <div className="panel empty-state">{loading ? '正在读取 Target…' : '宿主未提供可用 Target。'}</div>
      : <TargetRunWorkspace key={target.targetId} api={api} target={target} canStart={readiness?.canStart === true} />}
  </>;
}

function TargetRunWorkspace({ api, target, canStart }: { api: ApiClient; target: TargetCatalogDto; canStart: boolean }): ReactElement {
  const client = useMemo(() => new TargetRunViewClient(api, target), [api, target]);
  const controller = useMemo(() => new RunViewController(client), [client]);
  const state = useSyncExternalStore(controller.subscribe.bind(controller), controller.getState.bind(controller), controller.getState.bind(controller));
  const [memoryPreferences, setMemoryPreferences] = useState<MemoryPreferences>({ capture: 'manual', recall: 'disabled' });

  useEffect(() => {
    void controller.loadIndex();
    return () => controller.close();
  }, [controller]);

  async function startRun(message: string): Promise<void> {
    await controller.startRun(message, target.targetId, memoryPreferences);
    await controller.loadIndex();
  }

  async function openEvidence(ownerRunId: string): Promise<void> {
    await controller.openRun(ownerRunId);
    window.requestAnimationFrame(() => document.querySelector('.evidence-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  return <section className="workspace-grid target-workspace-grid">
    <aside className="panel run-history">
      <div className="panel-heading"><div><p className="eyebrow">TARGET RUNS</p><h2>此 Target 历史</h2></div><span className="count-badge">{state.runs.length}</span></div>
      <RunList runs={state.runs} selectedRunId={state.runId} onSelect={runId => void controller.openRun(runId)} />
    </aside>
    <section className="main-column">
      <TaskComposer profiles={[targetProfile(target)]} selectedProfile={target.targetId}
        profileDescription={`${target.projectName} · ${target.deploymentId} · ${target.scenario.serviceName} · ${target.scenario.id}@${target.scenario.version}`}
        pending={state.pendingCommand === 'start'} canSubmit={canStart} profileLabel="当前 Target"
        onProfileChange={() => undefined} onSubmit={startRun} />
      <div className="panel message-panel">
        <div className="panel-heading"><div><p className="eyebrow">TARGET RUN MESSAGES</p><h2>{state.runId === null ? '请选择一个 Run' : '调查过程'}</h2></div>{state.detail !== null && <span className="stage-chip">{state.detail.stage}</span>}</div>
        {state.runId === null ? <div className="empty-state">从左侧打开此 Target 历史，或提交一次新的巡检。</div> : <MessageList messages={state.messages} />}
      </div>
    </section>
    <aside className="side-column">
      <MemoryPanel profileId={target.targetId} targetId={target.targetId} {...(state.runId === null ? {} : { runId: state.runId })}
        preferences={memoryPreferences} onPreferencesChange={setMemoryPreferences}
        onOpenEvidence={(ownerRunId) => void openEvidence(ownerRunId)} client={api} />
      <RunStatus detail={state.detail} descendantUsage={state.descendantUsage} subtreeUsage={state.subtreeUsage} connected={state.connected}
        pending={state.pendingCommand === 'resume'} cancelPending={state.pendingCommand === 'cancel'} resumeAvailable={state.resumeRequired}
        toolActivity={state.toolActivity} datasourceActivity={state.datasourceActivity}
        onResume={() => void controller.resumeRun()} onCancel={() => void controller.cancelRun()} />
      <ConfirmationCard confirmation={state.confirmation} pending={state.pendingCommand === 'confirmation'} onDecision={(confirmed, reason) => {
        if (state.confirmation === null) return;
        void controller.decideConfirmation({ toolCallId: state.confirmation.toolCallId, confirmed,
          expectedRevision: state.confirmation.expectedRevision, ...(reason === undefined ? {} : { reason }) });
      }} />
      <EvidencePanel evidence={state.evidence} missingEvidence={state.detail?.missingEvidence ?? []} incomplete={state.evidenceIncomplete} />
      <SubagentPanel childRunIds={state.detail?.childRunIds ?? []} onOpen={runId => void controller.openRun(runId)} />
    </aside>
  </section>;
}

function targetProfile(target: TargetCatalogDto): PublicProfile {
  return { id: target.targetId, name: target.displayName, description: target.description, capabilities: { readOnly: true } };
}

class TargetRunViewClient implements RunViewClient {
  public constructor(private readonly api: ApiClient, private readonly target: TargetCatalogDto) {}
  public listProfiles(): Promise<readonly PublicProfile[]> { return Promise.resolve([targetProfile(this.target)]); }
  public listRuns(options?: { cursor?: string; limit?: number }) { return this.api.listTargetRuns(this.target.targetId, options); }
  public getRun(runId: string) { return this.api.getTargetRun(this.target.targetId, runId); }
  public getMessages(runId: string, options?: { cursor?: string; limit?: number }) { return this.api.getTargetMessages(this.target.targetId, runId, options); }
  public listEvidence(runId: string, options?: { cursor?: string; limit?: number }) { return this.api.listTargetEvidence(this.target.targetId, runId, options); }
  public getConfirmation(runId: string) { return this.api.getTargetConfirmation(this.target.targetId, runId); }
  public startRun(input: { runId: string; message: string; profileId: string; memoryPreferences?: MemoryPreferences }) {
    return this.api.startTargetRun(this.target.targetId, { requestId: input.runId, message: input.message,
      ...(input.memoryPreferences === undefined ? {} : { memoryPreferences: input.memoryPreferences }) });
  }
  public resumeRun(runId: string) { return this.api.resumeTargetRun(this.target.targetId, runId); }
  public cancelRun(runId: string) { return this.api.cancelTargetRun(this.target.targetId, runId); }
  public decideConfirmation(runId: string, input: Parameters<RunViewClient['decideConfirmation']>[1]) {
    return this.api.decideTargetConfirmation(this.target.targetId, runId, input);
  }
  public openRunEvents(runId: string, lastEventId: string | undefined,
    onEvent: Parameters<RunViewClient['openRunEvents']>[2], onError?: Parameters<RunViewClient['openRunEvents']>[3]) {
    return this.api.openTargetRunEvents(this.target.targetId, runId, lastEventId, onEvent, onError);
  }
}
