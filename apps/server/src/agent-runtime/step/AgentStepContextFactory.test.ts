// +-------------------------------------------------------------------------
//
//   地理智能平台 - 不可变 StepContext 工厂测试
//
//   文件:       AgentStepContextFactory.test.ts
//
//   日期:       2026年08月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentStepContext,
  AgentToolPlanEntry,
  AgentToolPlanSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'
import {
  createGeoWorldDiff,
  geoWorldStateSchema,
  type GeoWorldState,
} from '@geo-agent-platform/shared-types/geo-world'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import { agentContextDigest } from './agentContextDigest.js'
import {
  AgentStepContextFactory,
  type CaptureAgentStepContextInput,
} from './AgentStepContextFactory.js'

describe('AgentStepContextFactory', () => {
  it('keeps one request immutable and advances GeoWorld only for the next capability plan', async () => {
    const contexts: AgentStepContext[] = []
    let requestIndex = 0
    let world: { state: GeoWorldState; stateDigest: string } | null = null
    const factory = new AgentStepContextFactory(
      {
        appendNext: async (_runId, build) => {
          const context = build(++requestIndex)
          contexts.push(context)
          return context
        },
      },
      {
        get: async () => world,
        ensureBaseline: async (_runId, baseline) => {
          world = snapshot(baseline)
          return world
        },
        applyPatches: async ({ runId, patches }) => {
          if (!world) throw new Error('测试 GeoWorld 尚未建立')
          const changed = createGeoWorldDiff({
            diffId: `world_diff_${world.state.revision}`,
            runId,
            current: world.state,
            patches,
            createdAt: '2026-08-21T01:00:00.000Z',
          })
          world = snapshot(changed.state)
          return { snapshot: world }
        },
      },
      {
        build: async (_runId, capabilities) => worldState(capabilities),
      },
    )
    const config = runtimeConfigWithMcp()
    const initialPlan = toolPlan([
      toolEntry('list_layers', 'platform'),
      toolEntry('north_search', 'mcp'),
      toolEntry('south_search', 'mcp'),
    ])
    const base = captureInput(config, initialPlan)

    const first = await factory.capture(base)
    const second = await factory.capture(base)
    const expandedPlan = toolPlan([
      ...initialPlan.entries,
      toolEntry('query_layer', 'platform'),
    ])
    const third = await factory.capture({ ...base, toolPlan: expandedPlan })

    expect(first.identity.modelRequestIndex).toBe(1)
    expect(second.identity.modelRequestIndex).toBe(2)
    expect(first.worldRevision).toBe(1)
    expect(second.worldRevision).toBe(1)
    expect(third.worldRevision).toBe(2)
    expect(first.tools.entries.map(entry => entry.name)).toEqual([
      'list_layers',
      'north_search',
      'south_search',
    ])
    expect(first.world.capabilities.toolNames).toEqual([
      'list_layers',
      'north_search',
      'south_search',
    ])
    expect(third.world.capabilities.toolNames).toContain('query_layer')
    expect(first.mcp.servers).toEqual([
      expect.objectContaining({ name: 'north', toolNames: ['north_search'] }),
      expect.objectContaining({ name: 'south', toolNames: ['south_search'] }),
    ])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.tools.entries)).toBe(true)
    expect(contexts).toHaveLength(3)
  })

  it('rejects an MCP tool that is not bound to an active server', async () => {
    const factory = new AgentStepContextFactory(
      { appendNext: async (_runId, build) => build(1) },
      {
        get: async () => snapshot(worldState({
          toolNames: [],
          mcpServerNames: [],
          sandboxBackend: 'disabled',
          writableRoots: [],
          networkPolicy: 'provider_and_registered_tools',
        })),
        ensureBaseline: async () => { throw new Error('不应建立 baseline') },
        applyPatches: async () => { throw new Error('不应更新 world') },
      },
      { build: async () => { throw new Error('不应构建 baseline') } },
    )
    const config = runtimeConfigWithMcp()
    const plan = toolPlan([toolEntry('north_search', 'mcp')])

    await expect(factory.capture({
      ...captureInput(config, plan),
      activeMcpServers: ['north'],
      mcpToolServers: new Map(),
    })).rejects.toThrow(/north_search.*server/u)
  })

  it('rejects a runtime digest that does not describe the captured configuration', async () => {
    const factory = new AgentStepContextFactory(
      { appendNext: async (_runId, build) => build(1) },
      {
        get: async () => { throw new Error('配置摘要失败前不应读取 world') },
        ensureBaseline: async () => { throw new Error('配置摘要失败前不应建立 baseline') },
        applyPatches: async () => { throw new Error('配置摘要失败前不应更新 world') },
      },
      { build: async () => { throw new Error('配置摘要失败前不应构建 baseline') } },
    )
    const config = runtimeConfigWithMcp()
    const plan = toolPlan([toolEntry('north_search', 'mcp')])

    await expect(factory.capture({
      ...captureInput(config, plan),
      activeMcpServers: ['north'],
      mcpToolServers: new Map([['north_search', 'north']]),
      runtimeConfigDigest: 'sha256:not-the-runtime-config',
    })).rejects.toThrow(/runtimeConfigDigest/u)
  })
})

