// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行记录投影器
//
//   文件:       runtimeTranscriptProjector.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem, RunStreamEvent } from '@openai/agents'
import {
  agentToolOutputMetadataSchema,
  type AgentToolOutputMetadata,
} from '@geo-agent-platform/shared-types/runtime'

import type { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import type { RunEventSink } from './turnRunner.js'
import {
  extractReasoningDelta,
  isAssistantContentCheckpoint,
  parseArguments,
  sdkNativeLedgerStatus,
  toolResultText,
} from './runtimeSdkProjection.js'
import type { RuntimeAssembly, StreamProjectionState } from './runtimeTypes.js'

// SDK 流事件只在此处投影成 canonical transcript 与 ConversationItem。
export class RuntimeTranscriptProjector {
  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  createState(): StreamProjectionState {
    return {
      assistantItemId: null,
      reasoningItemId: null,
      reasoningText: '',
      lastAssistantText: '',
      completedAssistantItems: [],
      subAgentCallItemIds: new Map(),
    }
  }

  async projectStreamEvent(
    event: RunStreamEvent,
    projection: StreamProjectionState,
    assembly: RuntimeAssembly,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    if (event.type === 'raw_model_stream_event') {
      // Supervisor 使用结构化 outputType；output_text_delta 是尚未闭合的 JSON，
      // 不能直接进入用户时间线。先缓冲；只有同一响应确实发起工具调用时，
      // 才把它作为工具前置说明投影，终态 JSON 则始终不会泄露给用户。
      if (event.data.type === 'output_text_delta' && event.data.delta) {
        projection.lastAssistantText += event.data.delta
      }
      if (event.data.type === 'model') {
        const delta = extractReasoningDelta(event.data.event)
        if (delta) {
          if (!projection.reasoningItemId) {
            projection.reasoningItemId = itemSink.startItem('reasoning', { role: 'assistant' }).itemId
          }
          projection.reasoningText += delta
          itemSink.deltaItem(projection.reasoningItemId, delta)
        }
      }
      return
    }
    // Agent 生命周期由 Runner 的 agent_start / agent_end / agent_handoff hooks
    // 统一投影；stream event 只负责模型内容和 run item，避免同一状态双写。
    if (event.type === 'agent_updated_stream_event') return
    if (event.name === 'message_output_created') {
      const raw = event.item.rawItem as AgentInputItem
      if (raw.type === 'message' && raw.role === 'assistant') {
        const content = raw.content
          .filter(part => part.type === 'output_text')
          .map(part => part.text)
          .join('')
        if (content) projection.lastAssistantText = content
      }
      return
    }
    if (event.name === 'reasoning_item_created') {
      if (projection.reasoningItemId) {
        itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
        projection.reasoningItemId = null
      }
      return
    }
    if (event.name === 'tool_called') {
      if (projection.lastAssistantText.trim()) {
        const text = projection.lastAssistantText.trim()
        const item = itemSink.startItem('message', { role: 'assistant' })
        itemSink.completeItem(item.itemId, { body: text })
        projection.completedAssistantItems.push({ itemId: item.itemId, text, entryId: null })
        projection.lastAssistantText = ''
      }
      const raw = event.item.rawItem
      if (raw.type === 'function_call' && assembly.subAgentToolNames.has(raw.name)) {
        const exists = (await this.store.activeTranscript(assembly.threadId))
          .some(entry => entry.kind === 'tool_call' && entry.payload.callId === raw.callId)
        if (!exists) {
          const parsedArgs = parseArguments(raw.arguments)
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_call',
            payload: {
              callId: raw.callId,
              name: raw.name,
              label: '子智能体任务',
              arguments: parsedArgs,
              ledgerStatus: 'started',
            },
          })
        }
        if (!projection.subAgentCallItemIds.has(raw.callId)) {
          const item = itemSink.startItem('function_call', {
            name: raw.name,
            callId: raw.callId,
            arguments: raw.arguments,
            metadata: { toolLabel: '子智能体任务' },
          })
          projection.subAgentCallItemIds.set(raw.callId, item.itemId)
        }
      } else if (
        raw.type === 'function_call'
        && !this.isPlatformManagedTool(raw.name, assembly)
      ) {
        const exists = (await this.store.activeTranscript(assembly.threadId))
          .some(entry => entry.kind === 'tool_call' && entry.payload.callId === raw.callId)
        if (!exists) {
          await this.appendSdkNativeToolCallTranscript(
            assembly.context.runId,
            assembly.threadId,
            assembly.turnId,
            raw,
            itemSink,
            sdkToolPresentation(raw.name, assembly),
          )
        }
      }
      const eventLabel = raw.type === 'function_call'
        ? assembly.subAgentToolNames.has(raw.name)
          ? '子智能体任务'
          : assembly.handoffToolNames.has(raw.name)
            ? 'Handoff 转交'
            : '工具调用'
        : '工具调用'
      eventSink.emit('tool.started', eventLabel, { sdkItemType: event.item.type })
      return
    }
    if (event.name === 'tool_output') {
      const raw = event.item.rawItem
      const metadata = event.item.type === 'tool_call_output_item'
        && raw.type === 'function_call_result'
        ? parseOutputMetadata(
            event.item.customData,
            this.isPlatformManagedTool(raw.name, assembly)
              || assembly.subAgentToolNames.has(raw.name)
              || assembly.mcpToolNames.has(raw.name),
          )
        : null
      if (raw.type === 'function_call_result' && assembly.subAgentToolNames.has(raw.name)) {
        const failed = raw.status === 'incomplete'
        const itemId = projection.subAgentCallItemIds.get(raw.callId)
        if (itemId) {
          itemSink.completeItem(itemId, {
            name: raw.name,
            callId: raw.callId,
            body: failed ? '子智能体执行失败' : '子智能体已返回结果',
            isError: failed,
            metadata: { toolLabel: '子智能体任务' },
          })
          projection.subAgentCallItemIds.delete(raw.callId)
        }
        eventSink.emit('tool.completed', failed ? '子智能体执行失败' : '子智能体任务完成', {
          sdkItemType: event.item.type,
          callId: raw.callId,
          agentId: raw.name,
          status: failed ? 'failed' : 'completed',
        })
      }
      if (
        raw.type === 'function_call_result'
        && (
          assembly.subAgentToolNames.has(raw.name)
          || !this.isPlatformManagedTool(raw.name, assembly)
        )
      ) {
        const transcript = await this.store.activeTranscript(assembly.threadId)
        const exists = transcript.some(entry => (
          entry.kind === 'tool_result' && entry.payload.callId === raw.callId
        ))
        if (!exists) {
          const presentation = sdkToolPresentation(raw.name, assembly)
          const content = toolResultText(raw.output)
          const ledgerStatus = sdkNativeLedgerStatus(raw.status)
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_result',
            payload: {
              callId: raw.callId,
              name: raw.name,
              label: metadata?.display?.label ?? presentation.label,
              summary: metadata?.display?.summary ?? content,
              content,
              contentRef: null,
              ledgerStatus,
              resultId: metadata?.resultId ?? null,
              valueRefIds: metadata?.valueRefIds ?? [],
              artifactIds: metadata?.artifactIds ?? [],
              source: metadata?.display?.source ?? presentation.source,
            },
          })
          if (!assembly.subAgentToolNames.has(raw.name)) {
            const outputItem = itemSink.startItem('function_call_output', {
              callId: raw.callId,
              name: raw.name,
              role: 'tool',
              metadata: {
                toolLabel: metadata?.display?.label ?? presentation.label,
                source: metadata?.display?.source ?? presentation.source,
              },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: raw.callId,
              name: raw.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: {
                toolLabel: metadata?.display?.label ?? presentation.label,
                source: metadata?.display?.source ?? presentation.source,
                resultId: metadata?.resultId ?? null,
                valueRefIds: metadata?.valueRefIds ?? [],
                artifactIds: metadata?.artifactIds ?? [],
              },
            })
          }
        }
      }
      return
    }
    if (event.name === 'tool_approval_requested') {
      eventSink.emit('approval.required', '工具调用等待审批', {})
    }
  }

  async linkAssistantTranscriptEntries(
    runId: string,
    assembly: RuntimeAssembly,
    projection: StreamProjectionState,
    itemSink: ItemSink,
  ): Promise<void> {
    if (!projection.completedAssistantItems.length) return
    if (projection.completedAssistantItems.every(item => item.entryId)) return
    const entries = (await this.store.activeTranscript(assembly.threadId)).filter(entry => (
      entry.runId === runId && entry.turnId === assembly.turnId
    ))
    const assistantMessages = entries.filter(entry => (
      entry.kind === 'message' && entry.payload.role === 'assistant'
    ))
    const assistantToolContent = entries.filter(isAssistantContentCheckpoint)
    for (const projected of projection.completedAssistantItems) {
      const messageIndex = assistantMessages.findIndex(entry => entry.payload.content === projected.text)
      if (messageIndex >= 0) {
        const [entry] = assistantMessages.splice(messageIndex, 1)
        if (!entry) throw new Error('SDK Session assistant 消息索引失效')
        itemSink.completeItem(projected.itemId, {
          body: projected.text,
          metadata: { transcriptEntryId: entry.entryId },
        })
        projected.entryId = entry.entryId
        continue
      }
      const checkpointIndex = assistantToolContent.findIndex(entry => entry.payload.content === projected.text)
      if (checkpointIndex < 0) throw new Error('SDK Session 未持久化全部 assistant 可见正文')
      const [entry] = assistantToolContent.splice(checkpointIndex, 1)
      if (!entry) throw new Error('SDK Session assistant checkpoint 索引失效')
      itemSink.completeItem(projected.itemId, {
        body: projected.text,
        metadata: {
          transcriptEntryId: entry.entryId,
          assistantContentForCallId: entry.payload.callId,
        },
      })
      projected.entryId = entry.entryId
    }
  }

  isPlatformManagedTool(toolName: string, assembly: RuntimeAssembly): boolean {
    return Boolean(this.toolRegistry.get(toolName))
      || assembly.subAgentToolNames.has(toolName)
  }

  failPendingSubAgentItems(
    projection: StreamProjectionState,
    itemSink: ItemSink,
    message: string,
  ): void {
    for (const [callId, itemId] of projection.subAgentCallItemIds) {
      itemSink.completeItem(itemId, {
        callId,
        body: message,
        isError: true,
        metadata: { toolLabel: '子智能体任务' },
      })
    }
    projection.subAgentCallItemIds.clear()
  }

  async appendSdkNativeToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
    presentation: { label: string; source: string },
  ): Promise<void> {
    const args = parseArguments(item.arguments)
    const sdkStatus = item.status ?? 'completed'
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'tool_call',
      payload: {
        callId: item.callId,
        name: item.name,
        label: presentation.label,
        arguments: args,
        ledgerStatus: sdkNativeLedgerStatus(sdkStatus),
        source: presentation.source,
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { toolLabel: presentation.label, source: presentation.source },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: sdkStatus === 'incomplete' ? `${presentation.label}未完成` : `${presentation.label}已执行`,
      isError: item.status === 'incomplete',
      metadata: { toolLabel: presentation.label, source: presentation.source },
    })
  }

  async appendSdkRejectedToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
    label: string,
  ): Promise<void> {
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'tool_call',
      payload: {
        callId: item.callId,
        name: item.name,
        label,
        arguments: parseArguments(item.arguments),
        ledgerStatus: 'rejected',
        source: 'openai_agents_sdk',
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { toolLabel: label, source: 'openai_agents_sdk' },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: `${label}未在当前运行阶段开放`,
      isError: true,
      metadata: {
        toolLabel: label,
        source: 'openai_agents_sdk',
        rejectedBy: 'tool_not_found',
      },
    })
  }

  appendAssistantMessageTranscript(
    assembly: RuntimeAssembly,
    content: string,
    itemId?: string | null,
  ) {
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'message',
      payload: itemId
        ? { role: 'assistant', content, itemId }
        : { role: 'assistant', content },
    })
  }

  async appendAssistantContentCheckpoint(
    assembly: RuntimeAssembly,
    callId: string,
    content: string,
  ) {
    const entries = await this.store.activeTranscript(assembly.threadId)
    const toolCall = entries.find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (!toolCall) throw new Error(`SDK Session 收到未准备的工具调用 '${callId}'`)
    const existingContent = typeof toolCall.payload.assistantContent === 'string' && toolCall.payload.assistantContent.trim()
      ? toolCall.payload.assistantContent.trim()
      : null
    if (existingContent && existingContent !== content) {
      throw new Error(`工具调用 '${callId}' 的 assistant 前导正文不一致`)
    }
    const existingCheckpoint = entries.find(entry => (
      isAssistantContentCheckpoint(entry) && entry.payload.callId === callId
    ))
    if (existingCheckpoint) {
      if (existingCheckpoint.payload.content !== content) {
        throw new Error(`工具调用 '${callId}' 的 assistant 前导正文 checkpoint 不一致`)
      }
      return existingCheckpoint
    }
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'checkpoint',
      payload: {
        type: 'assistant_content_for_tool_call',
        callId,
        content,
        source: 'openai_agents_session',
      },
    })
  }
}

function parseOutputMetadata(
  value: unknown,
  requiredPlatformContract: boolean,
): AgentToolOutputMetadata | null {
  if (value === undefined) return null
  const parsed = agentToolOutputMetadataSchema.safeParse(value)
  if (!parsed.success) {
    if (requiredPlatformContract) {
      throw new Error('Agents SDK 工具输出 customData 不符合平台契约')
    }
    return null
  }
  return parsed.data
}

function sdkToolPresentation(
  toolName: string,
  assembly: RuntimeAssembly,
): { label: string; source: string } {
  if (assembly.handoffToolNames.has(toolName)) {
    return { label: 'Handoff 转交', source: 'openai_agents_handoff' }
  }
  if (assembly.mcpToolNames.has(toolName)) {
    return { label: 'MCP 工具调用', source: 'openai_agents_mcp' }
  }
  if (assembly.subAgentToolNames.has(toolName)) {
    return { label: '子智能体任务', source: 'openai_agents_agent_as_tool' }
  }
  return { label: '沙箱工具调用', source: 'openai_agents_sandbox' }
}
