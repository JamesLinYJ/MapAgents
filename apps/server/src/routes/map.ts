import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AgentThreadRecord, MapLayerManifest, SessionRecord } from '../schemas/types.js'
import { mapFeaturePageSchema, mapLayerManifestSchema, mapSceneSchema, mapTileJsonSchema } from '../schemas/types.js'
import {
  AUTHENTICATED_TILE_CACHE_CONTROL,
  buildTileJson,
  SHARED_TILE_CACHE_CONTROL,
} from '../map/mapTileDescriptor.js'
import { MapTileGateway } from '../map/mapTileGateway.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import { MapStore } from '../store/postgres/mapStore.js'

const idSchema = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/u)
const tileParamsSchema = z.object({
  mapLayerId: idSchema,
  z: z.coerce.number().int().min(0).max(24),
  x: z.coerce.number().int().nonnegative(),
  y: z.coerce.number().int().nonnegative(),
})
const featureQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const BASEMAPS = [
  {
    basemapKey: 'osm',
    name: 'OpenStreetMap',
    provider: 'OpenStreetMap',
    kind: 'raster',
    attribution: '© OpenStreetMap contributors',
    tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    labelTileUrls: [],
    available: true,
    isDefault: true,
  },
]

export interface PublicShareMapStore {
  getSessionByShareToken(shareToken: string): SessionRecord | null
  listThreadsForSession(sessionId: string): AgentThreadRecord[]
}

export function mapRoutes(deps: {
  mapStore: MapStore
  tileGateway: MapTileGateway
  security: SecurityServices
  publicShareStore: PublicShareMapStore
  runtimeRoot: string
}) {
  const { mapStore, tileGateway, security, publicShareStore, runtimeRoot } = deps
  const app = new Hono()

  app.get('/api/v1/map/basemaps', c => c.json(BASEMAPS))

  app.get('/api/v1/map/scenes/:threadId', async c => {
    const threadId = parseId(c.req.param('threadId'), 'threadId')
    await authorizeThread(mapStore, security, c, threadId, 'read')
    const scene = await mapStore.getOrCreateScene(threadId)
    return c.json({
      scene: mapSceneSchema.parse(scene),
      layers: (await mapStore.listSceneManifests(threadId)).map(layer => mapLayerManifestSchema.parse(layer)),
    })
  })

  app.get('/api/v1/map/layers/:mapLayerId/manifest', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    return manifest ? c.json(mapLayerManifestSchema.parse(manifest)) : c.json({ detail: '地图图层不存在。' }, 404)
  })

  app.get('/api/v1/map/layers/:mapLayerId/tilejson', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    if (!manifest) return c.json({ detail: '地图图层不存在。' }, 404)
    if (!isTileSource(manifest)) return c.json({ detail: '当前图层不是瓦片数据源。' }, 409)
    return c.json(mapTileJsonSchema.parse(buildTileJson(manifest, `/api/v1/map/layers/${mapLayerId}/tiles/{z}/{x}/{y}`)))
  })

  app.get('/api/v1/map/layers/:mapLayerId/tiles/:z/:x/:y', async c => {
    const params = tileParamsSchema.parse(c.req.param())
    await authorizeLayer(mapStore, security, c, params.mapLayerId, 'read')
    const spec = await mapStore.getTileExecutionSpec(params.mapLayerId)
    if (!spec) return c.json({ detail: '地图图层不存在。' }, 404)
    const tile = await tileGateway.fetchTile(spec, params.z, params.x, params.y, c.req.raw.signal)
    return tileResponse(tile, AUTHENTICATED_TILE_CACHE_CONTROL)
  })

  app.get('/api/v1/map/layers/:mapLayerId/features', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    const query = featureQuerySchema.parse(c.req.query())
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    return c.json(mapFeaturePageSchema.parse(await mapStore.listFeatures(mapLayerId, query.offset, query.limit)))
  })

  app.get('/api/v1/map/layers/:mapLayerId/download', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    if (!manifest) return c.json({ detail: '地图图层不存在。' }, 404)
    if (manifest.source.kind !== 'vector_tiles' && manifest.source.kind !== 'geojson') {
      return c.json({ detail: '该图层应从关联结果文件下载。' }, 409)
    }
    const filename = `${manifest.title.replaceAll(/[\\/:*?"<>|]/g, '_')}.geojson`
    return c.json(await mapStore.exportFeatureCollection(mapLayerId), 200, {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Type': 'application/geo+json; charset=utf-8',
    })
  })

  app.get('/api/share/:shareId/map/scenes/:threadId', async c => {
    const shareId = parseId(c.req.param('shareId'), 'shareId')
    const threadId = parseId(c.req.param('threadId'), 'threadId')
    requireSharedThread(publicShareStore, shareId, threadId)
    const scene = await mapStore.getScene(threadId)
    if (!scene) return c.json({ detail: '分享对话尚无地图场景。' }, 404)
    const layers = await mapStore.listSceneManifests(threadId)
    return c.json({ scene, layers: layers.map(layer => publicManifest(layer, shareId)) })
  })

  app.get('/api/share/:shareId/map/layers/:mapLayerId/manifest', async c => {
    const shareId = parseId(c.req.param('shareId'), 'shareId')
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    const manifest = await requireSharedLayer(publicShareStore, mapStore, shareId, mapLayerId)
    return c.json(publicManifest(manifest, shareId))
  })

  app.get('/api/share/:shareId/map/layers/:mapLayerId/data', async c => {
    const shareId = parseId(c.req.param('shareId'), 'shareId')
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    const manifest = await requireSharedLayer(publicShareStore, mapStore, shareId, mapLayerId)
    const spec = await mapStore.getTileExecutionSpec(mapLayerId)
    if (!spec?.artifactRelativePath) return c.json({ detail: '分享图层没有可读取的数据文件。' }, 404)
    const bytes = await readFile(resolveRuntimePath(runtimeRoot, spec.artifactRelativePath))
    return new Response(bytes, { headers: { 'Content-Type': contentTypeForSource(manifest) } })
  })

  app.get('/api/share/:shareId/map/layers/:mapLayerId/tilejson', async c => {
    const shareId = parseId(c.req.param('shareId'), 'shareId')
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    const manifest = await requireSharedLayer(publicShareStore, mapStore, shareId, mapLayerId)
    if (!isTileSource(manifest)) return c.json({ detail: '当前分享图层不是瓦片数据源。' }, 409)
    return c.json(buildTileJson(manifest, `/api/share/${shareId}/map/layers/${mapLayerId}/tiles/{z}/{x}/{y}`))
  })

  app.get('/api/share/:shareId/map/layers/:mapLayerId/tiles/:z/:x/:y', async c => {
    const shareId = parseId(c.req.param('shareId'), 'shareId')
    const params = tileParamsSchema.parse(c.req.param())
    await requireSharedLayer(publicShareStore, mapStore, shareId, params.mapLayerId)
    const spec = await mapStore.getTileExecutionSpec(params.mapLayerId)
    if (!spec) return c.json({ detail: '分享图层不存在。' }, 404)
    return tileResponse(
      await tileGateway.fetchTile(spec, params.z, params.x, params.y, c.req.raw.signal),
      SHARED_TILE_CACHE_CONTROL,
    )
  })

  return app
}

