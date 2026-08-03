// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 单次运行执行器
//
//   文件:       runtimeSdkExecutor.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  RunContext,
  type Agent,
  type AgentInputItem,
  type RunState,
} from '@openai/agents'

import type { ItemSink } from '../conversation/itemSink.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { ModelRequestTelemetry } from '../observability/modelRequestTelemetry.js'
import type { AgentState, SupervisorDelivery } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import type { AgentsCheckpointService } from './agentsCheckpointService.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { assertArtifactDeliveryIsVisible } from './artifactDeliveryPolicy.js'
import { aggregateModelUsage, mergeModelUsageStats, type ModelUsageLike } from './modelUsage.js'
import type { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import {
  combineSessionInput,
  errorMessage,
} from './runtimeSdkProjection.js'
import type { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import type { RunOptions, RuntimeAssembly, StreamProjectionState } from './runtimeTypes.js'
import type { RunSteeringController } from './runSteeringController.js'
import { evaluateTerminalDelivery } from './terminalDeliveryPolicy.js'
import type { RunEventSink } from './turnRunner.js'

export type RuntimeSdkOutcome = 'completed' | 'waiting_approval' | 'clarification_needed'

interface RuntimeSdkExecutorDependencies {
  store: AgentRuntimeStore
  checkpoints: AgentsCheckpointService
  transcriptProjector: RuntimeTranscriptProjector
  approvalPersistence: RuntimeApprovalPersistence
  steering: RunSteeringController
}

// 只负责驱动一次 SDK Runner，并把 SDK 中断和终态交给平台投影边界。
// PostgreSQL 仍是 transcript、审批、工作流和结果账本的事实源。
export class RuntimeSdkExecutor {
  constructor(private readonly dependencies: RuntimeSdkExecutorDependencies) {}

  async execute(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RunState<
      AgentsExecutionContext,
      Agent<AgentsExecutionContext>
    > | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<RuntimeSdkOutcome> {
    const {
      approvalPersistence,
      checkpoints,
      steering,
      store,
      transcriptProjector,
    } = this.dependencies
    let outcome: RuntimeSdkOutcome | null = null
    let nextInput: RunState<
      AgentsExecutionContext,
      Agent<AgentsExecutionContext>
    > | AgentInputItem[] | string = resumeState ?? options.query
    let activeProjection: StreamProjectionState | null = null
    let activeModelTelemetry: ModelRequestTelemetry | null = null
    let terminalRepairAttempts = 0

    try {
      while (true) {
        const projection = transcriptProjector.createState()
        activeProjection = projection
        const modelTelemetry = new ModelRequestTelemetry({
          provider: options.provider,
          model: assembly.modelName,
          transport: assembly.adapter.agentRuntimeCapabilities.transport,
          runId: options.runId,
          threadId: assembly.threadId,
        })
        activeModelTelemetry = modelTelemetry
        const stream = await assembly.runner.run(
          assembly.agent,
          nextInput,
          {
            stream: true,
            context: new RunContext(assembly.context),
            session: assembly.session,
            sessionInputCallback: combineSessionInput,
            ...(assembly.sandbox ? { sandbox: assembly.sandbox } : {}),
            maxTurns: options.runtimeConfig.maxTurns,
            signal,
            callModelInputFilter: async ({ modelData }) => {
              const steeringItems = await steering.consumePending(options.runId)
              return assembly.modelInput.filter(modelData, steeringItems)
            },
          },
        )
        await checkpoints.persist(options.runId, stream.state, assembly)
        for await (const event of stream) {
          modelTelemetry.observe(event)
          await transcriptProjector.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
          if (event.type === 'run_item_stream_event' && ['tool_output', 'tool_approval_requested'].includes(event.name)) {
            await checkpoints.persist(options.runId, stream.state, assembly)
          }
        }
        await stream.completed
        if (stream.error) {
          modelTelemetry.fail(stream.error)
          throw stream.error
        }
        await transcriptProjector.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
        if (projection.reasoningItemId) {
          itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
        }
        await this.updateUsage(options.runId, stream.rawResponses)

        const interruptions = stream.interruptions
        if (interruptions.length) {
          await checkpoints.persist(options.runId, stream.state, assembly)
          await approvalPersistence.persist(options, interruptions, eventSink, itemSink)
          await eventSink.flush()
          await itemSink.flush()
          outcome = 'waiting_approval'
          return outcome
        }

        assembly.discardPendingSessionAssistantMessage()
        const runAfterTools = store.getRun(options.runId)
        if (runAfterTools.state.clarification && !runAfterTools.state.clarification.selectedOptionId) {
          eventSink.emit('clarification.required', runAfterTools.state.clarification.question, {
            clarification: runAfterTools.state.clarification,
          })
          itemSink.appendResult('clarification_needed', {
            decisionId: runAfterTools.state.clarification.clarificationId,
            clarification: runAfterTools.state.clarification,
            message: runAfterTools.state.clarification.question,
          })
          await checkpoints.persist(options.runId, stream.state, assembly)
          await store.saveRunCheckpoint(options.runId, {
            pendingToolCallIds: [],
            recoveryStatus: 'clean',
          })
          await eventSink.flush()
          await itemSink.flush()
          await store.completeRun(options.runId, 'clarification_needed')
          outcome = 'clarification_needed'
          return outcome
        }

        const agentWorkflow = store.getRun(options.runId).state.agentWorkflow
        if (agentWorkflow && agentWorkflow.status !== 'completed') {
          throw new Error(`智能体工作流尚未完成，当前状态为 ${agentWorkflow.status}。必须完成或显式调整剩余步骤后再交付最终回答。`)
        }
        const incompleteTodos = store.getRun(options.runId).state.todos
          .filter(todo => todo.status === 'pending' || todo.status === 'running')
        if (incompleteTodos.length) {
          throw new Error(`运行仍有未完成 Todo：${incompleteTodos.map(todo => todo.title).join('、')}。请先更新为完成、失败或受阻状态。`)
        }

        const finalOutput = requireFinalText(stream.finalOutput)
        const delivery = platformDelivery(finalOutput, runAfterTools.state)
        const terminalDecision = options.executionMode === 'plan'
          ? { accepted: true as const }
          : evaluateTerminalDelivery({
              delivery,
            })
        if (!terminalDecision.accepted) {
          if (terminalRepairAttempts >= 2) {
            throw new Error(`Agent 最终交付缺少可核验证据：${terminalDecision.reason}`)
          }
          terminalRepairAttempts += 1
          eventSink.emit('warning.raised', '最终回答缺少可核验证据，正在继续执行。', {
            code: terminalDecision.code,
            repairAttempt: terminalRepairAttempts,
          })
          await checkpoints.persist(options.runId, stream.state, assembly)
          await eventSink.flush()
          await itemSink.flush()
          nextInput = [{
            type: 'message',
            role: 'user',
            content: terminalDecision.repairInstruction,
          }]
          continue
        }

        await assertArtifactDeliveryIsVisible(store, runAfterTools.id, delivery.artifactIds)
        const lastAgentName = stream.lastAgent?.name
        if (lastAgentName && assembly.handoffAgentNames.has(lastAgentName)) {
          await assembly.completeHandoff(lastAgentName, delivery.summary)
        }
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        const persisted = await transcriptProjector.appendAssistantMessageTranscript(
          assembly,
          finalOutput,
          itemId,
        )
        itemSink.completeItem(itemId, {
          body: finalOutput,
          metadata: {
            transcriptEntryId: persisted.entryId,
            deliverySummary: delivery.summary,
            artifactIds: delivery.artifactIds,
            warnings: delivery.warnings,
          },
        })
        projection.assistantItemId = null
        await checkpoints.persist(options.runId, stream.state, assembly)
        await store.saveRunCheckpoint(options.runId, {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
        await eventSink.flush()
        await itemSink.flush()

        if (await steering.tryClose(options.runId)) {
          outcome = 'completed'
          return outcome
        }
        // 新消息在最终回答生成期间到达。沿用同一 SDK Session 开启下一轮，
        // 消息会在下一次模型调用前由 callModelInputFilter 原子消费。
        nextInput = []
      }
    } catch (error) {
      activeModelTelemetry?.fail(error)
      const activeHandoff = assembly.coordinator.activeHandoffAgent()
      if (activeHandoff) {
        await assembly.failHandoff(activeHandoff, errorMessage(error)).catch(handoffError => {
          logger.warn({ error: errorLogPayload(handoffError) }, 'handoff failure state update failed')
        })
      }
      if (activeProjection) {
        transcriptProjector.failPendingSubAgentItems(activeProjection, itemSink, errorMessage(error))
      }
      throw error
    } finally {
      await assembly.sdkIntegration.close().catch(error => {
        logger.warn({ error: errorLogPayload(error) }, 'sdk mcp close failed')
      })
    }
  }

  private async updateUsage(
    runId: string,
    responses: Array<{ usage: ModelUsageLike }>,
  ): Promise<void> {
    if (!responses.length) return
    const usage = aggregateModelUsage(responses)
    const run = this.dependencies.store.getRun(runId)
    await this.dependencies.store.updateRunState(runId, {
      runtimeStats: mergeModelUsageStats(run.state.runtimeStats, usage),
    })
  }
}

function requireFinalText(finalOutput: unknown): string {
  if (typeof finalOutput !== 'string' || !finalOutput.trim()) {
    throw new Error('Agent 最终输出不是非空文本')
  }
  return finalOutput.trim()
}

function platformDelivery(markdown: string, state: AgentState): SupervisorDelivery {
  return {
    markdown,
    summary: summarizeMarkdown(markdown),
    artifactIds: [...new Set(state.artifacts
      .filter(artifact => !artifact.isIntermediate)
      .map(artifact => artifact.artifactId))],
    warnings: [...state.warnings],
  }
}

function summarizeMarkdown(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[#>*_`[\]()!-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!plain) return '任务已完成。'
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain
}
