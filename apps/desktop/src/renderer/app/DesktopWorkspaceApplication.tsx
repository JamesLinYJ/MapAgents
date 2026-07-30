// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作区应用组合根
//
//   文件:       DesktopWorkspaceApplication.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import AppShell from './AppShell'
import { AppQueryProvider } from './QueryProvider'

/**
 * Renderer 启动不依赖后台健康；查询层把网络故障投影为可恢复状态。
 */
export default function DesktopWorkspaceApplication() {
  return (
    <AppQueryProvider>
      <AppShell />
    </AppQueryProvider>
  )
}
