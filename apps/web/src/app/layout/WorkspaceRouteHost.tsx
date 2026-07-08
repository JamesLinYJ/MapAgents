// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台路由宿主
//
//   文件:       WorkspaceRouteHost.tsx
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { lazy, type ComponentType, type ReactNode } from 'react'
import type { DebugPageProps } from '../../features/debug/DebugPage'
import { AppRoutes } from '../routes'
import { WorkspaceDebugPanel } from './WorkspaceDebugPanel'
import { WorkspaceLayout, type WorkspaceLayoutProps } from './WorkspaceLayout'

const SecurityAdminPage = lazy(() => import('../../features/security/SecurityAdminPage'))

interface WorkspaceRouteHostProps {
  renderWorkspace: (Workspace: ComponentType<WorkspaceLayoutProps>) => ReactNode
  renderDebug: (Debug: ComponentType<DebugPageProps>) => ReactNode
}

export function WorkspaceRouteHost({ renderWorkspace, renderDebug }: WorkspaceRouteHostProps) {
  return (
    <AppRoutes
      workspace={renderWorkspace(WorkspaceLayout)}
      debug={renderDebug(WorkspaceDebugPanel)}
      security={<SecurityAdminPage />}
    />
  )
}
