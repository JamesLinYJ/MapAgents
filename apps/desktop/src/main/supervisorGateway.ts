// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Supervisor 网关
//
//   文件:       supervisorGateway.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import {
  OperationsClient,
  resolveOperationsPaths,
} from '@geo-agent-platform/operations-supervisor'

import {
  desktopSupervisorCommandSchema,
  type DesktopControlRequest,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import {
  operationsLogEntrySchema,
  type OperationsLogEntry,
  type OperationsLogQuery,
  type OperationsOperationResult,
} from '@geo-agent-platform/shared-types/operations'
import type { DesktopRuntimeConfig } from './runtimeConfig.js'

export class DesktopSupervisorGateway {
  private client: OperationsClient | null = null

  constructor(
    private readonly runtime: DesktopRuntimeConfig,
    private readonly localLogs?: {
      read(query: OperationsLogQuery): Promise<OperationsLogEntry[]>
    },
  ) {}

  async handle(request: DesktopControlRequest): Promise<DesktopControlResponse> {
    try {
      const command = desktopSupervisorCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      let data: unknown
      if (command.command === 'logs') {
        data = await this.readLogs(command.payload)
      } else if (command.command === 'status') {
        const client = await this.connect()
        data = await client.status()
      } else {
        const client = await this.connect()
        data = await client.operate({
          action: command.command,
          target: command.payload.target,
          operationId: command.payload.operationId,
          ...(command.command === 'stop' && command.payload.keepInfra !== undefined
            ? { keepInfra: command.payload.keepInfra }
            : {}),
        })
      }
      return {
        version: request.version,
        requestId: request.requestId,
        ok: true,
        data,
      }
    } catch (error) {
      this.client?.close()
      this.client = null
      return {
        version: request.version,
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'supervisor_unavailable',
          message: safeMessage(error),
        },
      }
    }
  }

  close(): void {
    this.client?.close()
    this.client = null
  }

  /**
   * 最高风险关闭不进入 Renderer 可调用的通用 supervisor 命令。调用方必须先
   * 完成 Main 身份和文字确认；这里再通过受保护 token 完成本机握手。
   */
  async shutdown(): Promise<OperationsOperationResult> {
    try {
      const client = await this.connect()
      return await client.shutdown()
    } catch (error) {
      this.client?.close()
      this.client = null
      throw new Error(safeMessage(error))
    }
  }

  private async readLogs(query: OperationsLogQuery): Promise<OperationsLogEntry[]> {
    const localEntries = await this.localLogs?.read(query) ?? []
    try {
      const client = await this.connect()
      const supervisorEntries = await client.logs(query.services, query.tail, {
        levels: query.levels,
        streams: query.streams,
        search: query.search,
        includeSupervisor: query.includeSupervisor,
        afterSequence: query.afterSequence,
      })
      return mergeLogEntries(supervisorEntries, localEntries, query.tail)
    } catch (error) {
      this.client?.close()
      this.client = null
      if (!query.includeSupervisor) throw error
      const unavailable = operationsLogEntrySchema.parse({
        sequence: 1_999_999_999,
        serviceId: null,
        component: 'desktop',
        processId: process.pid,
        stream: 'supervisor',
        level: 'error',
        message: `Supervisor 日志不可用：${safeMessage(error)}`,
        createdAt: new Date().toISOString(),
      })
      const includeUnavailable = (
        (query.levels.length === 0 || query.levels.includes('error'))
        && (query.streams.length === 0 || query.streams.includes('supervisor'))
        && (
          !query.search.trim()
          || `${unavailable.component ?? ''} ${unavailable.message}`
            .toLocaleLowerCase('zh-CN')
            .includes(query.search.trim().toLocaleLowerCase('zh-CN'))
        )
      )
      return mergeLogEntries(
        [],
        includeUnavailable ? [...localEntries, unavailable] : localEntries,
        query.tail,
      )
    }
  }

  private async connect(): Promise<OperationsClient> {
    if (this.client) return this.client
    const paths = await resolveOperationsPaths({
      projectRoot: this.runtime.projectRoot,
      runtimeRoot: this.runtime.runtimeRoot,
      tokenFile: this.runtime.supervisorTokenFile,
      profile: this.runtime.profile,
    })
    const token = (await readFile(paths.tokenFile, 'utf8')).trim()
    const client = await OperationsClient.connect({
      endpoint: paths.endpoint,
      token,
      interactive: false,
    })
    client.onDisconnected(() => {
      if (this.client === client) this.client = null
    })
    this.client = client
    return client
  }
}

function mergeLogEntries(
  supervisorEntries: readonly OperationsLogEntry[],
  desktopEntries: readonly OperationsLogEntry[],
  tail: number,
): OperationsLogEntry[] {
  if (tail === 0) return []
  return [...supervisorEntries, ...desktopEntries]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-tail)
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return '无法连接本机监督器。'
  const message = error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
  if (/\bENOENT\b/iu.test(message)) {
    return '本机监督器尚未初始化或运行文件缺失，请从本机运维台启动后台服务。'
  }
  if (/\b(?:EACCES|EPERM)\b/iu.test(message)) {
    return '当前账户无权访问本机监督器，请检查 GeoForge 运维权限。'
  }
  if (/\bECONNREFUSED\b|named pipe|unix socket/iu.test(message)) {
    return '本机监督器尚未运行，请从本机运维台启动后台服务。'
  }
  return message
}
