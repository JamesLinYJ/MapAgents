// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面应用运行壳
//
//   文件:       DesktopApplicationRuntime.tsx
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { AppLoader } from './AppLoader'
import { DesktopBackendMonitor } from './DesktopBackendMonitor'

/**
 * 把后台监督、日志和完整工作区留在异步运行壳中，入口只负责立即呈现稳定启动画面。
 */
export default function DesktopApplicationRuntime() {
  return (
    <DesktopBackendMonitor>
      <AppLoader />
    </DesktopBackendMonitor>
  )
}
