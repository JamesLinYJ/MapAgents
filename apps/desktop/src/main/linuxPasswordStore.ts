// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux 系统安全存储选择
//
//   文件:       linuxPasswordStore.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export interface LinuxPasswordStoreSelection {
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
  appendSwitch(name: string, value: string): void
}

/**
 * Chromium 在 Plasma 6 上仍可能探测到旧 KWallet 接口。必须在 app ready
 * 之前选定与桌面会话匹配的后端，否则 Electron safeStorage 会错误地报告不可用。
 */
export function configureLinuxPasswordStore(
  input: LinuxPasswordStoreSelection,
): 'kwallet5' | 'kwallet6' | null {
  if (input.platform !== 'linux') return null

  const desktop = [
    input.environment.XDG_CURRENT_DESKTOP,
    input.environment.XDG_SESSION_DESKTOP,
    input.environment.DESKTOP_SESSION,
  ].filter(Boolean).join(':').toLocaleLowerCase('en-US')
  if (!desktop.includes('kde') && !desktop.includes('plasma')) return null

  const backend = input.environment.KDE_SESSION_VERSION?.trim() === '5'
    ? 'kwallet5'
    : 'kwallet6'
  input.appendSwitch('password-store', backend)
  return backend
}
