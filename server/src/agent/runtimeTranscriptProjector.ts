import type { AgentInputItem, RunStreamEvent } from '@openai/agents'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'

import type { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import type { RunEventSink } from './turnRunner.js'
import {
  assistantText,
  extractReasoningDelta,
  isAssistantContentCheckpoint,
  isAssistantMessage,
  parseArguments,
  sdkNativeLedgerStatus,
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
      if (event.data.type === 'output_text_delta' && event.data.delta) {
        if (!projection.assistantItemId) {
          projection.assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
        }
        itemSink.deltaItem(projection.assistantItemId, event.data.delta)
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
    if (event.type === 'agent_updated_stream_event') {
      eventSink.emit('step.started', `Agent：${event.agent.name}`, { agentId: event.agent.name })
      return
    }
    if (event.name === 'message_output_created') {
      const raw = event.item.rawItem as AgentInputItem
      const text = isAssistantMessage(raw) ? assistantText(raw) : ''
      if (text) {
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        itemSink.completeItem(itemId, { body: text })
        projection.completedAssistantItems.push({ itemId, text, entryId: null })
        projection.lastAssistantText = text
        projection.assistantItemId = null
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
      const raw = event.item.rawItem
      if (raw.type === 'function_call' && assembly.subAgentNames.has(raw.name)) {
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
          const item = itemSink.startItem('function_call', {
            name: raw.name,
            callId: raw.callId,
            arguments: raw.arguments,
            metadata: { toolLabel: '子智能体任务' },
          })
          projection.subAgentCallItemIds.set(raw.callId, item.itemId)
        }
      }
      const eventLabel = raw.type === 'function_call' && assembly.subAgentNames.has(raw.name)
        ? '子智能体任务'
        : '工具调用'
      eventSink.emit('tool.started', eventLabel, { sdkItemType: event.item.type })
      return
    }
    if (event.name === 'tool_output') {
      const raw = event.item.rawItem
      if (raw.type === 'function_call_result' && assembly.subAgentNames.has(raw.name)) {
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

  isPlatformManagedTool(toolName: string, runtimeConfig: AgentRuntimeConfig): boolean {
    return Boolean(this.toolRegistry.get(toolName))
      || runtimeConfig.subAgents.some(config => config.agentId === toolName)
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

  async appendSandboxNativeToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
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
        label: '沙箱工具调用',
        arguments: args,
        ledgerStatus: sdkNativeLedgerStatus(sdkStatus),
        source: 'openai_agents_sandbox',
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { toolLabel: '沙箱工具调用', source: 'openai_agents_sandbox' },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: sdkStatus === 'incomplete' ? 'SDK 沙箱工具执行未完成' : 'SDK 沙箱工具已执行',
      isError: item.status === 'incomplete',
      metadata: { toolLabel: '沙箱工具调用', source: 'openai_agents_sandbox' },
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
