// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 跨平台真实 PTY 集成测试
//
//   文件:       terminalManager.integration.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OpsLimits } from '@geo-agent-platform/shared-types/operations'
import { parseTerminalBrokerEnvironment } from './config.js'
import { OPS_LIMITS } from './constants.js'
import { decryptTranscriptChunk } from './terminalRecording.js'
import { TerminalManager } from './terminalManager.js'
import { TranscriptSpool } from './transcriptSpool.js'

const temporaryDirectories: string[] = []
const managers: TerminalManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TerminalManager 真实 PTY', () => {
  it('执行 PowerShell/Bash、保留中文输出与 resize，并且 spool 不含明文', async () => {
    const { manager, spool, spoolRoot } = await createManager()
    const dataKey = randomBytes(32)
    const session = await manager.create(request('terminal_real_1', dataKey))
    expect(session.state).toBe('starting')
    manager.receiveControl(session.terminalId, { type: 'resize', cols: 132, rows: 41 })
    // 输入可以在 shell 初始化期间到达；Manager 必须排队并在明确的 prompt
    // 就绪信号后原序释放，不能依赖固定 sleep 或让 ConPTY 吞掉首条命令。
    manager.receiveBinary(session.terminalId, Buffer.from(shellCommand("PTY_中文_正常"), 'utf8'))
    const exited = await waitForSession(manager, session.terminalId, value => value.state === 'exited').catch(async error => {
      const captured = (await spool.list(500)).flatMap(chunk => decryptTranscriptChunk({
        terminalId: chunk.terminalId,
        sequence: chunk.sequence,
        dataKey,
        encrypted: Buffer.from(chunk.encryptedBase64, 'base64'),
      })).filter(event => event[1] === 'o').map(event => event[2]).join('')
      throw new Error(`${error instanceof Error ? error.message : '终端超时'}；已捕获输出 ${JSON.stringify(captured)}`)
    })
    expect(exited).toMatchObject({ cols: 132, rows: 41, exitCode: 0 })

    const chunks = await spool.list(500)
    expect(chunks.length).toBeGreaterThan(0)
    const events = chunks.flatMap(chunk => decryptTranscriptChunk({
      terminalId: chunk.terminalId,
      sequence: chunk.sequence,
      dataKey,
      encrypted: Buffer.from(chunk.encryptedBase64, 'base64'),
    }))
    expect(events.filter(event => event[1] === 'o').map(event => event[2]).join('')).toContain('PTY_中文_正常')
    expect(events).toContainEqual(expect.arrayContaining([expect.any(Number), 'r', '132x41']))

    const files = await readdir(spoolRoot)
    const persisted = await Promise.all(files.map(file => readFile(path.join(spoolRoot, file), 'utf8')))
    expect(persisted.join('')).not.toContain('PTY_中文_正常')
    dataKey.fill(0)
  }, 30_000)

  it('限制单帧和主机会话数量', async () => {
    const limits: OpsLimits = { ...OPS_LIMITS, maximumFrameBytes: 16, terminalsPerHost: 1 }
    const { manager } = await createManager(limits)
    const dataKey = randomBytes(32)
    const session = await manager.create(request('terminal_limit_1', dataKey))
    expect(() => manager.receiveBinary(session.terminalId, Buffer.alloc(17))).toThrow('64 KiB 限制')
    await expect(manager.create(request('terminal_limit_2', randomBytes(32)))).rejects.toThrow('数量已达到上限')
    await manager.terminate(session.terminalId)
    dataKey.fill(0)
  }, 10_000)

  it('断线后进入 detached，并在 TTL 到期后真实终止 PTY', async () => {
    const limits: OpsLimits = { ...OPS_LIMITS, detachTtlSeconds: 0.05 }
    const { manager } = await createManager(limits)
    const dataKey = randomBytes(32)
    const session = await manager.create(request('terminal_detach_1', dataKey))
    const client = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket
    manager.attach(session.terminalId, client)
    manager.detachClient(session.terminalId, client)
    expect(manager.get(session.terminalId)?.state).toBe('detached')
    const terminated = await waitForSession(manager, session.terminalId, value => value.state === 'terminated')
    expect(terminated.failureCode).toBe('detach_ttl_expired')
    dataKey.fill(0)
  }, 10_000)

  it('把 Ctrl+C 作为终端输入传给前台任务并继续复用 shell', async () => {
    const { manager, spool } = await createManager()
    const dataKey = randomBytes(32)
    const session = await manager.create(request('terminal_ctrl_c_1', dataKey))
    const longTask = process.platform === 'win32'
      ? "[Console]::Out.WriteLine(([char[]](67,84,82,76,95,66,69,70,79,82,69)-join '')); Start-Sleep -Seconds 30\r"
      : "printf '\\103\\124\\122\\114\\137\\102\\105\\106\\117\\122\\105\\n'; sleep 30\n"
    manager.receiveBinary(session.terminalId, Buffer.from(longTask, 'utf8'))
    await waitForOutput(spool, dataKey, 'CTRL_BEFORE')
    manager.receiveBinary(session.terminalId, Buffer.from([3]))
    await new Promise(resolve => setTimeout(resolve, 300))
    manager.receiveBinary(session.terminalId, Buffer.from(shellCommand('CTRL_C_OK'), 'utf8'))
    await waitForSession(manager, session.terminalId, value => value.state === 'exited')
    const output = await readOutput(spool, dataKey)
    expect(output).toContain('CTRL_BEFORE')
    expect(output).toContain('CTRL_C_OK')
    dataKey.fill(0)
  }, 40_000)
})

