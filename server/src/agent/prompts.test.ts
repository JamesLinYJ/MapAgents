import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { buildSystemPrompt } from './prompts.js'

describe('system prompt', () => {
  it('includes SDK MCP and Skill instructions without legacy product names', () => {
    const config = defaultRuntimeConfig()
    config.sdk.mcp = {
      enabled: true,
      connectTimeoutMs: 1000,
      closeTimeoutMs: 1000,
      servers: [{
        enabled: true,
        name: 'docs',
        description: '项目文档检索',
        transport: 'streamable_http',
        executionMode: 'function_tools',
        url: 'http://127.0.0.1:7777/mcp',
        connectorId: null,
        command: null,
        args: [],
        cwd: null,
        env: {},
        headers: {},
        authorizationEnv: null,
        allowedTools: ['search_docs'],
        blockedTools: [],
        includeServerInToolNames: true,
        convertSchemasToStrict: true,
        cacheToolsList: true,
        useStructuredContent: true,
        approval: 'always',
        timeoutMs: 1000,
      }],
    }
    config.sdk.skills = {
      enabled: true,
      skillsPath: '.agents',
      skillPaths: ['skills/reporting'],
      skillRoots: [],
    }

    const prompt = buildSystemPrompt(config, null, '', '', '')

    expect(prompt).toContain('## MCP 服务器指令')
    expect(prompt).toContain('docs')
    expect(prompt).toContain('search_docs')
    expect(prompt).toContain('## Skill 指令')
    expect(prompt).toContain('SKILL.md')
    expect(prompt).not.toMatch(/Claude|Newmap|GeoForge|CLAUDE/u)
  })

  it('keeps platform artifacts distinct from sandbox local files', () => {
    const prompt = buildSystemPrompt(defaultRuntimeConfig(), null, '', '', '')

    expect(prompt).toContain('平台 artifact URI')
    expect(prompt).toContain('不是开发者沙箱本地文件路径')
    expect(prompt).toContain('当前 run 的 Artifact 会按工具返回的「artifacts/<runId>/<filename>」相对路径只读挂载到沙箱')
    expect(prompt).toContain('Artifact 已注册，但视觉内容尚未验证')
  })
})
