// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线增量投影 Hook
//
//   文件:       useConversationTimelineProjection.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { ConversationProjectionIndex } from '@geo-agent-platform/conversation-presentation'

/**
 * 合并 canonical transcript 与当前 run overlay。
 *
 * index 在 render 之间复用；只有新增、删除或更新的 item 才触发对应索引操作，
 * 避免每个 run.item 都重建 Set/Map 并全量排序。返回数组是索引缓存的稳定快照，
 * 没有投影变化时不会让下游对话面板重复派生。
 */
export function useConversationTimelineProjection(
  canonical: ReadonlyArray<ConversationItem>,
  liveOverlay: ReadonlyArray<ConversationItem>,
): ConversationItem[] {
  const [projection] = useState(() => new ConversationProjectionIndex())
  return useMemo(() => {
    projection.replaceSource('canonical', canonical)
    projection.replaceSource('live', liveOverlay)
    return projection.toArray()
  }, [canonical, liveOverlay, projection])
}
