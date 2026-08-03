// +-------------------------------------------------------------------------
//
//   地理智能平台 - 短时临近预报工具
//
//   文件:       nowcastTools.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 短临预报文本直接采用领域 Worker 的确定性结果，不再调用模型复述。
// --------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import {
  numberParameter,
  refParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  artifactTarget,
  coordinateFromRef,
  featureCollectionFromBoundaryRef,
  isRecord,
  mergeArtifactMetadata,
  miniAppDisplay,
  nowcastRenderBbox,
  optionalRefValue,
  refObject,
  requiredCandidateText,
  requiredRefKind,
  requiredText,
  rasterTileDisplay,
  result,
  resultRefs,
  selectNowcastMapCandidate,
} from './toolRuntime.js'

const AUTOMATION_TOOL_OPTIONS: Pick<ToolDef, 'executionSurfaces'> = {
  executionSurfaces: ['automation', 'debug'],
}

export function createNowcastMeteorologyTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool('create_nowcast_sequence', '创建短时临近预报序列', '从当前线程气象文件集合创建短时临近预报序列引用；仅用于短时临近预报问答、连续时次分析和区域累计面雨量排行表，不作为短时强降水风险区划图 dataset_ref', {
      file_collection_ref: refParameter('文件集合引用', ['meteorological_file_collection']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      horizon_minutes: { ...numberParameter('预报时效（分钟）'), type: 'integer', minimum: 5, maximum: 360 },
    }, withMeteorologyDeps(deps, createNowcastSequence), ['file_collection_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('inspect_nowcast_sequence', '检查短时临近预报序列', '检查短时临近预报序列每个时次的数据集', {
      sequence_ref: refParameter('短时临近预报序列引用', ['nowcast_sequence']),
    }, withMeteorologyDeps(deps, inspectNowcastSequence), ['sequence_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('prepare_nowcast_scope', '准备短时临近预报范围', '根据问题和已有边界/坐标引用准备区划或地点范围', {
      question: textParameter('短时临近预报（短临）问题'),
      scope_ref: refParameter('已有边界或地点引用', ['feature_collection', 'nowcast_area', 'layer', 'nowcast_coordinate', 'place_candidate']),
      area_name: textParameter('区划名称'),
      district_name_field: textParameter('区划名称字段'),
    }, prepareNowcastScope, ['question'], AUTOMATION_TOOL_OPTIONS),
    tool('meteorological_precipitation_nowcast', '分析短时临近预报（短临）降水', '按时次和区划或地点范围计算降水统计事实', {
      sequence_ref: refParameter('短时临近预报序列引用', ['nowcast_sequence']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      scope_ref: refParameter('区划或地点范围引用', ['nowcast_area', 'nowcast_coordinate', 'feature_collection', 'layer', 'place_candidate']),
    }, withMeteorologyDeps(deps, analyzeNowcast), ['sequence_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('answer_nowcast_question', '回答短时临近预报（短临）问题', '根据短时临近预报（短临）分析事实回答明确问题并生成代表时次地图', {
      nowcast_analysis_ref: refParameter('短时临近预报（短临）分析引用', ['nowcast_analysis']),
      question: textParameter('问题'),
    }, withMeteorologyDeps(deps, answerNowcast), ['nowcast_analysis_ref', 'question'], AUTOMATION_TOOL_OPTIONS),
    tool('generate_nowcast_forecast_text', '生成短时临近预报（短临）预报文本', '保存领域 Worker 根据短时临近预报（短临）分析事实生成的确定性文本', {
      nowcast_analysis_ref: refParameter('短时临近预报（短临）分析引用', ['nowcast_analysis']),
    }, withMeteorologyDeps(deps, generateNowcastText), ['nowcast_analysis_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('render_nowcast_raster', '渲染短时临近预报（短临）栅格', '生成短时临近预报候选时次 COG 地图与 PNG 预览', {
      nowcast_map_candidate_ref: refParameter('短时临近预报（短临）地图候选引用', ['nowcast_map_candidate']),
    }, withMeteorologyDeps(deps, renderNowcastRaster), ['nowcast_map_candidate_ref'], AUTOMATION_TOOL_OPTIONS),
  ]
}

