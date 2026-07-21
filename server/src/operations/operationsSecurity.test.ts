// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维协议与认证边界测试
//
//   文件:       operationsSecurity.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { opsControlCommandSchema, opsServiceIdSchema } from '@geo-agent-platform/shared-types/operations'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { BetterAuthService } from '../security/authService.js'
import type { AuthContext } from '../security/types.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import { DatabaseUnavailableError, isDatabaseUnavailable } from '../db/databaseAvailability.js'
import { BrokerNonceCache, applyBrokerSignature, signBrokerRequest, verifyBrokerRequest } from './brokerAuthentication.js'
import { buildTerminalEnvironment, sanitizeBrokerProcessEnvironment } from './brokerEnvironment.js'
import { parseOpsGatewayEnvironment, parseTerminalBrokerEnvironment } from './config.js'
import { OpsAuditService } from './opsAuditService.js'
import { OpsAuthenticator } from './opsAuthenticator.js'
import { OpsError } from './opsError.js'
import { OpsSessionWindowCodec } from './opsSessionWindow.js'

const ADMIN: AuthContext = {
  userId: 'user_admin',
  subject: 'subject_admin',
  email: 'admin@example.com',
  displayName: '平台管理员',
  authSessionId: 'session_admin',
  authSessionExpiresAt: null,
  csrfToken: 'c'.repeat(43),
  defaultWorkspaceId: 'workspace_1',
  roles: [{ workspaceId: 'workspace_1', role: 'platform_admin' }],
}

const ANALYST: AuthContext = {
  ...ADMIN,
  userId: 'user_analyst',
  email: 'analyst@example.com',
  roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
}

describe('运维共享协议', () => {
  it('只接受四个固定服务标识', () => {
    expect(opsServiceIdSchema.options).toEqual(['web', 'api', 'worker', 'infra'])
    expect(opsServiceIdSchema.safeParse('postgres').success).toBe(false)
  })

  it('拒绝任意命令、任意服务名和额外字段', () => {
    expect(opsControlCommandSchema.safeParse({
      type: 'service_action',
      requestId: 'request_1',
      csrfToken: 'csrf',
      serviceId: 'database',
      action: 'restart',
    }).success).toBe(false)
    expect(opsControlCommandSchema.safeParse({
      type: 'terminal_create',
      requestId: 'request_2',
      csrfToken: 'csrf',
      label: '终端',
      cols: 120,
      rows: 32,
      command: 'rm -rf /',
    }).success).toBe(false)
  })
})

describe('Gateway 到 Broker 的签名', () => {
  it('绑定 method、path、body，并拒绝 nonce 重放', () => {
    const secret = 'broker-test-secret-that-is-long-enough'
    const body = Buffer.from('{"terminalId":"terminal_1"}', 'utf8')
    const signed = signBrokerRequest({ method: 'POST', pathAndQuery: '/internal/v1/sessions', body, secret, now: 10_000 })
    const headers = new Headers()
    applyBrokerSignature(headers, signed)
    const nonces = new BrokerNonceCache()
    const request = { method: 'POST', pathAndQuery: '/internal/v1/sessions', body, secret, headers, nonces, now: 10_000 }
    expect(verifyBrokerRequest(request)).toBe(true)
    expect(verifyBrokerRequest(request)).toBe(false)
    expect(verifyBrokerRequest({ ...request, body: Buffer.from('{}'), nonces: new BrokerNonceCache() })).toBe(false)
    expect(verifyBrokerRequest({ ...request, pathAndQuery: '/internal/v1/info', nonces: new BrokerNonceCache() })).toBe(false)
  })
})

describe('Broker 环境隔离', () => {
  it('进程入口删除数据库、模型与会话秘密，PTY 只获得白名单', () => {
    const processEnvironment: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\ops',
      DATABASE_URL: 'postgresql://secret',
      DEEPSEEK_API_KEY: 'model-secret',
      BETTER_AUTH_SECRET: 'session-secret',
      OPS_BROKER_SHARED_SECRET: 'broker-secret-that-is-long-enough',
      OPS_WORKSPACE_ROOT: 'workspace',
    }
    sanitizeBrokerProcessEnvironment(processEnvironment)
    expect(processEnvironment.DATABASE_URL).toBeUndefined()
    expect(processEnvironment.DEEPSEEK_API_KEY).toBeUndefined()
    expect(processEnvironment.BETTER_AUTH_SECRET).toBeUndefined()
    expect(processEnvironment.OPS_BROKER_SHARED_SECRET).toBeDefined()

    const terminalEnvironment = buildTerminalEnvironment(processEnvironment)
    expect(terminalEnvironment.PATH).toBe('C:\\Windows\\System32')
    expect(terminalEnvironment.OPS_BROKER_SHARED_SECRET).toBeUndefined()
    expect(terminalEnvironment.TERM).toBe('xterm-256color')
  })
})

