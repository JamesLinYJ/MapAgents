import { useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, CirclePause, CirclePlay, Clock, ListChecks, Square, Trash2 } from 'lucide-react'
import type {
  BackgroundTaskInfo,
  ScheduledTask,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowRunRecord,
  WorkflowValidationResult,
} from '@geo-agent-platform/shared-types'
import type {
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
  StartWorkflowPayload,
  WorkflowDraftPayload,
  WorkflowUpdatePayload,
} from '../../api/client'
import { StatusPill } from '../../shared/components/StatusPill'
import { WorkflowStudio } from './workflowStudio/WorkflowStudio'

export interface WorkflowManagementPanelProps {
  view: 'workflows' | 'scheduled' | 'background'
  tools: ToolDescriptor[]
  workflows: WorkflowDefinition[]
  workflowDiagnostics: Array<Record<string, unknown>>
  workflowValidation: Record<string, WorkflowValidationResult>
  scheduledTasks: ScheduledTask[]
  workflowRuns: WorkflowRunRecord[]
  backgroundTasks: BackgroundTaskInfo[]
  isSubmitting?: boolean
  onValidateWorkflow: (payload: WorkflowDraftPayload) => Promise<WorkflowValidationResult>
  onCreateWorkflow: (payload: WorkflowDraftPayload) => Promise<WorkflowDefinition>
  onUpdateWorkflow: (payload: WorkflowUpdatePayload) => Promise<WorkflowDefinition>
  onPublishWorkflow: (workflowId: string, revision: number) => Promise<void>
  onDisableWorkflow: (workflowId: string) => Promise<void>
  onRespondWorkflowApproval: (workflowRunId: string, approvalId: string, decision: 'approved' | 'rejected') => Promise<void>
  onStartWorkflow: (payload: StartWorkflowPayload) => void
  onCancelWorkflow: (workflowRunId: string) => void
  onSaveScheduledTask: (payload: ScheduledTaskCreatePayload | ScheduledTaskUpdatePayload) => void
  onDeleteScheduledTask: (taskId: string) => void
  onCancelBackgroundTask: (taskId: string) => void
  onPromoteBackgroundTask: (taskId: string) => void
}

export function WorkflowManagementPanel(props: WorkflowManagementPanelProps) {
  if (props.view === 'scheduled') return <ScheduledTasksPanel {...props} />
  if (props.view === 'background') return <BackgroundTasksPanel {...props} />
  return (
    <main className="tool-management__detail tool-management__detail--workflow-studio">
      {props.workflowDiagnostics.length ? (
        <section className="workflow-load-diagnostics">
          <strong>有 {props.workflowDiagnostics.length} 个内置 Workflow 文件未加载</strong>
          {props.workflowDiagnostics.map((diagnostic, index) => <p key={`${String(diagnostic.file ?? index)}:${index}`}>{String(diagnostic.file ?? '未知文件')}：{String(diagnostic.message ?? '定义校验失败')}</p>)}
        </section>
      ) : null}
      <WorkflowStudio
        workflows={props.workflows}
        validation={props.workflowValidation}
        tools={props.tools}
        workflowRuns={props.workflowRuns}
        isSubmitting={Boolean(props.isSubmitting)}
        onValidate={props.onValidateWorkflow}
        onCreate={props.onCreateWorkflow}
        onUpdate={props.onUpdateWorkflow}
        onPublish={props.onPublishWorkflow}
        onDisable={props.onDisableWorkflow}
        onStart={props.onStartWorkflow}
        onCancel={props.onCancelWorkflow}
        onRespondApproval={props.onRespondWorkflowApproval}
      />
    </main>
  )
}

