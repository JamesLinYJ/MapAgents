// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维进程配置
//
//   文件:       config.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const booleanSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  if (['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())) return false
  return value
}, z.boolean())

const commonProductionSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OPS_EXPECTED_SERVICE_USER: z.string().trim().min(1).optional(),
})

const gatewaySchema = commonProductionSchema.extend({
  OPS_GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  OPS_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8020),
  OPS_PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8020'),
  OPS_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:8020,http://localhost:8020'),
  OPS_STATIC_ROOT: z.string().default('apps/operations/dist'),
  OPS_BROKER_URL: z.string().url().default('http://127.0.0.1:8021'),
  OPS_BROKER_SHARED_SECRET: z.string().min(32),
  OPS_RECOVERY_SECRET: z.string().min(32),
  OPS_MASTER_KEYRING_FILE: z.string().min(1).default('runtime/ops/keyring.json'),
  OPS_ACTIVE_KEY_ID: z.string().min(1).default('dev-1'),
  PROCESS_COMPOSE_URL: z.string().url().default('http://127.0.0.1:8080'),
  PROCESS_COMPOSE_TOKEN_FILE: z.string().min(1).default('runtime/ops/process-compose.token'),
  DATABASE_URL: z.string().min(1),
  RUNTIME_ROOT: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_ALLOW_SIGN_UP: booleanSchema.default(false),
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: booleanSchema.default(true),
  BETTER_AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(8).default(12),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  CSRF_HEADER_NAME: z.string().min(1).default('x-geoforge-csrf'),
})

const brokerSchema = commonProductionSchema.extend({
  OPS_BROKER_HOST: z.string().min(1).default('127.0.0.1'),
  OPS_BROKER_PORT: z.coerce.number().int().min(1).max(65_535).default(8021),
  OPS_BROKER_SHARED_SECRET: z.string().min(32),
  OPS_TERMINAL_SPOOL_ROOT: z.string().min(1).default('runtime/ops/terminal-spool'),
  OPS_WORKSPACE_ROOT: z.string().min(1),
  OPS_WINDOWS_SHELL: z.string().min(1).optional(),
  OPS_LINUX_SHELL: z.string().min(1).optional(),
}).superRefine((value, context) => {
  const field = process.platform === 'win32' ? 'OPS_WINDOWS_SHELL' : 'OPS_LINUX_SHELL'
  if (!value[field]) {
    context.addIssue({ code: 'custom', path: [field], message: '当前平台必须显式配置终端 shell' })
  }
})

export interface OpsGatewayEnvironment extends z.infer<typeof gatewaySchema> {
  projectRoot: string
  staticRoot: string
  runtimeRoot: string
  keyringFile: string
  processComposeTokenFile: string
  trustedOrigins: Set<string>
}

export interface TerminalBrokerEnvironment extends z.infer<typeof brokerSchema> {
  projectRoot: string
  spoolRoot: string
  workspaceRoot: string
  shell: string
}

export function parseOpsGatewayEnvironment(
  input: NodeJS.ProcessEnv,
  projectRoot: string,
): OpsGatewayEnvironment {
  assertExplicitProductionFields(input, 'Ops Gateway', [
    'OPS_EXPECTED_SERVICE_USER',
    'OPS_STATIC_ROOT',
    'OPS_MASTER_KEYRING_FILE',
    'PROCESS_COMPOSE_TOKEN_FILE',
  ])
  const value = parseOrThrow(gatewaySchema, input, 'Ops Gateway')
  assertExpectedServiceUser(value.NODE_ENV, value.OPS_EXPECTED_SERVICE_USER)
  const trustedOrigins = parseTrustedOrigins(value.OPS_ALLOWED_ORIGINS)
  if (value.NODE_ENV === 'production') {
    assertLoopbackHost(value.OPS_GATEWAY_HOST, 'OPS_GATEWAY_HOST')
    assertLoopbackUrl(value.OPS_BROKER_URL, 'OPS_BROKER_URL')
    assertLoopbackUrl(value.PROCESS_COMPOSE_URL, 'PROCESS_COMPOSE_URL')
    if (new URL(value.OPS_PUBLIC_BASE_URL).protocol !== 'https:') {
      throw new Error('Ops Gateway 生产环境 OPS_PUBLIC_BASE_URL 必须使用 HTTPS。')
    }
    for (const origin of trustedOrigins) {
      if (new URL(origin).protocol !== 'https:') {
        throw new Error('Ops Gateway 生产环境的可信 Origin 必须全部使用 HTTPS。')
      }
    }
    assertProductionSecret('OPS_BROKER_SHARED_SECRET', value.OPS_BROKER_SHARED_SECRET)
    assertProductionSecret('OPS_RECOVERY_SECRET', value.OPS_RECOVERY_SECRET)
    assertProductionSecret('BETTER_AUTH_SECRET', value.BETTER_AUTH_SECRET)
    if (new Set([value.OPS_BROKER_SHARED_SECRET, value.OPS_RECOVERY_SECRET, value.BETTER_AUTH_SECRET]).size !== 3) {
      throw new Error('Ops Gateway 的 Broker、恢复窗口和认证密钥必须彼此独立。')
    }
  }
  return {
    ...value,
    projectRoot: path.resolve(projectRoot),
    staticRoot: resolveConfiguredPath(projectRoot, value.OPS_STATIC_ROOT),
    runtimeRoot: resolveConfiguredPath(projectRoot, value.RUNTIME_ROOT),
    keyringFile: resolveConfiguredPath(projectRoot, value.OPS_MASTER_KEYRING_FILE),
    processComposeTokenFile: resolveConfiguredPath(projectRoot, value.PROCESS_COMPOSE_TOKEN_FILE),
    trustedOrigins,
  }
}

