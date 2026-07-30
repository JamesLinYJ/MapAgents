// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面原生文件选择门面
//
//   文件:       desktopFiles.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopFileSelectionHandle } from '../../contracts/desktopIpc'
import { requireDesktopBridge } from './transport'

const LAYER_FILTERS = [{
  name: 'GeoJSON 图层',
  extensions: ['geojson', 'json'],
}] as const

const AUTOMATION_FILTERS = [{
  name: '自动化流程 JSON',
  extensions: ['json'],
}] as const

/**
 * 选择待上传文件。Main 拥有原生对话框、绝对路径和文件句柄，
 * Renderer 只接收可展示元数据与一次性不透明句柄。
 */
export function selectDesktopUploadFiles(
  kind: 'files' | 'folder',
): Promise<DesktopFileSelectionHandle[]> {
  return requireDesktopBridge().files.select({
    kind,
    multiple: kind === 'files',
    filters: [],
  })
}

export async function selectDesktopUploadFile(): Promise<DesktopFileSelectionHandle | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: [],
  })
  return file ?? null
}

export async function selectDesktopLayerFile(): Promise<DesktopFileSelectionHandle | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: LAYER_FILTERS.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })
  return file ?? null
}

export async function selectDesktopAutomationDraft(): Promise<{
  file: DesktopFileSelectionHandle
  text: string
} | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: AUTOMATION_FILTERS.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })
  if (!file) return null
  const result = await requireDesktopBridge().files.readText({
    handleId: file.handleId,
    expectedName: file.name,
    purpose: 'automation-draft-import',
  })
  return { file, text: result.text }
}
