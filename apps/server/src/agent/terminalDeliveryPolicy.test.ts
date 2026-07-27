// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 终态交付证据策略测试
//
//   文件:       terminalDeliveryPolicy.test.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { evaluateTerminalDelivery } from './terminalDeliveryPolicy.js'

const completeDelivery = {
  markdown: '北京当前 22.7°C，未来三小时降水概率不超过 8%。数据源：Open-Meteo。',
  summary: '北京当前天气及短时降水概率已给出。',
  artifactIds: [],
  warnings: [],
}

describe('evaluateTerminalDelivery', () => {
  it('rejects a preparation sentence presented as a completed answer', () => {
    const decision = evaluateTerminalDelivery({
      query: '帮我分析这个数据',
      delivery: {
        ...completeDelivery,
        markdown: '## 查询西湖位置\n我先查询西湖的精确位置，以便获取准确预报。',
        summary: '我先查询西湖位置。',
      },
      successfulToolNames: new Set(),
    })

    expect(decision).toMatchObject({ accepted: false, code: 'preparation_only' })
    if (!decision.accepted) expect(decision.repairInstruction).toContain('不能展示给用户')
  })

  it('requires current public-weather evidence even when geocoding already succeeded', () => {
    const decision = evaluateTerminalDelivery({
      query: '浙江杭州西湖附近明天会下雨吗？',
      delivery: completeDelivery,
      successfulToolNames: new Set(['geocode_place']),
    })

    expect(decision).toMatchObject({ accepted: false, code: 'fresh_weather_evidence_required' })
  })

  it('accepts a current weather answer backed by the public weather tool', () => {
    expect(evaluateTerminalDelivery({
      query: '北京现在天气怎样？',
      delivery: completeDelivery,
      successfulToolNames: new Set(['query_public_weather']),
    })).toEqual({ accepted: true })
  })

  it('requires public-weather source disclosure', () => {
    const decision = evaluateTerminalDelivery({
      query: '北京现在天气怎样？',
      delivery: {
        ...completeDelivery,
        markdown: '北京当前 22.7°C，未来三小时降水概率不超过 8%。',
      },
      successfulToolNames: new Set(['query_public_weather']),
    })

    expect(decision).toMatchObject({ accepted: false, code: 'public_weather_provenance_invalid' })
  })

  it('rejects false weather-station provenance for Open-Meteo grid data', () => {
    const decision = evaluateTerminalDelivery({
      query: '杭州明天会下雨吗？',
      delivery: {
        ...completeDelivery,
        markdown: '以下预报基于杭州市气象站数据。数据源：Open-Meteo。明天降水概率 75%。',
      },
      successfulToolNames: new Set(['query_public_weather']),
    })

    expect(decision).toMatchObject({ accepted: false, code: 'public_weather_provenance_invalid' })
    if (!decision.accepted) expect(decision.repairInstruction).toContain('数值模式网格')
  })

  it('does not require a live tool for timeless explanatory questions', () => {
    expect(evaluateTerminalDelivery({
      query: '降水概率是什么意思？',
      delivery: {
        ...completeDelivery,
        markdown: '降水概率表示指定时间和区域内出现可测降水的可能性。',
      },
      successfulToolNames: new Set(),
    })).toEqual({ accepted: true })
  })

  it('does not reject a substantive answer merely because it begins with 我先说明', () => {
    expect(evaluateTerminalDelivery({
      query: '解释结果',
      delivery: {
        ...completeDelivery,
        markdown: '我先说明结论：3 个站点均未超过阈值。结果表明当前不需要触发预警，建议继续每小时复核。',
      },
      successfulToolNames: new Set(),
    })).toEqual({ accepted: true })
  })
})
