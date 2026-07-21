// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台浏览器入口
//
//   文件:       main.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { OperationsErrorBoundary } from './components/OperationsErrorBoundary'

const root = document.getElementById('root')
if (!root) throw new Error('运维后台缺少 root 挂载点。')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: false },
  },
})

createRoot(root).render(
  <StrictMode>
    <OperationsErrorBoundary>
      <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
    </OperationsErrorBoundary>
  </StrictMode>,
)
