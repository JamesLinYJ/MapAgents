// +-------------------------------------------------------------------------
//
//   地理智能平台 - Chat Completions SDK Model 契约测试
//
//   文件:       deepSeekChatCompletionsModel.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ModelRequest, ResponseStreamEvent } from '@openai/agents'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { DeepSeekChatCompletionsModel, mergeDeltaOrSnapshot } from './deepSeekChatCompletionsModel.js'

describe('DeepSeekChatCompletionsModel', () => {
  it('normalizes standard text and DeepSeek reasoning streams', async () => {
    const model = createModel([
      chunk({ reasoning_content: '先分析' }),
      chunk({ content: '答案' }, 'stop', {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 1,
      }),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')

    expect(events.some(event => event.type === 'output_text_delta' && event.delta === '答案')).toBe(true)
    expect(done?.response.output).toContainEqual({
      type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '先分析' }],
    })
    expect(done?.response.usage.totalTokens).toBe(5)
    expect(done?.response.usage.inputTokensDetails).toContainEqual(expect.objectContaining({
      prompt_cache_hit_tokens: 2,
      prompt_cache_miss_tokens: 1,
    }))
  })

  it('keeps DeepSeek reasoning and final content on mutually exclusive stream channels', async () => {
    const model = createModel([
      chunk({
        reasoning_content: '先分析',
        content: '{"intermediate":true}',
      }),
      chunk({ content: '{"artifactIds":[],"markdown":"完成","summary":"完成","warnings":[]}' }, 'stop'),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output_text_delta',
      delta: '{"intermediate":true}',
    }))
    expect(done?.response.output).toContainEqual(expect.objectContaining({
      type: 'message',
      content: [{
        type: 'output_text',
        text: '{"artifactIds":[],"markdown":"完成","summary":"完成","warnings":[]}',
      }],
    }))
  })

  it('normalizes cumulative content snapshots without duplicating structured output', async () => {
    const partial = '{"artifactIds":[],"markdown":"完成"'
    const complete = `${partial},"summary":"完成","warnings":[]}`
    const model = createModel([
      chunk({ content: partial }),
      chunk({ content: complete }, 'stop'),
    ])

    const events = await collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
    })))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')
    const deltas = events
      .filter((event): event is Extract<ResponseStreamEvent, { type: 'output_text_delta' }> => event.type === 'output_text_delta')
      .map(event => event.delta)

    expect(deltas.join('')).toBe(complete)
    expect(done?.response.output).toContainEqual(expect.objectContaining({
      type: 'message',
      content: [{ type: 'output_text', text: complete }],
    }))
  })

  it('rejects invalid DeepSeek json_object content at the provider boundary', async () => {
    const model = createModel([
      chunk({ content: '{"summary":"完成"} trailing' }, 'stop'),
    ])

    await expect(collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
    })))).rejects.toThrow('DeepSeek JSON Output 未返回单个合法 JSON object')
  })

  it('applies structured-output validation only to the final non-tool response', async () => {
    const model = createModel([
      chunk({
        content: '先查询图层',
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'query_layer', arguments: '{"layerKey":"hangzhou_districts"}' },
        }],
      }, 'tool_calls'),
    ])

    const events = await collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
    })))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')

    expect(done?.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call',
      callId: 'call_1',
      name: 'query_layer',
    }))
  })

  it('accepts both incremental and full-snapshot tool argument frames', async () => {
    const model = createModel([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_layer', arguments: '{"layer"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"layer":"roads"}' } }] }, 'tool_calls'),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')
    expect(done?.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call', callId: 'call_1', name: 'query_layer', arguments: '{"layer":"roads"}',
    }))
    expect(mergeDeltaOrSnapshot('{"a"', ':1}')).toBe('{"a":1}')
  })

  it('does not project whitespace-only DeepSeek content as an assistant history message', async () => {
    const model = createModel([
      chunk({
        content: '         ',
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'list_layers', arguments: '{"query":"杭州"}' },
        }],
      }, 'tool_calls'),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')

    expect(done?.response.output).toEqual([
      expect.objectContaining({ type: 'function_call', callId: 'call_1', name: 'list_layers' }),
    ])
  })

  it('fails malformed tool arguments instead of manufacturing an empty object', async () => {
    const model = createModel([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_layer', arguments: '{bad' } }] }, 'tool_calls'),
    ])
    await expect(collect(model.getStreamedResponse(request()))).rejects.toThrow(/JSON/u)
  })

  it('rejects Responses-only state', async () => {
    const model = createModel([])
    await expect(collect(model.getStreamedResponse(request({ conversationId: 'conv_1' })))).rejects.toThrow(/conversationId/u)
  })

  it('rejects Responses-only fields injected through providerData', async () => {
    const model = createModel([])
    await expect(collect(model.getStreamedResponse(request({
      modelSettings: {
        providerData: { previous_response_id: 'resp_1' },
      },
    })))).rejects.toThrow(/previous_response_id/u)
    await expect(collect(model.getStreamedResponse(request({
      modelSettings: {
        providerData: { context_management: [{ type: 'compaction' }] },
      },
    })))).rejects.toThrow(/context_management/u)
  })

  // 历史 reasoning 只属于 UI/replay 诊断，不得变成 Chat Completions 的空 assistant 消息。
  it('drops reasoning-only history when serializing Chat Completions messages', async () => {
    let observedMessages: unknown[] = []
    const client = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            observedMessages = params.messages
            return (async function* () {
              yield chunk({ content: '继续回答' }, 'stop')
            })()
          },
        },
      },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    await collect(model.getStreamedResponse(request({
      input: [
        { type: 'message', role: 'user', content: '上一轮问题' },
        { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '内部推理，不进模型历史' }] },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '上一轮可见回答' }],
        },
      ],
    })))

    expect(observedMessages).toEqual([
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮可见回答' },
    ])
  })

  it('omits auto tool choice in thinking mode and rejects unsupported explicit choices', async () => {
    const observedRequests: Array<Record<string, unknown>> = []
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            observedRequests.push(params)
            return (async function* () {
              yield chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, 'tool_calls')
            })()
          },
        },
      },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    await expect(collect(model.getStreamedResponse(request({
      modelSettings: { parallelToolCalls: false, toolChoice: 'required', reasoning: { effort: 'high' } },
      tools: [serializedTool('probe')],
    })))).rejects.toThrow('DeepSeek V4 thinking 模式不支持显式 toolChoice')
    await collect(model.getStreamedResponse(request({
      modelSettings: {
        parallelToolCalls: false,
        toolChoice: 'required',
        reasoning: { effort: 'high' },
        providerData: { thinking: { type: 'disabled' } },
      },
      tools: [serializedTool('probe')],
    })))
    await collect(model.getStreamedResponse(request({
      modelSettings: { parallelToolCalls: false, toolChoice: 'auto', reasoning: { effort: 'high' } },
      tools: [serializedTool('probe')],
    })))

    expect(observedRequests[0]).toMatchObject({
      tool_choice: 'required',
      thinking: { type: 'disabled' },
    })
    expect(observedRequests[0]).not.toHaveProperty('reasoning_effort')
    expect(observedRequests[1]).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    })
    expect(observedRequests[1]).not.toHaveProperty('tool_choice')
    expect(observedRequests.every(item => !('cache_control' in item))).toBe(true)
    expect(observedRequests.every(item => !('parallel_tool_calls' in item))).toBe(true)
    expect(observedRequests.every(item => !('previous_response_id' in item))).toBe(true)
    expect(observedRequests.every(item => !('conversation' in item))).toBe(true)
  })

  it('stabilizes tool and JSON schema ordering for DeepSeek prefix caching', async () => {
    let observed: Record<string, unknown> | undefined
    const client = {
      chat: { completions: { create: async (params: Record<string, unknown>) => {
        observed = params
        return (async function* () { yield chunk({ content: '完成' }, 'stop') })()
      } } },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })
    await collect(model.getStreamedResponse(request({
      tools: [
        { ...serializedTool('z_tool'), parameters: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } } },
        serializedTool('a_tool'),
      ],
    })))

    const tools = observed?.tools as Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }>
    expect(tools.map(tool => tool.function.name)).toEqual(['a_tool', 'z_tool'])
    expect(Object.keys(tools[1]?.function.parameters.properties ?? {})).toEqual(['a', 'z'])
    expect(tools.every(tool => !('strict' in tool.function))).toBe(true)
  })

  it('bridges SDK structured output to DeepSeek json_object with a stable schema instruction', async () => {
    let observed: Record<string, unknown> | undefined
    const client = {
      chat: { completions: { create: async (params: Record<string, unknown>) => {
        observed = params
        return (async function* () {
          yield chunk({ content: '{"markdown":"完成","summary":"完成","artifactIds":[],"warnings":[]}' }, 'stop')
        })()
      } } },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })
    await collect(model.getStreamedResponse(request({
      systemInstructions: '保持回答可靠。',
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            warnings: { type: 'array', items: { type: 'string' } },
            markdown: { type: 'string' },
            summary: { type: 'string' },
            artifactIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['markdown', 'summary', 'artifactIds', 'warnings'],
          additionalProperties: false,
        },
      },
    })))

    expect(observed?.response_format).toEqual({ type: 'json_object' })
    expect(observed?.response_format).not.toHaveProperty('json_schema')
    const system = (observed?.messages as Array<{ role: string; content: string }>)[0]
    expect(system).toMatchObject({ role: 'system' })
    expect(system?.content).toContain('保持回答可靠。')
    expect(system?.content).toContain('JSON 必须严格符合以下 schema')
    expect(system?.content).toContain('"artifactIds"')
    expect(system?.content).toContain('EXAMPLE JSON OUTPUT:')
    expect(system?.content).toContain('{"artifactIds":[],"markdown":"示例","summary":"示例","warnings":[]}')
  })

  it('keeps DeepSeek JSON Output enabled while tool calling', async () => {
    let observed: Record<string, unknown> | undefined
    const client = {
      chat: { completions: { create: async (params: Record<string, unknown>) => {
        observed = params
        return (async function* () {
          yield chunk({ tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'probe', arguments: '{}' },
          }] }, 'tool_calls')
        })()
      } } },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    await collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
      tools: [serializedTool('probe')],
    })))

    expect(observed?.response_format).toEqual({ type: 'json_object' })
    const system = (observed?.messages as Array<{ role: string; content: string }>)[0]
    expect(system?.content).toContain('最终回答必须只包含一个有效 JSON object')
  })

  it('keeps tools available while retrying an invalid structured response before any tool result', async () => {
    let calls = 0
    const observed: Array<Record<string, unknown>> = []
    const valid = '{"artifactIds":[],"markdown":"完成","summary":"完成","warnings":[]}'
    const client = {
      chat: { completions: { create: async (params: Record<string, unknown>) => {
        calls += 1
        observed.push(params)
        return (async function* () {
          yield chunk({ content: calls < 3 ? ' ' : valid }, 'stop', {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_cache_hit_tokens: 6,
            prompt_cache_miss_tokens: 4,
          })
        })()
      } } },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    const events = await collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
      tools: [serializedTool('probe')],
    })))
    const deltas = events
      .filter((event): event is Extract<ResponseStreamEvent, { type: 'output_text_delta' }> => event.type === 'output_text_delta')
      .map(event => event.delta)

    expect(calls).toBe(3)
    expect(observed[0]?.tools).toBeDefined()
    expect(observed[1]?.tools).toBeDefined()
    expect(observed[2]?.tools).toBeDefined()
    expect(observed[2]?.thinking).toEqual({ type: 'disabled' })
    const secondMessages = observed[1]?.messages as Array<{ role: string; content: string }>
    const thirdMessages = observed[2]?.messages as Array<{ role: string; content: string }>
    expect(secondMessages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<structured_output_retry attempt="1">'),
    })
    expect(secondMessages.at(-1)?.content).not.toContain('英文自述')
    expect(thirdMessages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<structured_output_retry attempt="2">'),
    })
    expect(secondMessages.at(-1)?.content).not.toBe(thirdMessages.at(-1)?.content)
    expect(deltas.join('')).toBe(valid)
    expect(events.filter(event => event.type === 'response_started')).toHaveLength(1)
    expect(events.filter(event => event.type === 'response_done')).toHaveLength(1)
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')
    expect(done?.response.usage).toMatchObject({
      requests: 3,
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
    })
    expect(done?.response.usage.inputTokensDetails).toHaveLength(3)
  })

  it('uses a non-thinking, tool-free finalization retry after an executed tool result', async () => {
    let calls = 0
    const observed: Array<Record<string, unknown>> = []
    const valid = '{"artifactIds":[],"markdown":"完成","summary":"完成","warnings":[]}'
    const client = {
      chat: { completions: { create: async (params: Record<string, unknown>) => {
        calls += 1
        observed.push(params)
        return {
          id: `response_${calls}`,
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: calls < 3 ? '' : valid },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
      } } },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    const response = await model.getResponse(request({
      input: [
        { type: 'message', role: 'user', content: '查询图层' },
        { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '需要调用查询工具' }] },
        { type: 'function_call', status: 'completed', callId: 'call_1', name: 'probe', arguments: '{}' },
        { type: 'function_call_result', status: 'completed', callId: 'call_1', name: 'probe', output: { type: 'text', text: '查询完成' } },
      ],
      modelSettings: {
        parallelToolCalls: false,
        reasoning: { effort: 'high' },
        providerData: { thinking: { type: 'enabled' } },
      },
      outputType: {
        type: 'json_schema',
        name: 'delivery',
        strict: true,
        schema: { type: 'object' },
      },
      tools: [serializedTool('probe')],
    }))

    expect(calls).toBe(3)
    expect(observed[0]?.tools).toBeDefined()
    expect(observed[1]?.tools).toBeUndefined()
    expect(observed[2]?.tools).toBeUndefined()
    expect(observed[1]?.thinking).toEqual({ type: 'disabled' })
    expect(observed[1]).not.toHaveProperty('reasoning_effort')
    const retryMessages = observed[1]?.messages as Array<{ role: string; content: string }>
    expect(retryMessages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('只输出一个以 { 开始、以 } 结束'),
    })
    expect(response.usage).toMatchObject({
      requests: 3,
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6,
    })
    expect(response.usage.requestUsageEntries).toHaveLength(3)
    expect(response.output).toContainEqual(expect.objectContaining({
      type: 'message',
      content: [{ type: 'output_text', text: valid }],
    }))
  })

  it('rejects non-object structured output that DeepSeek json_object cannot represent', async () => {
    const model = createModel([])
    await expect(collect(model.getStreamedResponse(request({
      outputType: {
        type: 'json_schema',
        name: 'unsupported_scalar',
        strict: true,
        schema: { type: 'string' },
      },
    })))).rejects.toThrow('只支持 JSON object 根类型')
  })

  it('replays DeepSeek reasoning on its assistant tool-call message', async () => {
    let observedMessages: unknown[] = []
    const client = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            observedMessages = params.messages
            return (async function* () {
              yield chunk({ content: '继续回答' }, 'stop')
            })()
          },
        },
      },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })

    await collect(model.getStreamedResponse(request({
      input: [
        { type: 'message', role: 'user', content: '查询图层' },
        { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '需要调用查询工具' }] },
        { type: 'function_call', status: 'completed', callId: 'call_1', name: 'query_layer', arguments: '{"layerKey":"roads"}' },
        { type: 'function_call_result', status: 'completed', callId: 'call_1', name: 'query_layer', output: { type: 'text', text: '查询完成' } },
      ],
    })))

    expect(observedMessages).toEqual([
      { role: 'user', content: '查询图层' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: '需要调用查询工具',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'query_layer', arguments: '{"layerKey":"roads"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '查询完成' },
    ])
  })

  // DeepSeek 流可能先发送只有 role/id 的帧；此时断线尚未产生语义输出，允许 Runner 安全重试一次。
  it('keeps role-only frames invisible so a pre-semantic network failure is replay-safe', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => (async function* () {
            yield chunk({ role: 'assistant' })
            throw new Error('terminated')
          })(),
        },
      },
    } as unknown as OpenAI
    const model = new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })
    const modelRequest = request()
    const events: ResponseStreamEvent[] = []
    let failure: unknown
    try {
      for await (const event of model.getStreamedResponse(modelRequest)) events.push(event)
    } catch (error) {
      failure = error
    }

    expect(events).toEqual([])
    expect(model.getRetryAdvice({ request: modelRequest, error: failure, stream: true, attempt: 1 }))
      .toMatchObject({ suggested: true, replaySafety: 'safe' })
  })
})

function createModel(chunks: unknown[]) {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          for (const value of chunks) yield value
        })(),
      },
    },
  } as unknown as OpenAI
  return new DeepSeekChatCompletionsModel({ client, model: 'deepseek-v4-pro' })
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: [{ role: 'user', content: '测试' }],
    modelSettings: { parallelToolCalls: false },
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
    ...overrides,
  }
}

function serializedTool(name: string): ModelRequest['tools'][number] {
  return {
    type: 'function',
    name,
    description: '兼容性探针',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    strict: false,
  }
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>,
) {
  return {
    id: 'response_1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

async function collect(stream: AsyncIterable<ResponseStreamEvent>): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
