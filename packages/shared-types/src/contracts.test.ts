import { describe, expect, it } from 'vitest'
import {
  supervisorDeliverySchema,
} from './runtime.js'
import {
  wsCommandContracts,
  wsCommandContract,
  wsControlCommandSchema,
  wsControlCommands,
} from './transport.js'
import { workerToolCatalogSchema } from './worker.js'

describe('shared boundary contracts', () => {
  it('keeps every advertised WebSocket command mapped to one contract', () => {
    expect(Object.keys(wsCommandContracts).sort()).toEqual([...wsControlCommands].sort())
    expect(wsControlCommandSchema.safeParse('run:start').success).toBe(true)
    expect(wsControlCommandSchema.safeParse('run:unknown').success).toBe(false)

    const runStart = wsCommandContract('run:start')
    expect(runStart.category).toBe('write')
    expect(runStart.csrf).toBe(true)
    expect(runStart.payload.safeParse({ query: '分析杭州降水' }).success).toBe(true)
    expect(runStart.payload.safeParse({ query: '' }).success).toBe(false)
  })

  it('rejects delivery values that are not real artifact references', () => {
    const delivery = {
      markdown: '分析完成。',
      summary: '已生成结果。',
      artifactIds: [],
      warnings: [],
    }
    expect(supervisorDeliverySchema.safeParse(delivery).success).toBe(true)
    expect(supervisorDeliverySchema.safeParse({
      ...delivery,
      artifactIds: ['valueRef_fake'],
    }).success).toBe(false)
  })

  it('validates the Worker catalog envelope and schema hash at the Node boundary', () => {
    const catalog = {
      count: 1,
      tools: [{
        toolName: 'weather_check',
        route: '/tools/weather_check',
        schemaHash: `sha256:${'a'.repeat(64)}`,
        contract: {
          providerId: 'gis-meteorology',
          toolName: 'weather_check',
          version: '1',
          parametersSchema: { type: 'object' },
          resultSchema: { type: 'object' },
        },
      }],
    }
    expect(workerToolCatalogSchema.safeParse(catalog).success).toBe(true)
    expect(workerToolCatalogSchema.safeParse({
      ...catalog,
      tools: [{ ...catalog.tools[0], schemaHash: 'sha256:invalid' }],
    }).success).toBe(false)
  })
})
