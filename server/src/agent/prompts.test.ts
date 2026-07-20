import { describe, expect, it } from 'vitest'

import type { ToolDef } from '../framework/types.js'
import { agentStateSchema } from '../schemas/types.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { buildPlanningCapabilityCatalog, buildSystemPrompt } from './prompts.js'
import { approvalRejectionMessage } from './runtimeApprovals.js'
import { REQUEST_CLARIFICATION_PROMPT } from '../tools/plan/prompts.js'

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

  it('matches structured-workflow instructions to the dynamically visible tool set', () => {
    const state = agentStateSchema.parse({
      sessionId: 'session_1',
      userQuery: '生成杭州短时强降水风险区划图',
      planMode: false,
      agentWorkflow: {
        agentWorkflowId: 'workflow_1',
        goal: '生成杭州短时强降水风险区划图',
        status: 'running',
        revision: 1,
        changeReason: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        steps: [{
          stepId: 'step_1',
          title: '生成风险区划图',
          kind: 'tool',
          toolName: 'render_rainfall_risk_map',
          ownerAgentId: 'supervisor',
          args: {},
          reason: '交付地图',
          dependsOn: [],
          status: 'running',
          attempt: 1,
          resultSummary: null,
          errorMessage: null,
          startedAt: '2026-07-20T00:00:00.000Z',
          completedAt: null,
        }],
      },
    })
    const config = defaultRuntimeConfig()
    config.sdk.mcp.enabled = true
    config.sdk.skills.enabled = true
    const prompt = buildSystemPrompt(config, state, '', '', '')

    expect(prompt).toContain('沙箱、文件系统、Shell、MCP 与 Skill 工具当前不可用')
    expect(prompt).toContain('直接基于这些结果形成中文结论')
    expect(prompt).toContain('不得把内部工具协议、XML 标签、伪函数调用或工具参数写进对用户可见的正文')
    expect(prompt).not.toContain('才可用 view_image 检查图片')
    expect(prompt).not.toContain('## MCP 服务器指令')
    expect(prompt).not.toContain('## Skill 指令')
  })

  it('keeps parent-agent synthesis outside the executable workflow', () => {
    const prompt = buildSystemPrompt(defaultRuntimeConfig(), null, '', '', '')

    expect(prompt).toContain('## 已配置协作智能体')
    expect(prompt).toContain('spatial_analyst（空间分析助手；Agent-as-tool，完成后返回主智能体）')
    expect(prompt).toContain('本目录只用于识别用户指定的负责人，不表示当前阶段已经允许调用')
    expect(prompt).toContain('Agent-as-tool 与只读并行批次结果会返回父智能体')
    expect(prompt).toContain('存在匹配 Agent 时保留用户指定的负责人')
    expect(prompt).toContain('不得由 supervisor 静默代办')
    expect(prompt).toContain('最终汇总、解释和普通正文交付不是 workflow 步骤')
    expect(prompt).toContain('不得用 todo_write 代表“主智能体汇总”')
    expect(prompt).toContain('用户限定步骤数量、负责人或交付形式时不得擅自扩展')
  })

  it('treats current tool and automation schemas as authoritative over memory', () => {
    const state = agentStateSchema.parse({ sessionId: 'session_1', userQuery: '测试', planMode: true })
    const prompt = buildSystemPrompt(defaultRuntimeConfig(), state, '', '', '')

    expect(prompt).toContain('不得搜索或读取长期记忆来确认工具/Automation')
    expect(prompt).toContain('当前工具注册表、执行能力目录、Automation 清单和参数 Schema 是能力契约')
  })

  it('asks for the rejection reason without discovery or policy bypasses', () => {
    const prompt = buildSystemPrompt(defaultRuntimeConfig(), null, '', '', '')
    const rejection = approvalRejectionMessage('submit_agent_workflow')

    expect(prompt).toContain('不要先调用其它发现或业务工具')
    expect(prompt).toContain('不得建议绕过 Automation、审批、权限、真实数据')
    expect(REQUEST_CLARIFICATION_PROMPT).toContain('用户退回工作流但没有提供原因')
    expect(rejection).toContain('请立即调用 request_clarification')
  })

  it('describes exact planning parameters and subagent permission boundaries', () => {
    const config = defaultRuntimeConfig()
    const catalog = buildPlanningCapabilityCatalog([{
      name: 'query_layer',
      label: '查询图层',
      description: '读取真实图层要素。',
      prompt: '测试',
      group: '空间分析',
      tags: [],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: {
        type: 'object',
        properties: {
          layerKey: { type: 'string' },
          resultRef: { type: 'string', 'x-value-ref-kinds': ['feature_collection'] },
        },
        required: ['layerKey'],
      },
      handler: async () => ({
        message: 'ok', payload: {}, warnings: [], resultId: 'result_1', source: 'test',
      }),
    } satisfies ToolDef], config.subAgents)

    expect(catalog).toContain('layerKey: string 必填')
    expect(catalog).toContain('resultRef: string valueRef<feature_collection> 可选')
    expect(catalog).toContain('授权工具 [geocode_place, list_layers, query_layer, spatial_analysis, create_chart]')
    expect(catalog).toContain('objective: string 必填')
    expect(catalog).toContain('expectedDeliverables: string[] 必填')
    expect(catalog).toContain('委派模式 Agent-as-tool（完成后返回主智能体）')
    expect(catalog).toContain('最大运行轮次 12')
    expect(catalog).toContain('单次调用超时 120000ms')
  })

  it('does not advertise terminal handoffs as return-to-supervisor workflow steps', () => {
    const config = defaultRuntimeConfig()
    config.subAgents[0] = {
      ...config.subAgents[0]!,
      agentId: 'terminal_specialist',
      delegationMode: 'handoff',
    }

    const catalog = buildPlanningCapabilityCatalog([], config.subAgents)

    expect(catalog).not.toContain('terminal_specialist')
  })
})