async function waitForOutput(spool: TranscriptSpool, dataKey: Buffer, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await readOutput(spool, dataKey)).includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待终端输出超时：${expected}`)
}

async function readOutput(spool: TranscriptSpool, dataKey: Buffer): Promise<string> {
  return (await spool.list(500)).flatMap(chunk => decryptTranscriptChunk({
    terminalId: chunk.terminalId,
    sequence: chunk.sequence,
    dataKey,
    encrypted: Buffer.from(chunk.encryptedBase64, 'base64'),
  })).filter(event => event[1] === 'o').map(event => event[2]).join('')
}

async function createManager(limits: OpsLimits = OPS_LIMITS): Promise<{
  manager: TerminalManager
  spool: TranscriptSpool
  spoolRoot: string
}> {
  const projectRoot = path.resolve(process.cwd(), '..')
  const temporaryRoot = await createTemporaryDirectory()
  const spoolRoot = path.join(temporaryRoot, 'spool')
  const environment = parseTerminalBrokerEnvironment({
    NODE_ENV: 'test',
    OPS_BROKER_SHARED_SECRET: 'broker-test-secret-that-is-long-enough',
    OPS_WORKSPACE_ROOT: projectRoot,
    OPS_TERMINAL_SPOOL_ROOT: spoolRoot,
    OPS_WINDOWS_SHELL: 'pwsh.exe',
    OPS_LINUX_SHELL: '/bin/bash',
  }, projectRoot)
  const spool = new TranscriptSpool(spoolRoot)
  const manager = new TerminalManager(environment, spool, {
    limits,
    chunkIntervalMilliseconds: 25,
    chunkMaximumPlaintextBytes: 1_024,
  })
  await manager.initialize()
  managers.push(manager)
  return { manager, spool, spoolRoot }
}

function request(terminalId: string, dataKey: Buffer) {
  return {
    terminalId,
    ownerUserId: 'user_admin',
    label: '测试终端',
    cols: 120,
    rows: 32,
    dataKeyBase64: dataKey.toString('base64'),
  }
}

function shellCommand(message: string): string {
  if (process.platform === 'win32') {
    return `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '${message}'; exit\r`
  }
  return `printf '${message}\\n'; exit\n`
}

async function waitForSession(
  manager: TerminalManager,
  terminalId: string,
  predicate: (session: NonNullable<ReturnType<TerminalManager['get']>>) => boolean,
): Promise<NonNullable<ReturnType<TerminalManager['get']>>> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const session = manager.get(terminalId)
    if (session && predicate(session)) return session
    if (session?.state === 'failed') {
      throw new Error(`终端进入失败状态：${terminalId}，${session.failureCode ?? 'unknown'}，${session.failureMessage ?? '无详情'}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待终端状态超时：${terminalId}，最后状态 ${JSON.stringify(manager.get(terminalId))}`)
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-terminal-manager-'))
  temporaryDirectories.push(directory)
  return directory
}
