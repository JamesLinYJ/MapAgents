// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线
//
//   文件:       ConversationTimeline.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 维护聊天时间线的滚动、空状态和辅助面板渲染。输入只接受
// ConversationEntry[]，诊断 RunEvent 面板不得接入这里。

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, m, type Variants } from 'framer-motion'
import { AlertCircle, CheckCircle2, ChevronDown, Circle, LoaderCircle, PauseCircle } from 'lucide-react'
import { AppIcon } from '../../shared/components/AppIcon'
import { buildFadeUpMotion } from '../../shared/motion'
import type { DataReferenceSummary } from '../../shared/constants'
import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import type { ConversationEntry } from './items'
import type { ChatPanelProps } from './types'
import { ConversationEntryView } from './ConversationEntry'
import { ConversationJumpRail } from './ConversationJumpRail'
import { buildConversationJumpItems, conversationJumpAnchorId } from './conversationJumpItems'
import { formatTaskStatus } from './entryFormat'
import { fmtElapsed } from './useConversation'

interface ConversationTimelineProps {
  conversation: ConversationEntry[]
  activeDecision: DecisionRequest | null
  isSubmitting: boolean
  errorMessage?: string
  errorTitle: string
  dataReferences: DataReferenceSummary[]
  uploadedLayerName?: string
  runCreatedAt?: string
  runStatus?: string
  agentWorkflow?: ChatPanelProps['agentWorkflow']
  progressTasks?: ChatPanelProps['tasks']
  onSelectArtifact: (id: string) => void
  onForkMessage?: (entryId: string) => void
  onOpenWorkflow?: () => void
  onRetry: () => void
  onFocusDecision: () => void
  feedVariants: Variants
  entryVariants: Variants
  reducedMotion: boolean
}

