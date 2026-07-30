// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面启动失败窗口
//
//   文件:       startupFailureWindow.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { BrowserWindow } from 'electron'

import { buildStartupFailureDocument } from './startupFailureDocument.js'

export function showStartupFailureWindow(error: unknown): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 680,
    minHeight: 460,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#eef3f5',
    title: 'GeoForge 启动失败',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  const document = buildStartupFailureDocument(error)
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
  return window
}
