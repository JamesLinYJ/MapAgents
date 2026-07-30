// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台地图预加载
//
//   文件:       workspaceMapPreload.ts
//
//   日期:       2026年07月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const loadWorkspaceMapCanvas = () => import('../../features/map/MapCanvas')

export function preloadWorkspaceMap() {
  return loadWorkspaceMapCanvas()
}