export function ConversationTimeline({
  conversation,
  activeDecision,
  isSubmitting,
  errorMessage,
  errorTitle,
  dataReferences,
  uploadedLayerName,
  runCreatedAt,
  runStatus,
  agentWorkflow,
  progressTasks,
  onSelectArtifact,
  onForkMessage,
  onOpenWorkflow,
  onRetry,
  onFocusDecision,
  feedVariants,
  entryVariants,
  reducedMotion,
}: ConversationTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [activeJumpAnchorId, setActiveJumpAnchorId] = useState<string | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const jumpItems = useMemo(() => buildConversationJumpItems(conversation), [conversation])

  const handleTimelineScroll = () => {
    const el = timelineRef.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const jumpToAnchor = (anchorId: string) => {
    const container = timelineRef.current
    const target = document.getElementById(anchorId)
    if (!container || !target) return
    target.scrollIntoView({
      block: 'center',
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
    setActiveJumpAnchorId(anchorId)
  }

  useEffect(() => {
    const el = timelineRef.current
    if (!el || jumpItems.length < 2) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top))
        const active = visible[0]?.target.id
        if (active) setActiveJumpAnchorId(active)
      },
      {
        root: el,
        threshold: 0.35,
        rootMargin: '-20% 0px -55% 0px',
      },
    )
    for (const item of jumpItems) {
      const target = document.getElementById(item.anchorId)
      if (target) observer.observe(target)
    }
    return () => observer.disconnect()
  }, [jumpItems])

  // 新消息到达时自动滚到底部，除非用户手动上滚。
  useEffect(() => {
    const el = timelineRef.current
    if (!el || !nearBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [conversation])

  // 逐字投影不会修改 canonical conversation 数组；观察 DOM 增量，保证用户
  // 停留在底部时正文增长仍持续跟随，手动上滚后则不抢夺阅读位置。
  useEffect(() => {
    const el = timelineRef.current
    if (!el) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (!nearBottom.current || frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        el.scrollTop = el.scrollHeight
      })
    })
    observer.observe(el, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <m.div className="cc-chat-mode" layout>
      <m.div ref={timelineRef} onScroll={handleTimelineScroll} className="cc-timeline" aria-label="对话" aria-live="polite" variants={feedVariants} initial="hidden" animate="visible">
        {agentWorkflow && agentWorkflow.steps.length > 0 && (
          <PlanPanel plan={agentWorkflow} entryVariants={entryVariants} onOpenWorkflow={onOpenWorkflow} />
        )}
        {!agentWorkflow && progressTasks && progressTasks.length > 0 && (
          <TaskPanel tasks={progressTasks} entryVariants={entryVariants} />
        )}
        {activeDecision && (
          <m.div key={activeDecision.decisionId} className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <div className="cc-clarification-card">
                <div className="cc-clarification-card__copy">
                  <strong>{activeDecision.title}</strong>
                  <span>{activeDecision.question}</span>
                </div>
                <button className="cc-mini-button cc-mini-button--primary" onClick={onFocusDecision}>
                  打开面板
                </button>
              </div>
            </div>
          </m.div>
        )}
        {errorMessage && (
          <m.div className="cc-timeline-item cc-timeline-item--error" role="alert" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <div className="cc-error-card">
                <strong>{errorTitle}</strong>
                <span>{errorMessage}</span>
                <button className="cc-mini-button" onClick={onRetry}>
                  重试
                </button>
              </div>
            </div>
          </m.div>
        )}
        {conversation.length ? (
          <AnimatePresence initial={false}>
            {conversation.map((entry) => (
              <ConversationEntryView
                key={entry.id}
                entry={entry}
                entryVariants={entryVariants}
                reducedMotion={reducedMotion}
                animateText={isSubmitting || runStatus === 'running'}
                expandedIds={expandedIds}
                anchorId={entry.kind === 'message' && entry.role === 'user' ? conversationJumpAnchorId(entry.id) : undefined}
                onToggleExpanded={toggleExpanded}
                onSelectArtifact={onSelectArtifact}
                onForkMessage={onForkMessage}
              />
            ))}
          </AnimatePresence>
        ) : isSubmitting ? (
          <m.div className="cc-timeline-item cc-timeline-item--running" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <button className="cc-thought-toggle" type="button">
                <span>正在思考…</span>
                <ChevronDown size={14} />
              </button>
              <div className="cc-assistant-copy">
                <p>正在分析你的问题...</p>
              </div>
            </div>
          </m.div>
        ) : (
          <m.div className="cc-empty cc-empty--chat" layout {...buildFadeUpMotion(reducedMotion, 0, 12)}>
            {dataReferences.length ? (
              <DataReferenceCard references={dataReferences} />
            ) : (
              <>
                <strong>有什么可以帮你分析？</strong>
                <span>输入一个地点、范围、图层或空间关系，我会把过程放在这条时间线上。</span>
              </>
            )}
          </m.div>
        )}
      </m.div>
      <ConversationJumpRail
        items={jumpItems}
        activeAnchorId={activeJumpAnchorId}
        onJump={jumpToAnchor}
      />

      <div className="cc-run-footer">
        <span>{runCreatedAt && runStatus === 'running' ? `运行中 ${fmtElapsed(runCreatedAt)}` : '输入空间问题，按回车开始分析'}</span>
        {dataReferences.length ? <span>引用 {dataReferences.length} 个数据</span> : uploadedLayerName && <span>已接入 {uploadedLayerName}</span>}
      </div>
    </m.div>
  )
}

