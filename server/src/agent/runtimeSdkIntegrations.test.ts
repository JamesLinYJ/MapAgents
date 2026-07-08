import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RunContext, tool, type MCPServer } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { buildSandboxManifest } from './runtimeSandbox.js'
import {
  buildRuntimeSdkSandboxIntegration,
  createRuntimeSdkTools,
} from './runtimeSdkIntegrations.js'
import { agentRuntimeConfigSchema } from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'

describe('runtime SDK integrations', () => {
  it('keeps the default runtime SDK config schema-valid and disabled', () => {
    const parsed = agentRuntimeConfigSchema.parse(defaultRuntimeConfig())

    expect(parsed.sdk.mcp.enabled).toBe(false)
    expect(parsed.sdk.mcp.servers).toHaveLength(0)
    expect(parsed.sdk.skills.enabled).toBe(false)
    expect(parsed.sdk.skills.skillPaths).toHaveLength(0)
    expect(parsed.sdk.skills.skillRoots).toHaveLength(0)
  })

  it('rejects enabled HTTP MCP server config without a URL', () => {
    const config = defaultRuntimeConfig()
    config.sdk.mcp = {
      enabled: true,
      connectTimeoutMs: 1000,
      closeTimeoutMs: 1000,
      servers: [{
        enabled: true,
        name: 'docs',
        description: '文档 MCP',
        transport: 'streamable_http',
        executionMode: 'function_tools',
        url: null,
        connectorId: null,
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
        timeoutMs: 1000,
      }],
    }

    const parsed = agentRuntimeConfigSchema.safeParse(config)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message).join('\n')).toContain('HTTP/SSE MCP 必须配置 url')
    }
  })

  it('materializes configured SDK skills through the Sandbox skills capability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geoforge-sdk-skills-'))
    try {
      const skillRoot = path.join(root, 'skills')
      const skillDir = path.join(skillRoot, 'geo-skill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: geo-skill',
        'description: 读取地理数据 Skill。',
        '---',
        '',
        '# Geo Skill',
      ].join('\n'))

      const config = defaultRuntimeConfig()
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [],
        skillRoots: [skillRoot],
      }

      const integration = buildRuntimeSdkSandboxIntegration(config)
      expect(integration.activeSkills).toEqual(['geo-skill'])
      expect(integration.pathGrants).toHaveLength(0)

      const manifest = buildSandboxManifest({ runId: 'run_1', sessionId: 'session_1' }, 'thread_1', integration.pathGrants)
      const processed = integration.capabilities.reduce((current, capability) => capability.processManifest(current), manifest)
      const instructions = await integration.capabilities[0]?.instructions(processed)
      expect(instructions).toContain('geo-skill')
      expect(instructions).toContain('load_skill')
      expect(processed.extraPathGrants).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects enabled SDK skills when no SKILL.md exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geoforge-sdk-skills-empty-'))
    try {
      const config = defaultRuntimeConfig()
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [],
        skillRoots: [root],
      }

      expect(() => buildRuntimeSdkSandboxIntegration(config)).toThrow('没有发现可用的 SKILL.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects SDK skills whose SKILL.md casing is not exact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geoforge-sdk-skills-case-'))
    try {
      const skillDir = path.join(root, 'geo-skill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'sKilL.md'), '# Wrong case')

      const config = defaultRuntimeConfig()
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [skillDir],
        skillRoots: [],
      }

      expect(() => buildRuntimeSdkSandboxIntegration(config)).toThrow('大小写必须严格为 SKILL.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads MCP function tools and applies approval by default', async () => {
    const config = defaultRuntimeConfig()
    config.sdk.mcp = {
      enabled: true,
      connectTimeoutMs: 1000,
      closeTimeoutMs: 1000,
      servers: [{
        enabled: true,
        name: 'docs',
        description: '文档 MCP',
        transport: 'streamable_http',
        executionMode: 'function_tools',
        url: 'http://127.0.0.1:9999/mcp',
        connectorId: null,
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
        timeoutMs: 1000,
      }],
    }
    let closed = false
    const fakeServer = { name: 'docs' } as MCPServer
    const integration = await createRuntimeSdkTools(config, new Set(), {
      connectMcpServers: async () => ({
        active: [fakeServer],
        close: async () => { closed = true },
      }),
      getAllMcpTools: async () => [
        tool({
          name: 'docs_search',
          description: '搜索文档。',
          parameters: z.object({ query: z.string() }),
          execute: async () => 'ok',
        }),
      ],
    })

    expect(integration.activeMcpServers).toEqual(['docs'])
    expect(integration.tools.map(candidate => candidate.name)).toEqual(['docs_search'])
    const [mcpTool] = integration.tools
    expect(mcpTool?.type).toBe('function')
    if (mcpTool?.type !== 'function') throw new Error('测试工具必须是 function tool')
    const context = new RunContext<AgentsExecutionContext>({
      runId: 'run_1',
      prepareToolCall: async () => {},
      executeTool: async () => 'ok',
    })
    await expect(mcpTool.needsApproval(context, { query: 'abc' }, 'call_1')).resolves.toBe(true)
    await integration.close()
    expect(closed).toBe(true)
  })
})
