// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 跨平台运维协议
//
//   文件:       operations.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'
import { auditEventSchema } from './platform.js'

export const opsServiceIdSchema = z.enum(['web', 'api', 'worker', 'infra'])
export const opsServiceActionSchema = z.enum(['start', 'stop', 'restart'])
export const opsServiceStateSchema = z.enum([
  'disabled',
  'pending',
  'starting',
  'running',
  'stopping',
  'completed',
  'failed',
  'unknown',
])
export const opsServiceHealthSchema = z.enum(['healthy', 'unhealthy', 'starting', 'disabled', 'unknown'])
export const opsLogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'])
export const opsTerminalStateSchema = z.enum([
  'starting',
  'running',
  'detached',
  'exited',
  'terminated',
  'failed',
  'orphaned',
])

export const opsHostSnapshotSchema = z.object({
  hostname: z.string().min(1),
  platform: z.enum(['windows', 'linux']),
  architecture: z.string().min(1),
  distribution: z.string().min(1),
  release: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  cpu: z.object({
    manufacturer: z.string(),
    brand: z.string(),
    physicalCores: z.number().int().positive(),
    logicalCores: z.number().int().positive(),
    loadPercent: z.number().min(0).max(100),
  }).strict(),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    usedPercent: z.number().min(0).max(100),
  }).strict(),
  disks: z.array(z.object({
    filesystem: z.string(),
    mount: z.string(),
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    usedPercent: z.number().min(0).max(100),
  }).strict()),
  sampledAt: z.string().datetime(),
}).strict()

export const opsServiceSnapshotSchema = z.object({
  id: opsServiceIdSchema,
  label: z.string().min(1),
  description: z.string(),
  state: opsServiceStateSchema,
  health: opsServiceHealthSchema,
  pid: z.number().int().positive().nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  restartCount: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  cpuPercent: z.number().min(0).nullable(),
  memoryBytes: z.number().nonnegative().nullable(),
  dependencies: z.array(opsServiceIdSchema),
  updatedAt: z.string().datetime(),
}).strict()

export const opsLogEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  serviceId: opsServiceIdSchema,
  level: opsLogLevelSchema,
  message: z.string().max(32_768),
  timestamp: z.string().datetime(),
}).strict()

export const opsTerminalSessionSchema = z.object({
  terminalId: z.string().min(1),
  ownerUserId: z.string().min(1),
  ownerDisplayName: z.string().min(1),
  label: z.string().min(1),
  state: opsTerminalStateSchema,
  shell: z.string().min(1),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  recordedBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  detachedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
}).strict()

export const opsTranscriptSummarySchema = z.object({
  terminalId: z.string().min(1),
  ownerUserId: z.string().min(1),
  ownerDisplayName: z.string().min(1),
  label: z.string().min(1),
  shell: z.string().min(1),
  state: opsTerminalStateSchema,
  exitCode: z.number().int().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  retainedUntil: z.string().datetime(),
  ownedByRequester: z.boolean(),
}).strict()

export const opsLimitsSchema = z.object({
  terminalsPerAdministrator: z.number().int().positive(),
  terminalsPerHost: z.number().int().positive(),
  detachTtlSeconds: z.number().int().positive(),
  maximumSessionSeconds: z.number().int().positive(),
  maximumFrameBytes: z.number().int().positive(),
  scrollbackLines: z.number().int().positive(),
  maximumRecordingBytes: z.number().int().positive(),
  transcriptRetentionDays: z.number().int().positive(),
  stepUpWindowSeconds: z.number().int().positive(),
}).strict()

export const opsOperatorSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
}).strict()

export const opsBootstrapSchema = z.object({
  user: opsOperatorSchema,
  csrfToken: z.string().min(1),
  csrfHeaderName: z.string().min(1),
  recoveryMode: z.boolean(),
  stepUpExpiresAt: z.string().datetime().nullable(),
  terminal: z.object({
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
  }).strict(),
  host: opsHostSnapshotSchema,
  services: z.array(opsServiceSnapshotSchema),
  limits: opsLimitsSchema,
  generatedAt: z.string().datetime(),
}).strict()

export const opsStepUpRequestSchema = z.object({
  password: z.string().min(1, '请输入当前账户密码').max(1_024),
}).strict()

export const opsStepUpResponseSchema = z.object({
  verified: z.literal(true),
  expiresAt: z.string().datetime(),
}).strict()

