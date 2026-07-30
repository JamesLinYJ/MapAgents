// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Renderer 入口
//
//   文件:       main.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//
//   维护记录 (2026-07-29):
//     作者: OpenAI Codex
//     说明: 产品入口迁入 Electron；普通浏览器不挂载 GIS 工作台。
// --------------------------------------------------------------------------

// 模块职责
//
// 作为桌面 Renderer 挂载入口，装配查询缓存和全局样式资源。

import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { BootScreen } from './app/AppLoader'
import { ErrorBoundary } from './shared/components/ErrorBoundary'

const DesktopApplicationRuntime = lazy(() => import('./app/DesktopApplicationRuntime'))

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('桌面 Renderer 缺少根挂载节点。')

if (!window.geoforgeDesktop) {
  rootElement.textContent = 'GeoForge GIS 工作台只能通过 Electron 桌面应用启动。'
  rootElement.setAttribute('role', 'alert')
} else {
  createRoot(rootElement).render(
    <ErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <DesktopApplicationRuntime />
      </Suspense>
    </ErrorBoundary>,
  )
}