async function authorizeThread(
  mapStore: MapStore,
  security: SecurityServices,
  c: { get(key: string): unknown },
  threadId: string,
  action: 'read' | 'update',
): Promise<void> {
  const scope = await mapStore.getThreadScope(threadId)
  if (!scope) throw new Error(`线程 '${threadId}' 不存在`)
  await security.authorization.assertResourceWorkspace(requireAuth(c), 'layer', action, scope)
}

async function authorizeLayer(
  mapStore: MapStore,
  security: SecurityServices,
  c: { get(key: string): unknown },
  mapLayerId: string,
  action: 'read',
): Promise<void> {
  const scope = await mapStore.getLayerScope(mapLayerId)
  if (!scope) throw new Error(`地图图层 '${mapLayerId}' 不存在`)
  const auth = requireAuth(c)
  if (scope.system) {
    await security.authorization.enforce(auth, 'layer', action, {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: mapLayerId,
    })
    return
  }
  await security.authorization.assertResourceWorkspace(auth, 'layer', action, scope)
}

function requireSharedThread(store: PublicShareMapStore, shareId: string, threadId: string): void {
  const session = store.getSessionByShareToken(shareId)
  if (!session || session.status !== 'active') throw new Error('分享不存在或已失效。')
  if (!store.listThreadsForSession(session.id).some(thread => thread.id === threadId)) {
    throw new Error('分享中不存在这条对话。')
  }
}

async function requireSharedLayer(
  store: PublicShareMapStore,
  mapStore: MapStore,
  shareId: string,
  mapLayerId: string,
): Promise<MapLayerManifest> {
  const manifest = await mapStore.getManifest(mapLayerId)
  if (!manifest) throw new Error('分享图层不存在。')
  const session = store.getSessionByShareToken(shareId)
  if (!session || session.status !== 'active') throw new Error('分享不存在或已失效。')
  const threads = store.listThreadsForSession(session.id)
  let shared = false
  for (const thread of threads) {
    if (await mapStore.isLayerInThreadScene(thread.id, mapLayerId)) {
      shared = true
      break
    }
  }
  if (!shared) throw new Error('分享中不存在这个地图图层。')
  return manifest
}

function publicManifest(manifest: MapLayerManifest, shareId: string): MapLayerManifest {
  const prefix = `/api/share/${shareId}/map/layers/${manifest.mapLayerId}`
  const source = manifest.source.kind === 'geojson'
    ? { ...manifest.source, url: `${prefix}/data` }
    : manifest.source.kind === 'raster_image'
      ? { ...manifest.source, url: `${prefix}/data` }
      : { ...manifest.source, tileJsonUrl: `${prefix}/tilejson` }
  return mapLayerManifestSchema.parse({ ...manifest, source })
}

function isTileSource(manifest: MapLayerManifest): boolean {
  return ['vector_tiles', 'raster_tiles', 'raster_dem'].includes(manifest.source.kind)
}

function tileResponse(
  tile: { body: ArrayBuffer; contentType: string; cacheControl: string; etag: string | null },
  cacheControl: string,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': tile.contentType,
    'Cache-Control': cacheControl,
  }
  if (tile.etag) headers.ETag = tile.etag
  return new Response(tile.body, { headers })
}

function parseId(value: unknown, label: string): string {
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new Error(`${label} 无效`)
  return parsed.data
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('分享图层路径越出 runtime 根目录')
  return target
}

function contentTypeForSource(manifest: MapLayerManifest): string {
  if (manifest.source.kind === 'geojson') return 'application/geo+json'
  if (manifest.source.kind === 'raster_image') return 'image/png'
  return 'application/octet-stream'
}