describe('运维生产配置', () => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const productionGatewayEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    OPS_EXPECTED_SERVICE_USER: os.userInfo().username,
    OPS_GATEWAY_HOST: '127.0.0.1',
    OPS_PUBLIC_BASE_URL: 'https://ops.example.test',
    OPS_ALLOWED_ORIGINS: 'https://ops.example.test',
    OPS_STATIC_ROOT: 'apps/operations/dist',
    OPS_BROKER_URL: 'http://127.0.0.1:8021',
    OPS_BROKER_SHARED_SECRET: 'broker-secret-32-bytes-minimum-value-a',
    OPS_RECOVERY_SECRET: 'recovery-secret-32-bytes-minimum-value-b',
    OPS_MASTER_KEYRING_FILE: 'runtime/ops/keyring.json',
    OPS_ACTIVE_KEY_ID: 'key-1',
    PROCESS_COMPOSE_URL: 'http://127.0.0.1:8080',
    PROCESS_COMPOSE_TOKEN_FILE: 'runtime/ops/process-compose.token',
    DATABASE_URL: 'postgresql://db.example.test/geoforge',
    RUNTIME_ROOT: 'runtime',
    BETTER_AUTH_SECRET: 'better-auth-secret-32-bytes-minimum-c',
  }

  it('生产环境拒绝依赖默认路径、非 HTTPS 入口和非回环控制端口', () => {
    const missingStaticRoot = { ...productionGatewayEnvironment }
    delete missingStaticRoot.OPS_STATIC_ROOT
    expect(() => parseOpsGatewayEnvironment(missingStaticRoot, projectRoot)).toThrow('OPS_STATIC_ROOT')
    expect(() => parseOpsGatewayEnvironment({
      ...productionGatewayEnvironment,
      OPS_PUBLIC_BASE_URL: 'http://ops.example.test',
    }, projectRoot)).toThrow('必须使用 HTTPS')
    expect(() => parseOpsGatewayEnvironment({
      ...productionGatewayEnvironment,
      PROCESS_COMPOSE_URL: 'http://10.0.0.5:8080',
    }, projectRoot)).toThrow('必须绑定回环地址')
  })

  it('生产环境拒绝占位密钥，并要求 Broker 使用独立账户和显式路径', () => {
    expect(() => parseOpsGatewayEnvironment({
      ...productionGatewayEnvironment,
      OPS_RECOVERY_SECRET: 'replace-with-at-least-32-random-characters',
    }, projectRoot)).toThrow('仍是占位值')
    const shellField = process.platform === 'win32' ? 'OPS_WINDOWS_SHELL' : 'OPS_LINUX_SHELL'
    const brokerEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      OPS_EXPECTED_SERVICE_USER: os.userInfo().username,
      OPS_BROKER_HOST: '127.0.0.1',
      OPS_BROKER_SHARED_SECRET: 'broker-secret-32-bytes-minimum-value-a',
      OPS_TERMINAL_SPOOL_ROOT: 'runtime/ops/spool',
      OPS_WORKSPACE_ROOT: '.',
      [shellField]: process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash',
    }
    expect(parseTerminalBrokerEnvironment(brokerEnvironment, projectRoot).workspaceRoot).toBe(projectRoot)
    delete brokerEnvironment.OPS_TERMINAL_SPOOL_ROOT
    expect(() => parseTerminalBrokerEnvironment(brokerEnvironment, projectRoot)).toThrow('OPS_TERMINAL_SPOOL_ROOT')
  })
})

describe('短期恢复与二次验证窗口', () => {
  it('用途隔离、签名防篡改并在 15 分钟后失效', () => {
    const codec = new OpsSessionWindowCodec('recovery-secret-that-is-at-least-32-bytes', false)
    const issued = codec.issueRecovery(ADMIN, 1_000)
    const cookie = issued.cookie
    expect(codec.readRecoveryCookie(cookie, 2_000)?.userId).toBe(ADMIN.userId)
    expect(codec.readStepUpCookie(cookie, 2_000)).toBeNull()
    expect(codec.verify(`${issued.token.slice(0, -1)}x`, 2_000)).toBeNull()
    expect(codec.readRecoveryCookie(cookie, 1_000 + 15 * 60 * 1_000 + 1)).toBeNull()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })
})

