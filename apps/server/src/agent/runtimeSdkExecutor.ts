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
import type { AgentState, RunGoal, RunGoalVerdict, SupervisorDelivery } from '../schemas/types.js'
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
import { goalTokenUsage, type GoalJudgePort } from './goalJudge.js'
import { buildInitialAgentInput } from './multimodalInput.js'

export type RuntimeSdkOutcome = 'completed' | 'waiting_approval' | 'clarification_needed'

interface RuntimeSdkExecutorDependencies {
  store: AgentRuntimeStore
  checkpoints: AgentsCheckpointService
  transcriptProjector: RuntimeTranscriptProjector
  approvalPersistence: RuntimeApprovalPersistence
  steering: RunSteeringController
  goalJudge: GoalJudgePort
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
      goalJudge,
      steering,
      store,
      transcriptProjector,
    } = this.dependencies
    let outcome: RuntimeSdkOutcome | null = null
    let nextInput: RunState<
      AgentsExecutionContext,
      Agent<AgentsExecutionContext>
    > | AgentInputItem[] | string = resumeState ?? await buildInitialAgentInput(
      store,
      options.runId,
      options.query,
      assembly.modelCapabilities,
    )
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
          itemSink.completeItem(projection.reasoningItemId)
          projection.reasoningItemId = null
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
          if (runAfterTools.state.goal && ['active', 'evaluating'].includes(runAfterTools.state.goal.status)) {
            const transferredAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...runAfterTools.state.goal,
                status: 'cancelled',
                failureReason: '等待用户澄清，Goal 将由后续运行继承。',
                updatedAt: transferredAt,
                completedAt: transferredAt,
              },
            })
          }
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
        if (runAfterTools.state.runProfile === 'geospatial_compose' && !agentWorkflow) {
          throw new Error('地理分析 Compose 运行必须提交并完成 discover、validate、analyze、verify 阶段工作流后才能交付。')
        }
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
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        const persisted = await transcriptProjector.appendAssistantMessageTranscript(
          assembly,
          finalOutput,
          itemId,
        )
        projection.assistantItemId = null

        let goalMetadata: Record<string, unknown> = {}
        const persistedGoal = store.getRun(options.runId).state.goal
        if (persistedGoal && (persistedGoal.status === 'active' || persistedGoal.status === 'evaluating')) {
          const tokenUsageBeforeJudge = goalTokenUsage(store.getRun(options.runId).state.runtimeStats)
          const beforeJudgeBoundary = goalBoundaryReason(persistedGoal, tokenUsageBeforeJudge, 'before_judge')
          if (beforeJudgeBoundary) {
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...persistedGoal,
                status: 'exhausted',
                failureReason: beforeJudgeBoundary,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', beforeJudgeBoundary, {
              goalId: persistedGoal.goalId,
              status: 'exhausted',
              tokenUsage: tokenUsageBeforeJudge,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: { transcriptEntryId: persisted.entryId, goalStatus: 'exhausted' },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(beforeJudgeBoundary)
          }

          const evaluatingAt = new Date().toISOString()
          const evaluatingGoal: RunGoal = {
            ...persistedGoal,
            status: 'evaluating',
            failureReason: null,
            updatedAt: evaluatingAt,
          }
          await store.updateRunState(options.runId, { goal: evaluatingGoal })
          eventSink.emit('goal.updated', `正在执行 Goal 第 ${evaluatingGoal.recheckCount + 1} 次独立验收。`, {
            goalId: evaluatingGoal.goalId,
            status: 'evaluating',
            attempt: evaluatingGoal.recheckCount + 1,
          })
          await eventSink.flush()
          await itemSink.flush()

          const verdict = await goalJudge.evaluate({
            runId: options.runId,
            threadId: assembly.threadId,
            provider: options.provider,
            ...(options.modelName !== undefined ? { model: options.modelName } : {}),
            goal: evaluatingGoal,
            signal,
          })
          const latestGoal = store.getRun(options.runId).state.goal
          if (!latestGoal || latestGoal.goalId !== evaluatingGoal.goalId) {
            throw new Error('Goal 验收期间持久化状态发生了不一致变化。')
          }
          const afterJudgeBoundary = goalBoundaryReason(latestGoal, verdict.tokenUsage, 'after_judge')
          if (afterJudgeBoundary) {
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...latestGoal,
                status: 'exhausted',
                lastVerdict: verdict,
                failureReason: afterJudgeBoundary,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', afterJudgeBoundary, {
              goalId: latestGoal.goalId,
              status: 'exhausted',
              verdict,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: { transcriptEntryId: persisted.entryId, goalStatus: 'exhausted', goalVerdict: verdict },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(afterJudgeBoundary)
          }

          if (verdict.status === 'impossible') {
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...latestGoal,
                status: 'impossible',
                lastVerdict: verdict,
                failureReason: verdict.reason,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', `Goal 被独立验收器判定为不可达：${verdict.reason}`, {
              goalId: latestGoal.goalId,
              status: 'impossible',
              verdict,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: { transcriptEntryId: persisted.entryId, goalStatus: 'impossible', goalVerdict: verdict },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(`Goal 不可达：${verdict.reason}`)
          }

          if (verdict.status === 'incomplete') {
            const recheckBoundary = goalRecheckBoundaryReason(latestGoal, verdict.tokenUsage)
            if (recheckBoundary) {
              const completedAt = new Date().toISOString()
              await store.updateRunState(options.runId, {
                goal: {
                  ...latestGoal,
                  status: 'exhausted',
                  lastVerdict: verdict,
                  failureReason: recheckBoundary,
                  updatedAt: completedAt,
                  completedAt,
                },
              })
              eventSink.emit('goal.updated', recheckBoundary, {
                goalId: latestGoal.goalId,
                status: 'exhausted',
                verdict,
              })
              itemSink.completeItem(itemId, {
                body: finalOutput,
                metadata: { transcriptEntryId: persisted.entryId, goalStatus: 'exhausted', goalVerdict: verdict },
              })
              await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
              await eventSink.flush()
              await itemSink.flush()
              throw new Error(recheckBoundary)
            }

            const recheckAt = new Date().toISOString()
            const recheckCount = latestGoal.recheckCount + 1
            await store.updateRunState(options.runId, {
              goal: {
                ...latestGoal,
                status: 'active',
                recheckCount,
                lastVerdict: verdict,
                failureReason: null,
                updatedAt: recheckAt,
              },
            })
            await store.appendTranscript({
              threadId: assembly.threadId,
              runId: options.runId,
              turnId: assembly.turnId,
              kind: 'checkpoint',
              payload: {
                type: 'goal_recheck',
                goalId: latestGoal.goalId,
                recheckCount,
                verdict,
              },
            })
            eventSink.emit('goal.updated', `Goal 尚未满足，正在边界内继续执行：${verdict.reason}`, {
              goalId: latestGoal.goalId,
              status: 'active',
              recheckCount,
              verdict,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: { transcriptEntryId: persisted.entryId, goalStatus: 'incomplete', goalVerdict: verdict },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            nextInput = [{
              type: 'message',
              role: 'user',
              content: goalRecheckInstruction(latestGoal, verdict),
            }]
            continue
          }

          const completedAt = new Date().toISOString()
          await store.updateRunState(options.runId, {
            goal: {
              ...latestGoal,
              status: 'satisfied',
              lastVerdict: verdict,
              failureReason: null,
              updatedAt: completedAt,
              completedAt,
            },
          })
          eventSink.emit('goal.updated', `Goal 已通过第 ${verdict.attempt} 次独立验收。`, {
            goalId: latestGoal.goalId,
            status: 'satisfied',
            verdict,
          })
          goalMetadata = { goalStatus: 'satisfied', goalVerdict: verdict }
        }

        const lastAgentName = stream.lastAgent?.name
        if (lastAgentName && assembly.handoffAgentNames.has(lastAgentName)) {
          await assembly.completeHandoff(lastAgentName, delivery.summary)
        }
        itemSink.completeItem(itemId, {
          body: finalOutput,
          metadata: {
            transcriptEntryId: persisted.entryId,
            deliverySummary: delivery.summary,
            artifactIds: delivery.artifactIds,
            warnings: delivery.warnings,
            ...goalMetadata,
          },
        })
        await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
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

function goalBoundaryReason(
  goal: RunGoal,
  tokenUsage: number,
  stage: 'before_judge' | 'after_judge',
): string | null {
  if (goal.deadlineAt && Date.now() >= Date.parse(goal.deadlineAt)) {
    return `Goal 已超过截止时间 ${goal.deadlineAt}，停止验收与续跑。`
  }
  if (goal.maxTokenBudget === null) return null
  const exceeded = stage === 'before_judge'
    ? tokenUsage >= goal.maxTokenBudget
    : tokenUsage > goal.maxTokenBudget
  return exceeded
    ? `Goal 词元预算已用尽：${tokenUsage}/${goal.maxTokenBudget}。`
    : null
}

function goalRecheckBoundaryReason(goal: RunGoal, tokenUsage: number): string | null {
  if (goal.recheckCount >= goal.maxRechecks) {
    return `Goal 在 ${goal.maxRechecks} 次最大复验续跑后仍未满足。`
  }
  return goalBoundaryReason(goal, tokenUsage, 'before_judge')
}

function goalRecheckInstruction(goal: RunGoal, verdict: RunGoalVerdict): string {
  return [
    '独立 Goal 验收器判定当前证据不完整，必须继续真实执行，不得只改写最终结论。',
    `Goal：${goal.condition}`,
    `判定原因：${verdict.reason}`,
    `缺失验收项：${verdict.missingCriteria.join('；')}`,
    '请在现有 SDK Session 中使用已授权工具、valueRef 与工作流证据补齐缺失项；如果工具或数据真实阻断，保留失败证据并如实说明。',
  ].join('\n')
}

async function persistCleanCheckpoint(
  store: AgentRuntimeStore,
  checkpoints: AgentsCheckpointService,
  runId: string,
  state: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>,
  assembly: RuntimeAssembly,
): Promise<void> {
  await checkpoints.persist(runId, state, assembly)
  await store.saveRunCheckpoint(runId, {
    pendingToolCallIds: [],
    recoveryStatus: 'clean',
  })
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
