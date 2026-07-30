// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 加密认证存储
//
//   文件:       secureAuthStorage.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Storage } from '@better-auth/electron/client'
import { safeStorage } from 'electron'
import Conf from 'conf'
import { z } from 'zod'

const storedCipherSchema = z.string().min(1)

/**
 * Better Auth 官方 Electron 客户端只要求同步 Storage 契约。这里用 Conf 管理
 * 生命周期，用 Electron safeStorage 加密每个值；系统加密不可用时硬失败。
 */
export class SecureAuthStorage implements Storage {
  private readonly store = new Conf<Record<string, string>>({
    projectName: 'GeoForge',
    configName: 'desktop-auth',
    clearInvalidConfig: false,
  })

  constructor() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，GeoForge 不会把认证会话降级为明文保存。')
    }
  }

  getItem(name: string): unknown | null {
    const encrypted = this.store.get(name)
    if (encrypted === undefined) return null
    try {
      const cipher = Buffer.from(storedCipherSchema.parse(encrypted), 'base64')
      const plaintext = safeStorage.decryptString(cipher)
      return JSON.parse(plaintext) as unknown
    } catch {
      /*
       * Better Auth 会话是可重新建立的本地缓存，不是身份事实源。Windows 账户、
       * Chromium 配置或系统密钥发生变化后，旧密文必须按单项失效处理；继续
       * 抛错会让本机自动认证永久卡在启动页，而返回明文或保留坏值都不安全。
       */
      this.store.delete(name)
      return null
    }
  }

  setItem(name: string, value: unknown): void {
    const plaintext = JSON.stringify(value)
    const encrypted = safeStorage.encryptString(plaintext).toString('base64')
    this.store.set(name, encrypted)
  }
}
