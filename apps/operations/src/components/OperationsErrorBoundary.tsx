// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维页面错误边界
//
//   文件:       OperationsErrorBoundary.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ServerCog } from 'lucide-react'

interface OperationsErrorBoundaryState {
  failed: boolean
}

export class OperationsErrorBoundary extends Component<{ children: ReactNode }, OperationsErrorBoundaryState> {
  state: OperationsErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): OperationsErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('运维页面渲染失败', { name: error.name, componentStack: info.componentStack })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <main className="ops-loading ops-loading--error">
      <ServerCog size={24} />
      <strong>运维页面遇到问题</strong>
      <span>界面模块渲染失败；服务与终端状态没有被伪造。</span>
      <button className="ops-button" onClick={() => window.location.reload()}>重新加载</button>
    </main>
  }
}
