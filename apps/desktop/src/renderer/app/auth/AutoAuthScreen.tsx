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
import { useProductIdentity } from '../ProductIdentityContext'

export function AutoAuthScreen({
  errorMessage,
  isChecking,
  onRetry,
}: {
  errorMessage?: string
  isChecking: boolean
  onRetry: () => void
}) {
  const { productName } = useProductIdentity()
  return (
    <main className="dc-auto-auth-screen" aria-live="polite">
      <section className="dc-auto-auth-card" aria-labelledby="auto-auth-title">
        <div className="dc-auto-auth-brand">
          <span aria-hidden="true">{productName.slice(0, 1).toLocaleUpperCase()}</span>
          <div>
            <strong>{productName} GIS 工作台</strong>
            <small>本机工作台</small>
          </div>
        </div>

        <div className="dc-auto-auth-symbol" data-busy={isChecking} aria-hidden="true">
          <ShieldCheck size={34} />
          {isChecking ? <span /> : null}
        </div>

        <div className="dc-auto-auth-copy">
          <h1 id="auto-auth-title">
            {isChecking ? '正在准备工作台' : '工作台尚未就绪'}
          </h1>
          <p>
            {isChecking
              ? '正在连接本机服务并恢复你的工作区，完成后将自动进入。'
              : '本机工作区未能完成初始化，可重试或打开系统日志查看详情。'}
          </p>
        </div>

        {errorMessage ? (
          <p className="dc-auto-auth-error" role="alert">{errorMessage}</p>
        ) : null}

        <div className="dc-auto-auth-boundary">
          <Sparkles size={17} aria-hidden="true" />
          <span>应用会自动恢复本机会话，不需要额外登录或填写连接参数。</span>
        </div>

        {!isChecking ? (
          <button type="button" className="dc-auto-auth-retry" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />
            重新启动
          </button>
        ) : null}
      </section>
    </main>
  )
}
