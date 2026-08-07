#!/usr/bin/env node

/**
 * Build the self-contained service side of a release.
 *
 * The Electron package is deliberately separate. This artifact contains the
 * Node service, Worker sources, migrations, and service definitions together
 * with a checksum manifest. It never silently copies from the current working
 * directory: every source path is explicit and missing inputs fail the build.
 */

import { createHash, createPrivateKey, sign } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  collectNpmProductionPackages,
  createRuntimePackageLock,
  createRuntimeRootPackageManifest,
  createRuntimeWorkspacePackageManifest,
  prepareArtifactOutput,
  publicKeyFingerprint,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
} from './runtime-service-artifact-core.mjs'

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

await prepareArtifactOutput(root, output, args.force)

const sources = [
  ['package.json', 'package.json', 'file'],
  ['package-lock.json', 'package-lock.json', 'file'],
  ['.node-version', '.node-version', 'file'],
  ['apps/server/dist', 'apps/server/dist', 'directory'],
  ['apps/server/package.json', 'apps/server/package.json', 'file'],
  ['packages/db/dist', 'packages/db/dist', 'directory'],
  ['packages/db/package.json', 'packages/db/package.json', 'file'],
  ['packages/operations-supervisor/dist', 'packages/operations-supervisor/dist', 'directory'],
  ['packages/operations-supervisor/package.json', 'packages/operations-supervisor/package.json', 'file'],
  ['packages/shared-types/dist', 'packages/shared-types/dist', 'directory'],
  ['packages/shared-types/package.json', 'packages/shared-types/package.json', 'file'],
  ['apps/worker/src', 'apps/worker/src', 'directory'],
  ['apps/worker/pyproject.toml', 'apps/worker/pyproject.toml', 'file'],
  ['apps/worker/uv.lock', 'apps/worker/uv.lock', 'file'],
  ['packages/gis-meteorology/pyproject.toml', 'packages/gis-meteorology/pyproject.toml', 'file'],
  ['packages/gis-meteorology/src', 'packages/gis-meteorology/src', 'directory'],
  ['infra/migrations', 'infra/migrations', 'directory'],
  ['deploy', 'deploy', 'directory'],
  ['scripts/run-worker.ps1', 'scripts/run-worker.ps1', 'file'],
  ['scripts/run-worker.sh', 'scripts/run-worker.sh', 'file'],
  ['scripts/run-windows-service.ps1', 'scripts/run-windows-service.ps1', 'file'],
]

for (const [source, relativeDestination, kind] of sources) {
  const sourcePath = path.join(root, source)
  let metadata
  try {
    metadata = await stat(sourcePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Runtime Service 制品缺少输入：${source}`)
    }
    throw error
  }
  if ((kind === 'directory' && !metadata.isDirectory()) || (kind === 'file' && !metadata.isFile())) {
    throw new Error(`Runtime Service 输入类型不正确：${source}`)
  }
  const destination = path.join(output, relativeDestination)
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(sourcePath, destination, { recursive: kind === 'directory' })
}

const rootPackagePath = path.join(output, 'package.json')
const rootLockPath = path.join(output, 'package-lock.json')
const sourceRootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'))
const runtimeRootPackage = createRuntimeRootPackageManifest(sourceRootPackage)
const sourceRootLock = JSON.parse(await readFile(rootLockPath, 'utf8'))
const runtimeLock = createRuntimePackageLock(sourceRootLock, runtimeRootPackage)
await writeFile(rootPackagePath, `${JSON.stringify(runtimeRootPackage, null, 2)}\n`, 'utf8')
await writeFile(rootLockPath, `${JSON.stringify(runtimeLock, null, 2)}\n`, 'utf8')
for (const workspacePath of RUNTIME_WORKSPACE_PATHS) {
  const packagePath = path.join(output, workspacePath, 'package.json')
  const sourcePackage = JSON.parse(await readFile(packagePath, 'utf8'))
  const runtimePackage = createRuntimeWorkspacePackageManifest(sourcePackage)
  await writeFile(packagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8')
}

const serverPackagePath = path.join(output, 'apps/server/package.json')
const serverPackage = JSON.parse(await readFile(serverPackagePath, 'utf8'))
const releaseId = process.env.GEO_AGENT_PLATFORM_RELEASE_ID?.trim()
  || `geo-agent-platform@${String(serverPackage.version)}+runtime-service`
const workerContractDigest = process.env.WORKER_CONTRACT_DIGEST?.trim() || null
if (workerContractDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(workerContractDigest)) {
  throw new Error('WORKER_CONTRACT_DIGEST 必须是 sha256:<64 位小写十六进制>。')
}
const releaseContracts = await loadReleaseContracts()
const signingMaterial = args.signingKey ? await readSigningMaterial(args.signingKey) : null
await writeRuntimeSbom(output, runtimeLock, releaseId)

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
entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

const manifest = {
  schemaVersion: 1,
  kind: RUNTIME_SERVICE_KIND,
  releaseId,
  apiProtocolVersion: releaseContracts.apiProtocolVersion,
  minDesktopProtocol: releaseContracts.desktopProtocolVersion,
  maxDesktopProtocol: releaseContracts.desktopProtocolVersion,
  databaseSchemaVersion: releaseContracts.databaseSchemaVersion,
  workerContractDigest,
  workerContractDigestResolvedAtRuntime: workerContractDigest === null,
  signing: signingMaterial
    ? {
        algorithm: 'ed25519',
        signatureFile: 'runtime-service-manifest.sig',
        keyFingerprint: signingMaterial.keyFingerprint,
      }
    : null,
  entries,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(path.join(output, 'runtime-service-manifest.json'), manifestBytes)
if (signingMaterial) await writeManifestSignature(output, manifestBytes, signingMaterial)
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

async function listFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime Service 制品输入不得包含符号链接：${path.relative(output, fullPath)}`)
    }
    if (entry.isDirectory()) result.push(...await listFiles(fullPath))
    else if (entry.isFile()) result.push(fullPath)
    else throw new Error(`Runtime Service 制品输入包含不支持的文件类型：${path.relative(output, fullPath)}`)
  }
  return result
}

