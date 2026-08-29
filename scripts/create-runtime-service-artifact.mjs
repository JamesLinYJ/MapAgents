#!/usr/bin/env node

/**
 * Build the self-contained service side of a release.
 *
 * The Electron package is deliberately separate. This artifact contains the
 * Node service, Worker sources, the authoritative database schema, and service definitions together
 * with a checksum manifest. It never silently copies from the current working
 * directory: every source path is explicit and missing inputs fail the build.
 */

import { createHash, createPrivateKey, sign } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  collectNpmProductionPackages,
  createRuntimePackageLock,
  createRuntimeRootPackageManifest,
  createRuntimeWorkspacePackageManifest,
  prepareArtifactOutput,
  publicKeyFingerprint,
  rebaseCopiedAbsoluteSymlinks,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
} from './runtime-service-artifact-core.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const output = path.resolve(root, args.out ?? path.join('artifacts', 'runtime-service'))

const DARWIN_RUNTIME_CACHE = path.join(root, 'artifacts', 'runtime-dependencies', 'darwin-arm64')
const DARWIN_POSTGRES = {
  version: '16.15',
  postgisVersion: '3.4.6',
  appVersion: '2.9.6',
  url: 'https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-16.dmg',
  sha256: '2689dc64d6a02e0a66e4585616919060d8fbf5bb06886fccc05b7f87638bf081',
}
const DARWIN_UV = {
  version: '0.12.7',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-apple-darwin.tar.gz',
  sha256: '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3',
}
const DARWIN_PYTHON_VERSION = '3.12.14'

if (args.build) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const executable = process.platform === 'win32'
    ? process.env.ComSpec
    : npm
  if (!executable) throw new Error('Runtime Service 编译需要可用的 ComSpec。')
  for (const workspace of [
    '@geo-agent-platform/shared-types',
    '@geo-agent-platform/conversation-presentation',
    '@geo-agent-platform/operations-supervisor',
    '@geo-agent-platform/db',
    'geo-agent-server',
    '@geo-agent-platform/operations-console',
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
  ['apps/operations-console/dist', 'apps/operations-console/dist', 'directory'],
  ['apps/operations-console/package.json', 'apps/operations-console/package.json', 'file'],
  ['packages/db/dist', 'packages/db/dist', 'directory'],
  ['packages/db/package.json', 'packages/db/package.json', 'file'],
  ['packages/conversation-presentation/dist', 'packages/conversation-presentation/dist', 'directory'],
  ['packages/conversation-presentation/package.json', 'packages/conversation-presentation/package.json', 'file'],
  ['packages/operations-supervisor/dist', 'packages/operations-supervisor/dist', 'directory'],
  ['packages/operations-supervisor/package.json', 'packages/operations-supervisor/package.json', 'file'],
  ['packages/shared-types/dist', 'packages/shared-types/dist', 'directory'],
  ['packages/shared-types/package.json', 'packages/shared-types/package.json', 'file'],
  ['apps/worker/src', 'apps/worker/src', 'directory'],
  ['apps/worker/pyproject.toml', 'apps/worker/pyproject.toml', 'file'],
  ['apps/worker/uv.lock', 'apps/worker/uv.lock', 'file'],
  ['packages/gis-meteorology/pyproject.toml', 'packages/gis-meteorology/pyproject.toml', 'file'],
  ['packages/gis-meteorology/src', 'packages/gis-meteorology/src', 'directory'],
  ['infra/database/schema.sql', 'infra/database/schema.sql', 'file'],
  ['infra/seeds/layers', 'infra/seeds/layers', 'directory'],
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

if (args.materializeLinux) await materializeLinuxRuntime(output)
if (args.materializeDarwin) await materializeDarwinRuntime(output)

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

const files = await listArtifactEntries(output)
const entries = []
for (const file of files) {
  const relativePath = path.relative(output, file.path).replaceAll(path.sep, '/')
  if (file.kind === 'symlink') {
    entries.push({ path: relativePath, kind: 'symlink', target: file.target })
  } else {
    const content = await readFile(file.path)
    entries.push({
      path: relativePath,
      sizeBytes: content.byteLength,
      sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    })
  }
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
  const result = {
    build: false,
    force: false,
    materializeDarwin: false,
    materializeLinux: false,
    out: null,
    signingKey: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--build') result.build = true
    else if (argument === '--force') result.force = true
    else if (argument === '--materialize-darwin') result.materializeDarwin = true
    else if (argument === '--materialize-linux') result.materializeLinux = true
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
  if (result.materializeDarwin && result.materializeLinux) {
    throw new Error('Runtime Service 不能同时物化 Linux 与 macOS 运行时。')
  }
  return result
}

async function listArtifactEntries(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(fullPath)
      if (path.isAbsolute(target)) {
        throw new Error(`Runtime Service 制品符号链接不得使用绝对目标：${path.relative(output, fullPath)}`)
      }
      const resolvedTarget = path.resolve(path.dirname(fullPath), target)
      const relativeTarget = path.relative(output, resolvedTarget)
      if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        throw new Error(`Runtime Service 制品符号链接越界：${path.relative(output, fullPath)}`)
      }
      await stat(resolvedTarget)
      result.push({ path: fullPath, kind: 'symlink', target: target.replaceAll(path.sep, '/') })
      continue
    }
    if (entry.isDirectory()) result.push(...await listArtifactEntries(fullPath))
    else if (entry.isFile()) result.push({ path: fullPath, kind: 'file' })
    else throw new Error(`Runtime Service 制品输入包含不支持的文件类型：${path.relative(output, fullPath)}`)
  }
  return result
}

