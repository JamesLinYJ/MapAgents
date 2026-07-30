// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 API 组合响应 Schema
//
//   文件:       responseSchemas.ts
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
  backgroundTaskInfoSchema,
  memoryFileRecordSchema,
  memorySearchResultSchema,
  scheduledTaskSchema,
  automationDefinitionSchema,
  automationRunRecordSchema,
  automationValidationResultSchema,
} from '@geo-agent-platform/shared-types'

export const unknownRecordSchema = z.record(z.string(), z.unknown())
export const unknownRecordListSchema = z.array(unknownRecordSchema)

export const memoryListResponseSchema = z.object({
  records: z.array(memoryFileRecordSchema),
  total: z.number().int().nonnegative(),
})

export const memorySearchResponseSchema = z.object({
  matches: z.array(memorySearchResultSchema),
  total: z.number().int().nonnegative(),
})

export const automationDiagnosticSchema = z.record(z.string(), z.unknown())

export const automationListResponseSchema = z.object({
  definitions: z.array(automationDefinitionSchema),
  diagnostics: z.array(automationDiagnosticSchema),
  validation: z.record(z.string(), automationValidationResultSchema),
})

export const scheduledTaskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
  automationRuns: z.array(automationRunRecordSchema),
})

export const backgroundTaskListResponseSchema = z.object({
  tasks: z.array(backgroundTaskInfoSchema),
})

export const mutationAckSchema = z.record(z.string(), z.unknown())
