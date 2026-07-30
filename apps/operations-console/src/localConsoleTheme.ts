// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本地运维台视觉主题
//
//   文件:       localConsoleTheme.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加 Agent 终端的信息层级色与活动指示器主题。
// --------------------------------------------------------------------------

import { defaultTheme, extendTheme } from '@inkjs/ui'

export const consolePalette = {
  canvas: '#07121F',
  panel: '#0D1C2E',
  panelRaised: '#162B42',
  panelSoft: '#10243A',
  border: '#2E4C67',
  borderStrong: '#427D93',
  text: '#EAF4FF',
  muted: '#8499AE',
  focus: '#42D9E3',
  info: '#59A9FF',
  accent: '#9A8CFF',
  reasoning: '#DD8CFF',
  healthy: '#52DDA0',
  warning: '#FFC857',
  danger: '#FF6F7D',
  selected: '#183E57',
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
    Spinner: {
      styles: {
        container: () => ({ gap: 1 }),
        frame: () => ({ color: consolePalette.accent, bold: true }),
        label: () => ({ color: consolePalette.text, bold: true }),
      },
    },
  },
})