async function materializeLinuxRuntime(artifactRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('--materialize-linux 当前只支持 Linux x64 构建主机。')
  }

  await materializeNodeRuntime(artifactRoot)

  runRequired('npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: artifactRoot })

  const workerLock = await readFile(path.join(artifactRoot, 'apps', 'worker', 'uv.lock'), 'utf8')
  const requirementsPath = path.join(artifactRoot, 'python-private-requirements.lock')
  const privateRequirements = ['cfgrib', 'python-docx']
    .map(packageName => lockedPurePythonRequirement(workerLock, packageName))
  await writeFile(requirementsPath, `${privateRequirements.join('\n')}\n`, 'utf8')
  const privatePackagesRoot = path.join(artifactRoot, 'python-packages')
  runRequired('uv', [
    'pip',
    'install',
    '--python', '/usr/bin/python3',
    '--target', privatePackagesRoot,
    '--no-deps',
    '--require-hashes',
    '--requirements', requirementsPath,
  ], { cwd: artifactRoot, quiet: true })

  const pythonPath = [
    path.join(artifactRoot, 'apps', 'worker', 'src'),
    path.join(artifactRoot, 'packages', 'gis-meteorology', 'src'),
    privatePackagesRoot,
  ].join(path.delimiter)
  runRequired('/usr/bin/python3', [
    '-c',
    [
      'from pathlib import Path',
      'root = Path("python-packages")',
      'files = list(root.rglob("*.py"))',
      'assert files',
      '[compile(file.read_bytes(), str(file), "exec") for file in files]',
      'import docx',
      'assert (root / "cfgrib" / "__init__.py").is_file()',
      'import worker_app.sidecar',
    ].join('; '),
  ], { cwd: artifactRoot, environment: { PYTHONPATH: pythonPath } })
  runRequired(path.join(artifactRoot, 'node-runtime', 'bin', 'node'), [
    '--input-type=module',
    '--eval',
    "await import('sharp'); await import('@geo-agent-platform/operations-supervisor')",
  ], { cwd: path.join(artifactRoot, 'apps', 'server') })
  await writeFile(path.join(artifactRoot, 'linux-runtime-bundle.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'linux',
    architecture: 'x64',
    pythonRuntime: 'system',
    minimumPythonVersion: '3.11',
    privatePythonPackages: privateRequirements.map(value => value.split(' ')[0]),
    nodeRuntime: 'bundled',
    nodeVersion: process.version,
  }, null, 2)}\n`, 'utf8')
}

/**
 * macOS 桌面包必须在离线状态下拥有完整本机服务。构建机下载的第三方制品
 * 都固定版本并校验 SHA256；最终应用只携带运行文件，不在用户首次启动时联网。
 */
async function materializeDarwinRuntime(artifactRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('--materialize-darwin 当前只支持 macOS arm64 构建主机。')
  }

  await materializeNodeRuntime(artifactRoot)
  runRequired('npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: artifactRoot })

  await mkdir(DARWIN_RUNTIME_CACHE, { recursive: true })
  const postgresDmg = path.join(
    DARWIN_RUNTIME_CACHE,
    `Postgres-${DARWIN_POSTGRES.appVersion}-16.dmg`,
  )
  await downloadVerified(DARWIN_POSTGRES.url, postgresDmg, DARWIN_POSTGRES.sha256)
  await materializeDarwinPostgres(artifactRoot, postgresDmg)

  const uvArchive = path.join(DARWIN_RUNTIME_CACHE, `uv-${DARWIN_UV.version}.tar.gz`)
  await downloadVerified(DARWIN_UV.url, uvArchive, DARWIN_UV.sha256)
  const uvExecutable = path.join(
    DARWIN_RUNTIME_CACHE,
    `uv-${DARWIN_UV.version}`,
    'uv-aarch64-apple-darwin',
    'uv',
  )
  if (!await isRegularFile(uvExecutable)) {
    const extractionRoot = path.dirname(path.dirname(uvExecutable))
    await rm(extractionRoot, { recursive: true, force: true })
    await mkdir(extractionRoot, { recursive: true })
    runRequired('tar', ['-xzf', uvArchive, '-C', extractionRoot], { cwd: root })
  }
  runRequired(uvExecutable, ['--version'], { cwd: root })

  const pythonInstallRoot = path.join(DARWIN_RUNTIME_CACHE, 'python')
  runRequired(uvExecutable, [
    'python', 'install', DARWIN_PYTHON_VERSION,
    '--install-dir', pythonInstallRoot,
    '--no-bin',
    '--compile-bytecode',
  ], { cwd: root })
  const pythonSource = path.join(
    pythonInstallRoot,
    `cpython-${DARWIN_PYTHON_VERSION}-macos-aarch64-none`,
  )
  const pythonRoot = path.join(artifactRoot, 'python-runtime')
  await cp(pythonSource, pythonRoot, { recursive: true, dereference: false })
  await rebaseCopiedAbsoluteSymlinks(pythonSource, pythonRoot)
  const pythonExecutable = path.join(pythonRoot, 'bin', `python${pythonMinorVersion()}`)

  const workerBuildEnvironment = path.join(artifactRoot, '.worker-build-environment')
  await rm(workerBuildEnvironment, { recursive: true, force: true })
  runRequired(uvExecutable, [
    'sync',
    '--project', 'apps/worker',
    '--frozen',
    '--no-dev',
    '--no-editable',
    '--compile-bytecode',
    '--python', pythonExecutable,
  ], {
    cwd: artifactRoot,
    environment: { UV_PROJECT_ENVIRONMENT: workerBuildEnvironment },
  })
  const sitePackages = path.join(
    workerBuildEnvironment,
    'lib',
    `python${pythonMinorVersion()}`,
    'site-packages',
  )
  const pythonPackages = path.join(artifactRoot, 'python-packages')
  await cp(sitePackages, pythonPackages, { recursive: true, dereference: false })
  await rebaseCopiedAbsoluteSymlinks(sitePackages, pythonPackages)
  await rm(workerBuildEnvironment, { recursive: true, force: true })

  const pythonPath = [
    path.join(artifactRoot, 'apps', 'worker', 'src'),
    path.join(artifactRoot, 'packages', 'gis-meteorology', 'src'),
    pythonPackages,
  ].join(path.delimiter)
  runRequired(pythonExecutable, [
    '-c',
    [
      'import fastapi, pydantic, uvicorn',
      'import numpy, pandas, rasterio, scipy, shapely, xarray',
      'import worker_app.sidecar',
    ].join('; '),
  ], { cwd: artifactRoot, environment: { PYTHONPATH: pythonPath } })
  runRequired(path.join(artifactRoot, 'postgresql-portable', 'bin', 'postgres'), [
    '--version',
  ], { cwd: artifactRoot })
  runRequired(path.join(artifactRoot, 'node-runtime', 'bin', 'node'), [
    '--input-type=module',
    '--eval',
    "await import('sharp'); await import('@geo-agent-platform/operations-supervisor')",
  ], { cwd: path.join(artifactRoot, 'apps', 'server') })

  await writeFile(path.join(artifactRoot, 'darwin-runtime-bundle.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: process.version,
    pythonVersion: DARWIN_PYTHON_VERSION,
    postgresVersion: DARWIN_POSTGRES.version,
    postgisVersion: DARWIN_POSTGRES.postgisVersion,
    sources: {
      postgresApp: DARWIN_POSTGRES.url,
      uv: DARWIN_UV.url,
    },
  }, null, 2)}\n`, 'utf8')
}