async function createNowcastSequence(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'file_collection_ref', ['meteorological_file_collection']).value)
  if (!Array.isArray(collection.files) || collection.files.length < 2) throw new Error('短时临近预报序列至少需要两个气象文件')
  const variable = optionalRefValue(ctx, args, 'variable_ref', 'name')
  const horizonMinutes = args.horizon_minutes === undefined ? undefined : Number(args.horizon_minutes)
  if (horizonMinutes !== undefined && (!Number.isInteger(horizonMinutes) || horizonMinutes < 5 || horizonMinutes > 360)) {
    throw new Error('horizon_minutes 必须是 5 到 360 之间的整数')
  }
  const worker = await deps.callWorker('create_nowcast_sequence', {
    files: collection.files,
    variable,
    horizon_minutes: horizonMinutes,
  }, ctx.signal)
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列',
    value: worker.payload,
  }
  return result('create_nowcast_sequence', worker.message, worker.payload, [ref])
}

async function inspectNowcastSequence(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const sequence = refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value)
  const worker = await deps.callWorker('inspect_nowcast_sequence', { sequence }, ctx.signal)
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_sequence_inspection', label: '短时临近预报序列检查', value: worker.payload }
  return result('inspect_nowcast_sequence', worker.message, worker.payload, [ref])
}

async function prepareNowcastScope(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const question = requiredText(args, 'question')
  const requestedArea = typeof args.area_name === 'string' && args.area_name.trim()
    ? args.area_name.trim()
    : stripNowcastQuestion(question)
  const scopeRefId = typeof args.scope_ref === 'string' ? args.scope_ref.trim() : ''

  if (scopeRefId) {
    const scopeRef = requiredRefKind(ctx, args, 'scope_ref', ['feature_collection', 'nowcast_area', 'layer', 'nowcast_coordinate', 'place_candidate'])
    if (scopeRef.kind === 'nowcast_coordinate' || scopeRef.kind === 'place_candidate') {
      const coordinate = coordinateFromRef(scopeRef)
      const ref: ValueRef = {
        refId: makeId('ref'),
        kind: 'nowcast_coordinate',
        label: coordinate.label,
        value: coordinate,
        metadata: { sourceRef: scopeRef.refId },
      }
      return result('prepare_nowcast_scope', `已准备地点范围：${coordinate.label}`, {
        scopeType: 'coordinate', label: coordinate.label,
      }, [ref])
    }

    const boundary = featureCollectionFromBoundaryRef(scopeRef, 'scope_ref')
    const districtNameField = typeof args.district_name_field === 'string' && args.district_name_field.trim()
      ? args.district_name_field.trim()
      : typeof scopeRef.metadata?.districtNameField === 'string'
        ? scopeRef.metadata.districtNameField
        : 'name'
    const features = requestedArea
      ? boundary.features.filter(feature => isRecord(feature) && isRecord(feature.properties) && feature.properties[districtNameField] === requestedArea)
      : boundary.features
    if (!features.length) throw new Error(`已有区划边界中未找到 ${requestedArea}`)
    const collection = { type: 'FeatureCollection', features }
    const ref: ValueRef = {
      refId: makeId('ref'),
      kind: 'nowcast_area',
      label: requestedArea || '区划边界',
      value: collection,
      metadata: { sourceRef: scopeRef.refId, districtNameField },
    }
    const boundaryRef: ValueRef = {
      refId: makeId('ref'),
      kind: 'feature_collection',
      label: requestedArea ? `${requestedArea}区划边界` : '区划边界',
      value: collection,
      metadata: { sourceRef: scopeRef.refId, districtNameField, purpose: 'nowcast_scope' },
    }
    return result('prepare_nowcast_scope', `已准备 ${features.length} 个区划范围`, {
      scopeType: 'area', label: ref.label, featureCount: features.length,
    }, [ref, boundaryRef])
  }

  throw new Error('短时临近预报范围必须来自平台已有图层、上传边界或当前 run 的 valueRef。请先使用 list_layers 检索目标区划图层，或提供 nowcast_coordinate/place_candidate 引用；本工具不会联网解析地点或伪造边界。')
}

async function analyzeNowcast(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const sequence = refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value)
  const scope = optionalScope(ctx, args)
  const worker = await deps.callWorker('meteorological_precipitation_nowcast', {
    sequence,
    variable: optionalRefValue(ctx, args, 'variable_ref', 'name') ?? sequence.variable,
    ...scope,
  }, ctx.signal)
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'nowcast_analysis', label: '短时临近预报（短临）降水分析', value: worker.payload,
  }]
  const candidates = Array.isArray(worker.payload.mapCandidates) ? worker.payload.mapCandidates.filter(isRecord) : []
  for (const item of candidates) {
    refs.push({
      refId: makeId('ref'), kind: 'nowcast_map_candidate', label: String(item.label ?? item.filename ?? '短时临近预报（短临）地图候选'),
      value: item,
    })
  }
  return result('meteorological_precipitation_nowcast', worker.message, worker.payload, refs)
}

