#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'

import {
  assertArtifactFileSet,
  collectNpmProductionPackages,
  RUNTIME_OUTPUT_MARKER,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
  verifyTrustedManifestSignature,
} from './runtime-service-artifact-core.mjs'

const args = parseArgs(process.argv.slice(2))
const artifactRoot = path.resolve(args.artifactRoot ?? 'artifacts/runtime-service')
const canonicalArtifactRoot = await realpath(artifactRoot)
const manifestPath = path.join(artifactRoot, 'runtime-service-manifest.json')
await assertCanonicalArtifactPath(canonicalArtifactRoot, manifestPath, 'runtime-service-manifest.json')
if (!(await lstat(manifestPath)).isFile()) throw new Error('运行服务 manifest 不是普通文件。')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
if (manifest.kind !== RUNTIME_SERVICE_KIND || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error('运行服务 manifest 版本或类型不受支持。')
}

const entryPaths = new Set()
for (const entry of manifest.entries) {
  if (!isManifestEntry(entry)) throw new Error('运行服务 manifest 包含无效文件记录。')
  if (entryPaths.has(entry.path)) throw new Error(`运行服务 manifest 包含重复路径：${entry.path}`)
  entryPaths.add(entry.path)
  const filePath = resolveArtifactPath(artifactRoot, entry.path)
  await assertCanonicalArtifactPath(canonicalArtifactRoot, filePath, entry.path)
  const metadata = await lstat(filePath)
  if (entry.kind === 'symlink') {
    if (!metadata.isSymbolicLink() || await readlink(filePath) !== entry.target) {
      throw new Error(`运行服务制品符号链接校验失败：${entry.path}`)
    }
    continue
  }
  const content = await readFile(filePath)
  const actualHash = await sha256(content)
  if (!metadata.isFile() || metadata.size !== entry.sizeBytes || actualHash !== entry.sha256) {
    throw new Error(`运行服务制品校验失败：${entry.path}`)
  }
}

for (const requiredPath of requiredRuntimePaths(entryPaths)) {
  if (!entryPaths.has(requiredPath)) throw new Error(`运行服务制品缺少必需文件：${requiredPath}`)
}

const runtimePackage = JSON.parse(await readFile(path.join(artifactRoot, 'package.json'), 'utf8'))
const runtimeLock = JSON.parse(await readFile(path.join(artifactRoot, 'package-lock.json'), 'utf8'))
assertRuntimeWorkspaces(runtimePackage.workspaces, 'package.json')
assertRuntimeWorkspaces(runtimeLock.packages?.['']?.workspaces, 'package-lock.json')

const sbom = JSON.parse(await readFile(path.join(artifactRoot, 'runtime-service-sbom.spdx.json'), 'utf8'))
if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages)) {
  throw new Error('运行服务 SBOM 格式不受支持。')
}
const expectedNamespace = `https://geo-agent-platform.invalid/runtime-service/${encodeURIComponent(manifest.releaseId)}`
if (sbom.documentNamespace !== expectedNamespace) {
  throw new Error('运行服务 SBOM 与 manifest 的 releaseId 不一致。')
}
assertNpmSbomClosure(sbom.packages, collectNpmProductionPackages(runtimeLock))

const workerProject = await readFile(path.join(artifactRoot, 'apps/worker/pyproject.toml'), 'utf8')
const workerLock = await readFile(path.join(artifactRoot, 'apps/worker/uv.lock'), 'utf8')
const workerMeteorologyPackage = await lstat(path.join(artifactRoot, 'packages/gis-meteorology'))
if (!workerMeteorologyPackage.isDirectory()
  || !/path\s*=\s*["']\.\.\/\.\.\/packages\/gis-meteorology["']/u.test(workerProject)
  || !/editable\s*=\s*["']\.\.\/\.\.\/packages\/gis-meteorology["']/u.test(workerLock)) {
  throw new Error('运行服务 Worker 制品的 gis-meteorology 锁定相对路径无效。')
}

if (manifest.signing) {
  if (!args.trustedPublicKey) {
    throw new Error('已签名制品必须通过 --trusted-public-key 提供部署侧可信 Ed25519 公钥。')
  }
  const signaturePath = resolveArtifactPath(artifactRoot, manifest.signing.signatureFile)
  await assertCanonicalArtifactPath(canonicalArtifactRoot, signaturePath, manifest.signing.signatureFile)
  if (!(await lstat(signaturePath)).isFile()) throw new Error('运行服务 manifest 签名不是普通文件。')
  const signature = JSON.parse(await readFile(signaturePath, 'utf8'))
  if ('publicKeyPem' in signature) {
    throw new Error('签名文件不得自带并信任公钥；必须使用部署侧信任根。')
  }
  const trustedPublicKey = await readFile(path.resolve(args.trustedPublicKey))
  if (/PRIVATE KEY/u.test(trustedPublicKey.toString('utf8'))) {
    throw new Error('--trusted-public-key 必须指向公钥，不得使用私钥文件。')
  }
  verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning: manifest.signing,
    signature,
    trustedPublicKey,
  })
} else if (args.requireSignature || args.trustedPublicKey) {
  throw new Error('运行服务制品未签名，不符合当前验证要求。')
}