function captureInput(
  runtimeConfig: AgentRuntimeConfig,
  plan: AgentToolPlanSnapshot,
): CaptureAgentStepContextInput {
  return {
    runId: 'run_1',
    turnId: 'turn_1',
    segmentId: 'segment_1',
    objectiveRevision: 1,
    inputCursor: 0,
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    transport: 'deepseek_responses',
    modelCapabilities: {
      modelId: 'deepseek-v4-flash',
      contextWindowTokens: 1_000_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    },
    reasoningEffort: 'none',
    serviceTier: null,
    timeoutMs: 45_000,
    runtimeConfig,
    runtimeConfigDigest: agentContextDigest(runtimeConfig),
    toolPlan: plan,
    activeMcpServers: ['north', 'south'],
    mcpToolServers: new Map([
      ['north_search', 'north'],
      ['south_search', 'south'],
    ]),
    activeSkills: [],
    auth: null,
  }
}

function runtimeConfigWithMcp(): AgentRuntimeConfig {
  const config = defaultRuntimeConfig()
  config.sdk.mcp = {
    enabled: true,
    connectTimeoutMs: 1_000,
    closeTimeoutMs: 1_000,
    servers: [mcpServer('north'), mcpServer('south')],
  }
  return config
}

function mcpServer(name: string): AgentRuntimeConfig['sdk']['mcp']['servers'][number] {
  return {
    enabled: true,
    name,
    description: `${name} MCP`,
    transport: 'streamable_http',
    executionMode: 'function_tools',
    url: `https://${name}.example.test/mcp`,
    command: null,
    args: [],
    cwd: null,
    env: {},
    headers: {},
    authorizationEnv: null,
    allowedTools: [],
    blockedTools: [],
    includeServerInToolNames: true,
    convertSchemasToStrict: true,
    cacheToolsList: true,
    useStructuredContent: true,
    approval: 'always',
    timeoutMs: 1_000,
  }
}

function toolPlan(entries: AgentToolPlanEntry[]): AgentToolPlanSnapshot {
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  return { entries: sorted, catalogDigest: agentContextDigest(sorted) }
}

function toolEntry(
  name: string,
  kind: AgentToolPlanEntry['kind'],
): AgentToolPlanEntry {
  return {
    name,
    kind,
    providerId: kind === 'mcp' ? name.split('_')[0] ?? null : 'layers',
    schemaDigest: `sha256:schema:${name}`,
    definitionDigest: `sha256:definition:${name}`,
    requiresApproval: kind === 'mcp',
    readOnly: true,
    destructive: false,
  }
}

function worldState(capabilities: GeoWorldState['capabilities']): GeoWorldState {
  return geoWorldStateSchema.parse({
    schemaVersion: 1,
    revision: 1,
    workspaceId: 'workspace_1',
    map: {
      displayCrs: 'EPSG:3857',
      viewport: null,
      selectedLayerIds: [],
      selectedFeatureRefs: [],
      timeRange: null,
    },
    layers: [],
    datasets: [],
    files: [],
    artifacts: [],
    values: [],
    provenance: [],
    capabilities,
  })
}

function snapshot(state: GeoWorldState): { state: GeoWorldState; stateDigest: string } {
  return { state, stateDigest: agentContextDigest(state) }
}
