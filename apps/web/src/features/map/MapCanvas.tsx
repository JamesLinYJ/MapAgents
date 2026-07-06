// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布组件
//
//   文件:       MapCanvas.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责地图实例管理、底图切换、结果图层渲染和视角同步。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import type maplibregl from 'maplibre-gl/dist/maplibre-gl-csp'
import type { LngLatBounds, Map } from 'maplibre-gl/dist/maplibre-gl-csp'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url'
import 'maplibre-gl/dist/maplibre-gl.css'

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { DEFAULT_BASEMAP } from '../../shared/constants'
import {
  buildBasemapStyle,
  boundsFromLayer,
  extractRouteLegendInfo,
  formatMapResourceWarning,
  getMapPointerLngLat,
  isMapControlTarget,
  isStaleArtifactMapError,
  queryRenderedArtifactFeatures,
  type MapCanvasLayer,
} from './MapCanvasEngine'
import { MapCanvasChrome, type MapCanvasLegendItem } from './MapCanvasChrome'
import { pickLayerColor, syncArtifactLayers } from './MapCanvasLayerSync'
import { buildFeaturePopupHtml, buildHoverPopupHtml } from './MapCanvasPopups'
import {
  buildMeasureLineCollection,
  buildMeasurePointsCollection,
  ensureMeasureLayers,
  formatMeasurementDistance,
} from './MapCanvasMeasure'

type MapLibreRuntime = typeof import('maplibre-gl/dist/maplibre-gl-csp').default

let mapLibreRuntimePromise: Promise<MapLibreRuntime> | null = null

function loadMapLibreRuntime(): Promise<MapLibreRuntime> {
  // 地图运行时是工作台里最重的独占依赖；用真实动态 import 交给 Rolldown
  // 自动拆分，而不是维护手写 manualChunks 规则。
  mapLibreRuntimePromise ??= import('maplibre-gl/dist/maplibre-gl-csp').then((module) => {
    module.default.setWorkerUrl(mapLibreWorkerUrl)
    return module.default
  })
  return mapLibreRuntimePromise
}

type MapManualDragState = {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  dragging: boolean
}

interface MapCanvasProps {
  artifactCount: number
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  runStatus?: string
  onSelectBasemap: (basemapKey: string) => void
  layers: MapCanvasLayer[]
  selectedArtifactId?: string
  selectedArtifactName?: string
  focusRequest?: { artifactId?: string; nonce: number }
  onSelectArtifact: (artifactId: string) => void
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  agentState?: { placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null } | null
}

