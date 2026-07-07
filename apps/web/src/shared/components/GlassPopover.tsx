// +-------------------------------------------------------------------------
//
//   地理智能平台 - Glass 风格弹出框 (Radix Popover)
//
//   文件:       GlassPopover.tsx
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

import * as Popover from '@radix-ui/react-popover'
import { m, AnimatePresence } from 'framer-motion'
import type { ReactNode } from 'react'

export interface GlassPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function GlassPopover({ open, onOpenChange, trigger, children, align = 'center', side = 'bottom' }: GlassPopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <Popover.Content align={align} side={side} sideOffset={8} asChild>
              <m.div
                className="popover-content glass-panel"
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                transition={{ duration: 0.12 }}
              >
                {children}
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  )
}
