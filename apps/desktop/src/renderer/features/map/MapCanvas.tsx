// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布组件
//
//   文件:       MapCanvas.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import type maplibregl from 'maplibre-gl/dist/maplibre-gl-csp'
import type { Map } from 'maplibre-gl/dist/maplibre-gl-csp'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url'
import 'maplibre-gl/dist/maplibre-gl.css'

import type { BasemapDescriptor, MapSceneLayer } from '@geo-agent-platform/shared-types'
import { DEFAULT_BASEMAP } from '../../shared/constants'
import {
  buildBasemapStyle,
  boundsFromLayer,
  formatMapResourceWarning,
  isStaleMapLayerError,
  queryRenderedArtifactFeatures,
} from './MapCanvasEngine'
import { MapCanvasChrome } from './MapCanvasChrome'
import { sceneSourceId, syncSceneLayers } from './MapCanvasLayerSync'
import { buildFeaturePopupHtml, buildHoverPopupHtml } from './MapCanvasPopups'
import {
  buildMeasureLineCollection,
  buildMeasurePointsCollection,
  ensureMeasureLayers,
  formatMeasurementDistance,
} from './MapCanvasMeasure'
import {
  INITIAL_MAP_WORKBENCH_STATUS,
  publishMapWorkbenchStatus,
  scaleDenominatorForWebMercator,
  subscribeMapWorkbenchCommand,
} from './mapWorkbenchBridge'
import type { SceneRenderLayer } from './useMapScene'

type MapLibreRuntime = typeof import('maplibre-gl/dist/maplibre-gl-csp').default

let mapLibreRuntimePromise: Promise<MapLibreRuntime> | null = null

function loadMapLibreRuntime(): Promise<MapLibreRuntime> {
  mapLibreRuntimePromise ??= import('maplibre-gl/dist/maplibre-gl-csp').then(module => {
    module.default.setWorkerUrl(mapLibreWorkerUrl)
    return module.default
  })
  return mapLibreRuntimePromise
}

interface MapCanvasProps {
  artifactCount: number
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  runStatus?: string
  layers: SceneRenderLayer[]
  sceneError: string | null
  sceneLoading: boolean
  onUpdateLayer: (
    mapLayerId: string,
    patch: Partial<Pick<MapSceneLayer, 'visible' | 'opacity' | 'styleOverride' | 'label' | 'currentFrameId'>>,
  ) => Promise<void>
  selectedArtifactId?: string
  selectedArtifactName?: string
  focusRequest?: { mapLayerId?: string; nonce: number }
  onSelectArtifact: (artifactId: string) => void
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  agentState?: { placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null } | null
}

