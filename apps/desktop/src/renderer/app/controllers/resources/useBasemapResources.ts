// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 底图资源控制器
//
//   文件:       useBasemapResources.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useMemo } from 'react'
import { listBasemaps } from '../../../api/client'
import { DEFAULT_BASEMAP } from '../../../shared/constants'
import { useBasemapStore } from '../../stores/basemapStore'

/** 底图目录及当前选择的浏览器投影。 */
export function useBasemapResources() {
  const basemaps = useBasemapStore(state => state.basemaps)
  const selectedBasemapKey = useBasemapStore(state => state.selectedBasemapKey)
  const setBasemaps = useBasemapStore(state => state.setBasemaps)
  const setSelectedBasemapKey = useBasemapStore(state => state.setSelectedBasemapKey)

  const selectedBasemap = useMemo(
    () => basemaps.find(item => item.basemapKey === selectedBasemapKey) ?? basemaps[0] ?? DEFAULT_BASEMAP,
    [basemaps, selectedBasemapKey],
  )

  const loadBasemaps = useCallback(async () => {
    const available = (await listBasemaps()).filter(item => item.available)
    if (!available.length) throw new Error('底图目录没有可用条目。')
    const defaultBasemap = available.find(item => item.isDefault) ?? available[0]
    if (!defaultBasemap) throw new Error('底图目录没有默认条目。')
    setBasemaps(available)
    const currentKey = useBasemapStore.getState().selectedBasemapKey
    setSelectedBasemapKey(
      available.some(item => item.basemapKey === currentKey) ? currentKey : defaultBasemap.basemapKey,
    )
  }, [setBasemaps, setSelectedBasemapKey])

  return {
    basemaps,
    selectedBasemap,
    selectedBasemapKey,
    setSelectedBasemapKey,
    loadBasemaps,
  }
}
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 底图资源控制器
//
//   文件:       useBasemapResources.ts
// --------------------------------------------------------------------------
