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
import PQueue from 'p-queue'

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
    let terminalRepairObjectiveRevision: number | null = null
    let pendingInputLeaseId: string | null = null
    const inputCheckpointQueue = new PQueue({ concurrency: 1 })
    const serializeInputCheckpoint = async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await inputCheckpointQueue.add(async () => ({ value: await work() }))
      if (!result) throw new Error(`运行 '${options.runId}' 的输入 checkpoint 队列未返回结果`)
      return result.value
    }

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
        const streamStateReady = deferred<RunState<
          AgentsExecutionContext,
          Agent<AgentsExecutionContext>
        >>()
        const checkpointCurrentState = async (
          state: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>,
        ): Promise<void> => {
          const leaseId = pendingInputLeaseId
          const commit = await checkpoints.persist(options.runId, state, assembly, leaseId)
          // Durable checkpoint 事务已把 state 中的 function_call_result 与
          // pending tool ledger 绑定提交；再同步进程内快照，不发起二次 DB 写。
          await assembly.coordinator.acceptCheckpointedToolCalls(commit.terminalToolCallIds)
          if (leaseId) {
            pendingInputLeaseId = null
            await steering.recordCheckpointAcknowledgements(options.runId, commit.acknowledgedInputs)
          }
        }
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
            callModelInputFilter: ({ modelData }) => serializeInputCheckpoint(async () => {
              // 首次模型请求也必须先有一个可恢复 baseline。后续请求则用
              // 当前完整 state 原子 ack 上一批输入；因此工具结果恢复不依赖
              // 滞后的 stream event 消费，也不会出现 lease 已发出但无 hash。
              await checkpointCurrentState(await streamStateReady.promise)
              const delivery = await steering.consumePendingWithRevision(options.runId)
              if (delivery.leaseId) {
                appendRunInputsToSdkState(
                  await streamStateReady.promise,
                  options.runId,
                  delivery.items,
                )
                assembly.session.retainRunInputs(delivery.items)
                pendingInputLeaseId = delivery.leaseId
              }
              assembly.coordinator.bindModelInputObjectiveRevision(delivery.objectiveRevision)
              return assembly.modelInput.filter(modelData, delivery.items)
            }),
          },
        )
        streamStateReady.resolve(stream.state)
        for await (const event of stream) {
          modelTelemetry.observe(event)
          await transcriptProjector.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
        }
        await stream.completed
        if (stream.error) {
          modelTelemetry.fail(stream.error)
          throw stream.error
        }
        if (stream.cancelled || signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`运行 '${options.runId}' 的模型流在完整响应前被取消`)
        }
        await serializeInputCheckpoint(() => checkpointCurrentState(stream.state))
        await transcriptProjector.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
        if (projection.reasoningItemId) {
          itemSink.completeItem(projection.reasoningItemId)
          projection.reasoningItemId = null
        }
        await this.updateUsage(options.runId, stream.rawResponses)

        const interruptions = stream.interruptions
        if (interruptions.length) {
          await approvalPersistence.persist(options, interruptions, eventSink, itemSink)
          await eventSink.flush()
          await itemSink.flush()
          outcome = 'waiting_approval'
          return outcome
        }

        assembly.discardPendingSessionAssistantMessage()
        const candidateFinalOutput = optionalFinalText(stream.finalOutput)
        const candidateSnapshot = await steering.modelInputRevisionSnapshot(options.runId)
        const candidateObjectiveRevision = candidateSnapshot.objectiveRevision
        if (terminalRepairObjectiveRevision !== candidateObjectiveRevision) {
          terminalRepairObjectiveRevision = candidateObjectiveRevision
          terminalRepairAttempts = 0
        }
        const candidateState = candidateSnapshot.state
        if (!candidateState) {
          await supersedeAssistantCandidate({
            store,
            checkpoints,
            assembly,
            streamState: stream.state,
            eventSink,
            itemSink,
            projection,
            runId: options.runId,
            objectiveRevision: candidateObjectiveRevision,
            ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
          })
          nextInput = []
          continue
        }
        const supersedeProjectionCandidate = () => supersedeAssistantCandidate({
          store,
          checkpoints,
          assembly,
          streamState: stream.state,
          eventSink,
          itemSink,
          projection,
          runId: options.runId,
          objectiveRevision: candidateObjectiveRevision,
          ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
        })

        if (candidateState.clarification && !candidateState.clarification.selectedOptionId) {
          if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
            await supersedeAssistantCandidate({
              store,
              checkpoints,
              assembly,
              streamState: stream.state,
              eventSink,
              itemSink,
              projection,
              runId: options.runId,
              objectiveRevision: candidateObjectiveRevision,
              ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
            })
            nextInput = []
            continue
          }
          if (candidateState.goal && ['active', 'evaluating'].includes(candidateState.goal.status)) {
            const transferredAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...candidateState.goal,
                status: 'cancelled',
                failureReason: '等待用户澄清，Goal 将由后续运行继承。',
                updatedAt: transferredAt,
                completedAt: transferredAt,
              },
            })
          }
          eventSink.emit('clarification.required', candidateState.clarification.question, {
            clarification: candidateState.clarification,
          })
          itemSink.appendResult('clarification_needed', {
            decisionId: candidateState.clarification.clarificationId,
            clarification: candidateState.clarification,
            message: candidateState.clarification.question,
            objectiveRevision: candidateObjectiveRevision,
          })
          await eventSink.flush()
          await itemSink.flush()
          await store.completeRun(options.runId, 'clarification_needed')
          outcome = 'clarification_needed'
          return outcome
        }

        const agentWorkflow = candidateState.agentWorkflow
        if (candidateState.runProfile === 'geospatial_compose' && !agentWorkflow) {
          if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
            await supersedeProjectionCandidate()
            nextInput = []
            continue
          }
          throw new Error('地理分析 Compose 运行必须提交并完成 discover、validate、analyze、verify 阶段工作流后才能交付。')
        }
        if (agentWorkflow && (
          agentWorkflow.status !== 'completed'
          || agentWorkflow.objectiveRevision !== candidateObjectiveRevision
        )) {
          if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
            await supersedeProjectionCandidate()
            nextInput = []
            continue
          }
          throw new Error(`智能体工作流尚未完成，当前状态为 ${agentWorkflow.status}。必须完成或显式调整剩余步骤后再交付最终回答。`)
        }
        const incompleteTodos = candidateState.todos
          .filter(todo => todo.status === 'pending' || todo.status === 'running')
        if (incompleteTodos.length) {
          if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
            await supersedeProjectionCandidate()
            nextInput = []
            continue
          }
          throw new Error(`运行仍有未完成 Todo：${incompleteTodos.map(todo => todo.title).join('、')}。请先更新为完成、失败或受阻状态。`)
        }

        const finalOutput = candidateFinalOutput ?? requireFinalText(stream.finalOutput)
        const delivery = platformDelivery(finalOutput, candidateState)
        const terminalDecision = options.executionMode === 'plan'
          ? { accepted: true as const }
          : evaluateTerminalDelivery({
              delivery,
            })
        if (!terminalDecision.accepted) {
          if (terminalRepairAttempts >= 2) {
            if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
              await supersedeProjectionCandidate()
              nextInput = []
              continue
            }
            throw new Error(`Agent 最终交付缺少可核验证据：${terminalDecision.reason}`)
          }
          terminalRepairAttempts += 1
          eventSink.emit('warning.raised', '最终回答缺少可核验证据，正在继续执行。', {
            code: terminalDecision.code,
            repairAttempt: terminalRepairAttempts,
          })
          await eventSink.flush()
          await itemSink.flush()
          nextInput = [{
            type: 'message',
            role: 'user',
            content: terminalDecision.repairInstruction,
          }]
          continue
        }

        await assertArtifactDeliveryIsVisible(store, options.runId, delivery.artifactIds)
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        const persisted = await transcriptProjector.appendAssistantMessageTranscript(
          assembly,
          finalOutput,
          itemId,
          candidateObjectiveRevision,
        )
        projection.assistantItemId = null
        const supersedeCurrentCandidate = () => supersedeAssistantCandidate({
          store,
          checkpoints,
          assembly,
          streamState: stream.state,
          eventSink,
          itemSink,
          projection,
          runId: options.runId,
          objectiveRevision: candidateObjectiveRevision,
          itemId,
          transcriptEntryId: persisted.entryId,
          body: finalOutput,
        })

        let goalMetadata: Record<string, unknown> = {}
        let satisfiedGoal: { goal: RunGoal; verdict: RunGoalVerdict } | null = null
        const persistedGoal = candidateState.goal
        if (persistedGoal && (persistedGoal.status === 'active' || persistedGoal.status === 'evaluating')) {
          const tokenUsageBeforeJudge = goalTokenUsage(candidateState.runtimeStats)
          const beforeJudgeBoundary = goalBoundaryReason(persistedGoal, tokenUsageBeforeJudge, 'before_judge')
          if (beforeJudgeBoundary) {
            if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
              await supersedeAssistantCandidate({
                store,
                checkpoints,
                assembly,
                streamState: stream.state,
                eventSink,
                itemSink,
                projection,
                runId: options.runId,
                objectiveRevision: candidateObjectiveRevision,
                itemId,
                transcriptEntryId: persisted.entryId,
                body: finalOutput,
              })
              nextInput = []
              continue
            }
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
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'exhausted',
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(beforeJudgeBoundary)
          }

          const evaluatingAt = new Date().toISOString()
          const evaluatingGoal: RunGoal = {
            ...persistedGoal,
            objectiveRevision: candidateObjectiveRevision,
            status: 'evaluating',
            failureReason: null,
            updatedAt: evaluatingAt,
          }
          const evaluationStarted = await steering.commitRevision(
            options.runId,
            candidateObjectiveRevision,
            async state => {
              if (state.goal?.goalId !== evaluatingGoal.goalId) {
                throw new Error('Goal 验收前持久化状态发生了不一致变化。')
              }
              await store.updateRunState(options.runId, { goal: evaluatingGoal })
              eventSink.emit('goal.updated', `正在执行 Goal 第 ${evaluatingGoal.recheckCount + 1} 次独立验收。`, {
                goalId: evaluatingGoal.goalId,
                status: 'evaluating',
                attempt: evaluatingGoal.recheckCount + 1,
                objectiveRevision: candidateObjectiveRevision,
              })
              await eventSink.flush()
              await itemSink.flush()
            },
          )
          if (!evaluationStarted) {
            await supersedeAssistantCandidate({
              store,
              checkpoints,
              assembly,
              streamState: stream.state,
              eventSink,
              itemSink,
              projection,
              runId: options.runId,
              objectiveRevision: candidateObjectiveRevision,
              itemId,
              transcriptEntryId: persisted.entryId,
              body: finalOutput,
            })
            nextInput = []
            continue
          }

          const verdict = await goalJudge.evaluate({
            runId: options.runId,
            threadId: assembly.threadId,
            provider: options.provider,
            ...(options.modelName !== undefined ? { model: options.modelName } : {}),
            goal: evaluatingGoal,
            signal,
          })
          const latestGoal = evaluatingGoal
          const afterJudgeBoundary = goalBoundaryReason(latestGoal, verdict.tokenUsage, 'after_judge')
          if (afterJudgeBoundary) {
            if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
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
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'exhausted',
                goalVerdict: verdict,
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(afterJudgeBoundary)
          }

          if (verdict.status === 'impossible') {
            if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
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
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'impossible',
                goalVerdict: verdict,
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(`Goal 不可达：${verdict.reason}`)
          }

          if (verdict.status === 'incomplete') {
            const recheckBoundary = goalRecheckBoundaryReason(latestGoal, verdict.tokenUsage)
            if (recheckBoundary) {
              if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
                await supersedeCurrentCandidate()
                nextInput = []
                continue
              }
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
                objectiveRevision: candidateObjectiveRevision,
              })
              itemSink.completeItem(itemId, {
                body: finalOutput,
                metadata: {
                  transcriptEntryId: persisted.entryId,
                  goalStatus: 'exhausted',
                  goalVerdict: verdict,
                  objectiveRevision: candidateObjectiveRevision,
                },
              })
              await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
              await eventSink.flush()
              await itemSink.flush()
              throw new Error(recheckBoundary)
            }

            const recheckAt = new Date().toISOString()
            const recheckCount = latestGoal.recheckCount + 1
            const recheckCommitted = await steering.commitRevision(
              options.runId,
              candidateObjectiveRevision,
              async state => {
                if (
                  state.goal?.goalId !== latestGoal.goalId
                  || state.goal.objectiveRevision !== candidateObjectiveRevision
                ) {
                  throw new Error('Goal 复验提交时持久化状态发生了不一致变化。')
                }
                await store.updateRunState(options.runId, {
                  goal: {
                    ...state.goal,
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
                    objectiveRevision: candidateObjectiveRevision,
                    recheckCount,
                    verdict,
                  },
                })
                eventSink.emit('goal.updated', `Goal 尚未满足，正在边界内继续执行：${verdict.reason}`, {
                  goalId: latestGoal.goalId,
                  status: 'active',
                  objectiveRevision: candidateObjectiveRevision,
                  recheckCount,
                  verdict,
                })
                itemSink.completeItem(itemId, {
                  body: finalOutput,
                  metadata: {
                    transcriptEntryId: persisted.entryId,
                    goalStatus: 'incomplete',
                    goalVerdict: verdict,
                    objectiveRevision: candidateObjectiveRevision,
                  },
                })
                await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
                await eventSink.flush()
                await itemSink.flush()
              },
            )
            if (!recheckCommitted) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
            nextInput = [{
              type: 'message',
              role: 'user',
              content: goalRecheckInstruction(latestGoal, verdict),
            }]
            continue
          }

          satisfiedGoal = { goal: latestGoal, verdict }
        }

        if (!await steering.tryClaimTerminal(options.runId, candidateObjectiveRevision)) {
          await supersedeCurrentCandidate()
          nextInput = []
          continue
        }
        if (satisfiedGoal) {
          const completedAt = new Date().toISOString()
          await store.updateRunState(options.runId, {
            goal: {
              ...satisfiedGoal.goal,
              status: 'satisfied',
              lastVerdict: satisfiedGoal.verdict,
              failureReason: null,
              updatedAt: completedAt,
              completedAt,
            },
          })
          eventSink.emit('goal.updated', `Goal 已通过第 ${satisfiedGoal.verdict.attempt} 次独立验收。`, {
            goalId: satisfiedGoal.goal.goalId,
            status: 'satisfied',
            objectiveRevision: candidateObjectiveRevision,
            verdict: satisfiedGoal.verdict,
          })
          goalMetadata = {
            goalStatus: 'satisfied',
            goalVerdict: satisfiedGoal.verdict,
            objectiveRevision: candidateObjectiveRevision,
          }
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
            objectiveRevision: candidateObjectiveRevision,
            ...goalMetadata,
          },
        })
        await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
        await eventSink.flush()
        await itemSink.flush()

        outcome = 'completed'
        return outcome
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

