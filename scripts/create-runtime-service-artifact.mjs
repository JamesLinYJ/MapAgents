#!/usr/bin/env node

/**
 * Build the self-contained service side of a release.
 *
 * The Electron package is deliberately separate. This artifact contains the
 * Node service, Worker sources, migrations, and service definitions together
 * with a checksum manifest. It never silently copies from the current working
 * directory: every source path is explicit and missing inputs fail the build.
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const output = path.resolve(root, args.out ?? path.join('artifacts', 'runtime-service'))

if (args.build) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const workspace of ['@geo-agent-platform/shared-types', 'geo-agent-server']) {
    const build = spawnSync(npm, ['run', 'build', '--workspace', workspace], { cwd: root, stdio: 'inherit' })
    if (build.status !== 0) throw new Error(`Runtime Service 编译失败（${workspace}），未生成发布制品。`)
  }
}

if (await exists(output)) {
  if (!args.force) throw new Error(`输出目录已存在：${output}；需要显式 --force 才能覆盖。`)
  await rm(output, { recursive: true, force: true })
}
await mkdir(output, { recursive: true })

const sources = [
  ['apps/server/dist', 'server/dist', 'directory'],
  ['apps/server/package.json', 'server/package.json', 'file'],
  ['package-lock.json', 'package-lock.json', 'file'],
  ['apps/worker/src', 'worker/src', 'directory'],
  ['packages/gis-meteorology/pyproject.toml', 'worker/gis-meteorology/pyproject.toml', 'file'],
  ['packages/gis-meteorology/src', 'worker/gis-meteorology/src', 'directory'],
  ['infra/migrations', 'migrations', 'directory'],
  ['deploy/windows', 'service-definitions/windows', 'directory'],
  ['deploy/systemd', 'service-definitions/systemd', 'directory'],
]

for (const [source, relativeDestination, kind] of sources) {
  const sourcePath = path.join(root, source)
  if (!(await exists(sourcePath))) throw new Error(`Runtime Service 制品缺少输入：${source}`)
  const metadata = await stat(sourcePath)
  if ((kind === 'directory' && !metadata.isDirectory()) || (kind === 'file' && !metadata.isFile())) {
    throw new Error(`Runtime Service 输入类型不正确：${source}`)
  }
  const destination = path.join(output, relativeDestination)
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(sourcePath, destination, { recursive: kind === 'directory' })
}

const packageManifest = JSON.parse(await readFile(path.join(root, 'apps/server/package.json'), 'utf8'))
const releaseId = process.env.GEO_AGENT_PLATFORM_RELEASE_ID?.trim()
  || `geo-agent-platform@${String(packageManifest.version)}+runtime-service`
const workerContractDigest = process.env.WORKER_CONTRACT_DIGEST?.trim() || null
if (workerContractDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(workerContractDigest)) {
  throw new Error('WORKER_CONTRACT_DIGEST 必须是 sha256:<64 位小写十六进制>。')
}

const files = await listFiles(output)
const entries = []
for (const file of files) {
  const relativePath = path.relative(output, file).replaceAll(path.sep, '/')
  const content = await readFile(file)
  entries.push({
    path: relativePath,
    sizeBytes: content.byteLength,
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  })
}
entries.sort((left, right) => left.path.localeCompare(right.path))

const manifest = {
  schemaVersion: 1,
  kind: 'geo-agent-runtime-service',
  releaseId,
  apiProtocolVersion: 1,
  minDesktopProtocol: 1,
  maxDesktopProtocol: 1,
  databaseSchemaVersion: 9,
  workerContractDigest,
  workerContractDigestResolvedAtRuntime: workerContractDigest === null,
  entries,
}
await writeFile(path.join(output, 'runtime-service-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${output}${process.platform === 'win32' ? '\\' : '/'}runtime-service-manifest.json\n`)

function parseArgs(argv) {
  const result = { build: false, force: false, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--build') result.build = true
    else if (argument === '--force') result.force = true
    else if (argument === '--out') {
      result.out = argv[index + 1]
      index += 1
      if (!result.out) throw new Error('--out 需要目录参数。')
    } else {
      throw new Error(`未知参数：${argument}`)
    }
  }
  return result
}

async function exists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function listFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.name === 'runtime-service-manifest.json') continue
    if (entry.isDirectory()) result.push(...await listFiles(fullPath))
    else if (entry.isFile()) result.push(fullPath)
  }
  return result
}