async function writeRuntimeSbom(artifactRoot, npmLock, releaseId) {
  const npmPackages = collectNpmProductionPackages(npmLock)
    .map(value => ({
      ecosystem: 'npm',
      name: value.name,
      version: value.version,
      downloadLocation: value.resolved ?? 'NOASSERTION',
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
    .sort((left, right) => {
      const leftKey = `${left.ecosystem}:${left.name}:${left.version}`
      const rightKey = `${right.ecosystem}:${right.name}:${right.version}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
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
    documentNamespace: `https://geo-agent-platform.invalid/runtime-service/${encodeURIComponent(releaseId)}`,
    creationInfo: {
      created: resolveSbomCreatedAt(process.env),
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

async function readSigningMaterial(signingKeyPath) {
  const privateKey = createPrivateKey(await readFile(path.resolve(root, signingKeyPath)))
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('--signing-key 必须是 Ed25519 私钥。')
  }
  return { privateKey, keyFingerprint: publicKeyFingerprint(privateKey) }
}

async function writeManifestSignature(artifactRoot, manifestBytes, signingMaterial) {
  const signature = sign(null, manifestBytes, signingMaterial.privateKey)
  await writeFile(
    path.join(artifactRoot, 'runtime-service-manifest.sig'),
    `${JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyFingerprint: signingMaterial.keyFingerprint,
      signatureBase64: signature.toString('base64'),
    }, null, 2)}\n`,
    'utf8',
  )
}

async function loadReleaseContracts() {
  const sharedRelease = await import(pathToFileURL(
    path.join(root, 'packages/shared-types/dist/release.js'),
  ).href)
  const schemaCompatibility = await import(pathToFileURL(
    path.join(root, 'apps/server/dist/db/schemaCompatibility.js'),
  ).href)
  const apiProtocolVersion = sharedRelease.API_PROTOCOL_VERSION
  const desktopProtocolVersion = sharedRelease.DESKTOP_PROTOCOL_VERSION
  const databaseSchemaVersion = schemaCompatibility.CURRENT_DATABASE_SCHEMA_VERSION
  if (![apiProtocolVersion, desktopProtocolVersion, databaseSchemaVersion]
    .every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error('发布协议或数据库版本常量无效。')
  }
  return { apiProtocolVersion, desktopProtocolVersion, databaseSchemaVersion }
}

function resolveSbomCreatedAt(environment) {
  const sourceDateEpoch = environment.SOURCE_DATE_EPOCH?.trim()
  if (!sourceDateEpoch) return new Date().toISOString()
  if (!/^\d+$/u.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH 必须是非负 Unix 秒数。')
  }
  const timestamp = Number(sourceDateEpoch) * 1_000
  const date = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(date.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH 超出可支持时间范围。')
  }
  return date.toISOString()
}