// callModelInputFilter 新增的 item 只影响当次 HTTP 请求，Agents SDK 不会把它
// 写入 RunState。lease 后必须同步纳入 _originalInput，下一工具回合与 v5
// checkpoint 才都能证明模型看到过同一输入。platform marker 提供结构化幂等键，
// 不按文本猜测，也不会误去重用户重复发送的相同内容。
function appendRunInputsToSdkState(
  state: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>,
  runId: string,
  items: readonly AgentInputItem[],
): void {
  const original = typeof state._originalInput === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: state._originalInput }]
    : [...state._originalInput]
  const existing = new Map<number, AgentInputItem>()
  for (const item of original) {
    const marker = runInputMarker(item)
    if (!marker) continue
    if (marker.runId !== runId) {
      throw new Error(`RunState 含有其它运行 '${marker.runId}' 的 input marker`)
    }
    existing.set(marker.inputSequence, item)
  }
  for (const item of items) {
    const marker = runInputMarker(item)
    if (!marker || marker.runId !== runId) {
      throw new Error(`运行 '${runId}' 的 leased input 缺少可序列化 marker`)
    }
    const previous = existing.get(marker.inputSequence)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(item)) {
        throw new Error(`运行 '${runId}' 的 input sequence ${marker.inputSequence} 内容不一致`)
      }
      continue
    }
    original.push(structuredClone(item))
    existing.set(marker.inputSequence, item)
  }
  state._originalInput = original
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function runInputMarker(item: AgentInputItem): {
  runId: string
  inputSequence: number
} | null {
  if (!('providerData' in item) || !item.providerData) return null
  const marker = item.providerData.geoAgentRunInput
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const runId = Reflect.get(marker, 'runId')
  const inputSequence = Reflect.get(marker, 'inputSequence')
  return typeof runId === 'string'
    && Number.isInteger(inputSequence)
    && (inputSequence as number) > 0
    ? { runId, inputSequence: inputSequence as number }
    : null
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
  // stream.completed 后的统一 checkpoint 已落盘相同 RunState。这些
  // terminal/supersede 分支只验证 ledger，不重写同一 blob/DB，也不得
  // 用 pending=[] 覆盖尚未进入 SDK state 的未知副作用。
  void checkpoints
  void state
  void assembly
  const checkpoint = await store.getRunCheckpoint(runId)
  if (checkpoint.pendingToolCallIds.length) {
    throw new Error(
      `运行 '${runId}' 的 SDK checkpoint 尚未包含工具结果：`
      + checkpoint.pendingToolCallIds.join('、'),
    )
  }
}

