// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维监督运行时路径
//
//   文件:       paths.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

const execFileAsync = promisify(execFile)
const windowsAclSchema = z.object({
  protected: z.boolean(),
  currentSid: z.string().min(1),
  operatorSid: z.string().nullable(),
  rules: z.array(z.object({
    sid: z.string().min(1),
    type: z.enum(['Allow', 'Deny']),
    inherited: z.boolean(),
  }).strict()),
}).strict()

export interface OperationsPaths {
  projectRoot: string
  runtimeRoot: string
  operationsRoot: string
  workspaceId: string
  endpoint: string
  tokenFile: string
  rootSecretFile: string
  lockTarget: string
  leaseFile: string
}

export async function resolveOperationsPaths(input: {
  projectRoot: string
  runtimeRoot?: string
  tokenFile?: string
  rootSecretFile?: string
  profile: OperationsProfile
}): Promise<OperationsPaths> {
  if (!path.isAbsolute(input.projectRoot)) throw new Error('GEOFORGE_ROOT 必须是绝对路径。')
  const projectRoot = await realpath(input.projectRoot)
  const runtimeRoot = path.resolve(input.runtimeRoot ?? path.join(projectRoot, 'runtime'))
  const operationsRoot = path.join(runtimeRoot, 'ops')
  await mkdir(operationsRoot, { recursive: true })
  const workspaceId = createHash('sha256').update(`${projectRoot}\0${input.profile}`).digest('hex').slice(0, 24)
  return {
    projectRoot,
    runtimeRoot,
    operationsRoot,
    workspaceId,
    endpoint: process.platform === 'win32'
      ? `\\\\.\\pipe\\geoforge-operations-${workspaceId}`
      : path.join(operationsRoot, `supervisor-${workspaceId}.sock`),
    tokenFile: path.resolve(input.tokenFile ?? path.join(operationsRoot, 'supervisor.token')),
    rootSecretFile: path.resolve(input.rootSecretFile ?? path.join(operationsRoot, 'local-root.secret')),
    lockTarget: path.join(operationsRoot, `supervisor-${workspaceId}.lock-target`),
    leaseFile: path.join(operationsRoot, `supervisor-${workspaceId}.leases.json`),
  }
}

export async function ensureSecretFile(filePath: string, allowCreate: boolean): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error('密钥文件路径必须为绝对路径。')
  try {
    const value = (await readFile(filePath, 'utf8')).trim()
    if (value.length < 32) throw new Error('密钥文件内容长度不足。')
    if (process.platform === 'win32' && allowCreate) await protectWindowsSecret(filePath)
    return value
  } catch (error) {
    if (isMissing(error) && allowCreate) {
      await mkdir(path.dirname(filePath), { recursive: true })
      const value = randomBytes(32).toString('base64url')
      await writeFile(filePath, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      if (process.platform === 'win32') await protectWindowsSecret(filePath)
      else await chmod(filePath, 0o600)
      return value
    }
    if (isMissing(error)) throw new Error(`生产环境缺少受保护的密钥文件：${filePath}`)
    throw error
  }
}

export async function assertProductionSecretPermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    const acl = await readWindowsAcl(filePath)
    const allowed = new Set([
      acl.currentSid,
      acl.operatorSid,
      'S-1-5-18',
      'S-1-5-32-544',
    ].filter((value): value is string => Boolean(value)))
    if (!acl.protected || acl.rules.some(rule => rule.inherited || (rule.type === 'Allow' && !allowed.has(rule.sid)))) {
      throw new Error(`生产密钥文件 ACL 过宽：${filePath}`)
    }
    return
  }
  const details = await stat(filePath)
  if ((details.mode & 0o077) !== 0) throw new Error(`生产密钥文件权限过宽：${filePath}`)
}

async function protectWindowsSecret(filePath: string): Promise<void> {
  const identityResult = await execFileAsync('whoami', [], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  })
  const identity = z.string().trim().min(1).max(256).parse(identityResult.stdout)
  const options = { windowsHide: true, encoding: 'utf8' as const, timeout: 10_000 }
  // Set-Acl 会在部分 Windows 版本上连带写 SACL 并要求 SeSecurityPrivilege；
  // icacls 只重建 DACL，普通本机所有者可安全、幂等地执行。
  await execFileAsync('icacls', [filePath, '/reset'], options)
  await execFileAsync('icacls', [filePath, '/inheritance:r'], options)
  // Modify 仍只授予当前主体，同时保留密钥轮换与卸载所需的删除权。
  // 仅授予 R/W 会在移除继承后让 Windows 无法删除该文件。
  await execFileAsync('icacls', [filePath, '/grant:r', `${identity}:(M)`], options)
}

async function readWindowsAcl(filePath: string): Promise<z.infer<typeof windowsAclSchema>> {
  const script = [
    '$Target = $env:GEOFORGE_ACL_TARGET',
    '$acl = Get-Acl -LiteralPath $Target',
    '$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$operatorSid = $null',
    'if ($env:GEOFORGE_OPERATORS_PRINCIPAL) { try { $operatorSid = ([Security.Principal.NTAccount]::new($env:GEOFORGE_OPERATORS_PRINCIPAL)).Translate([Security.Principal.SecurityIdentifier]).Value } catch {} }',
    '$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited } })',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $currentSid; operatorSid = $operatorSid; rules = $rules } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')
  const { stdout } = await execFileAsync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, GEOFORGE_ACL_TARGET: filePath },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  })
  return windowsAclSchema.parse(JSON.parse(stdout))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
