// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话功能类型
//
//   文件:       types.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// conversation feature 的本地 UI 类型。ConversationItem 仍来自 shared-types，
// 这里只描述前端面板 props、编辑态和展示态，不创建新的聊天事实源。

import type {
  AgentRuntimeConfig,
  AgentExecutionMode,
  AgentWorkflow,
  AgentThreadRecord,
  ConversationItem,
  DecisionRequest,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'
import type { DataReferenceSummary } from '../../shared/constants'
import type { UploadReference } from '../../app/types'

export type ComposerMode = 'approval' | 'plan' | 'auto'
export type TaskView = 'chat' | 'history'

export type ActiveDecision = DecisionRequest & {
  source: 'server' | 'local'
}

export interface ChatPanelProps {
  artifactCount: number
  currentRunId?: string
  currentThreadId?: string
  currentThreadTitle?: string
  runCreatedAt?: string
  providerLabel: string
  runStatus?: string
  query: string
  isSubmitting: boolean
  conversationReady: boolean
  errorMessage?: string
  uploadedLayerName?: string
  uploadReferences?: UploadReference[]
  decisions?: DecisionRequest[]
  sessionThreads: AgentThreadRecord[]
  items: ReadonlyArray<ConversationItem>
  runtimeConfig?: AgentRuntimeConfig
  availableTools?: ToolDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: (mode: AgentExecutionMode) => Promise<void>
  onInterrupt?: () => void
  onNewConversation: () => void
  onFillSample: (value: string) => void
  onRespondDecision: (decisionId: string, optionId?: string | null, text?: string | null) => void
  onUseTemplate: () => void
  onUploadFiles: (files: DesktopFileSelectionHandle[]) => void
  onSelectArtifact: (id: string) => void
  onSelectTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onDeleteTask: (id: string) => void
  onForkMessage?: (entryId: string) => void
  onOpenWorkflow?: () => void
  dataReferences: DataReferenceSummary[]
  trashedThreads?: Array<{ thread: AgentThreadRecord; deletedAt: string; purgeAfter: string }>
  onLoadTrash?: () => void
  onRestoreThread?: (threadId: string) => void
  onPurgeThread?: (threadId: string) => void

  tokenBudget?: { used: number; max: number; status: 'normal' | 'warning' | 'critical' | 'exceeded' }

  activeSkills?: string[]
  activeMcpServers?: string[]
  compactionLevel?: string | null
  runStats?: { toolAttempts: number; toolSuccesses: number; toolFailures: number; tokensUsed: number }
  denialCounts?: Record<string, number>

  agentWorkflow?: AgentWorkflow | null

  tasks?: { id: string; content: string; status: string; activeForm: string }[]
}
