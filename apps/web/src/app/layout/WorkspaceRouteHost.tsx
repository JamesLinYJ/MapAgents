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
const AccountCenterPage = lazy(() => import('../../features/account/AccountCenterPage').then(module => ({
  default: module.AccountCenterPage,
})))
const LegalPolicyPage = lazy(() => import('../../features/account/LegalPolicyPage').then(module => ({
  default: module.LegalPolicyPage,
})))
const PublicSharePage = lazy(() => import('../../features/account/PublicSharePage').then(module => ({
  default: module.PublicSharePage,
})))

interface WorkspaceRouteHostProps {
  renderWorkspace: (Workspace: ComponentType<WorkspaceLayoutProps>) => ReactNode
  renderDebug: (Debug: ComponentType<DebugPageProps>) => ReactNode
  account: ReactNode
  terms: ReactNode
  privacy: ReactNode
}

export function WorkspaceRouteHost({ renderWorkspace, renderDebug, account, terms, privacy }: WorkspaceRouteHostProps) {
  return (
    <AppRoutes
      workspace={renderWorkspace(WorkspaceLayout)}
      debug={renderDebug(WorkspaceDebugPanel)}
      security={<SecurityAdminPage />}
      account={account}
      terms={terms}
      privacy={privacy}
      share={<PublicSharePage />}
    />
  )
}

export { AccountCenterPage, LegalPolicyPage, PublicSharePage }
