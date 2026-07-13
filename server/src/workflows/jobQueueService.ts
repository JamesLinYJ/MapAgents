// +-------------------------------------------------------------------------
//
//   地理智能平台 - pg-boss 任务队列适配层
//
//   文件:       jobQueueService.ts
//
// --------------------------------------------------------------------------

import { PgBoss, type Job } from 'pg-boss'
import { z } from 'zod'
import type { Env } from '../framework/env.js'
import { errorLogPayload, logger } from '../observability/logger.js'

export const WORKFLOW_QUEUE_NAME = 'geoforge.workflow.run'

export const workflowJobPayloadSchema = z.object({
  scheduledTaskId: z.string().min(1).nullable().default(null),
  workflowRunId: z.string().min(1).nullable().default(null),
  workflowId: z.string().min(1),
  workspaceId: z.string().min(1),
  triggeredByUserId: z.string().min(1),
  triggerKind: z.enum(['manual', 'schedule']),
  dispatchId: z.string().min(1),
  prompt: z.string().default(''),
  parameters: z.record(z.string(), z.unknown()).prefault({}),
})

export type WorkflowJobPayload = z.infer<typeof workflowJobPayloadSchema>

export type WorkflowJobHandler = (payload: WorkflowJobPayload, queueJobId: string) => Promise<void>

export class JobQueueService {
  private readonly boss: PgBoss
  private started = false

  constructor(env: Env) {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: 'pgboss',
      application_name: 'geoforge-workflow-queue',
      schedule: true,
      migrate: true,
      createSchema: true,
      supervise: true,
      monitorIntervalSeconds: 60,
      maintenanceIntervalSeconds: 60,
      connectionTimeoutMillis: 5_000,
    })
    this.boss.on('error', error => {
      logger.error({ error: errorLogPayload(error) }, 'workflow queue error')
    })
    this.boss.on('warning', warning => {
      logger.warn({ warning }, 'workflow queue warning')
    })
  }

  async start(handler: WorkflowJobHandler): Promise<void> {
    if (this.started) return
    await this.boss.start()
    await this.boss.createQueue(WORKFLOW_QUEUE_NAME, {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: 1800,
      retentionSeconds: 14 * 24 * 60 * 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    })
    await this.boss.work<WorkflowJobPayload>(WORKFLOW_QUEUE_NAME, { batchSize: 1 }, async jobs => {
      for (const job of jobs) {
        await this.handleJob(job, handler)
      }
    })
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.boss.stop({ graceful: true, timeout: 10_000 })
    this.started = false
  }

  async enqueueWorkflowRun(payload: WorkflowJobPayload): Promise<string> {
    const jobId = await this.boss.send(WORKFLOW_QUEUE_NAME, payload, {
      singletonKey: payload.dispatchId,
      retryLimit: 2,
      retryBackoff: true,
    })
    if (!jobId) throw new Error('Workflow 任务入队失败。')
    return jobId
  }

  async cancelWorkflowJob(jobId: string): Promise<void> {
    await this.boss.cancel(WORKFLOW_QUEUE_NAME, jobId)
  }

  async scheduleTask(input: {
    taskId: string
    cron: string
    timezone: string
    recurring: boolean
    nextFireAt: string
    payload: WorkflowJobPayload
  }): Promise<string | null> {
    await this.boss.unschedule(WORKFLOW_QUEUE_NAME, input.taskId)
    if (!input.recurring) {
      const jobId = await this.boss.send(WORKFLOW_QUEUE_NAME, input.payload, {
        singletonKey: `one-shot:${input.taskId}`,
        startAfter: new Date(input.nextFireAt),
        retryLimit: 2,
        retryBackoff: true,
      })
      if (!jobId) throw new Error('一次性定时任务入队失败。')
      return jobId
    }
    await this.boss.schedule(WORKFLOW_QUEUE_NAME, input.cron, input.payload, {
      key: input.taskId,
      tz: input.timezone,
      singletonKey: input.taskId,
      retryLimit: 2,
      retryBackoff: true,
    })
    return null
  }

  async unscheduleTask(taskId: string, queueJobId?: string | null): Promise<void> {
    await this.boss.unschedule(WORKFLOW_QUEUE_NAME, taskId)
    if (queueJobId) await this.boss.cancel(WORKFLOW_QUEUE_NAME, queueJobId)
  }

  private async handleJob(job: Job<WorkflowJobPayload>, handler: WorkflowJobHandler): Promise<void> {
    const payload = workflowJobPayloadSchema.parse(job.data)
    await handler(payload, job.id)
  }
}
