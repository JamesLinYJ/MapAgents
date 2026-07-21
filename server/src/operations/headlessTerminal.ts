// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Headless xterm Node 适配器
//
//   文件:       headlessTerminal.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createRequire } from 'node:module'
import type { Terminal as XtermTerminal } from '@xterm/headless'

// @xterm/headless 6.0.0 的 Node 入口是 webpack 生成的 CommonJS bundle。Node ESM
// 无法静态识别它的 Terminal 具名导出，因此把兼容处理集中在这个边界适配器。
const loadedModule: unknown = createRequire(import.meta.url)('@xterm/headless')
if (!loadedModule || typeof loadedModule !== 'object') {
  throw new Error('@xterm/headless 模块格式无效。')
}
const terminalConstructor = Reflect.get(loadedModule, 'Terminal')
if (typeof terminalConstructor !== 'function') {
  throw new Error('@xterm/headless 未导出 Terminal 构造器。')
}

export const HeadlessTerminal = terminalConstructor as typeof XtermTerminal
export type HeadlessTerminalInstance = XtermTerminal