export function MapCanvas({
  basemaps,
  selectedBasemapKey,
  onSelectBasemap,
  layers,
  selectedArtifactId,
  selectedArtifactName,
  focusRequest,
  onSelectArtifact,
}: MapCanvasProps) {
  // 地图主画布
  //
  // 负责承载 MapLibre 地图实例、底图切换、结果图层渲染、自动视野定位，
  // 以及与主工作台之间的选中状态同步。
  const stageRef = useRef<HTMLElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const boundsRef = useRef<LngLatBounds | null>(null)
  const prevLayerCountRef = useRef(0)
  const appliedBasemapKeyRef = useRef<string | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const manualDragRef = useRef<MapManualDragState | null>(null)
  const handledFocusRequestRef = useRef<number | null>(null)
  const suppressNextMapClickRef = useRef(false)
  const measureModeRef = useRef(false)
  const layersRef = useRef(layers)
  const onSelectArtifactRef = useRef(onSelectArtifact)
  const [cursor, setCursor] = useState('114.0579, 22.5431')
  const [interactionHint, setInteractionHint] = useState('拖拽平移 · 滚轮缩放 · 点击对象查看详情')
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number]>>([])
  const [showLayerLegend, setShowLayerLegend] = useState(true)
  const [mapError, setMapError] = useState<string | null>(null)
  const [tileWarning, setTileWarning] = useState<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const availableBasemaps = useMemo(() => basemaps.filter((item) => item.available !== false), [basemaps])
  const activeBasemap =
    availableBasemaps.find((item) => item.basemapKey === selectedBasemapKey) ??
    availableBasemaps.find((item) => item.isDefault) ??
    availableBasemaps[0] ??
    DEFAULT_BASEMAP
  const visibleTileWarning = tileWarning && !isStaleArtifactMapError(tileWarning, layers)
    ? formatMapResourceWarning(tileWarning)
    : null
  const canFocusSelection = layers.length > 0 && !mapError
  const initialBasemapRef = useRef(activeBasemap)
  const legendItems = useMemo<MapCanvasLegendItem[]>(() => layers.map(({ artifact, visible, featureCount, data }, index) => ({
    artifactId: artifact.artifactId,
    name: artifact.name,
    color: pickLayerColor(artifact.metadata as Record<string, unknown> | undefined, index),
    routeInfo: data ? extractRouteLegendInfo(data) : null,
    featureCount,
    isRaster: !data,
    visible,
    selected: artifact.artifactId === selectedArtifactId,
  })), [layers, selectedArtifactId])

  const cycleBasemap = useCallback(() => {
    // 底图轮转
    //
    // 维持一个极简但高频可用的交互：不弹复杂菜单，直接在可用底图间循环切换。
    if (!availableBasemaps.length) {
      return
    }
    const currentIndex = availableBasemaps.findIndex((item) => item.basemapKey === selectedBasemapKey)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % availableBasemaps.length : 0
    onSelectBasemap(availableBasemaps[nextIndex]?.basemapKey ?? availableBasemaps[0].basemapKey)
  }, [availableBasemaps, onSelectBasemap, selectedBasemapKey])

  const focusLayerBounds = useCallback((artifactId?: string) => {
    // 定位到结果图层
    //
    // 外部图层管理和地图控件共用同一套 bounds 解析，避免面板选择和地图视角各管一份状态。
    const map = mapRef.current
    if (!map) {
      return
    }
    const selectionBounds = artifactId
      ? boundsFromLayer(layers.find((item) => item.artifact.artifactId === artifactId))
      : boundsRef.current

    if (selectionBounds && !selectionBounds.isEmpty()) {
      map.fitBounds(selectionBounds, { padding: 120, duration: 900, maxZoom: 14 })
      return
    }

    setInteractionHint('当前结果没有可定位的空间范围')
  }, [layers])

  const focusSelection = useCallback(() => {
    // 定位到当前结果
    //
    // 有选中 artifact 时优先聚焦该结果；否则回退到当前所有结果的总 bounds。
    // 没有结果图层时按钮在渲染层禁用，避免“定位当前结果”变成默认城市飞行。
    focusLayerBounds(selectedArtifactId)
  }, [focusLayerBounds, selectedArtifactId])

  const handlePointerMove = useCallback((lng: number, lat: number) => {
    setCursor(`${lng.toFixed(4)}, ${lat.toFixed(4)}`)
  }, [])

  const toggleMeasureMode = useCallback(() => {
    setMeasureMode((current) => {
      const next = !current
      setInteractionHint(next ? '测距模式已开启，点击地图连续落点即可计算距离' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情')
      if (!next) {
        setMeasurePoints([])
      }
      return next
    })
  }, [])

  useEffect(() => {
    measureModeRef.current = measureMode
  }, [measureMode])

  useEffect(() => {
    // 地图拖拽边界
    //
    // 液体玻璃层与 Framer Motion 会让视觉层级更复杂，因此拖拽不只依赖
    // MapLibre 内建 handler；这里在地图舞台捕获 pointer 事件，直接平移地图。
    const stage = stageRef.current
    if (!stage) {
      return
    }

    const endDrag = (event?: PointerEvent) => {
      const state = manualDragRef.current
      if (!state) {
        return
      }

      if (event && event.pointerId !== state.pointerId) {
        return
      }

      if (!state.dragging && event && measureModeRef.current) {
        const map = mapRef.current
        const pointLngLat = map ? getMapPointerLngLat(map, event.clientX, event.clientY) : null
        if (pointLngLat) {
          setMeasurePoints((current) => [...current, [pointLngLat.lng, pointLngLat.lat]])
          suppressNextMapClickRef.current = true
        }
      }

      if (state.dragging) {
        suppressNextMapClickRef.current = true
        window.setTimeout(() => {
          suppressNextMapClickRef.current = false
        }, 0)
      } else if (suppressNextMapClickRef.current) {
        window.setTimeout(() => {
          suppressNextMapClickRef.current = false
        }, 0)
      }

      containerRef.current?.classList.remove('is-map-dragging')
      mapRef.current?.getCanvas().style.removeProperty('cursor')
      manualDragRef.current = null
      setInteractionHint(measureModeRef.current ? '测距模式已开启，点击地图继续加点' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情')

      try {
        if (event) {
          stage.releasePointerCapture(event.pointerId)
        }
      } catch {
        // 某些浏览器会在 pointercancel 后自动释放，忽略即可。
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isMapControlTarget(event.target)) {
        return
      }
      if (!mapRef.current) {
        return
      }

      manualDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragging: false,
      }
      containerRef.current?.classList.add('is-map-dragging')
      setInteractionHint('拖拽地图中')

      try {
        stage.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture 只是增强移动过程稳定性，不支持时仍然走 window 监听。
      }
    }

    const handleDragPointerMove = (event: PointerEvent) => {
      const state = manualDragRef.current
      const map = mapRef.current
      if (!state || !map || event.pointerId !== state.pointerId) {
        return
      }

      const pointLngLat = getMapPointerLngLat(map, event.clientX, event.clientY)
      if (pointLngLat) {
        handlePointerMove(pointLngLat.lng, pointLngLat.lat)
      }

      const deltaX = event.clientX - state.lastX
      const deltaY = event.clientY - state.lastY
      const totalMove = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (!state.dragging && totalMove < 3) {
        return
      }

      state.dragging = true
      state.lastX = event.clientX
      state.lastY = event.clientY
      event.preventDefault()
      event.stopPropagation()
      map.panBy([-deltaX, -deltaY], { duration: 0, noMoveStart: true }, { source: 'manual-map-drag' })
    }

    stage.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('pointermove', handleDragPointerMove, { capture: true, passive: false })
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)

    return () => {
      stage.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('pointermove', handleDragPointerMove, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
    }
  }, [handlePointerMove])

  useEffect(() => {
    layersRef.current = layers
  }, [layers])

  useEffect(() => {
    onSelectArtifactRef.current = onSelectArtifact
  }, [onSelectArtifact])

  useEffect(() => {
    // 地图实例初始化
    //
    // 只在组件首次挂载时创建 MapLibre 实例。
    // 当容器初始尺寸为零（CSS Grid / framer-motion 尚未完成布局）时，
    // 通过 ResizeObserver 等待容器获得尺寸后再创建。
    const target = containerRef.current
    if (!target || mapRef.current) {
      return
    }

    let disposed = false
    let sizeObserver: ResizeObserver | null = null
    let mapResizeObserver: ResizeObserver | null = null
    let creationPending = false

    const tryCreateMap = () => {
      if (disposed || mapRef.current || creationPending) return
      if (target.clientWidth === 0 || target.clientHeight === 0) return

      creationPending = true
      void loadMapLibreRuntime().then((maplibreRuntime) => {
        creationPending = false
        if (disposed || mapRef.current) return
        if (target.clientWidth === 0 || target.clientHeight === 0) return

        sizeObserver?.disconnect()
        sizeObserver = null

        let map: Map
        try {
          map = new maplibreRuntime.Map({
            container: target,
            style: buildBasemapStyle(initialBasemapRef.current),
            center: [121.4737, 31.2304],
            zoom: 11.2,
            interactive: true,
            dragRotate: false,
            attributionControl: false,
          })
        } catch (error) {
          setMapError(error instanceof Error ? error.message : '当前浏览器无法创建 WebGL 地图上下文')
          setInteractionHint('当前浏览器无法创建地图渲染上下文')
          return
        }

        // 捕获异步 WebGL 上下文创建失败（软件渲染/无 GPU 环境）
        const canvas = map.getCanvas()
        const onWebglError = (event: Event) => {
          const webglEvent = event as WebGLContextEvent
          setMapError(`WebGL 不可用：${webglEvent.statusMessage || '无法创建地图渲染上下文'}`)
          setInteractionHint('当前浏览器不支持硬件加速地图，请开启 GPU 加速或切换到支持 WebGL 的浏览器')
        }
        canvas.addEventListener('webglcontextcreationerror', onWebglError)

        map.on('error', (event) => {
          const msg = event.error?.message ?? '地图资源加载失败'
          // 已移除 artifact 的网络请求可能在超时后才上报，不能污染新线程的地图状态。
          if (isStaleArtifactMapError(msg, layersRef.current)) return
          // 仅展示非阻塞警告，不切换底图（切换会调用 setStyle 清除所有图层）
          setTileWarning(msg)
        })

        map.scrollZoom.enable()
        map.dragPan.enable()
        map.doubleClickZoom.enable()
        map.boxZoom.enable()
        map.keyboard.enable()
        map.touchZoomRotate.enable()
        map.addControl(new maplibreRuntime.ScaleControl({ maxWidth: 132, unit: 'metric' }), 'bottom-left')

        map.on('mousemove', (event) => {
          handlePointerMove(event.lngLat.lng, event.lngLat.lat)
          if (measureModeRef.current) {
            map.getCanvas().style.cursor = 'crosshair'
            return
          }
          const features = queryRenderedArtifactFeatures(map, event.point)
          map.getCanvas().style.cursor = features.length ? 'pointer' : ''

          // 悬停气泡：停留 250ms 后显示要素摘要，移动即清除
          if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
          hoverPopupRef.current?.remove()
          hoverPopupRef.current = null
          const hoverFeature = features[0]
          if (hoverFeature) {
            hoverTimerRef.current = window.setTimeout(() => {
              if (!mapRef.current) return
              hoverPopupRef.current = new maplibreRuntime.Popup({
                closeButton: false, closeOnClick: false, offset: 6,
                className: 'dc-map-stage__hover-popup',
              })
                .setLngLat(event.lngLat)
                .setHTML(buildHoverPopupHtml(hoverFeature))
                .addTo(mapRef.current)
            }, 250)
          }
        })
        map.on('mousedown', () => setInteractionHint('正在拖拽地图'))
        map.on('mouseup', () => setInteractionHint(measureModeRef.current ? '测距模式已开启，点击地图继续加点' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情'))
        map.on('wheel', () => setInteractionHint('滚轮缩放中'))
        map.on('click', (event) => {
          if (suppressNextMapClickRef.current) {
            return
          }

          if (measureModeRef.current) {
            popupRef.current?.remove()
            popupRef.current = null
            setMeasurePoints((current) => [...current, [event.lngLat.lng, event.lngLat.lat]])
            return
          }

          const feature = queryRenderedArtifactFeatures(map, event.point)[0]
          if (!feature) {
            popupRef.current?.remove()
            popupRef.current = null
            return
          }

          const sourceId = typeof feature.layer.source === 'string' ? feature.layer.source : null
          const artifactId = sourceId?.startsWith('artifact-') ? sourceId.replace(/^artifact-/, '') : null
          if (artifactId) {
            onSelectArtifactRef.current(artifactId)
          }

          popupRef.current = new maplibreRuntime.Popup({
            closeButton: false,
            closeOnClick: true,
            offset: 14,
            className: 'dc-map-stage__popup',
          })
            .setLngLat(event.lngLat)
            .setHTML(buildFeaturePopupHtml(feature, layersRef.current.find((item) => item.artifact.artifactId === artifactId)?.artifact.name))
            .addTo(map)

          setInteractionHint('已选中地图对象，可继续切换图层或查看其他结果')
        })
        map.on('load', () => map.resize())

        mapResizeObserver = new ResizeObserver(() => {
          map.resize()
        })
        mapResizeObserver.observe(target)

        mapRef.current = map
        appliedBasemapKeyRef.current = initialBasemapRef.current.basemapKey
      }).catch((error) => {
        creationPending = false
        if (disposed) return
        setMapError(error instanceof Error ? error.message : '地图运行时加载失败')
        setInteractionHint('地图运行时加载失败，请刷新页面后重试')
      })
    }

    // 先立即尝试创建（大多数情况下容器已就绪）
    tryCreateMap()

    // 如果容器初始尺寸为零，通过 ResizeObserver 等待尺寸就绪后重试
    if (!mapRef.current && !disposed) {
      sizeObserver = new ResizeObserver(() => {
        tryCreateMap()
      })
      sizeObserver.observe(target)
    }

    return () => {
      disposed = true
      sizeObserver?.disconnect()
      if (mapRef.current) {
        mapResizeObserver?.disconnect()
        popupRef.current?.remove()
        popupRef.current = null
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [handlePointerMove])

  useEffect(() => {
    // 底图样式同步
    //
    // 通过 ref 记住已应用的 basemap，避免重复 setStyle 导致整张地图重建。
    const map = mapRef.current
    if (!map) {
      return
    }

    if (appliedBasemapKeyRef.current === activeBasemap.basemapKey) {
      return
    }

    appliedBasemapKeyRef.current = activeBasemap.basemapKey
    map.setStyle(buildBasemapStyle(activeBasemap))
  }, [activeBasemap])

  useEffect(() => {
    // 结果图层同步
    //
    // 输入框每次变更都会让 App 重渲染，所以这里必须只响应真正的图层事实变化。
    // 同步时优先更新已有 source 与 paint，避免全量删建造成地图闪烁和视角重置。
    const map = mapRef.current
    if (!map) {
      return
    }

    const syncLayers = () => {
      const bounds = syncArtifactLayers(map, layers, selectedArtifactId)
      const prevLayerCount = prevLayerCountRef.current
      const prevBounds = boundsRef.current
      boundsRef.current = bounds
      prevLayerCountRef.current = layers.length

      if (!bounds || bounds.isEmpty()) return
      // 新图层出现时无条件飞行
      const isNewLayer = layers.length > prevLayerCount
      // 已有图层时仅 bounds 显著变化才飞
      const boundsShifted = prevBounds && !prevBounds.isEmpty() && (
        Math.abs(bounds.getWest() - prevBounds.getWest()) > 1e-5 ||
        Math.abs(bounds.getSouth() - prevBounds.getSouth()) > 1e-5 ||
        Math.abs(bounds.getEast() - prevBounds.getEast()) > 1e-5 ||
        Math.abs(bounds.getNorth() - prevBounds.getNorth()) > 1e-5
      )
      if (isNewLayer || boundsShifted || !prevBounds || prevBounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 100, duration: 700, maxZoom: 14 })
      }
    }

    if (map.isStyleLoaded()) {
      syncLayers()
      return
    }

    map.once('styledata', syncLayers)
  }, [layers, selectedArtifactId, activeBasemap])

  useEffect(() => {
    if (!focusRequest || handledFocusRequestRef.current === focusRequest.nonce) {
      return
    }
    const map = mapRef.current
    if (!map) {
      return
    }

    const focus = () => {
      handledFocusRequestRef.current = focusRequest.nonce
      focusLayerBounds(focusRequest.artifactId)
    }

    if (map.isStyleLoaded()) {
      focus()
      return
    }

    map.once('styledata', focus)
  }, [focusLayerBounds, focusRequest])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    const syncMeasureLayers = () => {
      ensureMeasureLayers(map)
      const pointSource = map.getSource('measure-points') as maplibregl.GeoJSONSource | undefined
      const lineSource = map.getSource('measure-line') as maplibregl.GeoJSONSource | undefined
      if (!pointSource || !lineSource) {
        return
      }
      pointSource.setData(buildMeasurePointsCollection(measurePoints))
      lineSource.setData(buildMeasureLineCollection(measurePoints))
    }

    if (map.isStyleLoaded()) {
      syncMeasureLayers()
      return
    }

    map.once('styledata', syncMeasureLayers)
  }, [activeBasemap, measurePoints])

  const measurementLabel = formatMeasurementDistance(measurePoints)

  return (
    <MapCanvasChrome
      activeBasemapName={activeBasemap.name}
      canFocusSelection={canFocusSelection}
      containerRef={containerRef}
      cursor={cursor}
      interactionHint={interactionHint}
      legendItems={legendItems}
      mapError={mapError}
      measureMode={measureMode}
      measurementLabel={measurementLabel}
      reducedMotion={reducedMotion}
      selectedArtifactName={selectedArtifactName}
      showLayerLegend={showLayerLegend}
      stageRef={stageRef}
      visibleTileWarning={visibleTileWarning}
      onCycleBasemap={cycleBasemap}
      onFocusSelection={focusSelection}
      onSelectArtifact={onSelectArtifact}
      onToggleLayerLegend={() => setShowLayerLegend((current) => !current)}
      onToggleMeasureMode={toggleMeasureMode}
      onZoomIn={() => mapRef.current?.zoomIn()}
      onZoomOut={() => mapRef.current?.zoomOut()}
    />
  )
}
