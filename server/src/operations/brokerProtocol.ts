// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker 内部协议
//
//   文件:       brokerProtocol.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { opsTerminalStateSchema } from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

export const brokerTerminalSessionSchema = z.object({
  terminalId: z.string().min(1).max(128),
  ownerUserId: z.string().min(1).max(128),
  label: z.string().min(1).max(80),
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
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
}).strict()

export const brokerCreateTerminalSchema = z.object({
  terminalId: z.string().min(1).max(128),
  ownerUserId: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(80),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
  dataKeyBase64: z.string().min(40).max(64),
}).strict()

export const brokerTranscriptChunkSchema = z.object({
  chunkId: z.string().regex(/^[A-Za-z0-9_.-]{1,180}$/u),
  terminalId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  encryptedBase64: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  eventCount: z.number().int().positive(),
  firstEventMilliseconds: z.number().int().nonnegative(),
  lastEventMilliseconds: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict()

export const brokerTerminalControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM']) }).strict(),
  z.object({ type: z.literal('detach') }).strict(),
])

export const brokerTerminalServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('screen'), data: z.string() }).strict(),
  z.object({ type: z.literal('state'), terminal: brokerTerminalSessionSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
])

export type BrokerTerminalSession = z.infer<typeof brokerTerminalSessionSchema>
export type BrokerCreateTerminal = z.infer<typeof brokerCreateTerminalSchema>
export type BrokerTranscriptChunk = z.infer<typeof brokerTranscriptChunkSchema>
export type BrokerTerminalControl = z.infer<typeof brokerTerminalControlSchema>
export type BrokerTerminalServerMessage = z.infer<typeof brokerTerminalServerMessageSchema>
