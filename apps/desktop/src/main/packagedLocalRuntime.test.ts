// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux RPM 本机运行时首次部署测试
//
//   文件:       packagedLocalRuntime.test.ts
//
//   日期:       2026年08月10日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { preparePackagedLocalRuntime } from './packagedLocalRuntime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('packaged Linux local runtime', () => {
  it('creates private user configuration and starts the packaged service without Docker', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const commands: string[][] = []

    const resolution = await preparePackagedLocalRuntime({
      platform: 'linux',
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return arguments_.includes('is-active') ? 3 : 0
      },
    })

    expect(resolution).not.toBeNull()
    const environmentFile = resolution!.serviceEnvironmentFile
    const source = await readFile(environmentFile, 'utf8')
    expect(source).toContain('NODE_ENV="production"')
    expect(source).toContain('API_PORT="8000"')
    expect(source).toContain('WORKER_PORT="8012"')
    expect(source).toContain('POSTGIS_PORT="54321"')
    expect(source).toContain('WORKER_PYTHON="/usr/bin/python3"')
    expect(source).toContain('/python-packages')
    expect(source).not.toContain('docker')
    expect((await stat(environmentFile)).mode & 0o777).toBe(0o600)
    expect((await stat(resolution!.runtimeManifestPath)).mode & 0o777).toBe(0o600)
    expect(commands).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'geo-agent-platform-supervisor.service'],
      ['--user', 'is-active', '--quiet', 'geo-agent-platform-supervisor.service'],
      ['--user', 'start', 'geo-agent-platform-supervisor.service'],
    ])
  })

  it('preserves secrets and restarts an active service only when the packaged release changes', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const options = {
      platform: 'linux' as const,
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
    }
    const first = await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async arguments_ => arguments_.includes('is-active') ? 3 : 0,
    })
    const initialEnvironment = await readFile(first!.serviceEnvironmentFile, 'utf8')

    await createBundledRuntime(resourcesPath, 'release-2')
    const commands: string[][] = []
    const second = await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })
    const updatedEnvironment = await readFile(second!.serviceEnvironmentFile, 'utf8')

    const secretLines = (source: string) => source.split('\n').filter(line => (
      line.startsWith('BETTER_AUTH_SECRET=') || line.startsWith('WORKER_SHARED_SECRET=')
    ))
    expect(secretLines(updatedEnvironment)).toEqual(secretLines(initialEnvironment))
    expect(updatedEnvironment).toContain('GEO_AGENT_PLATFORM_RELEASE_ID="release-2"')
    expect(commands.at(-1)).toEqual([
      '--user', 'restart', 'geo-agent-platform-supervisor.service',
    ])
  })

  it('keeps an administrator-provided system deployment authoritative', async () => {
    const root = await createTemporaryDirectory()
    const systemManifest = path.join(root, 'runtime-manifest.v1.json')
    await writeFile(systemManifest, '{}', 'utf8')
    const commands: string[][] = []

    await expect(preparePackagedLocalRuntime({
      platform: 'linux',
      resourcesPath: path.join(root, 'resources'),
      homeDirectory: path.join(root, 'home'),
      environment: {},
      systemRuntimeManifestPath: systemManifest,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toBeNull()
    expect(commands).toEqual([])
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-packaged-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createBundledRuntime(resourcesPath: string, releaseId: string): Promise<void> {
  const projectRoot = path.join(resourcesPath, 'runtime-service')
  const files = [
    'apps/server/dist/main.js',
    'apps/operations-console/dist/installedCliEntry.js',
    'node-runtime/bin/node',
    'packages/operations-supervisor/dist/cli.js',
    'python-packages/cfgrib/__init__.py',
    'python-packages/docx/__init__.py',
    'node_modules/.package-lock.json',
  ]
  for (const relativePath of files) {
    const filePath = path.join(projectRoot, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'fixture\n', 'utf8')
  }
  await writeFile(path.join(projectRoot, 'runtime-service-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'geo-agent-runtime-service',
    releaseId,
    entries: [],
  }), 'utf8')
}