export function parseTerminalBrokerEnvironment(
  input: NodeJS.ProcessEnv,
  projectRoot: string,
): TerminalBrokerEnvironment {
  assertExplicitProductionFields(input, 'Terminal Broker', [
    'OPS_EXPECTED_SERVICE_USER',
    'OPS_TERMINAL_SPOOL_ROOT',
    'OPS_WORKSPACE_ROOT',
    process.platform === 'win32' ? 'OPS_WINDOWS_SHELL' : 'OPS_LINUX_SHELL',
  ])
  const value = parseOrThrow(brokerSchema, input, 'Terminal Broker')
  assertExpectedServiceUser(value.NODE_ENV, value.OPS_EXPECTED_SERVICE_USER)
  if (value.NODE_ENV === 'production') {
    assertLoopbackHost(value.OPS_BROKER_HOST, 'OPS_BROKER_HOST')
    assertProductionSecret('OPS_BROKER_SHARED_SECRET', value.OPS_BROKER_SHARED_SECRET)
  }
  const configuredShell = process.platform === 'win32' ? value.OPS_WINDOWS_SHELL : value.OPS_LINUX_SHELL
  if (!configuredShell) throw new Error('当前平台未配置终端 shell。')
  return {
    ...value,
    projectRoot: path.resolve(projectRoot),
    spoolRoot: resolveConfiguredPath(projectRoot, value.OPS_TERMINAL_SPOOL_ROOT),
    workspaceRoot: resolveConfiguredPath(projectRoot, value.OPS_WORKSPACE_ROOT),
    shell: resolveConfiguredExecutable(projectRoot, configuredShell),
  }
}

function resolveConfiguredPath(projectRoot: string, configured: string): string {
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(projectRoot, configured)
}

function resolveConfiguredExecutable(projectRoot: string, configured: string): string {
  if (path.isAbsolute(configured)) return path.normalize(configured)
  return /[\\/]/u.test(configured) ? path.resolve(projectRoot, configured) : configured
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

function parseTrustedOrigins(value: string): Set<string> {
  const origins = value.split(',').map(normalizeOrigin).filter(Boolean)
  if (!origins.length) throw new Error('Ops Gateway 至少需要一个可信 Origin。')
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error('Ops Gateway 可信 Origin 格式无效。')
    }
    if (parsed.origin !== origin) throw new Error('Ops Gateway 可信 Origin 不得包含路径、查询或片段。')
  }
  return new Set(origins)
}

function assertExpectedServiceUser(environment: string, expected?: string): void {
  if (environment !== 'production' || !expected) return
  const actual = os.userInfo().username
  if (actual.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    throw new Error(`运维进程必须由配置的专用服务账户运行；当前账户不符合部署配置。`)
  }
}

function assertExplicitProductionFields(
  input: NodeJS.ProcessEnv,
  component: string,
  fields: string[],
): void {
  if (input.NODE_ENV?.trim().toLowerCase() !== 'production') return
  const missing = fields.filter(field => !input[field]?.trim())
  if (missing.length) {
    throw new Error(`${component} 生产配置缺少显式字段：${missing.join('、')}。`)
  }
}

function assertLoopbackHost(host: string, field: string): void {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(normalized)) {
    throw new Error(`${field} 必须绑定回环地址。`)
  }
}

function assertLoopbackUrl(value: string, field: string): void {
  assertLoopbackHost(new URL(value).hostname, field)
}

function assertProductionSecret(field: string, value: string): void {
  if (/(?:replace|change.?me|development|example|placeholder|<|>)/iu.test(value)) {
    throw new Error(`${field} 仍是占位值，生产环境已拒绝启动。`)
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, component: string): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const detail = result.error.issues.map(issue => `${issue.path.join('.') || '(根)'}: ${issue.message}`).join('；')
  throw new Error(`${component} 配置无效：${detail}`)
}
