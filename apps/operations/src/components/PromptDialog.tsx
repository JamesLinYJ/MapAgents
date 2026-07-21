// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维确认输入对话框
//
//   文件:       PromptDialog.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  confirmText = '确认',
  danger = false,
  validate,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  label: string
  placeholder?: string
  confirmText?: string
  danger?: boolean
  validate(value: string): boolean
  onOpenChange(open: boolean): void
  onConfirm(value: string): void
}) {
  const [value, setValue] = useState('')
  useEffect(() => { if (!open) setValue('') }, [open])
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ops-dialog__overlay" />
        <Dialog.Content className="ops-dialog">
          <div className={`ops-dialog__icon ${danger ? 'ops-dialog__icon--danger' : ''}`}><AlertTriangle size={18} /></div>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <label className="ops-field">
            <span>{label}</span>
            <input
              autoFocus
              value={value}
              placeholder={placeholder}
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && validate(value)) onConfirm(value)
              }}
            />
          </label>
          <div className="ops-dialog__actions">
            <Dialog.Close asChild><button className="ops-button ops-button--quiet">取消</button></Dialog.Close>
            <button
              className={`ops-button ${danger ? 'ops-button--danger' : 'ops-button--primary'}`}
              disabled={!validate(value)}
              onClick={() => onConfirm(value)}
            >{confirmText}</button>
          </div>
          <Dialog.Close className="ops-dialog__close" aria-label="关闭"><X size={16} /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
