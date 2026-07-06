// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布渲染外壳
//
//   文件:       MapCanvasChrome.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 仅负责 MapCanvas 的可见外壳：错误层、HUD、图例和地图控件。
// MapLibre 实例、source/layer 同步和 pointer 状态仍由 MapCanvas 持有。

import type { RefObject } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { Ruler } from 'lucide-react'

import { AppIcon } from '../../shared/components/AppIcon'
import { buildFadeMotion, buildFadeUpMotion, buildPressMotion } from '../../shared/motion'

export interface MapCanvasLegendItem {
  artifactId: string
  name: string
  color: string
  routeInfo: string | null
  featureCount: number
  isRaster: boolean
  visible: boolean
  selected: boolean
}

interface MapCanvasChromeProps {
  activeBasemapName: string
  canFocusSelection: boolean
  containerRef: RefObject<HTMLDivElement | null>
  cursor: string
  interactionHint: string
  legendItems: MapCanvasLegendItem[]
  mapError: string | null
  measureMode: boolean
  measurementLabel: string
  reducedMotion: boolean
  selectedArtifactName?: string
  showLayerLegend: boolean
  stageRef: RefObject<HTMLElement | null>
  visibleTileWarning: string | null
  onCycleBasemap: () => void
  onFocusSelection: () => void
  onSelectArtifact: (artifactId: string) => void
  onToggleLayerLegend: () => void
  onToggleMeasureMode: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

export function MapCanvasChrome({
  activeBasemapName,
  canFocusSelection,
  containerRef,
  cursor,
  interactionHint,
  legendItems,
  mapError,
  measureMode,
  measurementLabel,
  reducedMotion,
  selectedArtifactName,
  showLayerLegend,
  stageRef,
  visibleTileWarning,
  onCycleBasemap,
  onFocusSelection,
  onSelectArtifact,
  onToggleLayerLegend,
  onToggleMeasureMode,
  onZoomIn,
  onZoomOut,
}: MapCanvasChromeProps) {
  // 地图可见外壳
  //
  // 所有按钮都调用父组件注入的真实地图行为；这里不读取 MapLibre 实例，
  // 避免 UI 外壳反向拥有地图运行时状态。
  const pressMotion = buildPressMotion(reducedMotion)

  return (
    <m.section ref={stageRef} className="dc-map-stage relative h-[clamp(560px,68svh,780px)] overflow-hidden rounded-[28px] glass-strong" aria-label="地图画布" layout {...buildFadeUpMotion(reducedMotion, 0.06, 18)}>
      <div ref={containerRef} className="dc-map-stage__canvas" />
      <div className="dc-map-stage__wash" />

      {mapError ? (
        <m.div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-7 bg-[#f2f2f7]/95 backdrop-blur-xl text-center rounded-[28px]" role="status" layout {...buildFadeUpMotion(reducedMotion, 0.08, 12)}>
          <strong className="text-[17px] font-semibold text-[#1c1c1e]">地图无法渲染</strong>
          <p className="max-w-xs text-[14px] text-[#8e8e93]">当前浏览器不支持 WebGL。分析结果仍会保存。</p>
          <small className="text-[11px] text-[#8e8e93] font-mono break-all">{mapError}</small>
        </m.div>
      ) : visibleTileWarning ? (
        <m.div className="absolute left-3 right-3 top-3 z-20 p-3 rounded-[18px] bg-[#ff950010] border border-[#ff950020] text-[#ff9500] text-[13px] font-medium backdrop-blur-xl" role="status" layout {...buildFadeUpMotion(reducedMotion, 0.08, 12)}>
          <span>{visibleTileWarning}</span>
        </m.div>
      ) : null}

      <m.div className="dc-map-stage__hud" layout {...buildFadeMotion(reducedMotion, 0.08)}>
        <div className="dc-map-stage__status-copy">
          <span>{selectedArtifactName ?? '等待结果'}</span>
          <small>{measureMode ? measurementLabel : interactionHint}</small>
        </div>
        <strong>{cursor}</strong>
      </m.div>

      <AnimatePresence initial={false}>
        {legendItems.length && showLayerLegend ? (
          <m.div className="dc-map-stage__legend" aria-label="地图图层摘要" layout {...buildFadeUpMotion(reducedMotion, 0.14, 10)}>
            {legendItems.map((item) => (
              <m.button
                key={item.artifactId}
                type="button"
                className={`dc-map-stage__legend-item${item.selected ? ' dc-map-stage__legend-item--active' : ''}`}
                onClick={() => onSelectArtifact(item.artifactId)}
                {...pressMotion}
              >
                <span className="dc-map-stage__legend-dot" style={{ background: item.color }} aria-hidden="true" />
                <strong>{item.name}</strong>
                {item.routeInfo ? (
                  <span className="dc-map-stage__legend-route">{item.routeInfo}</span>
                ) : item.isRaster ? (
                  <span className="dc-map-stage__legend-count">栅格</span>
                ) : (
                  <span className="dc-map-stage__legend-count">{item.featureCount}</span>
                )}
                {!item.visible ? <em>隐藏</em> : null}
              </m.button>
            ))}
          </m.div>
        ) : null}
      </AnimatePresence>

      <m.div className="dc-map-stage__controls" layout {...buildFadeUpMotion(reducedMotion, 0.16, 8)}>
        <div className="dc-map-stage__zoom">
          <m.button type="button" onClick={onZoomIn} aria-label="放大地图" disabled={Boolean(mapError)} {...pressMotion}>
            <AppIcon name="add" size={18} />
          </m.button>
          <div className="dc-map-stage__zoom-divider" />
          <m.button type="button" onClick={onZoomOut} aria-label="缩小地图" disabled={Boolean(mapError)} {...pressMotion}>
            <AppIcon name="remove" size={18} />
          </m.button>
        </div>
        <m.button type="button" className={`dc-map-stage__icon${measureMode ? ' dc-map-stage__icon--active' : ''}`} onClick={onToggleMeasureMode} aria-label={measureMode ? '结束测距' : '开启测距'} disabled={Boolean(mapError)} {...pressMotion}>
          <Ruler size={18} />
        </m.button>
        <m.button type="button" className={`dc-map-stage__icon${showLayerLegend ? ' dc-map-stage__icon--active' : ''}`} onClick={onToggleLayerLegend} aria-label={showLayerLegend ? '隐藏图层摘要' : '显示图层摘要'} disabled={!legendItems.length} title={showLayerLegend ? '隐藏图层' : '显示图层'} {...pressMotion}>
          <AppIcon name="layers" size={18} />
        </m.button>
        <m.button type="button" className="dc-map-stage__icon" onClick={onCycleBasemap} aria-label="切换底图" title={activeBasemapName} {...pressMotion}>
          <AppIcon name="deployed_code" size={18} />
        </m.button>
        <m.button
          type="button"
          className="dc-map-stage__icon"
          onClick={onFocusSelection}
          aria-label="定位到当前结果"
          disabled={!canFocusSelection}
          title={canFocusSelection ? '定位到当前结果' : '暂无可定位的结果图层'}
          {...pressMotion}
        >
          <AppIcon name="my_location" size={18} />
        </m.button>
      </m.div>
    </m.section>
  )
}
