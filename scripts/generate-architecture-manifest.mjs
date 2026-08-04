#!/usr/bin/env node

/**
 * Generate one cross-plane inventory from the real registries and contracts.
 *
 * This is a build-time document, not a runtime permission gate. It fails when
 * a required registry cannot be loaded so a stale or partial inventory cannot
 * be mistaken for architecture evidence.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(root, process.argv[2] ?? 'docs/architecture/architecture-manifest.json')

const sharedTypes = await import(pathToFileURL(path.join(root, 'packages/shared-types/dist/transport.js')).href)
const serverRegistry = await import(pathToFileURL(path.join(root, 'apps/server/dist/model/registry.js')).href)
const wsRegistryModule = await import(pathToFileURL(path.join(root, 'apps/server/dist/ws/defaultCommandRegistry.js')).href)
const wsRegistry = wsRegistryModule.createDefaultCommandRegistry()
const workerCatalog = readWorkerCatalog()
const providerIds = [...serverRegistry.MODEL_PROVIDER_IDS]
const wsCommands = [...sharedTypes.wsControlCommands]
const meteorologyManifest = JSON.parse(await readFile(
  path.join(root, 'apps/server/src/tools/meteorology/manifest.json'),
  'utf8',
))
const desktopMenuCommands = readDesktopMenuCommands()

if (providerIds.length === 0) throw new Error('架构清单无法生成：模型 Provider registry 为空。')
if (wsCommands.length !== wsRegistry.registeredTypes().length) {
  throw new Error(
    `架构清单无法生成：共享 WS 命令 ${wsCommands.length} 个，Server registry ${wsRegistry.registeredTypes().length} 个。`,
  )
}
const workerToolNames = workerCatalog.tools.map(tool => tool.toolName).sort()
const nodeWorkerToolNames = meteorologyManifest.tools
  .map(tool => tool.name)
  .filter(name => workerToolNames.includes(name))
  .sort()

const manifest = {
  schemaVersion: 1,
  kind: 'geo-agent-architecture-inventory',
  generatedAt: new Date().toISOString(),
  sourceOfTruth: {
    providers: 'apps/server/src/model/registry.ts',
    wsCommands: 'packages/shared-types/src/transport.ts + apps/server/src/ws/defaultCommandRegistry.ts',
    workerTools: 'apps/worker/src/worker_app/tools + worker_app/catalog_cli.py',
    desktopCommands: 'apps/desktop/src/contracts/desktopIpc.ts',
  },
  provider: {
    ids: providerIds,
    count: providerIds.length,
  },
  ws: {
    commands: wsCommands,
    count: wsCommands.length,
  },
  worker: {
    catalogCount: workerCatalog.count,
    tools: workerToolNames,
    contractDigests: workerCatalog.tools.map(tool => ({
      name: tool.toolName,
      schemaHash: tool.schemaHash,
    })),
  },
  nodeWorkerProjection: {
    providerId: meteorologyManifest.id,
    declaredTools: meteorologyManifest.tools.map(tool => tool.name).sort(),
    workerBackedTools: nodeWorkerToolNames,
  },
  desktop: {
    menuCommands: desktopMenuCommands,
    transport: 'Electron Main DesktopApiGateway + controlGateway; Renderer uses typed transport',
  },
}

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${output}\n`)

function readWorkerCatalog() {
  const python = process.env.WORKER_PYTHON?.trim() || 'python'
  const result = spawnSync(python, ['-m', 'worker_app.catalog_cli'], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, 'apps/worker/src'),
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`架构清单无法生成：Worker catalog 命令失败。${result.stderr || result.error?.message || ''}`)
  }
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed.tools) || typeof parsed.count !== 'number') {
    throw new Error('架构清单无法生成：Worker catalog 格式不正确。')
  }
  return parsed
}

function readDesktopMenuCommands() {
  const sourcePath = path.join(root, 'apps/desktop/src/contracts/desktopIpc.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const match = /export const desktopMenuCommandSchema = z\.enum\(\[([\s\S]*?)\]\)/u.exec(source)
  if (!match) throw new Error('架构清单无法生成：找不到 Desktop menu command registry。')
  return [...match[1].matchAll(/'([^']+)'/gu)].map(entry => entry[1]).filter(Boolean)
}
