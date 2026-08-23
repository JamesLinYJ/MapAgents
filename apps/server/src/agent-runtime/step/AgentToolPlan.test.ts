// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求工具计划测试
//
//   文件:       AgentToolPlan.test.ts
//
//   日期:       2026年08月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import { describe, expect, it } from 'vitest'

import {
  createAgentToolPlan,
  type AgentToolPlanSource,
} from './AgentToolPlan.js'

describe('AgentToolPlan', () => {
  it('binds only the exact serialized tools and handoffs sent in one model request', () => {
    const request = modelRequest({
      tools: [{
        type: 'function',
        name: 'query_layer',
        description: '查询当前图层',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        strict: true,
      }],
      handoffs: [{
        toolName: 'handoff_to_reviewer',
        toolDescription: '转交给复核器',
        inputJsonSchema: { type: 'object', properties: {} },
        strictJsonSchema: true,
      }],
    })
    const plan = createAgentToolPlan({
      request,
      sources: [
        source('query_layer', 'platform'),
        source('handoff_to_reviewer', 'handoff'),
        source('disabled_tool', 'platform'),
      ],
    })

    expect(plan.entries.map(entry => entry.name)).toEqual([
      'handoff_to_reviewer',
      'query_layer',
    ])
    expect(plan.entries.find(entry => entry.name === 'query_layer')).toMatchObject({
      kind: 'platform',
      readOnly: true,
      destructive: false,
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.entries)).toBe(true)
  })

  it('changes the digest when the provider-visible definition changes', () => {
    const sources = [source('query_layer', 'platform')]
    const first = createAgentToolPlan({
      request: modelRequest({ tools: [serializedFunction('查询图层')] }),
      sources,
    })
    const second = createAgentToolPlan({
      request: modelRequest({ tools: [serializedFunction('查询并统计图层')] }),
      sources,
    })

    expect(first.catalogDigest).not.toBe(second.catalogDigest)
    expect(first.entries[0]?.schemaDigest).toBe(second.entries[0]?.schemaDigest)
    expect(first.entries[0]?.definitionDigest).not.toBe(second.entries[0]?.definitionDigest)
  })

  it('hard fails when a model-visible definition has no execution source or sources collide', () => {
    const request = modelRequest({ tools: [serializedFunction('查询图层')] })
    expect(() => createAgentToolPlan({ request, sources: [] }))
      .toThrow(/未绑定执行来源/u)
    expect(() => createAgentToolPlan({
      request,
      sources: [source('query_layer', 'platform'), source('query_layer', 'mcp')],
    })).toThrow(/来源 'query_layer' 重复/u)
  })
})

function modelRequest(overrides: Partial<Pick<ModelRequest, 'tools' | 'handoffs'>>): ModelRequest {
  return {
    input: [],
    modelSettings: {},
    tools: overrides.tools ?? [],
    outputType: 'text',
    handoffs: overrides.handoffs ?? [],
    tracing: false,
  }
}

function serializedFunction(description: string): ModelRequest['tools'][number] {
  return {
    type: 'function',
    name: 'query_layer',
    description,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  }
}

function source(
  name: string,
  kind: AgentToolPlanSource['kind'],
): AgentToolPlanSource {
  return {
    name,
    kind,
    providerId: kind === 'platform' ? 'layers' : 'reviewer',
    requiresApproval: false,
    readOnly: kind === 'platform' ? true : null,
    destructive: kind === 'platform' ? false : null,
  }
}
