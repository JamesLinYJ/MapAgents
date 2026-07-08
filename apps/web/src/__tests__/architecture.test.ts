// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端架构守卫测试
//
//   文件:       architecture.test.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('frontend architecture guards', () => {
  it('keeps WebSocket lifecycle behind PartySocket transport', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const files = (await collectSourceFiles(srcRoot))
      .filter(file => !file.endsWith(path.join('__tests__', 'architecture.test.ts')))
    const sources = await Promise.all(files.map(async file => ({
      file,
      source: await readFile(file, 'utf8'),
    })))
    const clientSource = sources.find(entry => entry.file.endsWith(path.join('ws', 'client.ts')))?.source ?? ''

    expect(clientSource.includes("from 'partysocket/ws'")).toBe(true)
    expect(clientSource.includes('new ReconnectingWebSocket')).toBe(true)

    for (const { file, source } of sources) {
      if (file.endsWith(path.join('ws', 'client.ts'))) continue
      expect(source.includes('new WebSocket('), file).toBe(false)
      expect(source.includes('new ReconnectingWebSocket('), file).toBe(false)
      expect(source.includes("from 'partysocket/ws'"), file).toBe(false)
    }
  })

  it('keeps workspace navigation facts in the Zustand workspace store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const navigationSource = await readFile(path.join(srcRoot, 'app/controllers/navigationController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/workspaceStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of ['activeNav', 'panelMode', 'activeSidebarItem', 'workspaceMode']) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(navigationSource.includes('useWorkspaceStore')).toBe(true)
    expect(navigationSource.includes("useState<PrimaryNav>")).toBe(false)
    expect(navigationSource.includes("useState<PanelMode>")).toBe(false)
    expect(navigationSource.includes("useState<SidebarItemId>")).toBe(false)
    expect(navigationSource.includes("useState<WorkspaceMode>")).toBe(false)
  })

  it('keeps model connection facts in the Zustand model connection store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/connectionController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/modelConnectionStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of ['providers', 'provider', 'model', 'applyProviders', 'changeProvider']) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(controllerSource.includes('useModelConnectionStore')).toBe(true)
    expect(controllerSource.includes('useState(')).toBe(false)
    expect(controllerSource.includes('startTransition')).toBe(false)
  })

  it('keeps shared resource facts in the Zustand resource store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/resourceController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/resourceStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of [
      'basemaps',
      'selectedBasemapKey',
      'artifactData',
      'artifactMetadata',
      'selectedArtifactId',
      'uploadedLayerName',
      'uploadReferences',
      'allFiles',
      'isFileSubmitting',
    ]) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(controllerSource.includes('useResourceStore')).toBe(true)
    for (const token of [
      'useState<BasemapDescriptor',
      "useState('osm')",
      'useState<Record<string, GeoJSON.FeatureCollection>>',
      'useState<Record<string, Record<string, unknown>>>',
      'useState<string>()',
      'useState<UploadReference[]>',
      'useState<FileEntry[]>',
      'useState(false)',
    ]) {
      expect(controllerSource.includes(token), token).toBe(false)
    }
  })

  it('keeps layer facts and layer mutations in the Zustand layer store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/resourceController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/layerStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of [
      'layers',
      'refreshLayers',
      'importLayer',
      'toggleLayerStatus',
      'replaceLayer',
      'removeLayer',
    ]) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(controllerSource.includes('useLayerStore')).toBe(true)
    expect(controllerSource.includes('useState<LayerDescriptor')).toBe(false)
    for (const token of [
      'listLayers(',
      'deleteLayer(',
      'importManagedLayer(',
      'replaceManagedLayer(',
      'updateLayer(',
    ]) {
      expect(controllerSource.includes(token), token).toBe(false)
    }
  })

  it('keeps map rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const mapPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceMapPanel.tsx'), 'utf8')
    const mapActivationSource = await readFile(path.join(srcRoot, 'app/layout/useWorkspaceMapActivation.ts'), 'utf8')

    expect(appShellSource.includes('WorkspaceMapPanel')).toBe(true)
    expect(appShellSource.includes('useWorkspaceMapActivation')).toBe(true)
    expect(appShellSource.includes('../features/map/MapCanvas')).toBe(false)
    expect(appShellSource.includes('../features/map/MapErrorBoundary')).toBe(false)
    expect(appShellSource.includes('requestIdleCallback')).toBe(false)
    expect(mapPanelSource.includes("import('../../features/map/MapCanvas')")).toBe(true)
    expect(mapPanelSource.includes('MapErrorBoundary')).toBe(true)
    expect(mapActivationSource.includes('requestIdleCallback')).toBe(true)
    expect(mapActivationSource.includes('requestMapFocus')).toBe(true)
  })

  it('keeps tool management rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const toolPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceToolPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceToolPanel')).toBe(true)
    expect(appShellSource.includes('../features/tools/ToolManagementPage')).toBe(false)
    expect(toolPanelSource.includes("import('../../features/tools/ToolManagementPage')")).toBe(true)
    expect(toolPanelSource.includes('ToolManagementPageProps')).toBe(true)
  })

  it('keeps inspector rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const inspectorSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceInspectorPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceInspectorPanel')).toBe(true)
    expect(appShellSource.includes('../features/artifacts/DetailPanel')).toBe(false)
    expect(appShellSource.includes('WorkbenchProgressCard')).toBe(false)
    expect(inspectorSource.includes("import('../../features/artifacts/DetailPanel')")).toBe(true)
    expect(inspectorSource.includes('WorkbenchProgressCard')).toBe(true)
  })

  it('keeps conversation rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const conversationPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceConversationPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceConversationPanel')).toBe(true)
    expect(appShellSource.includes('../features/conversation/ChatPanel')).toBe(false)
    expect(conversationPanelSource.includes("from '../../features/conversation/ChatPanel'")).toBe(true)
    expect(conversationPanelSource.includes('ChatPanelProps')).toBe(true)
  })

  it('keeps debug page rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const routeHostSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceRouteHost.tsx'), 'utf8')
    const debugPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceDebugPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceRouteHost')).toBe(true)
    expect(routeHostSource.includes('WorkspaceDebugPanel')).toBe(true)
    expect(appShellSource.includes("../features/debug/DebugPage")).toBe(false)
    expect(debugPanelSource.includes("import('../../features/debug/DebugPage')")).toBe(true)
    expect(debugPanelSource.includes('DebugPageProps')).toBe(true)
  })

  it('keeps route assembly out of AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const routeHostSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceRouteHost.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceRouteHost')).toBe(true)
    expect(appShellSource.includes('AppRoutes')).toBe(false)
    expect(appShellSource.includes('SecurityAdminPage')).toBe(false)
    expect(appShellSource.includes("import { WorkspaceLayout")).toBe(false)
    expect(routeHostSource.includes('AppRoutes')).toBe(true)
    expect(routeHostSource.includes('WorkspaceLayout')).toBe(true)
    expect(routeHostSource.includes('SecurityAdminPage')).toBe(true)
  })

  it('keeps browser diagnostics behind the shared client diagnostics boundary', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const files = (await collectSourceFiles(srcRoot))
      .filter(file => !file.endsWith(path.join('__tests__', 'architecture.test.ts')))
    const diagnosticsPath = path.join(srcRoot, 'shared/utils/clientDiagnostics.ts')

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (file === diagnosticsPath) {
        expect(source.includes('console.warn')).toBe(true)
        expect(source.includes('console.error')).toBe(true)
        expect(source.includes('sanitizeClientDiagnostic')).toBe(true)
        continue
      }
      expect(source.includes('console.warn'), file).toBe(false)
      expect(source.includes('console.error'), file).toBe(false)
    }
  })
})

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      files.push(...await collectSourceFiles(fullPath))
    } else if (/\.(ts|tsx)$/u.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}
