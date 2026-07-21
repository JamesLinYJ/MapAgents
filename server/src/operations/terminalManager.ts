// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - PTY 生命周期与加密录制
//
//   文件:       terminalManager.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { access } from 'node:fs/promises'
import { SerializeAddon } from '@xterm/addon-serialize'
import * as pty from 'node-pty'
import type { WebSocket } from 'ws'

import type { OpsLimits, OpsTerminalState } from '@geo-agent-platform/shared-types/operations'
import {
  OPS_CHUNK_INTERVAL_MILLISECONDS,
  OPS_CHUNK_MAX_PLAINTEXT_BYTES,
  OPS_LIMITS,
} from './constants.js'
import { buildTerminalEnvironment } from './brokerEnvironment.js'
import { HeadlessTerminal, type HeadlessTerminalInstance } from './headlessTerminal.js'
import {
  brokerCreateTerminalSchema,
  brokerTerminalControlSchema,
  brokerTerminalSessionSchema,
  type BrokerCreateTerminal,
  type BrokerTerminalServerMessage,
  type BrokerTerminalSession,
} from './brokerProtocol.js'
import { encryptTranscriptChunk, type AsciicastEvent } from './terminalRecording.js'
import type { TerminalBrokerEnvironment } from './config.js'
import type { TranscriptSpool } from './transcriptSpool.js'

interface ManagedTerminal {
  request: Omit<BrokerCreateTerminal, 'dataKeyBase64'>
  pty: pty.IPty
  headless: HeadlessTerminalInstance
  serializer: SerializeAddon
  headlessInput: { dispose(): void } | null
  dataKey: Buffer
  state: OpsTerminalState
  exitCode: number | null
  recordedBytes: number
  sequence: number
  events: AsciicastEvent[]
  eventBytes: number
  createdAt: Date
  startedAt: Date | null
  detachedAt: Date | null
  endedAt: Date | null
  failureCode: string | null
  failureMessage: string | null
  client: WebSocket | null
  chunkTimer: NodeJS.Timeout
  startupTimer: NodeJS.Timeout
  detachTimer: NodeJS.Timeout | null
  maximumTimer: NodeJS.Timeout
  shellReady: boolean
  startupOutputTail: string
  pendingInput: string[]
  pendingInputBytes: number
  writeChain: Promise<void>
  exitPromise: Promise<void>
  resolveExit(): void
  exitHandled: boolean
}

