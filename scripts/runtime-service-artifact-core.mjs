// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 制品核心边界
//
//   文件:       runtime-service-artifact-core.mjs
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const RUNTIME_SERVICE_KIND = 'geo-agent-runtime-service'
export const RUNTIME_OUTPUT_MARKER = '.geo-agent-runtime-service-output.json'
export const RUNTIME_WORKSPACE_PATHS = [
  'apps/server',
  'apps/operations-console',
  'packages/db',
  'packages/shared-types',
  'packages/conversation-presentation',
  'packages/operations-supervisor',
]
export const RUNTIME_NPM_ROOTS = [
  '',
  'apps/server',
  'apps/operations-console',
  'packages/operations-supervisor',
]

/**
 * 只有本脚本创建的专用目录才能被 `--force` 覆盖。仓库根、
 * 仓库祖先和符号链接均是不可删除边界。
 */
export async function prepareArtifactOutput(repositoryRoot, outputPath, force) {
  const root = path.resolve(repositoryRoot)
  const output = path.resolve(outputPath)
  assertOutputDoesNotContainRepository(root, output)

  const metadata = await optionalLstat(output)
  if (metadata) {
    if (metadata.isSymbolicLink()) {
      throw new Error(`Runtime Service 输出目录不得是符号链接：${output}`)
    }
    const [realRoot, realOutput] = await Promise.all([realpath(root), realpath(output)])
    assertOutputDoesNotContainRepository(realRoot, realOutput)
    if (!force) {
      throw new Error(`输出目录已存在：${output}；需要显式 --force 才能覆盖。`)
    }
    if (!(await isOwnedArtifactDirectory(output))) {
      throw new Error(
        `拒绝覆盖非 Runtime Service 专用目录：${output}。`
        + `请改用不存在的新目录，或确认目录内有 ${RUNTIME_OUTPUT_MARKER}。`,
      )
    }
    await rm(output, { recursive: true, force: true })
  }

  await mkdir(output, { recursive: true })
  await writeFile(
    path.join(output, RUNTIME_OUTPUT_MARKER),
    `${JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }, null, 2)}\n`,
    'utf8',
  )
}

export function createRuntimeRootPackageManifest(source) {
  return omitUndefined({
    name: source.name,
    private: true,
    version: source.version,
    type: source.type,
    engines: source.engines,
    workspaces: [...RUNTIME_WORKSPACE_PATHS],
    scripts: {
      'start:api': 'node apps/server/dist/main.js',
    },
    dependencies: source.dependencies,
    overrides: source.overrides,
    allowScripts: source.allowScripts,
  })
}

export function createRuntimeWorkspacePackageManifest(source) {
  const manifest = structuredClone(source)
  delete manifest.devDependencies
  return manifest
}

/**
 * 保留根锁文件的已解析版本，只收窄 workspace 集合及根包元数据。
 * 多余的不可达 node_modules entry 不会进入安装或 SBOM 闭包。
 */
export function createRuntimePackageLock(sourceLock, runtimePackageManifest) {
  const lock = structuredClone(sourceLock)
  lock.name = runtimePackageManifest.name
  lock.version = runtimePackageManifest.version
  if (!lock.packages || typeof lock.packages !== 'object' || !lock.packages['']) {
    throw new Error('package-lock.json 缺少根 packages 记录。')
  }
  lock.packages[''] = omitUndefined({
    name: runtimePackageManifest.name,
    version: runtimePackageManifest.version,
    workspaces: [...RUNTIME_WORKSPACE_PATHS],
    dependencies: runtimePackageManifest.dependencies,
    engines: runtimePackageManifest.engines,
  })

  const runtimeWorkspaces = new Set(RUNTIME_WORKSPACE_PATHS)
  for (const workspacePath of sourceLock.packages[''].workspaces ?? []) {
    if (runtimeWorkspaces.has(workspacePath)) continue
    delete lock.packages[workspacePath]
    for (const [location, value] of Object.entries(lock.packages)) {
      if (value?.link === true && normalizeLockPath(value.resolved) === workspacePath) {
        delete lock.packages[location]
      }
    }
  }
  for (const workspacePath of RUNTIME_WORKSPACE_PATHS) {
    const workspace = lock.packages[workspacePath]
    if (!workspace || typeof workspace !== 'object') {
      throw new Error(`package-lock.json 缺少 Runtime Service workspace：${workspacePath}`)
    }
    delete workspace.devDependencies
  }
  return lock
}

/**
 * 从 npm lockfile v3 的实际解析树遍历 Server/Supervisor 生产依赖，
 * 不依赖大多数 node_modules entry 不存在的 `name` 字段。
 */
