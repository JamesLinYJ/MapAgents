#!/usr/bin/env node

/**
 * Build the self-contained service side of a release.
 *
 * The Electron package is deliberately separate. This artifact contains the
 * Node service, Worker sources, migrations, and service definitions together
 * with a checksum manifest. It never silently copies from the current working
 * directory: every source path is explicit and missing inputs fail the build.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const output = path.resolve(root, args.out ?? path.join('artifacts', 'runtime-service'))

if (args.build) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const executable = process.platform === 'win32'
    ? process.env.ComSpec
    : npm
  if (!executable) throw new Error('Runtime Service 编译需要可用的 ComSpec。')
  for (const workspace of [
    '@geo-agent-platform/shared-types',
    '@geo-agent-platform/operations-supervisor',
    '@geo-agent-platform/db',
    'geo-agent-server',
  ]) {
    const npmArguments = ['run', 'build', '--workspace', workspace]
    const commandArguments = process.platform === 'win32'
      ? ['/d', '/s', '/c', npm, ...npmArguments]
      : npmArguments
    const build = spawnSync(executable, commandArguments, { cwd: root, stdio: 'inherit' })
    if (build.error || build.status !== 0) {
      throw new Error(`Runtime Service 编译失败（${workspace}），未生成发布制品。`)
    }
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
  ['packages/db/dist', 'packages/db/dist', 'directory'],
  ['packages/db/package.json', 'packages/db/package.json', 'file'],
  ['packages/operations-supervisor/dist', 'packages/operations-supervisor/dist', 'directory'],
  ['packages/operations-supervisor/package.json', 'packages/operations-supervisor/package.json', 'file'],
  ['packages/shared-types/dist', 'packages/shared-types/dist', 'directory'],
  ['packages/shared-types/package.json', 'packages/shared-types/package.json', 'file'],
  ['package-lock.json', 'package-lock.json', 'file'],
  ['apps/worker/src', 'worker/src', 'directory'],
  ['apps/worker/pyproject.toml', 'worker/pyproject.toml', 'file'],
  ['apps/worker/uv.lock', 'worker/uv.lock', 'file'],
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

const serverPackagePath = path.join(output, 'server/package.json')
const packageManifest = JSON.parse(await readFile(serverPackagePath, 'utf8'))
rewriteLocalDependencyPaths(packageManifest)
await writeFile(serverPackagePath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')
await rewriteWorkerProjectPaths(output)
await writeRuntimeSbom(output)
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
  signing: args.signingKey
    ? { algorithm: 'ed25519', signatureFile: 'runtime-service-manifest.sig' }
    : null,
  entries,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(path.join(output, 'runtime-service-manifest.json'), manifestBytes)
if (args.signingKey) await writeManifestSignature(output, manifestBytes, args.signingKey)
process.stdout.write(`${output}${process.platform === 'win32' ? '\\' : '/'}runtime-service-manifest.json\n`)

function parseArgs(argv) {
  const result = { build: false, force: false, out: null, signingKey: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--build') result.build = true
    else if (argument === '--force') result.force = true
    else if (argument === '--out') {
      result.out = argv[index + 1]
      index += 1
      if (!result.out) throw new Error('--out 需要目录参数。')
    } else if (argument === '--signing-key') {
      result.signingKey = argv[index + 1]
      index += 1
      if (!result.signingKey) throw new Error('--signing-key 需要 Ed25519 私钥文件。')
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

function rewriteLocalDependencyPaths(packageManifest) {
  for (const sectionName of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = packageManifest[sectionName]
    if (!section || typeof section !== 'object') continue
    for (const [name, version] of Object.entries(section)) {
      if (typeof version !== 'string') continue
      if (version.startsWith('file:../../packages/')) {
        section[name] = version.replace('file:../../packages/', 'file:../packages/')
      }
    }
  }
}

async function rewriteWorkerProjectPaths(artifactRoot) {
  const workerRoot = path.join(artifactRoot, 'worker')
  const projectPath = path.join(workerRoot, 'pyproject.toml')
  const lockPath = path.join(workerRoot, 'uv.lock')
  for (const filePath of [projectPath, lockPath]) {
    const content = await readFile(filePath, 'utf8')
    await writeFile(
      filePath,
      content
        .replaceAll('../../packages/gis-meteorology', 'gis-meteorology')
        .replaceAll('../packages/gis-meteorology', 'gis-meteorology'),
      'utf8',
    )
  }
}

async function writeRuntimeSbom(artifactRoot) {
  const npmLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const npmPackages = Object.entries(npmLock.packages ?? [])
    .map(([location, value]) => ({ location, value }))
    .filter(({ value }) => value && typeof value === 'object' && typeof value.name === 'string' && typeof value.version === 'string')
    .map(({ value }) => ({
      ecosystem: 'npm',
      name: value.name,
      version: value.version,
      downloadLocation: typeof value.resolved === 'string' ? value.resolved : 'NOASSERTION',
    }))
  const pythonLock = await readFile(path.join(root, 'apps/worker/uv.lock'), 'utf8')
  const pythonPackages = [...pythonLock.matchAll(/\[\[package\]\]\s*name = "([^"]+)"\s*version = "([^"]+)"/gu)]
    .map(match => ({
      ecosystem: 'pypi',
      name: match[1],
      version: match[2],
      downloadLocation: 'NOASSERTION',
    }))
  const packages = [...npmPackages, ...pythonPackages]
    .sort((left, right) => `${left.ecosystem}:${left.name}:${left.version}`.localeCompare(`${right.ecosystem}:${right.name}:${right.version}`))
    .map((entry, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: `${entry.ecosystem}:${entry.name}`,
      versionInfo: entry.version,
      downloadLocation: entry.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      supplier: 'NOASSERTION',
    }))
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'geo-agent-platform-runtime-service',
    documentNamespace: `https://geo-agent-platform.invalid/runtime-service/${releaseIdOrUnknown()}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: geo-agent-platform runtime artifact builder'],
    },
    packages,
    relationships: packages.map(pkg => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: pkg.SPDXID,
    })),
  }
  await writeFile(
    path.join(artifactRoot, 'runtime-service-sbom.spdx.json'),
    `${JSON.stringify(sbom, null, 2)}\n`,
    'utf8',
  )
}

async function writeManifestSignature(artifactRoot, manifestBytes, signingKeyPath) {
  const privateKey = createPrivateKey(await readFile(path.resolve(root, signingKeyPath)))
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('--signing-key 必须是 Ed25519 私钥。')
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  const signature = sign(null, manifestBytes, privateKey)
  await writeFile(
    path.join(artifactRoot, 'runtime-service-manifest.sig'),
    `${JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      publicKeyPem: publicKey,
      signatureBase64: signature.toString('base64'),
    }, null, 2)}\n`,
    'utf8',
  )
}

function releaseIdOrUnknown() {
  return process.env.GEO_AGENT_PLATFORM_RELEASE_ID?.trim() || 'unversioned'
}