const SHELL_READY_MARKER = '\u001b]777;geoforge-ready\u0007'
const SHELL_STARTUP_TIMEOUT_MILLISECONDS = 15_000

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>()
  private createChain: Promise<void> = Promise.resolve()
  private readonly limits: OpsLimits
  private readonly chunkIntervalMilliseconds: number
  private readonly chunkMaximumPlaintextBytes: number

  constructor(
    private readonly environment: TerminalBrokerEnvironment,
    private readonly spool: TranscriptSpool,
    options: {
      limits?: OpsLimits
      chunkIntervalMilliseconds?: number
      chunkMaximumPlaintextBytes?: number
    } = {},
  ) {
    this.limits = options.limits ?? OPS_LIMITS
    this.chunkIntervalMilliseconds = options.chunkIntervalMilliseconds ?? OPS_CHUNK_INTERVAL_MILLISECONDS
    this.chunkMaximumPlaintextBytes = options.chunkMaximumPlaintextBytes ?? OPS_CHUNK_MAX_PLAINTEXT_BYTES
  }

  async initialize(): Promise<void> {
    await access(this.environment.workspaceRoot)
    await this.verifyShellAvailable()
    await this.spool.initialize()
  }

  create(requestValue: unknown): Promise<BrokerTerminalSession> {
    const request = brokerCreateTerminalSchema.parse(requestValue)
    return new Promise<BrokerTerminalSession>((resolve, reject) => {
      this.createChain = this.createChain.then(async () => {
        try {
          resolve(await this.createExclusive(request))
        } catch (error) {
          reject(error)
        }
      }, async () => {
        try {
          resolve(await this.createExclusive(request))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  list(): BrokerTerminalSession[] {
    return [...this.sessions.values()].map(session => this.snapshot(session))
  }

  get(terminalId: string): BrokerTerminalSession | null {
    const session = this.sessions.get(terminalId)
    return session ? this.snapshot(session) : null
  }

  attach(terminalId: string, client: WebSocket): void {
    const session = this.sessions.get(terminalId)
    if (!session) throw new Error('终端会话不存在或 PTY 已消失。')
    if (!['starting', 'running', 'detached'].includes(session.state)) throw new Error('终端会话已经结束。')
    if (session.client && session.client !== client) session.client.close(4001, '会话已由新的连接接管')
    // PTY 输出同时进入浏览器 xterm 与 headless xterm。两者都会生成 DSR/DA
    // 等终端协议响应；连接期间只能由浏览器回送，否则 ConPTY 会把第二份响应
    // 当普通键盘输入回显为 `?[1;2c`。断线后再把协议响应所有权交回 headless。
    session.headlessInput?.dispose()
    session.headlessInput = null
    session.client = client
    session.state = session.shellReady ? 'running' : 'starting'
    session.detachedAt = null
    if (session.detachTimer) clearTimeout(session.detachTimer)
    session.detachTimer = null
    this.sendControl(client, { type: 'screen', data: session.serializer.serialize() })
    this.broadcastState(session)
  }

  detachClient(terminalId: string, client: WebSocket): void {
    const session = this.sessions.get(terminalId)
    if (!session || session.client !== client) return
    this.detach(session)
  }

  receiveBinary(terminalId: string, bytes: Uint8Array): void {
    const session = this.sessions.get(terminalId)
    if (!session || !['starting', 'running'].includes(session.state)) {
      throw new Error('终端会话当前不可写。')
    }
    if (bytes.byteLength > this.limits.maximumFrameBytes) {
      throw new Error('终端输入帧超过 64 KiB 限制。')
    }
    const data = Buffer.from(bytes).toString('utf8')
    if (!session.shellReady) {
      const nextBytes = session.pendingInputBytes + bytes.byteLength
      if (nextBytes > this.limits.maximumFrameBytes) {
        throw new Error('终端启动期间的待处理输入超过 64 KiB 限制。')
      }
      session.pendingInput.push(data)
      session.pendingInputBytes = nextBytes
      return
    }
    session.pty.write(data)
  }

  receiveControl(terminalId: string, value: unknown): void {
    const control = brokerTerminalControlSchema.parse(value)
    const session = this.sessions.get(terminalId)
    if (!session) throw new Error('终端会话不存在。')
    if (control.type === 'resize') {
      session.pty.resize(control.cols, control.rows)
      session.headless.resize(control.cols, control.rows)
      this.recordEvent(session, [this.relativeSeconds(session), 'r', `${control.cols}x${control.rows}`])
      this.broadcastState(session)
      return
    }
    if (control.type === 'signal') {
      session.pty.kill(control.signal)
      return
    }
    this.detach(session)
  }

  async terminate(terminalId: string): Promise<BrokerTerminalSession> {
    const session = this.sessions.get(terminalId)
    if (!session) throw new Error('终端会话不存在。')
    if (['starting', 'running', 'detached'].includes(session.state)) {
      session.state = 'terminated'
      session.pty.kill()
      await this.waitForExit(session)
    }
    return this.snapshot(session)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async session => {
      if (['starting', 'running', 'detached'].includes(session.state)) {
        session.state = 'terminated'
        session.pty.kill()
      }
      if (!session.exitHandled) await this.waitForExit(session)
      else await session.exitPromise
    }))
  }

  private async createExclusive(request: BrokerCreateTerminal): Promise<BrokerTerminalSession> {
    if (this.sessions.has(request.terminalId)) throw new Error('终端会话标识已存在。')
    const active = [...this.sessions.values()].filter(session => ['starting', 'running', 'detached'].includes(session.state))
    if (active.length >= this.limits.terminalsPerHost) throw new Error('主机终端会话数量已达到上限。')
    const dataKey = Buffer.from(request.dataKeyBase64, 'base64')
    if (dataKey.byteLength !== 32) throw new Error('终端会话数据密钥无效。')
    const createdAt = new Date()
    const headless = new HeadlessTerminal({
      cols: request.cols,
      rows: request.rows,
      scrollback: this.limits.scrollbackLines,
      // SerializeAddon 的屏幕恢复能力属于 xterm.js proposed API；仅在隔离的
      // headless 终端内开启，不向浏览器或插件暴露 Terminal 实例。
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    headless.loadAddon(serializer)
    const shell = this.environment.shell
    const shellArguments = process.platform === 'win32'
      ? [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        windowsShellBootstrap(),
      ]
      : ['--noprofile', '--norc', '-i']
    const terminalEnvironment = buildTerminalEnvironment(process.env)
    if (process.platform !== 'win32') {
      terminalEnvironment.PROMPT_COMMAND = "printf '\\033]777;geoforge-ready\\007'; unset PROMPT_COMMAND"
    }
    let terminalPty: pty.IPty
    try {
      terminalPty = pty.spawn(shell, shellArguments, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: this.environment.workspaceRoot,
        env: terminalEnvironment,
        useConpty: process.platform === 'win32',
        // node-pty 的内置 Windows ConPTY kill 路径会额外派生 console-list agent，
        // shell 快速退出时该 agent 可能 AttachConsole 失败。官方随包 conpty.dll
        // 路径不依赖该竞态，且仍是 ConPTY 语义。
        useConptyDll: process.platform === 'win32',
      })
    } catch (error) {
      dataKey.fill(0)
      headless.dispose()
      throw error
    }
    // 无浏览器连接时，PowerShell/PSReadLine 查询光标位置、能力和模式所需的
    // DSR/DA 等协议响应由 headless xterm 独占回送，避免 detached 状态卡死。
    const headlessInput = headless.onData(data => terminalPty.write(data))
    let resolveExit: () => void = () => undefined
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve })
    const session: ManagedTerminal = {
      request: {
        terminalId: request.terminalId,
        ownerUserId: request.ownerUserId,
        label: request.label,
        cols: request.cols,
        rows: request.rows,
      },
      pty: terminalPty,
      headless,
      serializer,
      headlessInput,
      dataKey,
      state: 'starting',
      exitCode: null,
      recordedBytes: 0,
      sequence: 0,
      events: [],
      eventBytes: 0,
      createdAt,
      startedAt: null,
      detachedAt: null,
      endedAt: null,
      failureCode: null,
      failureMessage: null,
      client: null,
      chunkTimer: setInterval(() => { void this.flushOrFail(session) }, this.chunkIntervalMilliseconds),
      startupTimer: setTimeout(() => {
        void this.failAndTerminate(session, 'shell_start_timeout', '终端 shell 未在 15 秒内完成启动，会话已终止。')
      }, SHELL_STARTUP_TIMEOUT_MILLISECONDS),
      detachTimer: null,
      maximumTimer: setTimeout(() => { void this.expire(session) }, this.limits.maximumSessionSeconds * 1_000),
      shellReady: false,
      startupOutputTail: '',
      pendingInput: [],
      pendingInputBytes: 0,
      writeChain: Promise.resolve(),
      exitPromise,
      resolveExit,
      exitHandled: false,
    }
    this.sessions.set(request.terminalId, session)
    terminalPty.onData(data => this.handleOutput(session, data))
    terminalPty.onExit(event => {
      void this.handleExit(session, event.exitCode).finally(() => session.resolveExit())
    })
    return this.snapshot(session)
  }

  private handleOutput(session: ManagedTerminal, data: string): void {
    session.headless.write(data)
    this.recordEvent(session, [this.relativeSeconds(session), 'o', data])
    if (session.client?.readyState === 1) session.client.send(Buffer.from(data, 'utf8'), { binary: true })
    if (!session.shellReady) {
      const startupOutput = session.startupOutputTail + data
      if (startupOutput.includes(SHELL_READY_MARKER)) this.markShellReady(session)
      else session.startupOutputTail = startupOutput.slice(-(SHELL_READY_MARKER.length - 1))
    }
  }

  private markShellReady(session: ManagedTerminal): void {
    if (session.shellReady || !['starting', 'detached'].includes(session.state)) return
    session.shellReady = true
    session.startupOutputTail = ''
    session.startedAt = new Date()
    clearTimeout(session.startupTimer)
    if (session.state === 'starting') session.state = 'running'
    const pendingInput = session.pendingInput
    session.pendingInput = []
    session.pendingInputBytes = 0
    for (const data of pendingInput) session.pty.write(data)
    this.broadcastState(session)
  }

  private recordEvent(session: ManagedTerminal, event: AsciicastEvent): void {
    session.events.push(event)
    session.eventBytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
    if (session.eventBytes >= this.chunkMaximumPlaintextBytes) void this.flushOrFail(session)
  }

  private flushOrFail(session: ManagedTerminal): Promise<void> {
    session.writeChain = session.writeChain.then(() => this.flush(session)).catch(async () => {
      await this.failAndTerminate(session, 'recording_failed', '终端录制写入失败，会话已立即终止。')
    })
    return session.writeChain
  }

  private async flush(session: ManagedTerminal): Promise<void> {
    if (!session.events.length) return
    const events = session.events
    session.events = []
    session.eventBytes = 0
    const chunk = encryptTranscriptChunk({
      terminalId: session.request.terminalId,
      sequence: session.sequence,
      dataKey: session.dataKey,
      events,
    })
    const nextSize = session.recordedBytes + chunk.encrypted.byteLength
    if (nextSize > this.limits.maximumRecordingBytes) {
      throw new Error('终端录制达到容量上限。')
    }
    // “:” 在 Windows 文件名中非法；Broker spool 标识必须跨平台安全。
    const chunkId = `${session.request.terminalId}.${String(chunk.sequence).padStart(10, '0')}`
    await this.spool.put({
      chunkId,
      terminalId: session.request.terminalId,
      sequence: chunk.sequence,
      encryptedBase64: chunk.encrypted.toString('base64'),
      sizeBytes: chunk.encrypted.byteLength,
      eventCount: chunk.eventCount,
      firstEventMilliseconds: chunk.firstEventMilliseconds,
      lastEventMilliseconds: chunk.lastEventMilliseconds,
      createdAt: new Date().toISOString(),
    })
    session.sequence += 1
    session.recordedBytes = nextSize
  }

  private async handleExit(session: ManagedTerminal, exitCode: number | undefined): Promise<void> {
    if (session.exitHandled) return
    session.exitHandled = true
    if (!session.shellReady && !['failed', 'terminated'].includes(session.state)) {
      session.state = 'failed'
      session.failureCode = 'shell_start_failed'
      session.failureMessage = '终端 shell 在完成启动前退出。'
    } else if (!['failed', 'terminated'].includes(session.state)) {
      session.state = 'exited'
    }
    // node-pty 的 ConPTY 强制终止事件在运行时可能不带 exitCode，尽管类型声明
    // 标注为 number；协议边界必须显式归一化，不能让 undefined 穿过 Zod。
    session.exitCode = typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null
    session.endedAt = new Date()
    await this.flushOrFail(session)
    this.clearTimers(session)
    this.broadcastState(session)
    session.client?.close(1000, '终端进程已退出')
    session.headlessInput?.dispose()
    session.headlessInput = null
    session.dataKey.fill(0)
  }

  private async waitForExit(session: ManagedTerminal): Promise<void> {
    const timeoutMilliseconds = 5_000
    let timer: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('终端进程未在 5 秒内确认退出。')), timeoutMilliseconds)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private detach(session: ManagedTerminal): void {
    session.client = null
    if (!['starting', 'running', 'detached'].includes(session.state)) return
    session.headlessInput ??= session.headless.onData(data => session.pty.write(data))
    session.state = 'detached'
    session.detachedAt = new Date()
    if (session.detachTimer) clearTimeout(session.detachTimer)
    session.detachTimer = setTimeout(() => { void this.expireDetached(session) }, this.limits.detachTtlSeconds * 1_000)
    this.broadcastState(session)
  }

  private async expireDetached(session: ManagedTerminal): Promise<void> {
    if (session.state !== 'detached') return
    await this.failAndTerminate(session, 'detach_ttl_expired', '终端断线保留时间已到，会话已终止。', 'terminated')
  }

  private async expire(session: ManagedTerminal): Promise<void> {
    if (!['starting', 'running', 'detached'].includes(session.state)) return
    await this.failAndTerminate(session, 'maximum_duration_reached', '终端会话已达到 8 小时上限。', 'terminated')
  }

  private async failAndTerminate(
    session: ManagedTerminal,
    code: string,
    message: string,
    state: OpsTerminalState = 'failed',
  ): Promise<void> {
    session.state = state
    session.failureCode = code
    session.failureMessage = message
    session.endedAt = new Date()
    session.pty.kill()
    this.clearTimers(session)
    this.broadcastState(session)
    this.sendControl(session.client, { type: 'error', message })
    session.client?.close(1011, message)
  }

  private snapshot(session: ManagedTerminal): BrokerTerminalSession {
    return brokerTerminalSessionSchema.parse({
      terminalId: session.request.terminalId,
      ownerUserId: session.request.ownerUserId,
      label: session.request.label,
      state: session.state,
      shell: this.environment.shell,
      cols: session.headless.cols,
      rows: session.headless.rows,
      pid: session.pty.pid > 0 ? session.pty.pid : null,
      exitCode: session.exitCode,
      recordedBytes: session.recordedBytes,
      createdAt: session.createdAt.toISOString(),
      startedAt: session.startedAt?.toISOString() ?? null,
      detachedAt: session.detachedAt?.toISOString() ?? null,
      expiresAt: new Date(session.createdAt.getTime() + this.limits.maximumSessionSeconds * 1_000).toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      failureCode: session.failureCode,
      failureMessage: session.failureMessage,
    })
  }

  private broadcastState(session: ManagedTerminal): void {
    this.sendControl(session.client, { type: 'state', terminal: this.snapshot(session) })
  }

  private sendControl(client: WebSocket | null, message: BrokerTerminalServerMessage): void {
    if (client?.readyState === 1) client.send(JSON.stringify(message))
  }

  private relativeSeconds(session: ManagedTerminal): number {
    return Math.max(0, Math.round((Date.now() - session.createdAt.getTime())) / 1_000)
  }

  private clearTimers(session: ManagedTerminal): void {
    clearInterval(session.chunkTimer)
    clearTimeout(session.startupTimer)
    clearTimeout(session.maximumTimer)
    if (session.detachTimer) clearTimeout(session.detachTimer)
    session.detachTimer = null
  }

  private async verifyShellAvailable(): Promise<void> {
    if (!/[\\/]/u.test(this.environment.shell)) return
    try {
      await access(this.environment.shell)
    } catch {
      throw new Error('配置的终端 shell 不存在，Terminal Broker 已拒绝启动。')
    }
  }
}

function windowsShellBootstrap(): string {
  return [
    "try { Set-PSReadLineOption -HistorySaveStyle SaveNothing -PredictionSource None -ErrorAction Stop } catch { [Console]::Error.WriteLine('无法禁用 PowerShell 历史记录，终端已拒绝启动。'); exit 70 }",
    '$global:GeoForgeShellReady = $false',
    'function global:prompt { if (-not $global:GeoForgeShellReady) { [Console]::Out.Write("`e]777;geoforge-ready`a"); $global:GeoForgeShellReady = $true }; "PS $($executionContext.SessionState.Path.CurrentLocation)$(\'>\' * ($nestedPromptLevel + 1)) " }',
  ].join('; ')
}
