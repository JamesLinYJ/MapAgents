// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层树工具
//
//   文件:       layerTreeUtils.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { LayerTreeNode } from './useLayerManager'

export function collectLayerIds(nodes: LayerTreeNode[]): string[] {
  return nodes.flatMap(node => (
    node.type === 'layer'
      ? [node.id]
      : collectLayerIds(node.children ?? [])
  ))
}
