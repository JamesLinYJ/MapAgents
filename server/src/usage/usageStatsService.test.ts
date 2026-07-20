// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型用量统计服务测试
//
//   文件:       usageStatsService.test.ts
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../framework/env.js'
import { analysisRunSchema, type AnalysisRun } from '@geo-agent-platform/shared-types/platform'
import type { RunStatus } from '@geo-agent-platform/shared-types/core'
import type { AuthContext } from '../security/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { UsageStatsService } from './usageStatsService.js'

describe('UsageStatsService', () => {
  it('separates input, output, cache-hit, total tokens, and missing usage runs', () => {
    const service = new UsageStatsService(fakeStore([
      run('run_with_cache', {
        runtimeStats: {
          modelInputTokens: 120,
          modelOutputTokens: 30,
          modelCacheHitInputTokens: 80,
          modelCacheHitReportedResponseCount: 1,
          modelTotalTokens: 150,
          modelUsageResponseCount: 1,
          contextEstimatedTokens: 900,
        },
      }),
      run('run_without_cache_detail', {
        runtimeStats: {
          modelInputTokens: 10,
          modelOutputTokens: 5,
          modelTotalTokens: 15,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_without_provider_usage', { runtimeStats: {} }),
    ]), env())

    const summary = service.summarizeWorkspace(auth())

    expect(summary.totals.runCount).toBe(3)
    expect(summary.totals.runsWithUsage).toBe(2)
    expect(summary.totals.runsWithoutUsage).toBe(1)
    expect(summary.totals.inputTokens).toBe(130)
    expect(summary.totals.outputTokens).toBe(35)
    expect(summary.totals.cacheHitInputTokens).toBe(80)
    expect(summary.totals.cacheHitReportedRuns).toBe(1)
    expect(summary.totals.totalTokens).toBe(165)
    expect(summary.totals.contextEstimatedTokens).toBe(900)
    expect(summary.byProvider[0]?.key).toBe('deepseek')
    expect(summary.byModel[0]?.label).toBe('deepseek-v4-pro')
    expect(summary.recentRuns[0]).toMatchObject({
      runId: 'run_with_cache',
      inputTokens: 120,
      outputTokens: 30,
      cacheHitInputTokens: 80,
      totalTokens: 150,
      cacheHitReported: true,
      hasUsage: true,
    })
    expect(summary.warnings.join('\n')).toContain('没有模型 provider 返回的 usage')
    expect(summary.warnings.join('\n')).toContain('没有返回缓存命中明细')
  })

  it('enforces daily and monthly limits from real total token usage', () => {
    const service = new UsageStatsService(fakeStore([
      run('run_today', {
        createdAt: new Date().toISOString(),
        runtimeStats: {
          modelInputTokens: 80,
          modelOutputTokens: 20,
          modelTotalTokens: 100,
          modelUsageResponseCount: 1,
        },
      }),
    ]), env({ USAGE_DAILY_TOTAL_TOKEN_LIMIT: '100', USAGE_MONTHLY_TOTAL_TOKEN_LIMIT: '1000' }))

    const summary = service.summarizeWorkspace(auth())

    expect(summary.limits.find(limit => limit.period === 'day')).toMatchObject({
      enabled: true,
      limitTokens: 100,
      usedTokens: 100,
      remainingTokens: 0,
      exceeded: true,
    })
    expect(summary.limits.find(limit => limit.period === 'month')).toMatchObject({
      enabled: true,
      limitTokens: 1000,
      usedTokens: 100,
      remainingTokens: 900,
      exceeded: false,
    })
    expect(() => service.assertWorkspaceCanStartModelRun(auth())).toThrow(/今日模型 token 用量已达到上限/)
  })
})

function fakeStore(runs: AnalysisRun[]): PlatformPersistenceFacade {
  return {
    listRunsForWorkspace: (workspaceId: string) => {
      expect(workspaceId).toBe('workspace_test')
      return runs
    },
  } as unknown as PlatformPersistenceFacade
}

function auth(): AuthContext {
  return {
    userId: 'user_test',
    subject: 'user_test',
    email: 'user@example.test',
    displayName: 'Usage Tester',
    authSessionId: 'session_test',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_test',
    defaultWorkspaceId: 'workspace_test',
    roles: [{ workspaceId: 'workspace_test', role: 'analyst' }],
  }
}

function run(
  id: string,
  options: {
    createdAt?: string
    status?: RunStatus
    runtimeStats: Record<string, number>
  },
): AnalysisRun {
  const createdAt = options.createdAt ?? '2026-07-09T00:00:00.000Z'
  return analysisRunSchema.parse({
    id,
    threadId: `thread_${id}`,
    sessionId: 'session_test',
    workspaceId: 'workspace_test',
    createdByUserId: 'user_test',
    visibility: 'workspace',
    userQuery: id,
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-pro',
    status: options.status ?? 'completed',
    createdAt,
    updatedAt: createdAt,
    state: {
      sessionId: 'session_test',
      threadId: `thread_${id}`,
      userQuery: id,
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      runtimeStats: options.runtimeStats,
    },
  })
}

function env(overrides: NodeJS.ProcessEnv = {}): Env {
  return parseEnv({
    API_PORT: '8000',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://geo_agent:geo_agent@localhost:5432/geo_agent',
    RUNTIME_ROOT: 'runtime',
    APP_BASE_URL: 'http://localhost:8000',
    BETTER_AUTH_URL: 'http://localhost:8000',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
    ...overrides,
  })
}
