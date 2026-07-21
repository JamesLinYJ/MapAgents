// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Process Compose 入口架构守卫
//
//   文件:       processComposeEntrypoints.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('Process Compose 入口架构', () => {
  it('使用当前固定版本支持的前台监督模式且只装配一次 dotenv', async () => {
    const windows = await source('dev.ps1')
    const linux = await source('dev.sh')
    const windowsService = await source('scripts/run-geoforge-windows-service.ps1')
    const linuxService = await source('deploy/systemd/geoforge-process-compose.service')

    for (const entrypoint of [windows, linux, windowsService, linuxService]) {
      expect(entrypoint).not.toContain('--detached')
      expect(entrypoint).toContain('--disable-dotenv')
    }
    expect(windows).toContain('Start-Process -FilePath $ProcessCompose')
    expect(windows).toContain('Assert-StartupPortsAvailable $Target')
    expect(linux).toContain('nohup "$PC"')
    expect(windows).not.toMatch(/\.pid['"]/u)
    expect(linux).not.toMatch(/\.pid['"]/u)
  })

  it('通过平台脚本调用 Worker，不把解释器路径嵌入监督器命令字符串', async () => {
    const configurations = await Promise.all([
      source('config/process-compose.windows.yaml'),
      source('config/process-compose.production.windows.yaml'),
      source('config/process-compose.linux.yaml'),
      source('config/process-compose.production.linux.yaml'),
    ])

    expect(configurations[0]).toContain('scripts/run-worker.ps1')
    expect(configurations[1]).toContain('scripts/run-worker.ps1')
    expect(configurations[2]).toContain('scripts/run-worker.sh')
    expect(configurations[3]).toContain('scripts/run-worker.sh')
    for (const configuration of configurations) {
      expect(configuration).not.toMatch(/command:.*WORKER_PYTHON/u)
    }
  })
})

function source(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8')
}
