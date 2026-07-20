// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流侧栏面板
//
//   文件:       WorkspaceWorkflowPanel.tsx
//
//   日期:       2026年07月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Bot, Check, Circle, Clock3, ListTree, LoaderCircle, X } from 'lucide-react'
import type { AgentState } from '@geo-agent-platform/shared-types'
import { deriveWorkspaceWorkflowView } from './WorkspaceWorkflowModel'

interface WorkspaceWorkflowPanelProps {
  agentState?: AgentState | null
}

export function WorkspaceWorkflowPanel({ agentState }: WorkspaceWorkflowPanelProps) {
  const workflow = deriveWorkspaceWorkflowView(agentState)
  if (!workflow) return null

  const progress = workflow.steps.length
    ? Math.round((workflow.completedCount / workflow.steps.length) * 100)
    : 0

  return (
    <section
      id="workbench-workflow-panel"
      className="workbench-inspector-card workbench-workflow-card"
      aria-label="智能体工作流"
    >
      <div className="workbench-workflow-card__head">
        <div className="workbench-workflow-card__title">
          <ListTree size={16} aria-hidden="true" />
          <div>
            <strong>任务计划</strong>
            <span>第 {workflow.revision} 版 · {workflow.steps.length} 步</span>
          </div>
        </div>
        <span className={`workbench-workflow-status workbench-workflow-status--${workflow.status}`}>
          {workflow.awaitingApproval ? <Clock3 size={12} aria-hidden="true" /> : null}
          {workflow.statusLabel}
        </span>
      </div>

      <p className="workbench-workflow-card__goal">{workflow.goal}</p>
      <div
        className="workbench-workflow-progress"
        role="progressbar"
        aria-label="工作流完成进度"
        aria-valuemin={0}
        aria-valuemax={workflow.steps.length}
        aria-valuenow={workflow.completedCount}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <ol className="workbench-workflow-steps">
        {workflow.steps.map((step, index) => (
          <li key={step.stepId} className={`workbench-workflow-step workbench-workflow-step--${step.status}`}>
            <span className="workbench-workflow-step__icon" aria-hidden="true">
              {step.status === 'completed' || step.status === 'skipped' ? <Check size={12} />
                : step.status === 'running' ? <LoaderCircle size={12} />
                  : step.status === 'failed' || step.status === 'blocked' ? <X size={12} />
                    : <Circle size={9} />}
            </span>
            <div className="workbench-workflow-step__copy">
              <strong>{index + 1}. {step.title}</strong>
              <span>{step.technicalLabel} · {step.statusLabel}</span>
              {step.argsSummary ? <code title={step.argsSummary}>{step.argsSummary}</code> : null}
              {step.detail ? <small>{step.detail}</small> : null}
            </div>
          </li>
        ))}
      </ol>

      {workflow.agents.length ? (
        <div className="workbench-workflow-agents" aria-label="协作智能体">
          <span className="workbench-workflow-agents__label"><Bot size={13} aria-hidden="true" />协作智能体</span>
          {workflow.agents.map(agent => (
            <div key={agent.agentId} className="workbench-workflow-agent">
              <div>
                <strong>{agent.name}</strong>
                {agent.detail ? <small>{agent.detail}</small> : null}
              </div>
              <span>{agent.statusLabel}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
