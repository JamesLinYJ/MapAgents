// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面受控下载服务
//
//   文件:       downloadService.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dialog, net, shell, type BrowserWindow } from 'electron'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  desktopDownloadRequestSchema,
  desktopDownloadResultSchema,
  type DesktopDownloadRequest,
  type DesktopDownloadResult,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthGateway } from './authGateway.js'
import { writeResponseBodyToFile } from './responseBodyWriter.js'

export class DesktopDownloadService {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: DesktopAuthGateway,
  ) {}

  async save(window: BrowserWindow, input: DesktopDownloadRequest): Promise<DesktopDownloadResult> {
    const request = desktopDownloadRequestSchema.parse(input)
    const choice = await dialog.showSaveDialog(window, {
      title: `保存 ${PRODUCT_CODENAME} 数据`,
      defaultPath: sanitizeFileName(request.suggestedName),
    })
    if (choice.canceled || !choice.filePath) {
      return desktopDownloadResultSchema.parse({ canceled: true, displayName: null })
    }
    const response = await this.fetchArtifact(request)
    await writeResponseBodyToFile(response, choice.filePath)
    return desktopDownloadResultSchema.parse({
      canceled: false,
      displayName: path.basename(choice.filePath),
    })
  }

  /**
   * 一键打开不向 Renderer 暴露本地路径。Main 先通过已认证的网关将文件
   * 落到 0700 临时目录，再交给系统默认应用。文件保留一段时间，避免外部
   * 应用延迟读取时遇到已删除文件。
   */
  async open(input: DesktopDownloadRequest): Promise<DesktopDownloadResult> {
    const request = desktopDownloadRequestSchema.parse(input)
    const directory = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-artifact-'))
    const displayName = sanitizeFileName(request.suggestedName)
    const filePath = path.join(directory, displayName)
    try {
      const response = await this.fetchArtifact(request)
      await writeResponseBodyToFile(response, filePath)
      const failure = await shell.openPath(filePath)
      if (failure) throw new Error(`无法用系统默认应用打开“${displayName}”：${failure}`)
      scheduleTemporaryArtifactCleanup(directory)
      return desktopDownloadResultSchema.parse({ canceled: false, displayName })
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async fetchArtifact(request: DesktopDownloadRequest): Promise<Response> {
    const headers = new Headers({ accept: '*/*', origin: PLATFORM_DESKTOP_APP_ORIGIN })
    const cookie = this.auth.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    const response = await net.fetch(new URL(request.path, `${this.apiBaseUrl}/`).toString(), { headers })
    if (!response.ok || !response.body) {
      const detail = (await response.text()).trim()
      throw new Error(detail || `下载失败（HTTP ${response.status}）。`)
    }
    return response
  }
}

const TEMPORARY_ARTIFACT_RETENTION_MS = 6 * 60 * 60 * 1_000

function scheduleTemporaryArtifactCleanup(directory: string): void {
  const timer = setTimeout(() => {
    void rm(directory, { recursive: true, force: true })
  }, TEMPORARY_ARTIFACT_RETENTION_MS)
  timer.unref()
}

function sanitizeFileName(value: string): string {
  const printableValue = [...value]
    .map(character => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
        ? '-'
        : character
    })
    .join('')

  return printableValue
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/[.\s]+$/gu, '')
    .slice(0, 180)
    || `${PRODUCT_CODENAME}-数据`
}
