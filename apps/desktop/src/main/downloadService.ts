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
import { BrowserWindow, dialog, net } from 'electron'
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
    const headers = new Headers({ accept: '*/*', origin: PLATFORM_DESKTOP_APP_ORIGIN })
    const cookie = this.auth.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    const response = await net.fetch(new URL(request.path, `${this.apiBaseUrl}/`).toString(), { headers })
    if (!response.ok || !response.body) {
      const detail = (await response.text()).trim()
      throw new Error(detail || `下载失败（HTTP ${response.status}）。`)
    }
    await writeResponseBodyToFile(response, choice.filePath)
    return desktopDownloadResultSchema.parse({
      canceled: false,
      displayName: path.basename(choice.filePath),
    })
  }
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
