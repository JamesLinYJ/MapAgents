// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维登录页
//
//   文件:       LoginPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { LockKeyhole, ServerCog } from 'lucide-react'
import { useState } from 'react'

import { signInWithEmail } from '../../api/betterAuthClient.js'

export function LoginPage({ onSignedIn }: { onSignedIn(): Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithEmail(email, password)
      await onSignedIn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败。')
    } finally {
      setBusy(false)
    }
  }
  return <main className="ops-auth-page">
    <section className="ops-auth-card">
      <div className="ops-auth-card__brand"><ServerCog size={22} /><div><strong>GeoForge</strong><span>运维控制台</span></div></div>
      <header><div className="ops-dialog__icon"><LockKeyhole size={18} /></div><h1>平台管理员登录</h1><p>使用现有 GeoForge 账户。运维后台不会创建独立永久账号。</p></header>
      <label className="ops-field"><span>邮箱</span><input autoFocus autoComplete="username" type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label className="ops-field"><span>密码</span><input autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && email && password) void submit() }} /></label>
      {error && <p className="ops-form-error">{error}</p>}
      <button className="ops-button ops-button--primary ops-button--block" disabled={!email || !password || busy} onClick={() => { void submit() }}>{busy ? '正在验证…' : '登录运维后台'}</button>
      <small>只有 platform_admin 可以进入；分析员和工作区管理员会收到 403。</small>
    </section>
  </main>
}

export function AccessDeniedPage() {
  return <main className="ops-auth-page"><section className="ops-auth-card"><div className="ops-auth-card__brand"><ServerCog size={22} /><div><strong>GeoForge</strong><span>运维控制台</span></div></div><header><div className="ops-dialog__icon ops-dialog__icon--danger"><LockKeyhole size={18} /></div><h1>无权访问运维后台</h1><p>当前账户不是平台管理员。此访问尝试已记录。</p></header></section></main>
}
