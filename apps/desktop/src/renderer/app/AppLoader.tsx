// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面应用渐进加载器
//
//   文件:       AppLoader.tsx
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'

const DesktopWorkspaceApplication = lazy(() => import('./DesktopWorkspaceApplication'))

export function AppLoader() {
  return (
    <Suspense fallback={<BootScreen />}>
      <DesktopWorkspaceApplication />
    </Suspense>
  )
}

export function BootScreen() {
  return (
    <main className="dc-boot" aria-label="正在加载地理智能工作台">
      <section className="dc-boot__shell">
        <div className="dc-boot__brand">
          <span aria-hidden="true">G</span>
          <strong>地理智能工作台</strong>
          <small>气象空间智能平台</small>
        </div>
        <div className="dc-boot__copy">
          <h1>正在准备工作台</h1>
          <p>连接认证、工具目录、地图引擎和会话运行时。</p>
        </div>
        <div className="dc-boot__progress" aria-hidden="true">
          <span />
        </div>
        <div className="dc-boot__deck" aria-hidden="true">
          <span className="dc-boot__card dc-boot__card--conversation" />
          <span className="dc-boot__card dc-boot__card--map" />
          <span className="dc-boot__card dc-boot__card--result" />
        </div>
        <p className="dc-boot__status">启动阶段只加载轻量壳层；地图和重型工具会在工作台就绪后按需加载。</p>
      </section>
    </main>
  )
}
