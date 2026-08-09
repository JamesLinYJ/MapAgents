// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 凭据边界
//
//   文件:       customProviderCredentials.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'

import type { AuthContext } from '../security/types.js'
import type { EncryptedProviderCredential } from '../store/postgres/customProviderStore.js'

const CREDENTIAL_KEY_VERSION = 'aes-256-gcm-v1'
const HANDLE_TTL_MS = 5 * 60 * 1_000
const MAX_STAGED_CREDENTIALS = 128

export class ProviderCredentialCipher {
  private readonly key: Buffer

  constructor(serverSecret: string) {
    if (Buffer.byteLength(serverSecret, 'utf8') < 32) {
      throw new Error('Provider 凭据加密根密钥至少需要 32 字节。')
    }
    this.key = Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(serverSecret, 'utf8'),
      Buffer.from('geo-agent-platform/provider-credentials/v1', 'utf8'),
      Buffer.from('model-provider-api-key', 'utf8'),
      32,
    ))
  }

  encrypt(providerId: string, plaintext: string): EncryptedProviderCredential {
    if (!plaintext) throw new Error('不能加密空的 Provider 凭据。')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(credentialAad(providerId))
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: CREDENTIAL_KEY_VERSION,
    }
  }

  decrypt(providerId: string, encrypted: EncryptedProviderCredential): string {
    if (encrypted.keyVersion !== CREDENTIAL_KEY_VERSION) {
      throw new Error(`不支持 Provider 凭据密钥版本 '${encrypted.keyVersion}'。`)
    }
    const iv = decodeSizedBase64(encrypted.iv, 12, 'IV')
    const authTag = decodeSizedBase64(encrypted.authTag, 16, '认证标签')
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAAD(credentialAad(providerId))
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
}

interface StagedCredential {
  secret: string
  userId: string
  authSessionId: string
  expiresAtMs: number
}

export class ProviderCredentialStagingService {
  private readonly staged = new Map<string, StagedCredential>()

  stage(secret: string, auth: AuthContext, nowMs = Date.now()): { credentialHandle: string; expiresAt: string } {
    if (!secret.trim()) throw new Error('Provider 凭据不能为空。')
    this.prune(nowMs)
    while (this.staged.size >= MAX_STAGED_CREDENTIALS) {
      const oldest = this.staged.keys().next().value as string | undefined
      if (!oldest) break
      this.staged.delete(oldest)
    }
    const credentialHandle = `provider_credential_${randomUUID()}`
    const expiresAtMs = nowMs + HANDLE_TTL_MS
    this.staged.set(credentialHandle, {
      secret,
      userId: auth.userId,
      authSessionId: auth.authSessionId,
      expiresAtMs,
    })
    return { credentialHandle, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  resolve(credentialHandle: string, auth: AuthContext, nowMs = Date.now()): string {
    this.prune(nowMs)
    const staged = this.staged.get(credentialHandle)
    if (!staged) throw new Error('Provider 凭据句柄不存在或已经过期，请重新输入。')
    if (staged.userId !== auth.userId || staged.authSessionId !== auth.authSessionId) {
      throw new Error('Provider 凭据句柄不属于当前登录会话。')
    }
    return staged.secret
  }

  consume(credentialHandle: string, auth: AuthContext, nowMs = Date.now()): void {
    this.resolve(credentialHandle, auth, nowMs)
    this.staged.delete(credentialHandle)
  }

  private prune(nowMs: number): void {
    for (const [handle, staged] of this.staged) {
      if (staged.expiresAtMs <= nowMs) this.staged.delete(handle)
    }
  }
}

function credentialAad(providerId: string): Buffer {
  return Buffer.from(`geo-agent-platform:model-provider:${providerId}`, 'utf8')
}

function decodeSizedBase64(value: string, expectedBytes: number, label: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength !== expectedBytes) throw new Error(`Provider 凭据${label}长度无效。`)
  return decoded
}
