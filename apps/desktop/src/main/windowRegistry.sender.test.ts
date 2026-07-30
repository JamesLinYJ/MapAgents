// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区窗口 IPC 所有权测试
//
//   文件:       windowRegistry.sender.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

const { getAllWindows } = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {
    static getAllWindows = getAllWindows
  },
  dialog: {},
  shell: {},
}))
vi.mock('electron-window-state', () => ({
  default: vi.fn(),
}))
vi.mock('./nativeMenus.js', () => ({
  installNativeContextMenu: vi.fn(),
}))

import { WorkspaceWindowRegistry } from './windowRegistry.js'

describe('WorkspaceWindowRegistry IPC ownership', () => {
  it('resolves only registry-owned windows, never arbitrary same-process windows', () => {
    const registry = new WorkspaceWindowRegistry({
      releaseForWebContents: vi.fn(),
    } as never)
    const registered = fakeWindow(11)
    const unregistered = fakeWindow(22)
    registeredWindows(registry).set('workspace_1', registered)
    getAllWindows.mockReturnValue([registered, unregistered])

    expect(registry.getForWebContents(11)).toBe(registered)
    expect(registry.getForWebContents(22)).toBeNull()
    expect(registry.first()).toBe(registered)
    expect(getAllWindows).not.toHaveBeenCalled()
  })
})

function registeredWindows(
  registry: WorkspaceWindowRegistry,
): Map<string, ReturnType<typeof fakeWindow>> {
  return (registry as unknown as {
    windows: Map<string, ReturnType<typeof fakeWindow>>
  }).windows
}

function fakeWindow(webContentsId: number) {
  return {
    isDestroyed: () => false,
    webContents: { id: webContentsId },
  }
}