function ScheduledTasksPanel(props: WorkflowManagementPanelProps) {
  const enabledWorkflows = useMemo(() => props.workflows.filter(workflow => workflow.enabled && workflow.publishedRevision !== null), [props.workflows])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(enabledWorkflows[0]?.workflowId ?? '')
  const selectedWorkflow = enabledWorkflows.find(workflow => workflow.workflowId === selectedWorkflowId)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [parameters, setParameters] = useState('{}')
  const [cron, setCron] = useState('*/30 * * * *')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
  const [recurring, setRecurring] = useState(true)
  const [enabled, setEnabled] = useState(true)
  return (
    <main className="tool-management__detail tool-management__detail--extensions">
      <section className="panel workflow-panel workflow-panel--summary">
        <div className="panel__header"><div><div className="panel__eyebrow">系统调度</div><h2>定时任务</h2></div><StatusPill label={`${props.scheduledTasks.length} 个任务`} tone="accent" /></div>
        <div className="panel__section workflow-form-grid">
          <Field label="目标 Workflow"><select value={selectedWorkflowId} onChange={event => setSelectedWorkflowId(event.target.value)}>{enabledWorkflows.map(workflow => <option key={workflow.workflowId} value={workflow.workflowId}>{workflow.name} · r{workflow.revision}</option>)}</select></Field>
          <Field label="任务名称"><input value={title} placeholder="例如：每 30 分钟降水短临监测" onChange={event => setTitle(event.target.value)} /></Field>
          <Field label="Cron"><input value={cron} placeholder="*/30 * * * *" onChange={event => setCron(event.target.value)} /></Field>
          <Field label="时区"><input value={timezone} placeholder="Asia/Shanghai" onChange={event => setTimezone(event.target.value)} /></Field>
          <Field label="执行目标" className="workflow-field--wide"><textarea value={prompt} placeholder="写清楚触发时要完成的分析目标。" onChange={event => setPrompt(event.target.value)} /></Field>
          <Field label="参数 JSON" className="workflow-field--wide"><textarea value={parameters} onChange={event => setParameters(event.target.value)} /></Field>
          <label className="workflow-toggle"><input type="checkbox" checked={recurring} onChange={event => setRecurring(event.target.checked)} /><span>周期任务</span></label>
          <label className="workflow-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>创建后启用</span></label>
          <button type="button" className="toolbar-button toolbar-button--primary workflow-action" disabled={!selectedWorkflow || !prompt.trim() || !cron.trim() || !timezone.trim() || Boolean(props.isSubmitting)} onClick={() => {
            if (!selectedWorkflow) return
            try {
              props.onSaveScheduledTask({ targetKind: 'workflow', targetId: selectedWorkflow.workflowId, title: title.trim() || selectedWorkflow.name, prompt: prompt.trim(), parameters: parseObject(parameters), cron: cron.trim(), timezone: timezone.trim(), recurring, enabled })
            } catch (error) { window.alert(error instanceof Error ? error.message : '参数 JSON 无效。') }
          }}><CalendarClock size={15} /><span>{props.isSubmitting ? '保存中' : '创建定时任务'}</span></button>
        </div>
      </section>
      <section className="panel workflow-panel">
        <PanelTitle title="任务列表" count={props.scheduledTasks.length} />
        <div className="panel__section workflow-list">
          {props.scheduledTasks.map(task => (
            <article className="workflow-row" key={task.taskId}>
              <div className="workflow-row__main"><CalendarClock size={17} /><div><strong>{task.title}</strong><p>{task.cron} · {task.timezone} · 下次 {formatDateTime(task.nextFireAt)}</p></div></div>
              <div className="workflow-row__meta"><span className={task.enabled ? 'dc-pill-meta badge-green' : 'dc-pill-meta'}>{task.enabled ? '已启用' : '已停用'}</span><span className="dc-pill-meta">失败 {task.failureCount} 次</span></div>
              <div className="workflow-row__actions"><button type="button" className="toolbar-button" disabled={Boolean(props.isSubmitting)} onClick={() => props.onSaveScheduledTask({ taskId: task.taskId, enabled: !task.enabled })}>{task.enabled ? <CirclePause size={15} /> : <CirclePlay size={15} />}<span>{task.enabled ? '停用' : '启用'}</span></button><button type="button" className="toolbar-button" disabled={Boolean(props.isSubmitting)} onClick={() => props.onDeleteScheduledTask(task.taskId)}><Trash2 size={15} /><span>删除</span></button></div>
              {task.lastErrorMessage ? <p className="workflow-row__error">最近失败：{task.lastErrorMessage}</p> : null}
            </article>
          ))}
          {!props.scheduledTasks.length ? <div className="panel__empty">暂无定时任务。</div> : null}
        </div>
      </section>
    </main>
  )
}

function BackgroundTasksPanel(props: WorkflowManagementPanelProps) {
  return (
    <main className="tool-management__detail tool-management__detail--extensions">
      <section className="panel workflow-panel">
        <PanelTitle title="当前进程后台任务" count={props.backgroundTasks.length} />
        <div className="panel__section workflow-list">
          {props.backgroundTasks.map(task => (
            <article className="workflow-row" key={task.taskId}>
              <div className="workflow-row__main"><Clock size={17} /><div><strong>{task.label}</strong><p>{task.kind} · {task.status} · {formatDateTime(task.startedAt)}</p></div></div>
              <div className="workflow-row__meta"><span className={task.status === 'running' ? 'dc-pill-meta badge-green' : 'dc-pill-meta'}>{task.status}</span>{task.runId ? <span className="dc-pill-meta">{task.runId}</span> : null}</div>
              <div className="workflow-row__actions"><button type="button" className="toolbar-button" onClick={() => props.onPromoteBackgroundTask(task.taskId)}><ListChecks size={15} /><span>定位</span></button><button type="button" className="toolbar-button" disabled={task.status !== 'running' || Boolean(props.isSubmitting)} onClick={() => props.onCancelBackgroundTask(task.taskId)}><Square size={15} /><span>取消</span></button></div>
              {task.errorMessage ? <p className="workflow-row__error">{task.errorMessage}</p> : null}
            </article>
          ))}
          {!props.backgroundTasks.length ? <div className="panel__empty">当前工作区没有正在观察的后台任务。持久化状态请查看 Workflow 运行和定时任务。</div> : null}
        </div>
      </section>
    </main>
  )
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) { return <label className={className ? `workflow-field ${className}` : 'workflow-field'}><span>{label}</span>{children}</label> }
function PanelTitle({ title, count }: { title: string; count: number }) { return <div className="panel__header"><div><div className="panel__eyebrow">Registry</div><h2>{title}</h2></div><StatusPill label={String(count)} tone="accent" /></div> }
function parseObject(value: string): Record<string, unknown> { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON object。'); return parsed as Record<string, unknown> }
function formatDateTime(value?: string | null) { if (!value) return '未计算'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
