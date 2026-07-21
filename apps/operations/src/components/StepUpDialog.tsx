// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维二次密码验证对话框
//
//   文件:       StepUpDialog.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import * as Dialog from '@radix-ui/react-dialog'
import { LockKeyhole, X } from 'lucide-react'
import { useState } from 'react'

export function StepUpDialog({
  open,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  error: string | null
  onOpenChange(open: boolean): void
  onSubmit(password: string): void
}) {
  const [password, setPassword] = useState('')
  return (
    <Dialog.Root open={open} onOpenChange={value => {
      if (!busy) onOpenChange(value)
      if (!value) setPassword('')
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ops-dialog__overlay" />
        <Dialog.Content className="ops-dialog">
          <div className="ops-dialog__icon"><LockKeyhole size={18} /></div>
          <Dialog.Title>重新验证管理员身份</Dialog.Title>
          <Dialog.Description>
            创建终端和服务写操作会开启 15 分钟操作窗口。密码只提交给 Better Auth。
          </Dialog.Description>
          <label className="ops-field">
            <span>当前账户密码</span>
            <input
              autoFocus
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && password && !busy) onSubmit(password)
              }}
            />
          </label>
          {error && <p className="ops-form-error">{error}</p>}
          <div className="ops-dialog__actions">
            <Dialog.Close asChild><button className="ops-button ops-button--quiet">取消</button></Dialog.Close>
            <button
              className="ops-button ops-button--primary"
              disabled={!password || busy}
              onClick={() => onSubmit(password)}
            >{busy ? '验证中…' : '验证并继续'}</button>
          </div>
          <Dialog.Close className="ops-dialog__close" aria-label="关闭"><X size={16} /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
