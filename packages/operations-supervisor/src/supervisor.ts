// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机进程监督运行时
//
//   文件:       supervisor.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'

import type {
  OperationsLogEntry,
  OperationsOperationResult,
  OperationsProfile,
  OperationsServiceId,
  OperationsServiceSnapshot,
  OperationsServiceState,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import concurrently, { type CloseEvent, Command } from 'concurrently'
import type { Logger } from 'pino'
import si from 'systeminformation'
import treeKill from 'tree-kill'
import { z } from 'zod'

import {
  commandFor,
  executableFor,
  SERVICE_CATALOG,
  SERVICE_ORDER,
  transitiveDependencies,
  transitiveDependents,
  type ServiceDefinition,
} from './catalog.js'
import { environmentForConcurrently, environmentForService } from './environment.js'
import { LineDecoder, OperationsLogBuffer } from './logBuffer.js'
import {
  collectDockerMetrics,
  collectHostMetrics,
  collectProcessTreeMetrics,
  unavailable,
  type ProcessTreeMetrics,
} from './metrics.js'
import type { OperationsPaths } from './paths.js'

const execFileAsync = promisify(execFile)
const noopOutput = new Writable({ write(_chunk, _encoding, callback) { callback() } })

const leaseSchema = z.object({
  serviceId: z.enum(['infra', 'worker', 'api', 'web']),
  pid: z.number().int().positive(),
  marker: z.string().min(16),
  commandHash: z.string().length(64),
  startedAt: z.string().datetime(),
}).strict()
const leasesSchema = z.array(leaseSchema)
type Lease = z.infer<typeof leaseSchema>

interface ManagedService {
  definition: ServiceDefinition
  state: OperationsServiceState
  healthMessage: string
  command: Command | null
  desiredRunning: boolean
  stopping: boolean
  startedAt: Date | null
  restartCount: number
  failureTimes: number[]
  lastExitCode: string | number | null
  healthFailures: number
  healthTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  metrics: ProcessTreeMetrics
  containers: OperationsServiceSnapshot['containers']
}

export interface SupervisorActor {
  osUser: string
  hostname: string
  processId: number
}

export interface OperationsSupervisorOptions {
  paths: OperationsPaths
  profile: OperationsProfile
  environment: NodeJS.ProcessEnv
  logBuffer: OperationsLogBuffer
  logger: Logger
}

export class OperationsSupervisor {
  private readonly records = new Map<OperationsServiceId, ManagedService>()
  private readonly events = new EventEmitter()
  private readonly operationResults = new Map<string, OperationsOperationResult>()
  private readonly operationPromises = new Map<string, Promise<OperationsOperationResult>>()
  private readonly startedAt = new Date()
  private readonly daemonId = randomUUID()
  private operationQueue: Promise<unknown> = Promise.resolve()
  private leaseWriteQueue: Promise<void> = Promise.resolve()
  private sequence = 0
  private subscribers = 0
  private metricsTimer: NodeJS.Timeout | null = null
  private hostMetrics = {
    cpuPercent: unavailable('尚无指标订阅。'),
    memoryUsedBytes: unavailable('尚无指标订阅。'),
    memoryTotalBytes: unavailable('尚无指标订阅。'),
    runtimeDiskUsedBytes: unavailable('尚无指标订阅。'),
    runtimeDiskTotalBytes: unavailable('尚无指标订阅。'),
  }

  constructor(private readonly options: OperationsSupervisorOptions) {
    for (const serviceId of SERVICE_ORDER) {
      this.records.set(serviceId, {
        definition: SERVICE_CATALOG[serviceId],
        state: 'stopped',
        healthMessage: '未启动',
        command: null,
        desiredRunning: false,
        stopping: false,
        startedAt: null,
        restartCount: 0,
        failureTimes: [],
        lastExitCode: null,
        healthFailures: 0,
        healthTimer: null,
        restartTimer: null,
        metrics: { cpuPercent: unavailable('服务没有运行进程。'), memoryBytes: unavailable('服务没有运行进程。') },
        containers: [],
      })
    }
  }

  get id(): string {
    return this.daemonId
  }

  get profile(): OperationsProfile {
    return this.options.profile
  }

  get workspaceId(): string {
    return this.options.paths.workspaceId
  }

  onSnapshot(listener: (snapshot: OperationsSnapshot) => void): () => void {
    this.events.on('snapshot', listener)
    return () => this.events.off('snapshot', listener)
  }

  onLog(listener: (entry: OperationsLogEntry) => void): () => void {
    this.events.on('log', listener)
    return () => this.events.off('log', listener)
  }

  onOperation(listener: (operation: OperationsOperationResult) => void): () => void {
    this.events.on('operation', listener)
    return () => this.events.off('operation', listener)
  }

  setMetricsSubscriber(active: boolean): void {
    this.subscribers = Math.max(0, this.subscribers + (active ? 1 : -1))
    if (this.subscribers > 0 && !this.metricsTimer) {
      void this.collectMetrics()
      this.metricsTimer = setInterval(() => void this.collectMetrics(), 2_000)
      this.metricsTimer.unref()
    } else if (this.subscribers === 0 && this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
  }

  snapshot(): OperationsSnapshot {
    const now = Date.now()
    return {
      sequence: ++this.sequence,
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        profile: this.options.profile,
        supervisorPid: process.pid,
        supervisorStartedAt: this.startedAt.toISOString(),
        ...this.hostMetrics,
        sampledAt: new Date().toISOString(),
      },
      services: SERVICE_ORDER.map(serviceId => {
        const record = this.requireRecord(serviceId)
        const blockedBy = record.definition.dependencies.filter(dependency => {
          const dependencyState = this.requireRecord(dependency).state
          return dependencyState !== 'healthy'
        })
        const effectiveState = blockedBy.length && record.state === 'healthy' ? 'degraded' : record.state
        return {
          serviceId,
          displayName: record.definition.displayName,
          description: record.definition.description,
          state: effectiveState,
          healthMessage: blockedBy.length && record.state === 'healthy'
            ? `依赖不可用：${blockedBy.join('、')}`
            : record.healthMessage,
          pid: record.command?.pid ?? null,
          cpuPercent: record.metrics.cpuPercent,
          memoryBytes: record.metrics.memoryBytes,
          startedAt: record.startedAt?.toISOString() ?? null,
          uptimeSeconds: record.startedAt ? Math.max(0, Math.floor((now - record.startedAt.getTime()) / 1_000)) : null,
          restartCount: record.restartCount,
          lastExitCode: record.lastExitCode,
          blockedBy,
          containers: record.containers,
        }
      }),
    }
  }

  tailLogs(services: readonly OperationsServiceId[], tail: number): OperationsLogEntry[] {
    return this.options.logBuffer.tail(services, tail)
  }

  operationResult(operationId: string): OperationsOperationResult | null {
    this.pruneOperationResults()
    return this.operationResults.get(operationId) ?? null
  }

  execute(input: {
    action: 'start' | 'stop' | 'restart' | 'shutdown'
    target: OperationsServiceId | 'all'
    operationId: string
    keepInfra?: boolean
    actor: SupervisorActor
  }): Promise<OperationsOperationResult> {
    const previous = this.operationResults.get(input.operationId)
    if (previous) return Promise.resolve(previous)
    const inFlight = this.operationPromises.get(input.operationId)
    if (inFlight) return inFlight
    const run = async (): Promise<OperationsOperationResult> => {
      const startedAt = new Date()
      let outcome: OperationsOperationResult['outcome'] = 'succeeded'
      let message = '操作完成。'
      try {
        if (input.action === 'start') await this.startTarget(input.target)
        if (input.action === 'stop') await this.stopTarget(input.target, input.keepInfra ?? false)
        if (input.action === 'restart') await this.restartTarget(input.target)
        if (input.action === 'shutdown') await this.stopTarget('all', false)
        message = operationSuccessMessage(input.action, input.target)
      } catch (error) {
        outcome = 'failed'
        message = safeMessage(error)
      }
      const result: OperationsOperationResult = {
        operationId: input.operationId,
        action: input.action,
        target: input.target,
        outcome,
        message,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
      }
      this.operationResults.set(result.operationId, result)
      this.events.emit('operation', result)
      this.options.logger.info({
        operationId: result.operationId,
        action: result.action,
        target: result.target,
        outcome: result.outcome,
        actor: input.actor,
      }, result.message)
      this.emitSnapshot()
      return result
    }
    const queued = this.operationQueue.then(run, run)
    this.operationPromises.set(input.operationId, queued)
    this.operationQueue = queued.catch(() => undefined)
    void queued.finally(() => {
      if (this.operationPromises.get(input.operationId) === queued) {
        this.operationPromises.delete(input.operationId)
      }
    }).catch(() => undefined)
    return queued
  }

  async recoverLeases(): Promise<void> {
    let leases: Lease[]
    try {
      leases = leasesSchema.parse(JSON.parse(await readFile(this.options.paths.leaseFile, 'utf8')))
    } catch (error) {
      if (isMissing(error)) return
      this.appendSupervisorLog('warn', `恢复租约不可读，已拒绝自动认领旧进程：${safeMessage(error)}`)
      return
    }
    const processList = await si.processes().catch(() => null)
    if (!processList) {
      this.appendSupervisorLog('warn', '无法读取操作系统进程表，旧租约不会被自动清理。')
      return
    }
    const byPid = new Map(processList.list.map(item => [item.pid, item]))
    for (const lease of leases) {
      const processInfo = byPid.get(lease.pid)
      if (!processInfo) continue
      const commandLine = `${processInfo.command} ${processInfo.params}`
      const expectedCommandHash = commandDigest(this.requireRecord(lease.serviceId).definition, this.options.profile)
      if (
        !commandLine.includes(lease.marker)
        || lease.commandHash !== expectedCommandHash
        || !processStartMatches(processInfo.started, lease.startedAt)
      ) {
        const record = this.requireRecord(lease.serviceId)
        record.state = 'conflict'
        record.healthMessage = `旧租约 PID ${lease.pid} 的创建时间、命令或工作区标记无法验证，未执行清理。`
        continue
      }
      if (lease.serviceId === 'infra') await this.runShutdownHook(this.requireRecord('infra')).catch(() => undefined)
      await killProcessTree(lease.pid, 'SIGTERM').catch(() => undefined)
      this.appendSupervisorLog('warn', `已清理异常退出遗留的 ${lease.serviceId} 进程树（PID ${lease.pid}）。`)
    }
    await rm(this.options.paths.leaseFile, { force: true })
    this.emitSnapshot()
  }

  async close(): Promise<void> {
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    this.metricsTimer = null
    for (const record of this.records.values()) {
      if (record.healthTimer) clearInterval(record.healthTimer)
      if (record.restartTimer) clearTimeout(record.restartTimer)
    }
    await this.stopTarget('all', false)
    this.events.removeAllListeners()
  }

  private async startTarget(target: OperationsServiceId | 'all'): Promise<void> {
    const targetOrder = target === 'all'
      ? [...SERVICE_ORDER]
      : [...transitiveDependencies(target), target]
    for (const serviceId of targetOrder) await this.startSingle(serviceId, false)
  }

  private async stopTarget(target: OperationsServiceId | 'all', keepInfra: boolean): Promise<void> {
    const selected = target === 'all'
      ? [...SERVICE_ORDER]
      : [target, ...transitiveDependents(target)]
    const stopOrder = SERVICE_ORDER.filter(serviceId => selected.includes(serviceId)).reverse()
      .filter(serviceId => !(keepInfra && serviceId === 'infra'))
    for (const serviceId of stopOrder) this.requireRecord(serviceId).desiredRunning = false
    for (const serviceId of stopOrder) await this.stopSingle(serviceId)
  }

  private async restartTarget(target: OperationsServiceId | 'all'): Promise<void> {
    const selected = target === 'all'
      ? [...SERVICE_ORDER]
      : [target, ...transitiveDependents(target)]
    const previouslyRunning = selected.filter(serviceId => {
      const state = this.requireRecord(serviceId).state
      return state !== 'stopped' && state !== 'conflict'
    })
    const restore = target === 'all'
      ? [...SERVICE_ORDER]
      : [target, ...previouslyRunning.filter(serviceId => serviceId !== target)]
    for (const serviceId of [...previouslyRunning].reverse()) {
      this.requireRecord(serviceId).desiredRunning = false
      await this.stopSingle(serviceId)
    }
    for (const serviceId of restore) await this.startSingle(serviceId, false)
  }

  private async startSingle(serviceId: OperationsServiceId, automatic: boolean): Promise<void> {
    const record = this.requireRecord(serviceId)
    if (record.command && ['starting', 'healthy', 'degraded'].includes(record.state)) return
    if (record.state === 'conflict') throw new Error(`${record.definition.displayName} 存在未解决的进程冲突。`)
    for (const dependency of record.definition.dependencies) {
      if (this.requireRecord(dependency).state !== 'healthy') {
        record.state = 'waiting_dependency'
        record.healthMessage = `等待依赖 ${dependency}`
        this.emitSnapshot()
        await this.startSingle(dependency, automatic)
      }
    }
    await this.assertPortsAvailable(record)
    record.desiredRunning = true
    record.stopping = false
    record.state = 'starting'
    record.healthMessage = automatic ? '自动重启中' : '正在启动'
    record.healthFailures = 0
    const marker = `GEOFORGE_MANAGED_${this.options.paths.workspaceId}_${serviceId}`
    const baseCommand = commandFor(record.definition, this.options.profile)
    const markedCommand = process.platform === 'win32'
      ? `set "GEOFORGE_MANAGED_MARKER=${marker}" && ${baseCommand}`
      : `GEOFORGE_MANAGED_MARKER=${marker} ${baseCommand}`
    const environment = environmentForService(serviceId, this.options.environment, {
      GEOFORGE_MANAGED_MARKER: marker,
      GEOFORGE_ROOT: this.options.paths.projectRoot,
      RUNTIME_ROOT: this.options.paths.runtimeRoot,
      FORCE_COLOR: '0',
    })
    const result = concurrently([{
      command: markedCommand,
      name: serviceId,
      cwd: this.options.paths.projectRoot,
      env: environmentForConcurrently(process.env, environment),
    }], {
      // concurrently 仅负责可靠执行；必须保留 pipe，监督器才能成为日志事实源。
      raw: false,
      outputStream: noopOutput,
      handleInput: false,
      restartTries: 0,
      killSignal: 'SIGTERM',
      killTimeout: serviceId === 'infra' ? 40_000 : 10_000,
    })
    const command = result.commands[0]
    if (!command) throw new Error(`未能创建 ${record.definition.displayName} 进程。`)
    record.command = command
    record.startedAt = new Date()
    record.lastExitCode = null
    this.bindCommand(record, command)
    result.result.catch(() => undefined)
    await waitFor(() => Boolean(command.pid), 5_000, `${record.definition.displayName} 未产生 PID。`)
    await this.writeLeases()
    this.emitSnapshot()
    await sleep(record.definition.health.initialDelayMs)
    await this.waitForHealthy(record, 90_000)
    this.startHealthMonitor(record)
  }

  private bindCommand(record: ManagedService, command: Command): void {
    const stdout = new LineDecoder()
    const stderr = new LineDecoder()
    command.stdout.subscribe(chunk => this.appendLines(record.definition.serviceId, 'stdout', stdout.push(chunk)))
    command.stderr.subscribe(chunk => this.appendLines(record.definition.serviceId, 'stderr', stderr.push(chunk)))
    command.close.subscribe(event => {
      this.appendLines(record.definition.serviceId, 'stdout', stdout.finish())
      this.appendLines(record.definition.serviceId, 'stderr', stderr.finish())
      void this.handleClose(record, event)
    })
    command.error.subscribe(error => {
      this.appendSupervisorLog('error', `${record.definition.displayName} 启动错误：${safeMessage(error)}`, record.definition.serviceId)
    })
  }

  private async handleClose(record: ManagedService, event: CloseEvent): Promise<void> {
    if (record.command && event.command.name !== record.command.name) return
    if (record.healthTimer) clearInterval(record.healthTimer)
    record.healthTimer = null
    record.command = null
    record.lastExitCode = event.exitCode
    record.metrics = { cpuPercent: unavailable('服务没有运行进程。'), memoryBytes: unavailable('服务没有运行进程。') }
    record.containers = []
    await this.writeLeases()
    if (record.stopping || !record.desiredRunning) {
      record.state = 'stopped'
      record.healthMessage = '已停止'
      record.stopping = false
      record.startedAt = null
      this.emitSnapshot()
      return
    }
    this.appendSupervisorLog('error', `${record.definition.displayName} 异常退出（${String(event.exitCode)}）。`, record.definition.serviceId)
    this.scheduleRestart(record)
  }

  private scheduleRestart(record: ManagedService): void {
    const now = Date.now()
    record.failureTimes = record.failureTimes.filter(value => now - value < 10 * 60_000)
    record.failureTimes.push(now)
    const maximum = this.options.profile === 'production' ? 10 : 5
    if (record.failureTimes.length > maximum) {
      record.desiredRunning = false
      record.state = 'failed'
      record.healthMessage = `10 分钟内重启超过 ${maximum} 次，已停止自动重试。`
      this.emitSnapshot()
      return
    }
    const delay = Math.min(30_000, 2_000 * 2 ** Math.max(0, record.failureTimes.length - 1))
    record.restartCount += 1
    record.state = 'restart_wait'
    record.healthMessage = `${Math.ceil(delay / 1_000)} 秒后自动重启`
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null
      void this.startSingle(record.definition.serviceId, true).catch(error => {
        record.state = 'failed'
        record.healthMessage = safeMessage(error)
        this.emitSnapshot()
      })
    }, delay)
    record.restartTimer.unref()
    this.emitSnapshot()
  }

  private async stopSingle(serviceId: OperationsServiceId): Promise<void> {
    const record = this.requireRecord(serviceId)
    if (record.restartTimer) clearTimeout(record.restartTimer)
    record.restartTimer = null
    if (!record.command) {
      record.state = record.state === 'conflict' ? 'conflict' : 'stopped'
      record.healthMessage = record.state === 'conflict' ? record.healthMessage : '已停止'
      return
    }
    record.stopping = true
    record.state = 'stopping'
    record.healthMessage = '正在停止'
    this.emitSnapshot()
    const command = record.command
    const closed = onceCommandClosed(command, serviceId === 'infra' ? 40_000 : 10_000)
    await this.runShutdownHook(record)
    if (Command.canKill(command)) command.kill('SIGTERM')
    await closed.catch(async () => {
      if (command.pid) await killProcessTree(command.pid, 'SIGKILL').catch(() => undefined)
    })
    record.command = null
    record.state = 'stopped'
    record.healthMessage = '已停止'
    record.stopping = false
    record.startedAt = null
    record.metrics = { cpuPercent: unavailable('服务没有运行进程。'), memoryBytes: unavailable('服务没有运行进程。') }
    record.containers = []
    await this.writeLeases()
    this.emitSnapshot()
  }

  private async waitForHealthy(record: ManagedService, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!record.command) throw new Error(`${record.definition.displayName} 在健康检查前退出。`)
      const result = await this.probe(record)
      if (result.ok) {
        record.state = 'healthy'
        record.healthMessage = result.message
        record.healthFailures = 0
        this.emitSnapshot()
        return
      }
      record.healthMessage = result.message
      this.emitSnapshot()
      await sleep(record.definition.health.periodMs)
    }
    record.healthMessage = '启动健康检查超时。'
    if (record.command && Command.canKill(record.command)) record.command.kill('SIGTERM')
    throw new Error(`${record.definition.displayName} 未在 ${Math.ceil(timeoutMs / 1_000)} 秒内就绪。`)
  }

  private startHealthMonitor(record: ManagedService): void {
    if (record.healthTimer) clearInterval(record.healthTimer)
    record.healthTimer = setInterval(() => void this.monitorHealth(record), record.definition.health.periodMs)
    record.healthTimer.unref()
  }

  private async monitorHealth(record: ManagedService): Promise<void> {
    if (!record.command || record.stopping) return
    const result = await this.probe(record)
    if (result.ok) {
      record.healthFailures = 0
      record.state = 'healthy'
      record.healthMessage = result.message
      if (record.startedAt && Date.now() - record.startedAt.getTime() >= 10 * 60_000) record.failureTimes = []
    } else {
      record.healthFailures += 1
      if (record.healthFailures >= 3) {
        record.state = 'degraded'
        record.healthMessage = result.message
      }
      if (record.healthFailures >= 10 && record.definition.dependencies.every(id => this.requireRecord(id).state === 'healthy')) {
        record.healthMessage = '连续健康失败，正在自动重启。'
        if (Command.canKill(record.command)) record.command.kill('SIGTERM')
      }
    }
    this.emitSnapshot()
  }

  private async probe(record: ManagedService): Promise<{ ok: boolean; message: string }> {
    const probe = record.definition.health
    try {
      if (probe.kind === 'http') {
        const environmentName = typeof probe.portEnvironment === 'string'
          ? probe.portEnvironment
          : probe.portEnvironment[this.options.profile]
        const port = requirePort(this.options.environment, environmentName)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), probe.timeoutMs)
        try {
          const response = await fetch(`http://127.0.0.1:${port}${probe.path}`, { signal: controller.signal })
          return response.ok
            ? { ok: true, message: `健康检查通过（HTTP ${response.status}）` }
            : { ok: false, message: `健康检查返回 HTTP ${response.status}` }
        } finally {
          clearTimeout(timeout)
        }
      }
      const command = executableFor(probe.command[this.options.profile])
      await execFileAsync(command.file, [...command.args], {
        cwd: this.options.paths.projectRoot,
        env: environmentForService(record.definition.serviceId, this.options.environment, {
          GEOFORGE_ROOT: this.options.paths.projectRoot,
          RUNTIME_ROOT: this.options.paths.runtimeRoot,
        }),
        timeout: probe.timeoutMs,
        windowsHide: true,
      })
      return { ok: true, message: '健康检查通过' }
    } catch (error) {
      return { ok: false, message: `健康检查失败：${safeMessage(error)}` }
    }
  }

  private async runShutdownHook(record: ManagedService): Promise<void> {
    if (!record.definition.shutdown) return
    const command = executableFor(record.definition.shutdown[this.options.profile])
    await execFileAsync(command.file, [...command.args], {
      cwd: this.options.paths.projectRoot,
      env: environmentForService(record.definition.serviceId, this.options.environment, {
        GEOFORGE_ROOT: this.options.paths.projectRoot,
        RUNTIME_ROOT: this.options.paths.runtimeRoot,
      }),
      timeout: 40_000,
      windowsHide: true,
    })
  }

  private async assertPortsAvailable(record: ManagedService): Promise<void> {
    for (const name of record.definition.portEnvironments[this.options.profile]) {
      const port = requirePort(this.options.environment, name)
      if (!await isPortAvailable(port)) {
        record.state = 'conflict'
        record.healthMessage = `${name} 端口 ${port} 已被非受监督进程占用。`
        this.emitSnapshot()
        throw new Error(record.healthMessage)
      }
    }
  }

  private async collectMetrics(): Promise<void> {
    const roots = new Map<OperationsServiceId, number | null>(SERVICE_ORDER.map(serviceId => [
      serviceId,
      this.requireRecord(serviceId).command?.pid ?? null,
    ]))
    const [host, processes, docker] = await Promise.all([
      collectHostMetrics(this.options.paths.runtimeRoot),
      collectProcessTreeMetrics(roots),
      collectDockerMetrics({
        projectRoot: this.options.paths.projectRoot,
        profile: this.options.profile,
        environment: environmentForService('infra', this.options.environment, {
          GEOFORGE_ROOT: this.options.paths.projectRoot,
          RUNTIME_ROOT: this.options.paths.runtimeRoot,
        }),
      }),
    ])
    this.hostMetrics = host
    for (const serviceId of SERVICE_ORDER) {
      const record = this.requireRecord(serviceId)
      record.metrics = processes.get(serviceId) ?? {
        cpuPercent: unavailable('进程指标缺失。'),
        memoryBytes: unavailable('进程指标缺失。'),
      }
    }
    const infra = this.requireRecord('infra')
    infra.containers = docker.containers
    if (infra.command) infra.metrics = docker.total
    this.emitSnapshot()
  }

  private appendLines(serviceId: OperationsServiceId, stream: 'stdout' | 'stderr', lines: readonly string[]): void {
    for (const message of lines) {
      const entry = this.options.logBuffer.append({ serviceId, stream, message })
      this.events.emit('log', entry)
      const output = `[${serviceId}] ${entry.message}`
      if (stream === 'stderr') this.options.logger.error(output)
      else this.options.logger.info(output)
    }
  }

  private appendSupervisorLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    serviceId: OperationsServiceId | null = null,
  ): void {
    const entry = this.options.logBuffer.append({ serviceId, stream: 'supervisor', message })
    this.events.emit('log', entry)
    this.options.logger[level](message)
  }

  private emitSnapshot(): void {
    this.events.emit('snapshot', this.snapshot())
  }

  private requireRecord(serviceId: OperationsServiceId): ManagedService {
    const record = this.records.get(serviceId)
    if (!record) throw new Error(`未知服务 '${serviceId}'。`)
    return record
  }

  private async writeLeases(): Promise<void> {
    const write = this.leaseWriteQueue.then(async () => {
      const leases: Lease[] = SERVICE_ORDER.flatMap(serviceId => {
        const record = this.requireRecord(serviceId)
        const pid = record.command?.pid
        if (!pid || !record.startedAt) return []
        const marker = `GEOFORGE_MANAGED_${this.options.paths.workspaceId}_${serviceId}`
        return [{
          serviceId,
          pid,
          marker,
          commandHash: commandDigest(record.definition, this.options.profile),
          startedAt: record.startedAt.toISOString(),
        }]
      })
      const temporary = `${this.options.paths.leaseFile}.tmp-${process.pid}-${randomUUID()}`
      await writeFile(temporary, JSON.stringify(leases), 'utf8')
      await rename(temporary, this.options.paths.leaseFile)
    })
    this.leaseWriteQueue = write.catch(() => undefined)
    await write
  }

  private pruneOperationResults(): void {
    const cutoff = Date.now() - 15 * 60_000
    for (const [operationId, result] of this.operationResults) {
      if (new Date(result.completedAt).getTime() < cutoff) this.operationResults.delete(operationId)
    }
    while (this.operationResults.size > 1_000) {
      const first = this.operationResults.keys().next().value as string | undefined
      if (!first) break
      this.operationResults.delete(first)
    }
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

function requirePort(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(environment[name])
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} 不是有效端口。`)
  return value
}

function onceCommandClosed(command: Command, timeoutMs: number): Promise<void> {
  if (command.exited) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe()
      reject(new Error('进程未在关闭期限内退出。'))
    }, timeoutMs)
    const subscription = command.close.subscribe(() => {
      clearTimeout(timer)
      subscription.unsubscribe()
      resolve()
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs: number, errorMessage: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error(errorMessage)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function operationSuccessMessage(action: string, target: string): string {
  if (action === 'shutdown') return '监督器与全部受监督服务已关闭。'
  const actionLabel = { start: '启动', stop: '停止', restart: '重启', shutdown: '关闭监督器' }[action] ?? action
  return `${target === 'all' ? '全部服务' : SERVICE_CATALOG[target as OperationsServiceId].displayName}${actionLabel}完成。`
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '未知错误。'
}

function commandDigest(definition: ServiceDefinition, profile: OperationsProfile): string {
  return createHash('sha256').update(commandFor(definition, profile)).digest('hex')
}

function processStartMatches(observed: string, expected: string): boolean {
  const observedTime = Date.parse(observed)
  const expectedTime = Date.parse(expected)
  return Number.isFinite(observedTime)
    && Number.isFinite(expectedTime)
    && Math.abs(observedTime - expectedTime) <= 120_000
}

function killProcessTree(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
