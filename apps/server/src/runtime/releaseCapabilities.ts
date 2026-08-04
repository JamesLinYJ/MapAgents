// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务发布能力清单
//
//   文件:       releaseCapabilities.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  runtimeCapabilitiesSchema,
  type RuntimeCapabilities,
} from '@geo-agent-platform/shared-types/release'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../db/schemaCompatibility.js'

const packageVersion = readServerPackageVersion()

/**
 * 发布 ID 优先来自服务制品注入的显式值；开发工作树使用带版本的开发 ID，
 * 因而不会把两个不同制品伪装成同一个发布版本。
 */
export function resolveReleaseId(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.GEO_AGENT_PLATFORM_RELEASE_ID?.trim()
  if (configured) return configured
  return `geo-agent-platform@${packageVersion}+workspace`
}

export function buildRuntimeCapabilities(input: {
  workerContractDigest: string | null
  environment?: NodeJS.ProcessEnv
}): RuntimeCapabilities {
  return runtimeCapabilitiesSchema.parse({
    releaseId: resolveReleaseId(input.environment),
    apiProtocolVersion: API_PROTOCOL_VERSION,
    minDesktopProtocol: DESKTOP_PROTOCOL_VERSION,
    maxDesktopProtocol: DESKTOP_PROTOCOL_VERSION,
    databaseSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    workerContractDigest: input.workerContractDigest,
  })
}

function readServerPackageVersion(): string {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(packagePath), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error('无法读取 geo-agent-server 发布版本。')
  }
  return parsed.version
}