function DataReferenceCard({ references }: { references: DataReferenceSummary[] }) {
  const visible = references.slice(0, 8)
  const hiddenCount = Math.max(0, references.length - visible.length)
  return (
    <div className="cc-data-context">
      <div className="cc-data-context__head">
        <strong>当前引用的数据</strong>
        <span>{references.length} 个文件/结果</span>
      </div>
      <div className="cc-data-context__list">
        {visible.map((reference) => (
          <div key={reference.id} className="cc-data-reference">
            <span className={`cc-data-reference__kind cc-data-reference__kind--${reference.kind}`}>{formatReferenceKind(reference.kind)}</span>
            <span className="cc-data-reference__main">
              <strong title={reference.relativePath ?? reference.name}>{reference.relativePath ?? reference.name}</strong>
              <small>{reference.detail}</small>
            </span>
            <span className="cc-data-reference__status">{reference.status}</span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && <span className="cc-data-context__more">还有 {hiddenCount} 个文件已接入，可在数据源面板查看。</span>}
    </div>
  )
}

function PlanPanel({ plan, entryVariants, onOpenWorkflow }: {
  plan: NonNullable<ChatPanelProps['agentWorkflow']>
  entryVariants: Variants
  onOpenWorkflow?: () => void
}) {
  return (
    <m.div key="plan-panel" className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-plan-panel cc-plan-panel--summary">
          <div className="cc-plan-panel__header">
            <span className="cc-plan-panel__icon"><AppIcon name="psychology" size={16} /></span>
            <span>
              <strong>智能体工作流</strong>
              <small>第 {plan.revision} 版 · {plan.steps.length} 个步骤</small>
            </span>
            <span className={`cc-plan-panel__status cc-plan-panel__status--${plan.status}`}>
              {workflowStatusLabel(plan.status)}
            </span>
          </div>
          <div className="cc-plan-panel__goal">{plan.goal}</div>
          <div className="cc-plan-panel__footer">
            <span>{plan.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length}/{plan.steps.length} 步完成</span>
            {onOpenWorkflow ? <button type="button" onClick={onOpenWorkflow}>在侧栏查看</button> : null}
          </div>
        </div>
      </div>
    </m.div>
  )
}

function workflowStatusLabel(status: NonNullable<ChatPanelProps['agentWorkflow']>['status']): string {
  if (status === 'awaiting_approval') return '等待审批'
  if (status === 'running') return '执行中'
  if (status === 'adjusting') return '调整中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '已取消'
}

function TaskPanel({ tasks, entryVariants }: {
  tasks: NonNullable<ChatPanelProps['tasks']>
  entryVariants: Variants
}) {
  const completed = tasks.filter(t => t.status === 'completed').length
  const total = tasks.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const currentTask = tasks.find((task) => task.status === 'running') ?? tasks.find((task) => task.status === 'pending') ?? tasks.at(-1)
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <m.div key="task-progress" className="cc-timeline-item cc-timeline-item--todo" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-task-progress">
          <div className="cc-task-progress__header">
            <span className="cc-task-progress__title">
              {completed === total ? <CheckCircle2 size={16} /> : <LoaderCircle size={16} className="cc-task-progress__spinner" />}
              <strong>{completed === total ? '任务已完成' : '任务执行中'}</strong>
            </span>
            <span>{completed}/{total} · {pct}%</span>
          </div>
          {currentTask && (
            <div className="cc-task-progress__current">
              <small>当前步骤</small>
              <strong>{currentTask.status === 'running' ? currentTask.activeForm || currentTask.content : currentTask.content}</strong>
            </div>
          )}
          <div className="cc-task-progress__bar">
            <div className="cc-task-progress__fill" style={{ width: `${pct}%` }} />
          </div>
          <button className="cc-thought-toggle" type="button" onClick={() => setIsExpanded(!isExpanded)}>
            <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
            <span>{isExpanded ? '收起 Todo' : '展开 Todo'}</span>
          </button>
          <AnimatePresence initial={false}>
            {isExpanded && (
              <m.div className="cc-task-progress__list" {...buildFadeUpMotion(false, 0, 4)}>
                {tasks.map(task => (
                  <div key={task.id} className={`cc-task-progress-item cc-task-progress-item--${task.status}`}>
                    <span className="cc-task-progress-item__icon">{taskStatusIcon(task.status)}</span>
                    <span className="cc-task-progress-item__content">
                      <strong>{task.content}</strong>
                      {task.status === 'running' && task.activeForm && task.activeForm !== task.content ? <small>{task.activeForm}</small> : null}
                    </span>
                    <span className={`cc-task-progress-item__tag cc-task-progress-item__tag--${task.status}`}>
                      {formatTaskStatus(task.status)}
                    </span>
                  </div>
                ))}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </m.div>
  )
}

function taskStatusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 size={15} />
  if (status === 'running' || status === 'in_progress') return <LoaderCircle size={15} className="cc-task-progress__spinner" />
  if (status === 'failed') return <AlertCircle size={15} />
  if (status === 'blocked') return <PauseCircle size={15} />
  return <Circle size={15} />
}

function formatReferenceKind(kind: DataReferenceSummary['kind']) {
  if (kind === 'artifact') return '结果'
  if (kind === 'meteorology') return '气象数据'
  if (kind === 'file') return '文件'
  return '图层'
}
