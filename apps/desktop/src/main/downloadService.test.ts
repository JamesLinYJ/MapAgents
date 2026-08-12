// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面结果文件打开服务测试
//
// --------------------------------------------------------------------------

import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  fetch: vi.fn(),
  openPath: vi.fn(),
  showSaveDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: electron.showSaveDialog },
  net: { fetch: electron.fetch },
  shell: { openPath: electron.openPath },
}))

import { DesktopDownloadService } from './downloadService.js'

describe('DesktopDownloadService.open', () => {
  const temporaryDirectories = new Set<string>()

  beforeEach(() => {
    electron.fetch.mockReset()
    electron.openPath.mockReset()
    electron.showSaveDialog.mockReset()
    electron.fetch.mockResolvedValue(new Response('artifact-bytes', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    electron.openPath.mockResolvedValue('')
  })

  afterEach(async () => {
    await Promise.all([...temporaryDirectories].map(directory => (
      rm(directory, { recursive: true, force: true })
    )))
    temporaryDirectories.clear()
  })

  it('downloads to a private temporary file and opens it with the system application', async () => {
    const service = new DesktopDownloadService('http://127.0.0.1:8000', {
      cookieHeader: () => 'session=opaque',
    } as never)

    await expect(service.open({
      path: '/api/v1/results/artifact_png/file',
      suggestedName: '风险区划图.png',
    })).resolves.toEqual({ canceled: false, displayName: '风险区划图.png' })

    const filePath = electron.openPath.mock.calls[0]?.[0] as string
    temporaryDirectories.add(path.dirname(filePath))
    expect(await readFile(filePath, 'utf8')).toBe('artifact-bytes')
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
    expect(electron.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/results/artifact_png/file',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('removes the temporary file when the operating system cannot open it', async () => {
    electron.openPath.mockResolvedValue('没有关联的应用')
    const service = new DesktopDownloadService('http://127.0.0.1:8000', {
      cookieHeader: () => null,
    } as never)

    await expect(service.open({
      path: '/api/v1/results/artifact_csv/file',
      suggestedName: '风险分级.csv',
    })).rejects.toThrow('没有关联的应用')

    const filePath = electron.openPath.mock.calls[0]?.[0] as string
    await expect(stat(path.dirname(filePath))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
