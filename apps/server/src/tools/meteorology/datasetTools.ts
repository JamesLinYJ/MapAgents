// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据集工具
//
//   文件:       datasetTools.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import type { MeteorologyWorkerToolName } from './meteorologyWorkerClient.js'
import {
  refParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  artifactTarget,
  assertSuffix,
  datasetFileFromArgs,
  datasetValue,
  geoJsonDisplay,
  isRecord,
  mergeArtifactMetadata,
  miniAppDisplay,
  NETCDF_SUFFIXES,
  optionalRefValue,
  requiredRefKind,
  rasterTileDisplay,
  result,
  resultRefs,
  writeJsonArtifact,
} from './toolRuntime.js'

export function createDatasetMeteorologyTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool('meteorological_inspect', '检查气象数据集', '检查变量、维度、时间、层级和地图能力；未提供参数时使用当前 thread 最新上传的数据集', {
      dataset_ref: refParameter('气象文件引用', ['meteorological_file', 'meteorological_dataset']),
      dataset_id: textParameter('气象数据集 ID，latest_upload 表示当前 thread 最新上传'),
      filename: textParameter('气象数据文件名'),
    }, withMeteorologyDeps(deps, inspectDataset)),
    tool('interpret_meteorological_dataset', '解读气象数据集', '保存经过结构化校验的模型气象解读', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
    }, interpretDataset, ['dataset_ref']),
    workerDatasetTool(deps, 'meteorological_render', '渲染气象栅格', '生成气象变量 COG 地图与 PNG 预览', 'raster', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    workerDatasetTool(deps, 'meteorological_stats', '气象统计', '计算变量统计值', null, {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    workerDatasetTool(deps, 'meteorological_threshold', '气象阈值区域', '计算超过阈值的区域', 'geojson', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      threshold_ref: refParameter('阈值引用', ['meteorological_threshold']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
      operator: textParameter('比较运算符'),
    }, ['dataset_ref', 'variable_ref', 'threshold_ref']),
    workerDatasetTool(deps, 'meteorological_contour', '气象等值线', '生成气象变量等值线', 'geojson', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      levels_ref: refParameter('等值线层级引用', ['meteorological_contour_levels']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    tool('meteorological_report', '生成气象报告', '使用显式模型解读引用生成 DOCX 报告', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      interpretation_ref: refParameter('模型解读引用', ['meteorological_interpretation']),
    }, withMeteorologyDeps(deps, generateReport), ['dataset_ref', 'interpretation_ref'], {
      isReadOnly: false,
      requiresApproval: true,
    }),
  ]
}

function workerDatasetTool(
  deps: MeteorologyToolDeps,
  name: MeteorologyWorkerToolName,
  label: string,
  description: string,
  artifactType: 'raster' | 'geojson' | null,
  properties: Record<string, unknown>,
  required = ['dataset_ref'],
): ToolDef {
  return tool(name, label, description, properties, async (args, ctx) => {
    const file = await datasetFileFromArgs(ctx, args, 'dataset_ref', ['meteorological_dataset'])
    const workerArgs: Record<string, unknown> = {
      file_relative_path: file.relativePath,
      file_name: file.name,
      variable: optionalRefValue(ctx, args, 'variable_ref', 'name'),
      time_index: optionalRefValue(ctx, args, 'time_index_ref'),
      level_index: optionalRefValue(ctx, args, 'level_index_ref'),
      bbox: optionalRefValue(ctx, args, 'bbox_ref'),
      threshold: optionalRefValue(ctx, args, 'threshold_ref'),
      levels: optionalRefValue(ctx, args, 'levels_ref'),
      operator: typeof args.operator === 'string' ? args.operator : undefined,
    }
    let artifact = null
    let previewArtifact = null
    if (artifactType === 'raster') {
      previewArtifact = artifactTarget(ctx, 'png', `${file.name} 栅格预览`)
      artifact = artifactTarget(ctx, 'tif', `${file.name} 科学栅格`)
      workerArgs.output_relative_path = previewArtifact.relativePath
      workerArgs.output_cog_relative_path = artifact.relativePath
    }
    const worker = await deps.callWorker(name, workerArgs, ctx.signal)
    if (artifactType === 'raster' && artifact && previewArtifact) {
      mergeArtifactMetadata(previewArtifact, worker.payload, miniAppDisplay())
      mergeArtifactMetadata(artifact, worker.payload, rasterTileDisplay(artifact, worker.payload))
    }
    if (artifactType === 'geojson') {
      artifact = artifactTarget(ctx, 'geojson', `${file.name} ${label}`)
      await writeJsonArtifact(deps, artifact.relativePath, worker.payload)
      const features = Array.isArray(worker.payload.features) ? worker.payload.features : []
      if (features.length > 0) {
        mergeArtifactMetadata(
          artifact,
          worker.payload,
          geoJsonDisplay(artifact, worker.payload, name === 'meteorological_contour' ? 'line' : 'polygon'),
        )
      } else {
        mergeArtifactMetadata(artifact, worker.payload)
      }
    }
    const refs = resultRefs(name, label, worker.payload)
    const artifacts = [previewArtifact, artifact].filter((item): item is NonNullable<typeof item> => item !== null)
    return result(name, worker.message, worker.payload, refs, artifacts)
  }, required)
}

async function inspectDataset(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const file = await datasetFileFromArgs(ctx, args, 'dataset_ref', ['meteorological_file', 'meteorological_dataset'])
  const worker = await deps.callWorker(
    'meteorological_inspect',
    { file_relative_path: file.relativePath, file_name: file.name },
    ctx.signal,
  )
  const variables = Array.isArray(worker.payload.variables) ? worker.payload.variables.filter(isRecord) : []
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'meteorological_dataset', label: file.name,
    value: { ...file, metadata: worker.payload },
  }]
  for (const variable of variables) {
    refs.push({
      refId: makeId('ref'), kind: 'meteorological_variable',
      label: `${file.name} / ${String(variable.name ?? '')}`,
      value: { name: String(variable.name ?? ''), datasetRelativePath: file.relativePath, metadata: variable },
    })
  }
  if (Array.isArray(worker.payload.bounds)) {
    refs.push({ refId: makeId('ref'), kind: 'bbox', label: `${file.name} 数据范围`, value: worker.payload.bounds })
  }
  const times = Array.isArray(worker.payload.times) ? worker.payload.times : []
  times.forEach((time, index) => {
    refs.push({ refId: makeId('ref'), kind: 'meteorological_time_index', label: `${file.name} / ${String(time)}`, value: index })
  })
  const levels = Array.isArray(worker.payload.levels) ? worker.payload.levels : []
  levels.forEach((level, index) => {
    refs.push({ refId: makeId('ref'), kind: 'meteorological_level_index', label: `${file.name} / ${String(level)}`, value: index })
  })
  return result('meteorological_inspect', worker.message, worker.payload, refs)
}

