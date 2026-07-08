// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import type { Env } from '../../framework/env.js'
import { createMeteorologyTools } from './meteorologyTools.js'

export function createMeteorologyProvider(env: Env): ToolProvider {
  return {
    manifest,
    tools: () => createMeteorologyTools(env),
  }
}