describe('运维身份权限矩阵', () => {
  function createAuthenticator(authenticateRequest: (request: Request) => Promise<AuthContext | null>) {
    const audit = { recordEvent: vi.fn().mockResolvedValue(undefined) }
    const auth = { authenticateRequest } as unknown as BetterAuthService
    return {
      authenticator: new OpsAuthenticator({
        auth,
        audit: audit as unknown as OpsAuditService,
        recoverySecret: 'recovery-secret-that-is-at-least-32-bytes',
        secureCookies: true,
        trustedOrigins: new Set(['https://ops.example.com']),
        csrfHeaderName: 'x-geoforge-csrf',
      }),
      audit,
    }
  }

  it('允许 platform_admin，拒绝分析员并记录拒绝审计', async () => {
    const admin = createAuthenticator(async () => ADMIN)
    const request = new Request('https://ops.example.com/ops/api/v1/bootstrap', {
      headers: { origin: 'https://ops.example.com' },
    })
    expect((await admin.authenticator.authenticate(request)).userId).toBe(ADMIN.userId)

    const analyst = createAuthenticator(async () => ANALYST)
    await expect(analyst.authenticator.authenticate(request)).rejects.toMatchObject<Partial<OpsError>>({ status: 403 })
    expect(analyst.audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }))
  })

  it('来源和 CSRF 必须同时匹配', () => {
    const { authenticator } = createAuthenticator(async () => ADMIN)
    expect(() => authenticator.requireTrustedRequest(new Request('https://ops.example.com', {
      headers: { origin: 'https://evil.example.com' },
    }))).toThrow('请求来源不受信任')
    expect(() => authenticator.requireCsrf(new Request('https://ops.example.com'), {
      userId: ADMIN.userId,
      email: ADMIN.email,
      displayName: ADMIN.displayName,
      csrfToken: ADMIN.csrfToken,
      recoveryMode: false,
      auth: ADMIN,
    })).toThrow('CSRF 校验失败')
  })

  it('只有连接级数据库故障才启用已签发恢复窗口', async () => {
    const unavailable = createAuthenticator(async () => {
      throw Object.assign(new Error('database offline'), { code: 'ECONNREFUSED' })
    })
    const recovery = unavailable.authenticator.windows.issueRecovery(ADMIN)
    const request = new Request('https://ops.example.com/ops/api/v1/bootstrap', {
      headers: {
        origin: 'https://ops.example.com',
        cookie: recovery.cookie.split(';')[0] ?? '',
      },
    })
    expect((await unavailable.authenticator.authenticate(request, true)).recoveryMode).toBe(true)

    const programmingError = createAuthenticator(async () => { throw new Error('schema mismatch') })
    await expect(programmingError.authenticator.authenticate(request, true)).rejects.toThrow('schema mismatch')
    expect(isDatabaseUnavailable({ code: '23505' })).toBe(false)
    expect(isDatabaseUnavailable(new DatabaseUnavailableError({ code: 'ECONNREFUSED' }))).toBe(true)
    expect(isDatabaseUnavailable(new AggregateError([{ code: '57P01' }], 'pool unavailable'))).toBe(true)
  })
})

describe('数据库故障期间的审计缓冲', () => {
  it('仅缓冲连接故障并在恢复后保持顺序补写', async () => {
    const recorded: string[] = []
    let offline = true
    const store = {
      recordEvent: vi.fn(async (event: { action: string }) => {
        if (offline) throw Object.assign(new Error('offline'), { code: '08006' })
        recorded.push(event.action)
      }),
    } as unknown as AuditStore
    const service = new OpsAuditService(store)
    const event = {
      actorUserId: ADMIN.userId,
      workspaceId: null,
      action: 'ops.service.restart',
      objectType: 'operations_service',
      objectId: 'api',
      outcome: 'allowed' as const,
      metadata: {},
    }
    await service.recordEvent(event)
    expect(service.pendingCount()).toBe(1)
    offline = false
    await service.flush()
    expect(recorded).toEqual(['ops.service.restart'])
    expect(service.pendingCount()).toBe(0)
  })

  it('不把约束或代码错误伪装成离线审计成功', async () => {
    const store = { recordEvent: vi.fn(async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }) }) } as unknown as AuditStore
    const service = new OpsAuditService(store)
    await expect(service.recordEvent({
      actorUserId: null,
      workspaceId: null,
      action: 'ops.test',
      objectType: 'operations_gateway',
      objectId: null,
      outcome: 'error',
      metadata: {},
    })).rejects.toThrow('duplicate')
    expect(service.pendingCount()).toBe(0)
  })
})
