// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux 安装版命令行测试
//
//   文件:       installedCli.test.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  assertGraphicalDesktopSession,
  assertProductNodeRuntime,
  createDesktopLaunchEnvironment,
  installedCliHelpText,
  launchInstalledDesktop,
  parseInstalledCli,
} from './installedCli.js'

describe('installed CLI', () => {
  it('uses the interactive Agent as the zero-configuration default', () => {
    expect(parseInstalledCli([])).toEqual({ kind: 'agent', arguments: [] })
    expect(parseInstalledCli(['-p', '分析杭州降雨'])).toEqual({
      kind: 'agent',
      arguments: ['-p', '分析杭州降雨'],
    })
  })

  it('routes explicit product commands without confusing Agent arguments', () => {
    expect(parseInstalledCli(['agent', '--check'])).toEqual({
      kind: 'agent',
      arguments: ['--check'],
    })
    expect(parseInstalledCli(['console'])).toEqual({ kind: 'console', arguments: [] })
    expect(parseInstalledCli(['start'])).toEqual({ kind: 'start' })
    expect(parseInstalledCli(['status'])).toEqual({
      kind: 'supervisor',
      command: 'status',
      arguments: [],
    })
    expect(parseInstalledCli(['logs', 'api', '--tail', '20'])).toEqual({
      kind: 'supervisor',
      command: 'logs',
      arguments: ['api', '--tail', '20'],
    })
  })

  it('documents the installed command rather than requiring a source checkout', () => {
    const help = installedCliHelpText()
    expect(help).toContain('geo-agent-platform')
    expect(help).toContain('自动启动后端')
    expect(help).toContain('无需 Docker')
    expect(help).not.toContain('dev.sh')
  })

  it('starts the managed backend before opening the desktop', async () => {
    const calls: string[] = []
    await launchInstalledDesktop({
      ensureBackend: async () => { calls.push('backend') },
      launchDesktop: async () => { calls.push('desktop') },
    })
    expect(calls).toEqual(['backend', 'desktop'])
  })

  it('does not launch the desktop when the managed backend cannot start', async () => {
    const launchDesktop = async () => {
      throw new Error('不应调用桌面启动器。')
    }
    await expect(launchInstalledDesktop({
      ensureBackend: async () => { throw new Error('API 启动失败。') },
      launchDesktop,
    })).rejects.toThrow(/API 启动失败/u)
  })

  it('keeps backend runtime variables out of the packaged desktop process', () => {
    const backendEnvironment = {
      PATH: '/usr/bin',
      DISPLAY: ':0',
      GEO_AGENT_PLATFORM_ROOT: '/opt/runtime-service',
      RUNTIME_ROOT: '/home/tester/.local/state/runtime',
      APP_BASE_URL: 'http://127.0.0.1:8000',
      GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: '/home/tester/.local/state/runtime/token',
    }
    const desktopEnvironment = createDesktopLaunchEnvironment(backendEnvironment)

    expect(desktopEnvironment).toEqual({ PATH: '/usr/bin', DISPLAY: ':0' })
    expect(backendEnvironment.GEO_AGENT_PLATFORM_ROOT).toBe('/opt/runtime-service')
  })

  it('rejects a headless Linux shell before Electron can crash', () => {
    expect(() => assertGraphicalDesktopSession({}, 'linux')).toThrow(/图形会话/u)
    expect(() => assertGraphicalDesktopSession({
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/run/user/1000',
    }, 'linux')).not.toThrow()
  })

  it('rejects a system Node 22 before terminal rendering can enter the crashing V8 path', () => {
    expect(() => assertProductNodeRuntime('22.23.1')).toThrow(/内置 Node 24\+/u)
    expect(() => assertProductNodeRuntime('24.14.1')).not.toThrow()
  })
})
