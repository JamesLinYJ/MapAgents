// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 发布边界测试
//
//   文件:       runtime-service-artifact.test.mjs
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { generateKeyPairSync, sign } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  assertArtifactFileSet,
  collectNpmProductionPackages,
  createRuntimePackageLock,
  createRuntimeRootPackageManifest,
  createRuntimeWorkspacePackageManifest,
  prepareArtifactOutput,
  publicKeyFingerprint,
  RUNTIME_OUTPUT_MARKER,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
  verifyTrustedManifestSignature,
} from './runtime-service-artifact-core.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('force 只能覆盖已标记的专用制品目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-output-'))
  try {
    const unmanaged = path.join(root, 'artifacts', 'unmanaged')
    await mkdir(unmanaged, { recursive: true })
    await writeFile(path.join(unmanaged, 'keep.txt'), 'keep', 'utf8')
    await writeFile(
      path.join(unmanaged, 'runtime-service-manifest.json'),
      JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }),
      'utf8',
    )
    await assert.rejects(
      prepareArtifactOutput(root, unmanaged, true),
      /拒绝覆盖非 Runtime Service 专用目录/u,
    )
    assert.equal(await readFile(path.join(unmanaged, 'keep.txt'), 'utf8'), 'keep')

    await assert.rejects(
      prepareArtifactOutput(root, root, true),
      /不得是仓库根或其祖先/u,
    )

    const managed = path.join(root, 'artifacts', 'managed')
    await mkdir(managed, { recursive: true })
    await writeFile(
      path.join(managed, RUNTIME_OUTPUT_MARKER),
      JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }),
      'utf8',
    )
    await writeFile(path.join(managed, 'stale.txt'), 'stale', 'utf8')
    await prepareArtifactOutput(root, managed, true)
    await access(path.join(managed, RUNTIME_OUTPUT_MARKER))
    await assert.rejects(access(path.join(managed, 'stale.txt')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime package 和 lock 只保留生产 workspace', () => {
  const sourcePackage = {
    name: 'platform',
    private: true,
    version: '1.0.0',
    workspaces: [...RUNTIME_WORKSPACE_PATHS, 'apps/desktop'],
    dependencies: { root: '1.0.0' },
    devDependencies: { test: '1.0.0' },
  }
  const runtimePackage = createRuntimeRootPackageManifest(sourcePackage)
  const runtimeLock = createRuntimePackageLock({
    name: 'platform',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': sourcePackage,
      'apps/server': {
        name: 'server',
        version: '1.0.0',
        dependencies: { pino: '1.0.0' },
        devDependencies: { vitest: '1.0.0' },
      },
      'apps/operations-console': { name: 'console', version: '1.0.0' },
      'apps/desktop': { name: 'desktop', version: '1.0.0' },
      'node_modules/desktop': { resolved: 'apps/desktop', link: true },
      'packages/db': { name: 'db', version: '1.0.0' },
      'packages/shared-types': { name: 'shared', version: '1.0.0' },
      'packages/conversation-presentation': { name: 'presentation', version: '1.0.0' },
      'packages/operations-supervisor': { name: 'supervisor', version: '1.0.0' },
    },
  }, runtimePackage)

  assert.deepEqual(runtimePackage.workspaces, RUNTIME_WORKSPACE_PATHS)
  assert.equal(runtimePackage.scripts['start:api'], 'node apps/server/dist/main.js')
  assert.equal('devDependencies' in runtimePackage, false)
  assert.deepEqual(runtimeLock.packages[''].workspaces, RUNTIME_WORKSPACE_PATHS)
  assert.deepEqual(runtimeLock.packages['apps/server'].dependencies, { pino: '1.0.0' })
  assert.equal('devDependencies' in runtimeLock.packages['apps/server'], false)
  assert.equal(runtimeLock.packages['apps/desktop'], undefined)
  assert.equal(runtimeLock.packages['node_modules/desktop'], undefined)

  const workspacePackage = createRuntimeWorkspacePackageManifest({
    name: 'server',
    dependencies: { pino: '1.0.0' },
    devDependencies: { vitest: '1.0.0' },
  })
  assert.deepEqual(workspacePackage.dependencies, { pino: '1.0.0' })
  assert.equal('devDependencies' in workspacePackage, false)
})

test('npm SBOM 闭包遍历生产依赖且排除无关 workspace', async () => {
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'))
  const components = collectNpmProductionPackages(lock)
  const names = new Set(components.map(component => component.name))

  assert.ok(components.length > 100)
  assert.ok(names.has('geo-agent-server'))
  assert.ok(names.has('@geo-agent-platform/operations-supervisor'))
  assert.ok(names.has('pino'))
  assert.ok(names.has('zod'))
  assert.equal(names.has('@geo-agent-platform/desktop'), false)
  assert.equal(names.has('electron'), false)
})

test('manifest 签名只信任部署侧公钥', () => {
  const trusted = generateKeyPairSync('ed25519')
  const attacker = generateKeyPairSync('ed25519')
  const manifestBytes = Buffer.from('{"releaseId":"release-1"}\n', 'utf8')
  const keyFingerprint = publicKeyFingerprint(trusted.publicKey)
  const signature = {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyFingerprint,
    signatureBase64: sign(null, manifestBytes, trusted.privateKey).toString('base64'),
  }
  const manifestSigning = { algorithm: 'ed25519', keyFingerprint }

  assert.doesNotThrow(() => verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning,
    signature,
    trustedPublicKey: trusted.publicKey,
  }))
  assert.throws(() => verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning,
    signature,
    trustedPublicKey: attacker.publicKey,
  }), /信任根不一致/u)
})

test('runtime 制品携带首次启动必需的系统图层 seed', async () => {
  const creator = await readFile(
    path.join(repositoryRoot, 'scripts', 'create-runtime-service-artifact.mjs'),
    'utf8',
  )
  const verifier = await readFile(
    path.join(repositoryRoot, 'scripts', 'verify-runtime-service-artifact.mjs'),
    'utf8',
  )
  assert.match(creator, /\['infra\/seeds\/layers', 'infra\/seeds\/layers', 'directory'\]/u)
  assert.match(verifier, /infra\/seeds\/layers\/catalog\.json/u)
  assert.match(verifier, /infra\/seeds\/layers\/hangzhou_districts\.geojson/u)
})

test('verifier 拒绝 manifest 未声明的额外文件', () => {
  assert.doesNotThrow(() => assertArtifactFileSet(
    ['package.json', 'runtime-service-manifest.json'],
    ['package.json'],
  ))
  assert.throws(() => assertArtifactFileSet(
    ['package.json', 'runtime-service-manifest.json', 'injected.js'],
    ['package.json'],
  ), /未声明的文件.*injected\.js/u)
})
