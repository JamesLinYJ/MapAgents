// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker 环境隔离
//
//   文件:       brokerEnvironment.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const BROKER_CONFIGURATION_NAMES = new Set([
  'NODE_ENV',
  'OPS_EXPECTED_SERVICE_USER',
  'OPS_BROKER_HOST',
  'OPS_BROKER_PORT',
  'OPS_BROKER_SHARED_SECRET',
  'OPS_TERMINAL_SPOOL_ROOT',
  'OPS_WORKSPACE_ROOT',
  'OPS_WINDOWS_SHELL',
  'OPS_LINUX_SHELL',
])

const SHELL_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'LANG',
  'LC_ALL',
])

const SENSITIVE_NAME = /(API|DATABASE|PASSWORD|PASSWD|SECRET|SESSION|TOKEN|PRIVATE|CREDENTIAL|OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|AZURE|POSTGRES)/iu

export function sanitizeBrokerProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of Object.keys(environment)) {
    if (!BROKER_CONFIGURATION_NAMES.has(name) && !SHELL_ENVIRONMENT_NAMES.has(name)) delete environment[name]
  }
  return environment
}

export function buildTerminalEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of SHELL_ENVIRONMENT_NAMES) {
    if (SENSITIVE_NAME.test(name)) continue
    const value = environment[name]
    if (typeof value === 'string' && value) result[name] = value
  }
  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  // 加密 spool 是唯一终端记录；shell 不得在用户目录另写明文命令历史。
  result.HISTFILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return result
}

export function containsSensitiveEnvironmentName(environment: Record<string, string>): boolean {
  return Object.keys(environment).some(name => SENSITIVE_NAME.test(name))
}