async function materializeDarwinPostgres(artifactRoot, imagePath) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-postgres-app-'))
  const mountPoint = path.join(temporaryRoot, 'mount')
  await mkdir(mountPoint)
  let mounted = false
  try {
    runRequired('hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, imagePath,
    ], { cwd: root, quiet: true })
    mounted = true
    const postgresSource = path.join(
      mountPoint,
      'Postgres.app',
      'Contents',
      'Versions',
      '16',
    )
    const postgresRoot = path.join(artifactRoot, 'postgresql-portable')
    await mkdir(postgresRoot, { recursive: true })
    for (const directory of ['bin', 'lib', 'share']) {
      await cp(path.join(postgresSource, directory), path.join(postgresRoot, directory), {
        recursive: true,
        dereference: false,
      })
    }
    await rebaseCopiedAbsoluteSymlinks(postgresSource, postgresRoot)
    await cp(
      path.join(mountPoint, 'Postgres.app', 'Contents', 'Resources', 'Credits.rtf'),
      path.join(postgresRoot, 'PostgresApp-Credits.rtf'),
    )
  } finally {
    if (mounted) {
      runRequired('hdiutil', ['detach', mountPoint], { cwd: root, quiet: true })
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function downloadVerified(url, destination, expectedSha256) {
  if (await isRegularFile(destination)) {
    const currentHash = await sha256File(destination)
    if (currentHash === expectedSha256) return
    await rm(destination, { force: true })
  }
  await mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.${process.pid}.download`
  await rm(temporaryPath, { force: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`运行时依赖下载失败：${url}（HTTP ${response.status}）`)
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    )
    const actualSha256 = await sha256File(temporaryPath)
    if (actualSha256 !== expectedSha256) {
      throw new Error(`运行时依赖 SHA256 不匹配：${url}`)
    }
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function isRegularFile(filePath) {
  return (await stat(filePath).catch(() => null))?.isFile() === true
}

function pythonMinorVersion() {
  return DARWIN_PYTHON_VERSION.split('.').slice(0, 2).join('.')
}

async function materializeNodeRuntime(artifactRoot) {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`本机运行时发布必须由 Node 24+ 构建，当前为 ${process.version}。`)
  }
  const compatibilityProbe = spawnSync(process.execPath, [
    '-e',
    "const s=new Intl.Segmenter(undefined,{granularity:'grapheme'});if([...s.segment('中A')].length!==2)process.exit(2)",
  ], { encoding: 'utf8' })
  if (compatibilityProbe.error || compatibilityProbe.status !== 0) {
    throw new Error(`构建机 Node 的 Intl.Segmenter 不可用（${process.version}），拒绝生成运行时。`)
  }

  const destination = path.join(artifactRoot, 'node-runtime', 'bin', 'node')
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(process.execPath, destination)
  await chmod(destination, 0o755)
  const version = spawnSync(destination, ['--version'], { encoding: 'utf8' })
  if (version.error || version.status !== 0 || version.stdout.trim() !== process.version) {
    throw new Error('复制后的 Node 运行时版本校验失败。')
  }
  await writeFile(path.join(artifactRoot, 'node-runtime-version.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  }, null, 2)}\n`, 'utf8')
}

function runRequired(file, commandArguments, options = {}) {
  const stdio = options.capture
    ? ['ignore', 'pipe', 'inherit']
    : (options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit')
  const result = spawnSync(file, commandArguments, {
    cwd: options.cwd,
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...options.environment },
    stdio,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Runtime Service 依赖物化失败：${file} ${commandArguments.join(' ')}`)
  }
  return options.capture ? String(result.stdout) : ''
}

function lockedPurePythonRequirement(lockSource, packageName) {
  const marker = `[[package]]\nname = "${packageName}"`
  const start = lockSource.indexOf(marker)
  if (start < 0) throw new Error(`Worker uv.lock 缺少 ${packageName}。`)
  const next = lockSource.indexOf('[[package]]', start + marker.length)
  const block = lockSource.slice(start, next < 0 ? undefined : next)
  const version = /^version = "([^"]+)"$/mu.exec(block)?.[1]
  const wheel = /url = "[^"]+-py3-none-any\.whl", hash = "(sha256:[a-f0-9]{64})"/u.exec(block)
  if (!version || !wheel) {
    throw new Error(`Worker uv.lock 中的 ${packageName} 不是可私有携带的锁定纯 Python wheel。`)
  }
  return `${packageName}==${version} --hash=${wheel[1]}`
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
  const databaseSchemaVersion = schemaCompatibility.DATABASE_SCHEMA_CONTRACT_VERSION
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