async function interpretDataset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const datasetRef = requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset'])
  const dataset = datasetValue(ctx, datasetRef)
  const source = isRecord(datasetRef.value) ? datasetRef.value : {}
  const structured = await ctx.invokeStructuredModel(
    `仅根据以下气象数据 metadata 生成 JSON 对象，必须包含 reportText、summary、keyFindings、riskSignals、methodNotes、recommendedNextSteps：\n${JSON.stringify(source.metadata ?? {})}`,
  )
  const text = typeof structured.reportText === 'string' ? structured.reportText.trim() : ''
  if (text.length < 20) throw new Error('模型气象解读正文过短')
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'meteorological_interpretation', label: `${dataset.name} 模型解读`,
    value: { datasetRelativePath: dataset.relativePath, text, structured },
  }
  return result('interpret_meteorological_dataset', '模型气象解读已通过校验', structured, [ref])
}

async function generateReport(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const dataset = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
  assertSuffix(dataset.name, NETCDF_SUFFIXES, '短时强降水风险图数据')
  const interpretation = requiredRefKind(ctx, args, 'interpretation_ref', ['meteorological_interpretation'])
  const source = isRecord(interpretation.value) ? interpretation.value : {}
  const text = typeof source.text === 'string' ? source.text : ''
  if (!text) throw new Error('interpretation_ref 不包含模型解读正文')
  const artifact = artifactTarget(ctx, 'docx', `${dataset.name} 气象分析报告`)
  const worker = await deps.callWorker('meteorological_report', {
    file_relative_path: dataset.relativePath,
    file_name: dataset.name,
    interpretation_text: text,
    output_relative_path: artifact.relativePath,
  }, ctx.signal)
  mergeArtifactMetadata(artifact, {
    ...worker.payload,
  })
  return result('meteorological_report', worker.message, worker.payload, [], [artifact])
}
