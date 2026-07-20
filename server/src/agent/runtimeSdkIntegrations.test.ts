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
  createRuntimeSdkIntegration,
} from './runtimeSdkIntegrations.js'
import { agentRuntimeConfigSchema } from '@geo-agent-platform/shared-types/runtime'
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

      const capability = integration.capabilities[0]
      if (!capability) throw new Error('Skills capability missing')
      capability.bind({
        pathExists: async () => false,
        materializeEntry: async () => {},
      } as never)
      const [loadSkill] = capability.tools()
      if (!loadSkill || loadSkill.type !== 'function') throw new Error('load_skill tool missing')
      let extensionEnabled = true
      const runContext = new RunContext<AgentsExecutionContext>({
        runId: 'run_skill',
        isExecutionEnabled: () => true,
        isSdkExtensionEnabled: () => extensionEnabled,
        isToolEnabled: () => true,
        validateToolCall: () => null,
        formatToolFailureForModel: (_toolName, message) => message,
        rejectPreparedToolCall: async () => {},
        prepareToolCall: async () => {},
        executeTool: async () => 'ok',
      })
      await expect(loadSkill.isEnabled(runContext, {} as never)).resolves.toBe(true)
      extensionEnabled = false
      await expect(loadSkill.isEnabled(runContext, {} as never)).resolves.toBe(false)
      await expect(loadSkill.invoke(runContext, '{"skill_name":"geo-skill"}')).rejects.toThrow(
        '当前规划或结构化工作流边界禁止调用 SDK Skill',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('mounts current-run artifacts read-only at the relative path returned by tools', () => {
    const artifactDirectory = path.join(process.cwd(), 'runtime', 'artifacts', 'run_1')
    const manifest = buildSandboxManifest(
      { runId: 'run_1', sessionId: 'session_1' },
      'thread_1',
      [],
      { artifactDirectory },
    )
    const artifactsEntry = manifest.entries.artifacts
    expect(artifactsEntry?.type).toBe('dir')
    if (!artifactsEntry || artifactsEntry.type !== 'dir') throw new Error('artifacts manifest entry missing')
    expect(artifactsEntry.children?.run_1).toMatchObject({
      type: 'mount',
      source: path.resolve(artifactDirectory),
      readOnly: true,
      mountStrategy: { type: 'local_bind' },
    })
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
    enableTestMcp(config, 'always')
    let closed = false
    const fakeServer = { name: 'docs' } as MCPServer
    const integration = await createRuntimeSdkIntegration(config, new Set(), {
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
    expect(integration.mcpServers).toEqual([])
    expect(integration.tools.map(candidate => candidate.name)).toEqual(['docs_search'])
    expect([...integration.mcpToolNames]).toEqual(['docs_search'])
    const [mcpTool] = integration.tools
    expect(mcpTool?.type).toBe('function')
    if (mcpTool?.type !== 'function') throw new Error('测试工具必须是 function tool')
    let executionEnabled = true
    let sdkExtensionEnabled = true
    const context = new RunContext<AgentsExecutionContext>({
      runId: 'run_1',
      isExecutionEnabled: () => executionEnabled,
      isSdkExtensionEnabled: () => sdkExtensionEnabled,
      isToolEnabled: () => true,
      validateToolCall: () => null,
      formatToolFailureForModel: (_toolName, message) => message,
      rejectPreparedToolCall: async () => {},
      prepareToolCall: async () => {},
      executeTool: async () => 'ok',
    })
    await expect(mcpTool.needsApproval(context, { query: 'abc' }, 'call_1')).resolves.toBe(true)
    await expect(mcpTool.isEnabled(context, {} as never)).resolves.toBe(true)
    sdkExtensionEnabled = false
    await expect(mcpTool.isEnabled(context, {} as never)).resolves.toBe(false)
    await expect(mcpTool.invoke(context, '{"query":"abc"}')).rejects.toThrow('结构化工作流边界禁止调用 MCP 工具')
    await integration.close()
    expect(closed).toBe(true)
  })

  it('attaches approval-free local MCP through the Agent native mcpServers boundary', async () => {
    const config = defaultRuntimeConfig()
    enableTestMcp(config, 'never')
    let connectedServer: MCPServer | null = null
    let closed = false
    const integration = await createRuntimeSdkIntegration(config, new Set(['platform_tool']), {
      connectMcpServers: async servers => {
        connectedServer = servers[0] ?? null
        return {
          active: servers,
          close: async () => { closed = true },
        }
      },
      getAllMcpTools: async options => {
        expect(options.mcpServers).toHaveLength(1)
        expect(options.includeServerInToolNames).toBe(true)
        expect(options.convertSchemasToStrict).toBe(true)
        expect(options.reservedToolNames).toEqual(new Set(['platform_tool']))
        return [tool({
          name: 'docs_search',
          description: '搜索文档。',
          parameters: z.object({ query: z.string() }),
          execute: async () => 'ok',
        })]
      },
    })

    expect(integration.tools).toEqual([])
    expect(integration.mcpServers).toHaveLength(1)
    expect(integration.mcpServers[0]).toBe(connectedServer)
    expect(integration.mcpConfig).toEqual({
      convertSchemasToStrict: true,
      includeServerInToolNames: true,
      errorFunction: null,
    })
    expect([...integration.mcpToolNames]).toEqual(['docs_search'])

    const filter = connectedServer?.toolFilter
    expect(typeof filter).toBe('function')
    if (typeof filter !== 'function') throw new Error('原生 MCP 必须使用动态执行阶段过滤器')
    let sdkExtensionEnabled = true
    const runContext = new RunContext<AgentsExecutionContext>({
      runId: 'run_native_mcp',
      isExecutionEnabled: () => true,
      isSdkExtensionEnabled: () => sdkExtensionEnabled,
      isToolEnabled: () => true,
      validateToolCall: () => null,
      formatToolFailureForModel: (_toolName, message) => message,
      rejectPreparedToolCall: async () => {},
      prepareToolCall: async () => {},
      executeTool: async () => 'ok',
    })
    const filterContext = { runContext, agent: {} as never, serverName: 'docs' }
    await expect(filter(filterContext, { name: 'search' } as never)).resolves.toBe(true)
    sdkExtensionEnabled = false
    await expect(filter(filterContext, { name: 'search' } as never)).resolves.toBe(false)

    await integration.close()
    expect(closed).toBe(true)
  })
})

function enableTestMcp(
  config: ReturnType<typeof defaultRuntimeConfig>,
  approval: 'always' | 'never',
): void {
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
      approval,
      timeoutMs: 1000,
    }],
  }
}