export function MapCanvas({
  basemaps,
  selectedBasemapKey,
  layers,
  sceneError,
  sceneLoading,
  onUpdateLayer,
  selectedArtifactId,
  selectedArtifactName,
  focusRequest,
  onSelectArtifact,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const layersRef = useRef(layers)
  const activeBasemapRef = useRef<BasemapDescriptor>(DEFAULT_BASEMAP)
  const onSelectArtifactRef = useRef(onSelectArtifact)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const firstSceneFitRef = useRef(false)
  const appliedBasemapKeyRef = useRef<string | null>(null)
  const handledFocusRequestRef = useRef<number | null>(null)
  const cursorCoordinateRef = useRef<[number, number] | null>(null)
  const selectedFeatureCountRef = useRef(0)
  const basemapTileLoadedRef = useRef(false)
  const [mapReadyVersion, setMapReadyVersion] = useState(0)
  const [renderedBasemapKey, setRenderedBasemapKey] = useState<string | null>(null)
  const [cursor, setCursor] = useState('—')
  const [mapError, setMapError] = useState<string | null>(null)
  const [resourceWarning, setResourceWarning] = useState<string | null>(null)
  const [layerErrors, setLayerErrors] = useState<Record<string, string>>({})
  const [selectedMapLayerId, setSelectedMapLayerId] = useState<string | undefined>()
  const [measureMode, setMeasureMode] = useState(false)
  const measureModeRef = useRef(false)
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number]>>([])
  const reducedMotion = useReducedMotion() ?? false

  const availableBasemaps = useMemo(() => basemaps.filter(item => item.available !== false), [basemaps])
  const activeBasemap = availableBasemaps.find(item => item.basemapKey === selectedBasemapKey)
    ?? availableBasemaps.find(item => item.isDefault)
    ?? availableBasemaps[0]
    ?? DEFAULT_BASEMAP
  const selectedLayer = layers.find(layer => layer.manifest.mapLayerId === selectedMapLayerId)
    ?? layers.find(layer => layer.manifest.artifactId === selectedArtifactId)
    ?? layers.find(layer => layer.scene.visible)
    ?? layers[0]

  useEffect(() => { layersRef.current = layers }, [layers])
  useEffect(() => { activeBasemapRef.current = activeBasemap }, [activeBasemap])
  useEffect(() => { onSelectArtifactRef.current = onSelectArtifact }, [onSelectArtifact])
  useEffect(() => { measureModeRef.current = measureMode }, [measureMode])

  useEffect(() => {
    const target = containerRef.current
    if (!target || mapRef.current) return
    let disposed = false
    let waitingForSize: ResizeObserver | null = null

    const createMap = async () => {
      if (disposed || mapRef.current || target.clientWidth < 2 || target.clientHeight < 2) return
      const runtime = await loadMapLibreRuntime()
      if (disposed || mapRef.current) return
      const initialBasemap = activeBasemapRef.current
      const map = new runtime.Map({
        container: target,
        style: buildBasemapStyle(initialBasemap),
        center: [105, 35],
        zoom: 3.6,
        attributionControl: false,
        dragRotate: true,
        touchPitch: true,
        maxPitch: 70,
      })
      mapRef.current = map
      appliedBasemapKeyRef.current = initialBasemap.basemapKey
      waitingForSize?.disconnect()

      map.addControl(new runtime.ScaleControl({ maxWidth: 132, unit: 'metric' }), 'bottom-left')
      map.addControl(new runtime.AttributionControl({ compact: true }), 'bottom-right')
      map.on('load', () => {
        map.resize()
        setMapReadyVersion(version => version + 1)
        publishMapStatus(map, cursorCoordinateRef.current, selectedFeatureCountRef.current)
      })
      map.on('style.load', () => {
        basemapTileLoadedRef.current = false
        setResourceWarning(null)
        setMapReadyVersion(version => version + 1)
        publishMapStatus(map, cursorCoordinateRef.current, selectedFeatureCountRef.current)
      })
      map.on('moveend', () => {
        publishMapStatus(map, cursorCoordinateRef.current, selectedFeatureCountRef.current)
      })
      const publishRenderedBasemap = () => {
        if (
          basemapTileLoadedRef.current
          && map.isStyleLoaded()
          && map.areTilesLoaded()
        ) {
          setRenderedBasemapKey(appliedBasemapKeyRef.current)
        }
      }
      map.on('sourcedata', event => {
        if (event.sourceId !== 'basemap') return
        if (event.tile) basemapTileLoadedRef.current = true
        if (event.tile || event.sourceDataType === 'content') setResourceWarning(null)
        if (event.sourceDataType === 'idle') publishRenderedBasemap()
      })
      map.on('idle', publishRenderedBasemap)
      map.on('error', event => {
        const message = event.error?.message ?? '地图资源加载失败'
        if (isStaleMapLayerError(message, layersRef.current)) return
        const sourceId = (event as unknown as { sourceId?: string }).sourceId
        const layer = sourceId?.startsWith('map-layer-')
          ? layersRef.current.find(candidate => sceneSourceId(candidate.manifest.mapLayerId) === sourceId)
          : null
        if (layer) {
          setLayerErrors(current => ({ ...current, [layer.manifest.mapLayerId]: formatMapResourceWarning(message) }))
        } else {
          setResourceWarning(formatMapResourceWarning(message))
        }
      })
      map.on('mousemove', event => {
        cursorCoordinateRef.current = [event.lngLat.lng, event.lngLat.lat]
        setCursor(`${event.lngLat.lng.toFixed(4)}, ${event.lngLat.lat.toFixed(4)}`)
        publishMapStatus(map, cursorCoordinateRef.current, selectedFeatureCountRef.current)
        if (measureModeRef.current) {
          map.getCanvas().style.cursor = 'crosshair'
          return
        }
        const features = queryRenderedArtifactFeatures(map, event.point)
        map.getCanvas().style.cursor = features.length ? 'pointer' : ''
        if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        const feature = features[0]
        if (!feature) return
        hoverTimerRef.current = window.setTimeout(() => {
          if (!mapRef.current) return
          hoverPopupRef.current = new runtime.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 6,
            className: 'dc-map-stage__hover-popup',
          }).setLngLat(event.lngLat).setHTML(buildHoverPopupHtml(feature)).addTo(map)
        }, 220)
      })
      map.on('mouseout', () => {
        cursorCoordinateRef.current = null
        setCursor('—')
        publishMapStatus(map, null, selectedFeatureCountRef.current)
      })
      map.on('click', event => {
        if (measureModeRef.current) {
          setMeasurePoints(current => [...current, [event.lngLat.lng, event.lngLat.lat]])
          return
        }
        const feature = queryRenderedArtifactFeatures(map, event.point)[0]
        if (!feature) {
          selectedFeatureCountRef.current = 0
          publishMapStatus(map, cursorCoordinateRef.current, 0)
          popupRef.current?.remove()
          return
        }
        selectedFeatureCountRef.current = 1
        publishMapStatus(map, cursorCoordinateRef.current, 1)
        const source = typeof feature.layer.source === 'string' ? feature.layer.source : ''
        const layer = layersRef.current.find(candidate => sceneSourceId(candidate.manifest.mapLayerId) === source)
        if (layer) {
          setSelectedMapLayerId(layer.manifest.mapLayerId)
          if (layer.manifest.artifactId) onSelectArtifactRef.current(layer.manifest.artifactId)
        }
        popupRef.current?.remove()
        popupRef.current = new runtime.Popup({ closeButton: true, closeOnClick: true, offset: 12 })
          .setLngLat(event.lngLat)
          .setHTML(buildFeaturePopupHtml(feature, layer?.manifest.title))
          .addTo(map)
      })

      resizeObserverRef.current = new ResizeObserver(() => map.resize())
      resizeObserverRef.current.observe(target)
    }

    void createMap().catch(error => {
      if (!disposed) setMapError(error instanceof Error ? error.message : '地图运行时加载失败')
    })
    if (!mapRef.current) {
      waitingForSize = new ResizeObserver(() => { void createMap() })
      waitingForSize.observe(target)
    }
    return () => {
      disposed = true
      waitingForSize?.disconnect()
      resizeObserverRef.current?.disconnect()
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
      hoverPopupRef.current?.remove()
      popupRef.current?.remove()
      mapRef.current?.remove()
      mapRef.current = null
      publishMapWorkbenchStatus(INITIAL_MAP_WORKBENCH_STATUS)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (!map.isStyleLoaded()) return
      const result = syncSceneLayers(map, layers, selectedLayer?.manifest.mapLayerId)
      setLayerErrors(result.errors)
      const demLayer = layers.find(layer => layer.scene.visible && layer.manifest.source.kind === 'raster_dem')
      if (demLayer) {
        map.setTerrain({
          source: sceneSourceId(demLayer.manifest.mapLayerId),
          exaggeration: demLayer.manifest.style.kind === 'hillshade' ? demLayer.manifest.style.exaggeration : 1,
        })
      } else if (map.getTerrain()) {
        map.setTerrain(null)
      }
      if (result.bounds && layers.length > 0 && !firstSceneFitRef.current) {
        firstSceneFitRef.current = true
        map.fitBounds(result.bounds, { padding: 64, duration: reducedMotion ? 0 : 700, maxZoom: 13 })
      }
      ensureMeasureLayers(map)
      const pointSource = map.getSource('measure-points') as maplibregl.GeoJSONSource | undefined
      const lineSource = map.getSource('measure-line') as maplibregl.GeoJSONSource | undefined
      pointSource?.setData(buildMeasurePointsCollection(measurePoints))
      lineSource?.setData(buildMeasureLineCollection(measurePoints))
    }
    if (map.isStyleLoaded()) apply()
    else map.once('styledata', apply)
  }, [layers, mapReadyVersion, measurePoints, reducedMotion, selectedLayer])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded() || appliedBasemapKeyRef.current === activeBasemap.basemapKey) return
    appliedBasemapKeyRef.current = activeBasemap.basemapKey
    basemapTileLoadedRef.current = false
    map.setStyle(buildBasemapStyle(activeBasemap))
  }, [activeBasemap])

  useEffect(() => {
    if (!focusRequest || handledFocusRequestRef.current === focusRequest.nonce) return
    const map = mapRef.current
    if (!map) return
    const layer = focusRequest.mapLayerId
      ? layers.find(candidate => candidate.manifest.mapLayerId === focusRequest.mapLayerId)
      : selectedLayer
    const bounds = boundsFromLayer(layer)
    if (!bounds) return
    handledFocusRequestRef.current = focusRequest.nonce
    map.fitBounds(bounds, { padding: 72, duration: reducedMotion ? 0 : 700, maxZoom: 14 })
  }, [focusRequest, layers, reducedMotion, selectedLayer])

  const focusSelection = useCallback(() => {
    const map = mapRef.current
    const bounds = boundsFromLayer(selectedLayer)
    if (map && bounds) map.fitBounds(bounds, { padding: 72, duration: reducedMotion ? 0 : 700, maxZoom: 14 })
  }, [reducedMotion, selectedLayer])

  const toggleMeasure = useCallback(() => {
    setMeasureMode(current => {
      if (current) setMeasurePoints([])
      return !current
    })
  }, [])

  useEffect(() => subscribeMapWorkbenchCommand(command => {
    const map = mapRef.current
    if (command === 'zoom-in') map?.zoomIn()
    else if (command === 'zoom-out') map?.zoomOut()
    else if (command === 'toggle-measure') toggleMeasure()
    else if (command === 'focus-selection') focusSelection()
  }), [focusSelection, toggleMeasure])

  return (
    <MapCanvasChrome
      containerRef={containerRef}
      cursor={cursor}
      layerErrors={layerErrors}
      layers={layers}
      mapReady={mapReadyVersion > 0}
      basemapRendered={renderedBasemapKey === activeBasemap.basemapKey}
      mapError={mapError ?? sceneError}
      measureMode={measureMode}
      measurementLabel={formatMeasurementDistance(measurePoints)}
      reducedMotion={reducedMotion}
      resourceWarning={resourceWarning}
      sceneLoading={sceneLoading}
      selectedLayerId={selectedLayer?.manifest.mapLayerId}
      selectedLayerName={selectedLayer?.manifest.title ?? selectedArtifactName}
      onSetCurrentFrame={(mapLayerId, currentFrameId) => onUpdateLayer(mapLayerId, { currentFrameId })}
    />
  )
}

function publishMapStatus(
  map: Map,
  cursorCoordinate: [number, number] | null,
  selectedFeatureCount: number,
): void {
  const center = map.getCenter()
  const longitude = cursorCoordinate?.[0] ?? null
  const latitude = cursorCoordinate?.[1] ?? null
  const zoom = map.getZoom()
  publishMapWorkbenchStatus({
    ready: map.isStyleLoaded() === true,
    longitude,
    latitude,
    zoom,
    scaleDenominator: scaleDenominatorForWebMercator(zoom, center.lat),
    crs: 'EPSG:3857',
    selectedFeatureCount,
  })
}