function stripNowcastQuestion(question: string): string {
  return question
    .replace(/[？?。]/gu, '')
    .replace(/未来三小时|未来3小时|接下来|短时临近预报（短临）|降水|降雨|天气怎么样|天气如何|会不会下雨|会下雨吗|下雨吗/gu, '')
    .trim()
}

function optionalScope(ctx: ToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const refId = args.scope_ref
  if (typeof refId !== 'string' || !refId.trim()) return {}
  const ref = ctx.resolveValueRef(refId)
  if (ref.kind === 'nowcast_area' || ref.kind === 'feature_collection') {
    return {
      area: ref.value,
      district_name_field: typeof ref.metadata?.districtNameField === 'string' ? ref.metadata.districtNameField : undefined,
    }
  }
  if (ref.kind === 'nowcast_coordinate' || ref.kind === 'place_candidate') {
    const value = refObject(ref.value)
    return {
      coordinate: {
        lat: Number(value.lat),
        lng: Number(value.lng ?? value.lon),
        label: typeof value.label === 'string' ? value.label : ref.label,
      },
      point_buffer_meters: 1000,
    }
  }
  if (ref.kind === 'bbox') return { bbox: ref.value }
  throw new Error(`scope_ref 必须引用区划、地点坐标或 bbox，实际为 ${ref.kind}`)
}

async function answerNowcast(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const analysis = refObject(requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value)
  const worker = await deps.callWorker(
    'answer_nowcast_question',
    { analysis, question: requiredText(args, 'question') },
    ctx.signal,
  )
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_answer', label: '短时临近预报（短临）问题回答事实', value: worker.payload }
  const candidate = selectNowcastMapCandidate(analysis)
  const rendered = await renderCandidateArtifacts(
    ctx,
    deps,
    candidate,
    `${String(candidate.label ?? '代表时次')} 短时临近预报（短临）降水`,
    nowcastRenderBbox(analysis),
  )
  return result('answer_nowcast_question', worker.message, {
    ...worker.payload,
    map: {
      artifactId: rendered.map.artifactId,
      label: rendered.map.name,
      reason: candidate.reason ?? null,
      leadMinutes: candidate.leadMinutes ?? null,
    },
  }, [ref], [rendered.preview, rendered.map])
}

async function generateNowcastText(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const analysis = requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value
  const facts = await deps.callWorker('generate_nowcast_forecast_text', { analysis }, ctx.signal)
  const text = typeof facts.payload.answer === 'string' ? facts.payload.answer.trim() : ''
  if (!text) throw new Error('短时临近预报（短临）领域服务未生成可用预报事实文本')
  const payload = { forecastText: text, facts: facts.payload }
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'nowcast_forecast_text',
    label: '短时临近预报（短临）预报文本',
    value: { text, facts: facts.payload },
  }
  return result('generate_nowcast_forecast_text', '短时临近预报（短临）领域文本已生成', payload, [ref])
}

async function renderNowcastRaster(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const candidate = refObject(requiredRefKind(ctx, args, 'nowcast_map_candidate_ref', ['nowcast_map_candidate']).value)
  const rendered = await renderCandidateArtifacts(ctx, deps, candidate, '短时临近预报（短临）降水栅格')
  return result(
    'render_nowcast_raster',
    rendered.worker.message,
    rendered.worker.payload,
    resultRefs('render_nowcast_raster', '短时临近预报（短临）栅格', rendered.worker.payload),
    [rendered.preview, rendered.map],
  )
}

async function renderCandidateArtifacts(
  ctx: ToolContext,
  deps: MeteorologyToolDeps,
  candidate: Record<string, unknown>,
  title: string,
  bbox?: number[],
) {
  const preview = artifactTarget(ctx, 'png', `${title}预览`)
  const map = artifactTarget(ctx, 'tif', title)
  const worker = await deps.callWorker('render_nowcast_raster', {
    file_relative_path: requiredCandidateText(candidate, 'relativePath'),
    file_name: typeof candidate.filename === 'string' ? candidate.filename : undefined,
    variable: requiredCandidateText(candidate, 'variable'),
    bbox,
    output_relative_path: preview.relativePath,
    output_cog_relative_path: map.relativePath,
  }, ctx.signal)
  const metadata = {
    ...worker.payload,
    nowcastCandidate: candidate,
    nowcastMapReason: candidate.reason ?? null,
    nowcastLeadMinutes: candidate.leadMinutes ?? null,
  }
  mergeArtifactMetadata(preview, metadata, miniAppDisplay())
  mergeArtifactMetadata(
    map,
    metadata,
    rasterTileDisplay(map, worker.payload, map.name, 'meteorological-nowcast-precipitation'),
  )
  return { preview, map, worker }
}
