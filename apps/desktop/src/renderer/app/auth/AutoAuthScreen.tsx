// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机自动认证状态页
//
//   文件:       AutoAuthScreen.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import {
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
} from '@geo-agent-platform/shared-types/product-identity'

export function AutoAuthScreen({
  errorMessage,
  isChecking,
  onRetry,
}: {
  errorMessage?: string
  isChecking: boolean
  onRetry: () => void
}) {
  return (
    <main className="dc-auto-auth-screen" aria-live="polite">
      <section className="dc-auto-auth-card" aria-labelledby="auto-auth-title">
        <div className="dc-auto-auth-brand">
          <span aria-hidden="true">{PRODUCT_CODENAME.slice(0, 1).toLocaleUpperCase()}</span>
          <div>
            <strong>{PRODUCT_DESKTOP_NAME}</strong>
            <small>本机演示环境</small>
          </div>
        </div>

        <div className="dc-auto-auth-symbol" data-busy={isChecking} aria-hidden="true">
          <ShieldCheck size={34} />
          {isChecking ? <span /> : null}
        </div>

        <div className="dc-auto-auth-copy">
          <h1 id="auto-auth-title">
            {isChecking ? '正在自动认证' : '自动认证暂不可用'}
          </h1>
          <p>
            {isChecking
              ? '正在通过 Electron 主进程建立 Better Auth 会话，并由服务端校验平台权限。'
              : '登录表单已在本机演示模式中隐藏；恢复后台后可以重新建立会话。'}
          </p>
        </div>

        {errorMessage ? (
          <p className="dc-auto-auth-error" role="alert">{errorMessage}</p>
        ) : null}

        <div className="dc-auto-auth-boundary">
          <Sparkles size={17} aria-hidden="true" />
          <span>凭据不会进入 Renderer；所有管理权限仍由服务端 RBAC 决定。</span>
        </div>

        {!isChecking ? (
          <button type="button" className="dc-auto-auth-retry" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />
            重新认证
          </button>
        ) : null}
      </section>
    </main>
  )
}