export const opsTranscriptAccessRequestSchema = z.object({
  reason: z.string().trim().min(10, '查阅原因至少需要 10 个字符').max(500),
}).strict()

const opsControlBaseSchema = z.object({
  requestId: z.string().min(1).max(128),
  csrfToken: z.string().min(1),
})

export const opsControlCommandSchema = z.discriminatedUnion('type', [
  opsControlBaseSchema.extend({ type: z.literal('subscribe_metrics') }).strict(),
  opsControlBaseSchema.extend({
    type: z.literal('subscribe_logs'),
    services: z.array(opsServiceIdSchema).min(1).max(4),
    levels: z.array(opsLogLevelSchema).max(7).default([]),
    search: z.string().trim().max(200).default(''),
    tail: z.number().int().min(1).max(5_000).default(500),
  }).strict(),
  opsControlBaseSchema.extend({
    type: z.literal('service_action'),
    serviceId: opsServiceIdSchema,
    action: opsServiceActionSchema,
    confirmation: z.string().trim().max(80).optional(),
  }).strict(),
  opsControlBaseSchema.extend({
    type: z.literal('terminal_create'),
    label: z.string().trim().min(1).max(80),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  opsControlBaseSchema.extend({ type: z.literal('terminal_list') }).strict(),
  opsControlBaseSchema.extend({
    type: z.literal('terminal_close'),
    terminalId: z.string().min(1).max(128),
  }).strict(),
])

export const opsControlSuccessSchema = z.object({
  requestId: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
}).strict()

export const opsControlErrorSchema = z.object({
  requestId: z.string(),
  ok: z.literal(false),
  error: z.object({
    code: z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'rate_limited', 'dependency_unavailable', 'command_failed']),
    message: z.string(),
  }).strict(),
}).strict()

export const opsPushEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('host_snapshot'), payload: opsHostSnapshotSchema }).strict(),
  z.object({ type: z.literal('service_snapshot'), payload: z.array(opsServiceSnapshotSchema) }).strict(),
  z.object({ type: z.literal('log_entry'), payload: opsLogEntrySchema }).strict(),
  z.object({ type: z.literal('terminal_snapshot'), payload: opsTerminalSessionSchema }).strict(),
])

export const opsTerminalClientControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), csrfToken: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM']) }).strict(),
  z.object({ type: z.literal('detach') }).strict(),
])

export const opsTerminalServerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), terminal: opsTerminalSessionSchema }).strict(),
  z.object({ type: z.literal('screen'), data: z.string() }).strict(),
  z.object({ type: z.literal('state'), terminal: opsTerminalSessionSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
])

export const opsAsciicastEventSchema = z.tuple([
  z.number().nonnegative(),
  z.enum(['o', 'r']),
  z.string(),
])

export const opsAuditEventSchema = auditEventSchema

export type OpsServiceId = z.infer<typeof opsServiceIdSchema>
export type OpsServiceAction = z.infer<typeof opsServiceActionSchema>
export type OpsServiceState = z.infer<typeof opsServiceStateSchema>
export type OpsServiceHealth = z.infer<typeof opsServiceHealthSchema>
export type OpsLogLevel = z.infer<typeof opsLogLevelSchema>
export type OpsTerminalState = z.infer<typeof opsTerminalStateSchema>
export type OpsHostSnapshot = z.infer<typeof opsHostSnapshotSchema>
export type OpsServiceSnapshot = z.infer<typeof opsServiceSnapshotSchema>
export type OpsLogEntry = z.infer<typeof opsLogEntrySchema>
export type OpsTerminalSession = z.infer<typeof opsTerminalSessionSchema>
export type OpsTranscriptSummary = z.infer<typeof opsTranscriptSummarySchema>
export type OpsLimits = z.infer<typeof opsLimitsSchema>
export type OpsOperator = z.infer<typeof opsOperatorSchema>
export type OpsBootstrap = z.infer<typeof opsBootstrapSchema>
export type OpsControlCommand = z.infer<typeof opsControlCommandSchema>
export type OpsControlSuccess = z.infer<typeof opsControlSuccessSchema>
export type OpsControlError = z.infer<typeof opsControlErrorSchema>
export type OpsPushEvent = z.infer<typeof opsPushEventSchema>
export type OpsTerminalClientControl = z.infer<typeof opsTerminalClientControlSchema>
export type OpsTerminalServerControl = z.infer<typeof opsTerminalServerControlSchema>
export type OpsAsciicastEvent = z.infer<typeof opsAsciicastEventSchema>
