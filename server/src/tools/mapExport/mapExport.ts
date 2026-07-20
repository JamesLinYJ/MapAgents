// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图数据导出工具
//
//   文件:       mapExport.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 导出文件必须进入统一 artifact store；payload 和 valueRef 不暴露绝对路径。
// 文件名只用于展示，真实存储路径由 artifactId 决定。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import { geoJsonInputSchema, resolveGeoJsonInput } from '../spatial/geoJsonInput.js'
import { MAP_EXPORT_PROMPT } from '../spatial/prompts.js'

export function createMapExportTool(runtimeRoot: string): ToolDef {
  return {
    name: 'map_export',
    label: '导出 GeoJSON 数据',
    description: '将 GeoJSON 分析结果保存为可下载、可在平台地图中加载的 artifact；不生成 PNG/JPEG 或带标注的静态图片。',
    prompt: MAP_EXPORT_PROMPT,
    group: '空间分析',
    tags: ['export', 'file'],
    isReadOnly: false,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        geojson: geoJsonInputSchema('要导出的 GeoJSON：优先传前序工具返回的 valueRef ID，也可传小型内联对象。'),
        filename: { type: 'string', description: '导出文件名（不含路径）', default: 'export.geojson' },
      },
      required: ['geojson'],
    },
    async handler(args, ctx) {
      const geojson = resolveGeoJsonInput(args.geojson, ctx, 'geojson')
      const filename = safeFilename(args.filename)
      const artifactId = makeId('artifact')
      const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.geojson`)
      const target = resolveRuntimePath(runtimeRoot, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      const serialized = JSON.stringify(geojson, null, 2)
      await writeFile(target, serialized, 'utf8')
      const bounds = geoJsonBounds(geojson)

      return {
        message: `地图数据已导出为 ${filename}`,
        payload: {
          operation: 'map_export',
          filename,
          artifactId,
          downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
          featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
        },
        warnings: [],
        resultId: makeId('result'),
        source: 'artifact-store',
        provenance: { backend: 'artifact-store', format: 'geojson' },
        artifacts: [{
          artifactId,
          artifactType: 'geojson',
          name: filename,
          uri: `/api/v1/results/${artifactId}/geojson`,
          display: {
            surfaces: ['map', 'download'],
            primarySurface: 'map',
            map: {
              title: filename,
              replacementGroup: null,
              bounds,
              crs: 'EPSG:4326',
              minZoom: 0,
              maxZoom: 22,
              source: {
                kind: 'geojson',
                url: `/api/v1/results/${artifactId}/geojson`,
                featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
                sizeBytes: Buffer.byteLength(serialized, 'utf8'),
              },
              style: {
                kind: 'line',
                color: '#2563eb',
                width: 2,
                dashArray: null,
                opacity: 0.9,
                colorField: null,
                categories: [],
              },
              legend: null,
              temporal: null,
              capabilities: {
                query: true,
                labels: true,
                style: true,
                temporal: false,
                opacity: true,
                download: true,
              },
            },
          },
          relativePath,
          metadata: { relativePath, downloadUrl: `/api/v1/artifacts/${artifactId}/download` },
        }],
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'artifact_ref',
          label: filename,
          value: { artifactId },
        }],
      }
    },
  }
}

function geoJsonBounds(value: unknown): [number, number, number, number] {
  const coordinates: Array<[number, number]> = []
  collectCoordinates(value, coordinates)
  if (!coordinates.length) throw new Error('导出的 GeoJSON 没有可制图坐标')
  const xs = coordinates.map(([x]) => x)
  const ys = coordinates.map(([, y]) => y)
  const west = Math.min(...xs)
  const east = Math.max(...xs)
  const south = Math.min(...ys)
  const north = Math.max(...ys)
  return [west === east ? west - 0.0001 : west, south === north ? south - 0.0001 : south, west === east ? east + 0.0001 : east, south === north ? north + 0.0001 : north]
}

function collectCoordinates(value: unknown, output: Array<[number, number]>): void {
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      output.push([value[0], value[1]])
      return
    }
    for (const child of value) collectCoordinates(child, output)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties') continue
    collectCoordinates(child, output)
  }
}

function safeFilename(value: unknown): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : 'export.geojson'
  const base = path.basename(requested).replace(/\.geojson$/iu, '')
  const normalized = base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/u, '').slice(0, 100).trim()
  return `${normalized || 'export'}.geojson`
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  return target
}
