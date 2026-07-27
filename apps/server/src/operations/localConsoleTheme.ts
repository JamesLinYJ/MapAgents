// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本地运维台视觉主题
//
//   文件:       localConsoleTheme.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defaultTheme, extendTheme } from '@inkjs/ui'

export const consolePalette = {
  canvas: '#08111F',
  panel: '#101D2E',
  panelRaised: '#17283D',
  border: '#36506D',
  text: '#DCE8F5',
  muted: '#8296AC',
  focus: '#39D0D8',
  healthy: '#50D890',
  warning: '#F2B84B',
  danger: '#FF6B6B',
  selected: '#173F52',
} as const

export const geoForgeConsoleTheme = extendTheme(defaultTheme, {
  components: {
    TextInput: {
      styles: { value: () => ({ color: consolePalette.focus, bold: true }) },
    },
    PasswordInput: {
      styles: { value: () => ({ color: consolePalette.focus, bold: true }) },
    },
    ConfirmInput: {
      styles: {
        container: () => ({ gap: 1 }),
        confirm: ({ isFocused }: { isFocused: boolean }) => ({
          color: isFocused ? consolePalette.healthy : consolePalette.muted,
          bold: isFocused,
        }),
        cancel: ({ isFocused }: { isFocused: boolean }) => ({
          color: isFocused ? consolePalette.danger : consolePalette.muted,
          bold: isFocused,
        }),
      },
    },
    Select: {
      styles: {
        selectedIndicator: () => ({ color: consolePalette.healthy }),
        focusIndicator: () => ({ color: consolePalette.focus }),
        label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
          color: isFocused ? consolePalette.focus : isSelected ? consolePalette.healthy : consolePalette.text,
          bold: isFocused,
        }),
      },
    },
  },
})
