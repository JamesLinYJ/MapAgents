// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一开发启动器测试
//
//   文件:       devLauncher.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  parseDevLauncherCommand,
  prerequisiteBuilds,
  waitForSupervisorReady,
} from './devLauncher.js'

describe('统一开发启动器', () => {
  it('为 Bash 与 PowerShell 参数生成同一命令模型', () => {
    const bash = parseDevLauncherCommand([
      'agent', 'all', '--json', '--prompt', '你好', '--mode', 'plan', '--no-reasoning',
    ])
    const powershell = parseDevLauncherCommand([
      'agent', 'all', '-Json', '-AgentPrompt', '你好', '-AgentMode', 'plan', '-NoReasoning',
    ])

    expect(powershell).toEqual(bash)
  })

  it('只有一处声明共享构建顺序', () => {
    expect(prerequisiteBuilds().map(([, args]) => args.at(-1))).toEqual([
      '@geo-agent-platform/shared-types',
      '@geo-agent-platform/conversation-presentation',
      '@geo-agent-platform/operations-supervisor',
    ])
  })

  it('监督器在重试窗口内就绪', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(waitForSupervisorReady(probe, delay, 3)).resolves.toBeUndefined()
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('监督器持续不可用时给出日志位置并失败', async () => {
    await expect(waitForSupervisorReady(
      vi.fn().mockResolvedValue(1),
      vi.fn().mockResolvedValue(undefined),
      2,
    )).rejects.toThrow(/runtime\/ops\/supervisor-launch/u)
  })
})
