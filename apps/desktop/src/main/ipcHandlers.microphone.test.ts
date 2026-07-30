// +-------------------------------------------------------------------------
//
//   地理智能平台 - 麦克风授权 IPC 测试
//
//   文件:       ipcHandlers.microphone.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  dialogResponse: 1,
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  showMessageBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { showAboutPanel: vi.fn() },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
  },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showMessageBox: electronState.showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => unknown) => {
      electronState.handlers.set(channel, handler)
    }),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
    getApplicationMenu: vi.fn(() => null),
    setApplicationMenu: vi.fn(),
  },
}))

import {
  DESKTOP_IPC_CHANNELS,
  desktopMicrophonePermissionResultSchema,
} from '../contracts/desktopIpc.js'
import {
  installDesktopIpcHandlers,
  type DesktopIpcDependencies,
} from './ipcHandlers.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'

describe('microphone permission IPC', () => {
  beforeEach(() => {
    electronState.handlers.clear()
    electronState.dialogResponse = 1
    electronState.showMessageBox.mockReset()
    electronState.showMessageBox.mockImplementation(async () => ({
      response: electronState.dialogResponse,
    }))
  })

  it('arms one owner-bound grant only after Main authentication and native confirmation', async () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const fixture = installFixture(gate)
    const handler = requireHandler()

    const result = desktopMicrophonePermissionResultSchema.parse(
      await handler(fixture.event, { purpose: 'speech-recognition' }),
    )

    expect(result).toEqual({ granted: true, message: null })
    expect(fixture.authorization).toHaveBeenCalledTimes(2)
    expect(electronState.showMessageBox).toHaveBeenCalledWith(
      fixture.window,
      expect.objectContaining({
        title: '允许本次使用麦克风',
        defaultId: 0,
        cancelId: 0,
      }),
    )
    expect(gate.hasActiveGrant(61)).toBe(true)
    expect(fixture.sender.on).toHaveBeenCalledWith(
      'did-start-navigation',
      expect.any(Function),
    )
    expect(fixture.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const navigated = fixture.sender.on.mock.calls[0]?.[1] as (
      event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => void
    navigated({}, 'geoforge://app/next', false, true)
    expect(gate.hasActiveGrant(61)).toBe(false)
    expect(gate.grant(61)).toBe(false)
    const destroyed = fixture.sender.once.mock.calls[0]?.[1] as (() => void) | undefined
    destroyed?.()
    expect(gate.hasActiveGrant(61)).toBe(false)
    expect(gate.grant(61)).toBe(true)
  })

  it('fails closed for rejection, malformed requests, and unknown windows', async () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const fixture = installFixture(gate)
    const handler = requireHandler()
    gate.grant(61)
    electronState.dialogResponse = 0

    await expect(handler(
      fixture.event,
      { purpose: 'speech-recognition' },
    )).resolves.toEqual({
      granted: false,
      message: '你已取消本次麦克风授权，语音识别未启动。',
    })
    expect(gate.hasActiveGrant(61)).toBe(false)

    await expect(handler(fixture.event, { purpose: 'camera' })).rejects.toThrow()
    fixture.getForWebContents.mockReturnValue(null)
    await expect(handler(
      fixture.event,
      { purpose: 'speech-recognition' },
    )).rejects.toThrow('未知窗口')
    expect(gate.hasActiveGrant(61)).toBe(false)
  })
})

function installFixture(gate: MicrophonePermissionGate) {
  const frame = { url: 'geoforge://app/workspace' }
  const sender = {
    id: 61,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
  }
  const window = {
    webContents: {
      id: 61,
      mainFrame: frame,
    },
    isDestroyed: () => false,
  }
  const getForWebContents = vi.fn((): typeof window | null => window)
  const authorization = vi.fn(() => ({
    userId: 'user_1',
    csrfToken: 'main-only-csrf',
    revision: 1,
    platformRoles: ['platform_admin'] as const,
    permissions: [],
  }))
  installDesktopIpcHandlers({
    api: {},
    auth: { requireAuthorizationContext: authorization },
    control: {},
    downloads: {},
    exports: {},
    files: {},
    microphone: gate,
    supervisor: {},
    windows: { getForWebContents },
  } as unknown as DesktopIpcDependencies)
  return {
    authorization,
    event: { sender, senderFrame: frame },
    getForWebContents,
    sender,
    window,
  }
}

function requireHandler() {
  const handler = electronState.handlers.get(DESKTOP_IPC_CHANNELS.microphonePermission)
  if (!handler) throw new Error('麦克风 IPC 未注册。')
  return handler
}
