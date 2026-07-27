// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 终态交付证据策略
//
//   文件:       terminalDeliveryPolicy.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { SupervisorDelivery } from '@geo-agent-platform/shared-types/runtime'

export interface TerminalDeliveryEvidence {
  query: string
  delivery: SupervisorDelivery
  successfulToolNames: ReadonlySet<string>
}

export type TerminalDeliveryDecision =
  | { accepted: true }
  | {
      accepted: false
      code: 'preparation_only' | 'fresh_weather_evidence_required' | 'public_weather_provenance_invalid'
      reason: string
      repairInstruction: string
    }

const WEATHER_TOPIC = /天气|气温|温度|体感|湿度|降水|下雨|雨量|风速|阵风|空气质量|AQI|PM\s*(?:2\.5|10)|臭氧|紫外线|UV|气象预警/iu
const FRESH_TIME_SCOPE = /现在|当前|今天|明天|后天|未来|本周|这周|近期|实时|逐小时|小时|预报/iu
const PREPARATION_ACTION = /(?:我先|我会|我将|接下来|下一步|让我|准备|正在).{0,24}(?:查询|检查|调用|获取|分析|处理|定位|整理)/iu
const CONCRETE_RESULT = /\d|结论|结果|建议|数据来源|未找到|无法|不能|不需要|已完成/iu
const OPEN_METEO_SOURCE = /Open[\s-]?Meteo/iu
const FALSE_STATION_PROVENANCE = /(?:基于|来自|依据|使用).{0,20}(?:气象站|观测站)(?:数据|观测|坐标)?/iu

/**
 * 终态必须是已经完成的可核验回答，而不是“稍后去做”的前置说明。
 * 对时效性公开天气问题，只有本轮真实天气工具结果才能成为交付证据。
 */
export function evaluateTerminalDelivery(evidence: TerminalDeliveryEvidence): TerminalDeliveryDecision {
  const text = `${evidence.delivery.markdown}\n${evidence.delivery.summary}`.trim()
  if (PREPARATION_ACTION.test(text) && (text.length < 180 || !CONCRETE_RESULT.test(text))) {
    return {
      accepted: false,
      code: 'preparation_only',
      reason: '上一版交付只有准备执行的说明，没有给出已经完成的结果。',
      repairInstruction: terminalRepairInstruction('请立即执行所需工具；不要再次用“我先查询”“接下来处理”等计划语气结束。'),
    }
  }

  if (WEATHER_TOPIC.test(evidence.query) && FRESH_TIME_SCOPE.test(evidence.query)
    && !evidence.successfulToolNames.has('query_public_weather')) {
    return {
      accepted: false,
      code: 'fresh_weather_evidence_required',
      reason: '时效性天气回答缺少本轮 query_public_weather 的成功结果，不能作为已完成结论。',
      repairInstruction: terminalRepairInstruction(
        '当前问题需要时效性天气数据。必要时先调用 geocode_place 明确地点，然后必须调用 query_public_weather；只能基于本轮工具结果回答。',
      ),
    }
  }

  if (evidence.successfulToolNames.has('query_public_weather')
    && (!OPEN_METEO_SOURCE.test(text) || FALSE_STATION_PROVENANCE.test(text))) {
    return {
      accepted: false,
      code: 'public_weather_provenance_invalid',
      reason: !OPEN_METEO_SOURCE.test(text)
        ? '公开天气回答没有标明 Open-Meteo 数据来源。'
        : '公开天气回答把 Open-Meteo 数值模式网格误称为气象站数据。',
      repairInstruction: terminalRepairInstruction(
        '本轮 query_public_weather 来自 Open-Meteo 数值模式网格。回答必须注明“数据源：Open-Meteo”，不得写成气象站或观测站数据；坐标只能称为解析地点对应的模式网格点。',
      ),
    }
  }

  return { accepted: true }
}

function terminalRepairInstruction(requirement: string): string {
  return [
    '<terminal_delivery_repair>',
    '上一版结构化交付未通过终态证据校验，不能展示给用户。',
    requirement,
    '获得结果后再提交完整的 supervisorDelivery；若工具失败，明确报告失败，不得把准备动作写成完成结果。',
    '</terminal_delivery_repair>',
  ].join('\n')
}
