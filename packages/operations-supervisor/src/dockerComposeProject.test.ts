// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 固定 Docker Compose 项目边界测试
//
//   文件:       dockerComposeProject.test.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  parseComposeProcesses,
  verifyComposePortOwnership,
  type ComposeProcess,
} from './dockerComposeProject.js'

const composeFile = path.resolve('infra/compose/docker-compose.dev.yml')

describe('Docker Compose project ownership', () => {
  it('accepts running containers from the exact fixed compose file', () => {
    const result = verifyComposePortOwnership({
      composeFile,
      occupiedPorts: [
        { environmentName: 'POSTGIS_PORT', port: 55432 },
        { environmentName: 'MARTIN_PORT', port: 3000 },
      ],
      processes: [
        composeProcess('postgis', 55432, composeFile),
        composeProcess('martin', 3000, composeFile),
      ],
    })

    expect(result).toEqual({
      owned: true,
      message: '已核验 2 个端口属于当前 GeoForge Compose 项目。',
    })
  })

  it('rejects a container created from another compose file', () => {
    const result = verifyComposePortOwnership({
      composeFile,
      occupiedPorts: [{ environmentName: 'POSTGIS_PORT', port: 55432 }],
      processes: [composeProcess('postgis', 55432, path.resolve('other/docker-compose.yml'))],
    })

    expect(result).toEqual({
      owned: false,
      message: 'POSTGIS_PORT 端口 55432 不属于当前 GeoForge Compose 项目。',
    })
  })

  it('rejects stopped containers and missing port publications', () => {
    const stopped = composeProcess('postgis', 55432, composeFile)
    stopped.State = 'exited'
    const result = verifyComposePortOwnership({
      composeFile,
      occupiedPorts: [
        { environmentName: 'POSTGIS_PORT', port: 55432 },
        { environmentName: 'MARTIN_PORT', port: 3000 },
      ],
      processes: [stopped, composeProcess('martin', 3001, composeFile)],
    })

    expect(result.owned).toBe(false)
    expect(result.message).toContain('POSTGIS_PORT')
  })

  it('parses Docker Compose JSON-lines output without weakening its schema', () => {
    const first = composeProcess('postgis', 55432, composeFile)
    const second = composeProcess('martin', 3000, composeFile)

    expect(parseComposeProcesses(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`))
      .toMatchObject([
        { Service: 'postgis', Publishers: [{ PublishedPort: 55432 }] },
        { Service: 'martin', Publishers: [{ PublishedPort: 3000 }] },
      ])
  })
})

function composeProcess(service: string, publishedPort: number, configFile: string): ComposeProcess {
  return {
    ID: `${service}-container`,
    Labels: `com.docker.compose.project.config_files=${configFile},com.docker.compose.service=${service}`,
    Name: `geoforge-${service}-dev`,
    Publishers: [{
      URL: '127.0.0.1',
      TargetPort: publishedPort,
      PublishedPort: publishedPort,
      Protocol: 'tcp',
    }],
    Service: service,
    State: 'running',
  }
}
