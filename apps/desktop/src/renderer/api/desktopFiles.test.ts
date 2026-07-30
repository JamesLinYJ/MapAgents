// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面原生文件选择门面测试
//
//   文件:       desktopFiles.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '../../contracts/desktopBridge'
import {
  selectDesktopAutomationDraft,
  selectDesktopLayerFile,
  selectDesktopUploadFiles,
} from './desktopFiles'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('desktop native file picker facade', () => {
  it('requests native file and folder selection without accepting Renderer paths', async () => {
    const select = vi.fn().mockResolvedValue([])
    installBridge({ select, readText: vi.fn() })

    await selectDesktopUploadFiles('files')
    await selectDesktopUploadFiles('folder')
    await selectDesktopLayerFile()

    expect(select).toHaveBeenNthCalledWith(1, {
      kind: 'files',
      multiple: true,
      filters: [],
    })
    expect(select).toHaveBeenNthCalledWith(2, {
      kind: 'folder',
      multiple: false,
      filters: [],
    })
    expect(select).toHaveBeenNthCalledWith(3, {
      kind: 'files',
      multiple: false,
      filters: [{
        name: 'GeoJSON 图层',
        extensions: ['geojson', 'json'],
      }],
    })
    expect(JSON.stringify(select.mock.calls)).not.toMatch(/[A-Z]:\\/u)
  })

  it('reads an automation draft only through its one-time opaque handle', async () => {
    const file = {
      handleId: crypto.randomUUID(),
      name: 'rainfall.automation.json',
      sizeBytes: 128,
      mediaType: 'application/json',
      relativePath: 'rainfall.automation.json',
      modifiedAtMs: 100,
    }
    const select = vi.fn().mockResolvedValue([file])
    const readText = vi.fn().mockResolvedValue({
      name: file.name,
      text: '{"name":"rainfall"}',
    })
    installBridge({ select, readText })

    await expect(selectDesktopAutomationDraft()).resolves.toEqual({
      file,
      text: '{"name":"rainfall"}',
    })
    expect(readText).toHaveBeenCalledWith({
      handleId: file.handleId,
      expectedName: file.name,
      purpose: 'automation-draft-import',
    })
  })
})

function installBridge(files: DesktopBridge['files']): void {
  const bridge = { files } as unknown as DesktopBridge
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { platformDesktop: bridge },
  })
}
