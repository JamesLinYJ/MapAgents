// +-------------------------------------------------------------------------
//
//   地理智能平台 - 后台运行任务管理器
//
//   文件:       runTaskManager.ts
//
// --------------------------------------------------------------------------

import type { AnalysisRun } from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import type { OpenAIAgentsRuntime, RunOptions } from './runtime.js'

export interface RunTaskCompletionTarget {
  onComplete?: (runId: string) => Promise<void> | void
}

// RunTaskManager 是所有“后台 run”的唯一启动入口。WS、未来的定时任务和
// workflow 调度器都只创建 run 事实，再委托这里执行，避免散落 fire-and-forget。
export class RunTaskManager {
  private readonly activeTasks = new Map<string, Promise<AnalysisRun>>()

  constructor(
    private readonly runtime: OpenAIAgentsRuntime,
    private readonly store: PostgresPlatformStore,
  ) {}

  start(options: RunOptions, target: RunTaskCompletionTarget = {}): Promise<AnalysisRun> {
    const existing = this.activeTasks.get(options.runId)
    if (existing) throw new Error(`运行 '${options.runId}' 已在后台执行中`)
    const task = this.runtime.run(options)
      .then(async run => {
        await this.sendSnapshotIfConnected(options.runId, target)
        return run
      })
      .catch(async error => {
        logger.error({ error: errorLogPayload(error), runId: options.runId }, 'background run task failed')
        await this.sendSnapshotIfConnected(options.runId, target)
        return this.store.getRun(options.runId)
      })
      .finally(() => {
        this.activeTasks.delete(options.runId)
      })
    this.activeTasks.set(options.runId, task)
    return task
  }

  startDetached(options: RunOptions, target: RunTaskCompletionTarget = {}): void {
    this.start(options, target).catch(error => {
      // start() already owns run failure persistence and snapshot emission.
      // This catch only protects the Node event loop from an unhandled rejection
      // if the task creation path itself fails synchronously.
      logger.error({ error: errorLogPayload(error), runId: options.runId }, 'background run task launch failed')
    })
  }

  cancel(runId: string): Promise<AnalysisRun> {
    return this.runtime.cancel(runId)
  }

  activeRunIds(): string[] {
    return [...this.activeTasks.keys()]
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.activeTasks.values())
  }

  private async sendSnapshotIfConnected(runId: string, target: RunTaskCompletionTarget): Promise<void> {
    if (!target.onComplete) return
    try {
      await target.onComplete(runId)
    } catch (error) {
      logger.warn({ error: errorLogPayload(error), runId }, 'background run completion callback failed')
    }
  }
}
