// +-------------------------------------------------------------------------
//
//   地理智能平台 - Glass 风格对话框 (Radix Dialog)
//
//   文件:       GlassDialog.tsx
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

import * as Dialog from '@radix-ui/react-dialog'
import { AnimatePresence, m } from 'framer-motion'
import type { ReactNode } from 'react'

export interface GlassDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  children: ReactNode
  /** 点击遮罩是否关闭，默认 true */
  modal?: boolean
}

export function GlassDialog({ open, onOpenChange, title, description, children, modal = true }: GlassDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <m.div
                className="alert-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <m.div
                className="alert"
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: 'spring', stiffness: 360, damping: 36 }}
              >
                {title && (
                  <Dialog.Title asChild>
                    <h2>{title}</h2>
                  </Dialog.Title>
                )}
                {description && (
                  <Dialog.Description asChild>
                    <p>{description}</p>
                  </Dialog.Description>
                )}
                {children}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

export function GlassDialogActions({ children }: { children: ReactNode }) {
  return <div className="alert-actions">{children}</div>
}

export { Dialog }
