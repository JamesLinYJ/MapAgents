// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 组合响应 Schema
//
//   文件:       responseSchemas.ts
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
  backgroundTaskInfoSchema,
  memoryFileRecordSchema,
  memorySearchResultSchema,
  scheduledTaskSchema,
  workflowDefinitionSchema,
  workflowRunRecordSchema,
  workflowValidationResultSchema,
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

export const workflowDiagnosticSchema = z.record(z.string(), z.unknown())

export const workflowListResponseSchema = z.object({
  definitions: z.array(workflowDefinitionSchema),
  diagnostics: z.array(workflowDiagnosticSchema),
  validation: z.record(z.string(), workflowValidationResultSchema),
})

export const scheduledTaskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
  workflowRuns: z.array(workflowRunRecordSchema),
})

export const backgroundTaskListResponseSchema = z.object({
  tasks: z.array(backgroundTaskInfoSchema),
})

export const mutationAckSchema = z.record(z.string(), z.unknown())
