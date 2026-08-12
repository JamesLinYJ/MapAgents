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

import { installedCliHelpText, parseInstalledCli } from './installedCli.js'

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
    expect(help).toContain('geoforge')
    expect(help).toContain('自动启动后端')
    expect(help).toContain('无需 Docker')
    expect(help).not.toContain('dev.sh')
  })
})