assertArtifactFileSet(
  await listArtifactPaths(artifactRoot),
  entryPaths,
  manifest.signing?.signatureFile ?? null,
)

process.stdout.write(`${artifactRoot}\n`)

function parseArgs(argv) {
  const result = { artifactRoot: null, trustedPublicKey: null, requireSignature: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--trusted-public-key') {
      result.trustedPublicKey = argv[index + 1] ?? null
      index += 1
      if (!result.trustedPublicKey) throw new Error('--trusted-public-key 需要公钥文件路径。')
    } else if (argument === '--require-signature') {
      result.requireSignature = true
    } else if (argument.startsWith('--')) {
      throw new Error(`未知参数：${argument}`)
    } else if (result.artifactRoot) {
      throw new Error('只能指定一个 Runtime Service 制品目录。')
    } else {
      result.artifactRoot = argument
    }
  }
  return result
}

function resolveArtifactPath(root, relativePath) {
  if (typeof relativePath !== 'string'
    || !relativePath
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || path.posix.normalize(relativePath).startsWith('../')) {
    throw new Error(`Runtime Service manifest 包含非法路径：${String(relativePath)}`)
  }
  const resolved = path.resolve(root, ...relativePath.split('/'))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime Service manifest 路径越界：${relativePath}`)
  }
  return resolved
}

async function assertCanonicalArtifactPath(canonicalRoot, candidate, relativePath) {
  const canonical = await realpath(candidate)
  const relative = path.relative(canonicalRoot, canonical)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime Service manifest 路径通过链接越界：${relativePath}`)
  }
}

async function listArtifactPaths(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    const relativePath = path.relative(root, fullPath).replaceAll(path.sep, '/')
    if (entry.isSymbolicLink()) {
      files.push(relativePath)
      continue
    }
    if (entry.isDirectory()) files.push(...await listArtifactPaths(root, fullPath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new Error(`Runtime Service 制品包含不支持的文件类型：${relativePath}`)
  }
  return files
}

function isManifestEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.path !== 'string') return false
  if (entry.kind === 'symlink') {
    return typeof entry.target === 'string'
      && entry.target.length > 0
      && !entry.target.includes('\\')
      && !path.posix.isAbsolute(entry.target)
      && path.posix.normalize(entry.target) === entry.target
  }
  return entry.kind === undefined
    && Number.isInteger(entry.sizeBytes)
    && entry.sizeBytes >= 0
    && typeof entry.sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(entry.sha256)
}

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function assertRuntimeWorkspaces(value, source) {
  if (!Array.isArray(value)
    || value.length !== RUNTIME_WORKSPACE_PATHS.length
    || value.some((entry, index) => entry !== RUNTIME_WORKSPACE_PATHS[index])) {
    throw new Error(`${source} 没有锁定 Runtime Service 的窄 workspace 集合。`)
  }
}

function assertNpmSbomClosure(sbomPackages, expectedPackages) {
  const actual = new Set(sbomPackages
    .filter(entry => typeof entry?.name === 'string' && entry.name.startsWith('npm:'))
    .map(entry => `${entry.name.slice(4)}\u0000${String(entry.versionInfo)}`))
  const expected = new Set(expectedPackages.map(entry => `${entry.name}\u0000${entry.version}`))
  const missing = [...expected].filter(entry => !actual.has(entry))
  const unexpected = [...actual].filter(entry => !expected.has(entry))
  if (missing.length || unexpected.length) {
    throw new Error(
      `运行服务 SBOM 与 npm 生产依赖闭包不一致`
      + `（缺少 ${missing.length} 项，多出 ${unexpected.length} 项）。`,
    )
  }
}

function requiredRuntimePaths(entryPaths) {
  const paths = [
    RUNTIME_OUTPUT_MARKER,
    '.node-version',
    'package.json',
    'package-lock.json',
    'runtime-service-sbom.spdx.json',
    'apps/server/package.json',
    'apps/server/dist/main.js',
    'apps/operations-console/package.json',
    'apps/operations-console/dist/installedCliEntry.js',
    'apps/worker/pyproject.toml',
    'apps/worker/uv.lock',
    'apps/worker/src/worker_app/sidecar.py',
    'packages/db/package.json',
    'packages/db/dist/index.js',
    'packages/shared-types/package.json',
    'packages/shared-types/dist/index.js',
    'packages/conversation-presentation/package.json',
    'packages/conversation-presentation/dist/index.js',
    'packages/operations-supervisor/package.json',
    'packages/operations-supervisor/dist/cli.js',
    'packages/gis-meteorology/pyproject.toml',
    'infra/migrations/000_schema_migrations.sql',
    'deploy/systemd/geo-agent-platform-supervisor.service',
    'deploy/systemd/geo-agent-platform-supervisor.user.service',
    'deploy/bin/geo-agent-platform',
    'deploy/windows/GeoAgentPlatformSupervisor.xml.template',
    'scripts/run-worker.ps1',
    'scripts/run-worker.sh',
    'scripts/run-windows-service.ps1',
  ]
  if (entryPaths.has('linux-runtime-bundle.json')) {
    paths.push(
      'node_modules/.package-lock.json',
      'python-private-requirements.lock',
      'python-packages/cfgrib/__init__.py',
      'python-packages/docx/__init__.py',
    )
  }
  return paths
}
