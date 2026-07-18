// +-------------------------------------------------------------------------
//
//   地理智能平台 - 浏览器认证状态
//
//   文件:       authStore.ts
//
//   日期:       2026年07月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuthMe } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'error'

interface AuthStoreState {
  authMe: AuthMe | null
  status: AuthStatus
  clear: () => void
  setAuthenticated: (auth: AuthMe) => void
  setStatus: (status: AuthStatus) => void
}

// 认证状态是 HTTP 会话在浏览器内的实时投影；Cookie 和服务端会话仍是身份事实源。
export const useAuthStore = create<AuthStoreState>(set => ({
  authMe: null,
  status: 'checking',
  clear: () => set({ authMe: null, status: 'unauthenticated' }),
  setAuthenticated: authMe => set({ authMe, status: 'authenticated' }),
  setStatus: status => set(state => ({
    authMe: status === 'authenticated' ? state.authMe : null,
    status,
  })),
}))