async function supersedeAssistantCandidate(input: {
  store: AgentRuntimeStore
  checkpoints: AgentsCheckpointService
  assembly: RuntimeAssembly
  streamState: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>
  eventSink: RunEventSink
  itemSink: ItemSink
  projection: StreamProjectionState
  runId: string
  objectiveRevision: number
  itemId?: string
  transcriptEntryId?: string
  body?: string
}): Promise<void> {
  const matchingCompleted = input.body === undefined
    ? undefined
    : [...input.projection.completedAssistantItems]
        .reverse()
        .find(item => item.text.trim() === input.body?.trim())
  const itemId = input.itemId
    ?? input.projection.assistantItemId
    ?? matchingCompleted?.itemId
    ?? (input.body === undefined
      ? null
      : input.itemSink.startItem('message', { role: 'assistant' }).itemId)
  if (itemId) {
    input.itemSink.completeItem(itemId, {
      ...(input.body === undefined ? {} : { body: input.body }),
      metadata: {
        ...(input.transcriptEntryId === undefined
          ? {}
          : { transcriptEntryId: input.transcriptEntryId }),
        objectiveRevision: input.objectiveRevision,
        supersededByNewObjectiveRevision: true,
      },
    })
    if (input.projection.assistantItemId === itemId) input.projection.assistantItemId = null
    if (input.body && input.projection.lastAssistantText.trim() === input.body.trim()) {
      input.projection.lastAssistantText = ''
    }
  }
  await persistCleanCheckpoint(
    input.store,
    input.checkpoints,
    input.runId,
    input.streamState,
    input.assembly,
  )
  await input.eventSink.flush()
  await input.itemSink.flush()
}

function optionalFinalText(finalOutput: unknown): string | null {
  return typeof finalOutput === 'string' && finalOutput.trim()
    ? finalOutput.trim()
    : null
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
