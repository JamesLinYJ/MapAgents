// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区认证协调器
//
//   文件:       useWorkspaceAuthenticationCoordinator.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useEffect, useRef } from 'react'

import { logout } from '../../api/client'
import { formatUiError } from '../bootstrap'
import type { AuthStatus, DesktopAuthMode } from '../useWorkspaceBootstrap'

interface WorkspaceAuthenticationCoordinatorOptions {
  hasAuthenticatedIdentity: boolean
  authMode: DesktopAuthMode
  authStatus: AuthStatus
  backendOnlineRevision: number
  clearAuth: () => void
  retryAuth: () => void
  setUiError: (message: string | undefined) => void
}

export function shouldRetryAuthentication(
  previousOnlineRevision: number,
  currentOnlineRevision: number,
  authStatus: AuthStatus,
): boolean {
  return currentOnlineRevision > previousOnlineRevision && authStatus === 'error'
}

export function useWorkspaceAuthenticationCoordinator({
  hasAuthenticatedIdentity,
  authMode,
  authStatus,
  backendOnlineRevision,
  clearAuth,
  retryAuth,
  setUiError,
}: WorkspaceAuthenticationCoordinatorOptions) {
  const previousBackendOnlineRevision = useRef(backendOnlineRevision)
  useEffect(() => {
    if (shouldRetryAuthentication(
      previousBackendOnlineRevision.current,
      backendOnlineRevision,
      authStatus,
    )) {
      retryAuth()
    }
    previousBackendOnlineRevision.current = backendOnlineRevision
  }, [authStatus, backendOnlineRevision, retryAuth])

  const handleLogout = useCallback(async () => {
    if (!hasAuthenticatedIdentity) {
      retryAuth()
      return
    }
    try {
      await logout()
    } catch (error) {
      setUiError(formatUiError(error, '退出登录失败。'))
      return
    }
    clearAuth()
    setUiError(undefined)
    if (authMode === 'local_auto') retryAuth()
  }, [
    authMode,
    clearAuth,
    hasAuthenticatedIdentity,
    retryAuth,
    setUiError,
  ])

  return { handleLogout }
}