export function collectNpmProductionPackages(lock, roots = RUNTIME_NPM_ROOTS) {
  const packages = lock.packages
  if (!packages || typeof packages !== 'object') {
    throw new Error('package-lock.json 缺少 packages 映射。')
  }

  const queue = [...roots]
  const visited = new Set()
  const components = new Map()
  while (queue.length > 0) {
    const requestedLocation = normalizeLockPath(queue.shift())
    if (visited.has(requestedLocation)) continue
    visited.add(requestedLocation)
    const entry = packages[requestedLocation]
    if (!entry || typeof entry !== 'object') {
      throw new Error(`package-lock.json 缺少生产依赖节点：${requestedLocation || '<root>'}`)
    }
    if (entry.link === true) {
      const target = normalizeLockPath(entry.resolved)
      if (!target) throw new Error(`package-lock.json 链接节点缺少 resolved：${requestedLocation}`)
      queue.push(target)
      continue
    }

    if (typeof entry.version === 'string') {
      const name = typeof entry.name === 'string'
        ? entry.name
        : packageNameFromLockLocation(requestedLocation)
      if (!name) throw new Error(`无法从 package-lock 路径推导包名：${requestedLocation}`)
      const key = `${name}\u0000${entry.version}`
      const previous = components.get(key)
      components.set(key, {
        name,
        version: entry.version,
        resolved: previous?.resolved
          ?? (typeof entry.resolved === 'string' ? entry.resolved : null),
      })
    }

    enqueueDependencies(queue, packages, requestedLocation, entry.dependencies, false)
    enqueueDependencies(queue, packages, requestedLocation, entry.optionalDependencies, true)
    enqueuePeerDependencies(
      queue,
      packages,
      requestedLocation,
      entry.peerDependencies,
      entry.peerDependenciesMeta,
    )
  }

  return [...components.values()].sort((left, right) => (
    `${left.name}\u0000${left.version}`.localeCompare(`${right.name}\u0000${right.version}`)
  ))
}

export function publicKeyFingerprint(key) {
  const publicKey = key
    && typeof key === 'object'
    && key.type === 'public'
    && typeof key.export === 'function'
    ? key
    : createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('发布签名密钥必须是 Ed25519。')
  }
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

export function verifyTrustedManifestSignature(input) {
  const { manifestBytes, manifestSigning, signature, trustedPublicKey } = input
  if (manifestSigning?.algorithm !== 'ed25519' || signature?.algorithm !== 'ed25519') {
    throw new Error('Runtime Service 只支持 Ed25519 manifest 签名。')
  }
  if (signature.schemaVersion !== 1 || typeof signature.signatureBase64 !== 'string') {
    throw new Error('Runtime Service manifest 签名格式不受支持。')
  }
  const trustedFingerprint = publicKeyFingerprint(trustedPublicKey)
  if (manifestSigning.keyFingerprint !== trustedFingerprint
    || signature.keyFingerprint !== trustedFingerprint) {
    throw new Error('Runtime Service manifest 签名密钥指纹与部署侧信任根不一致。')
  }
  const valid = verify(
    null,
    manifestBytes,
    trustedPublicKey,
    Buffer.from(signature.signatureBase64, 'base64'),
  )
  if (!valid) throw new Error('Runtime Service manifest Ed25519 签名校验失败。')
}

export function assertArtifactFileSet(actualPaths, manifestEntryPaths, signatureFile = null) {
  const allowed = new Set([
    ...manifestEntryPaths,
    'runtime-service-manifest.json',
    ...(signatureFile ? [signatureFile] : []),
  ])
  const unexpected = [...actualPaths].filter(candidate => !allowed.has(candidate)).sort()
  if (unexpected.length > 0) {
    throw new Error(`Runtime Service 制品包含 manifest 未声明的文件：${unexpected.join('、')}`)
  }
}

function assertOutputDoesNotContainRepository(repositoryRoot, outputPath) {
  const relative = path.relative(outputPath, repositoryRoot)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Runtime Service 输出目录不得是仓库根或其祖先：${outputPath}`)
  }
}

async function isOwnedArtifactDirectory(output) {
  try {
    const parsed = JSON.parse(await readFile(path.join(output, RUNTIME_OUTPUT_MARKER), 'utf8'))
    return parsed?.kind === RUNTIME_SERVICE_KIND && parsed?.schemaVersion === 1
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function optionalLstat(candidate) {
  try {
    return await lstat(candidate)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function enqueueDependencies(queue, packages, location, dependencies, missingAllowed) {
  if (!dependencies || typeof dependencies !== 'object') return
  for (const dependencyName of Object.keys(dependencies)) {
    const resolved = resolveDependencyLocation(packages, location, dependencyName)
    if (resolved) queue.push(resolved)
    else if (!missingAllowed) {
      throw new Error(`package-lock.json 无法解析 ${location || '<root>'} -> ${dependencyName}`)
    }
  }
}

function enqueuePeerDependencies(queue, packages, location, dependencies, metadata) {
  if (!dependencies || typeof dependencies !== 'object') return
  for (const dependencyName of Object.keys(dependencies)) {
    if (metadata?.[dependencyName]?.optional === true) continue
    const resolved = resolveDependencyLocation(packages, location, dependencyName)
    if (!resolved) throw new Error(`package-lock.json 无法解析 ${location || '<root>'} -> ${dependencyName}`)
    queue.push(resolved)
  }
}

function resolveDependencyLocation(packages, location, dependencyName) {
  const segments = normalizeLockPath(location).split('/').filter(Boolean)
  const dependencySegments = dependencyName.split('/')
  for (let index = segments.length; index >= 0; index -= 1) {
    const candidate = [...segments.slice(0, index), 'node_modules', ...dependencySegments].join('/')
    if (packages[candidate]) return candidate
  }
  return null
}

function packageNameFromLockLocation(location) {
  const normalized = normalizeLockPath(location)
  if (!normalized) return null
  const marker = 'node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const remainder = normalized.slice(markerIndex + marker.length)
  const segments = remainder.split('/')
  return segments[0]?.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0] ?? null
}

function normalizeLockPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//u, '') : ''
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
