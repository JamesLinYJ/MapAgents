// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 加密认证存储测试
//
//   文件:       secureAuthStorage.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const values = new Map<string, string>()
const decryptString = vi.fn<(value: Buffer) => string>()
const encryptString = vi.fn<(value: string) => Buffer>()

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString,
    encryptString,
  },
}))

vi.mock('conf', () => ({
  default: class {
    get(name: string) {
      return values.get(name)
    }

    set(name: string, value: string) {
      values.set(name, value)
    }

    delete(name: string) {
      values.delete(name)
    }
  },
}))

const { SecureAuthStorage } = await import('./secureAuthStorage.js')

describe('SecureAuthStorage', () => {
  beforeEach(() => {
    values.clear()
    decryptString.mockReset()
    encryptString.mockReset()
  })

  it('encrypts and decrypts Better Auth values without plaintext persistence', () => {
    encryptString.mockReturnValue(Buffer.from('ciphertext'))
    decryptString.mockReturnValue(JSON.stringify({ session: 'session_1' }))
    const storage = new SecureAuthStorage()

    storage.setItem('cookie', { session: 'session_1' })

    expect(values.get('cookie')).toBe(Buffer.from('ciphertext').toString('base64'))
    expect(values.get('cookie')).not.toContain('session_1')
    expect(storage.getItem('cookie')).toEqual({ session: 'session_1' })
  })

  it('removes ciphertext that the current operating-system identity cannot decrypt', () => {
    values.set('cookie', Buffer.from('old-identity-cipher').toString('base64'))
    decryptString.mockImplementation(() => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    })
    const storage = new SecureAuthStorage()

    expect(storage.getItem('cookie')).toBeNull()
    expect(values.has('cookie')).toBe(false)
  })

  it('removes decrypted payloads that are not valid Better Auth JSON', () => {
    values.set('cookie', Buffer.from('ciphertext').toString('base64'))
    decryptString.mockReturnValue('{not-json')
    const storage = new SecureAuthStorage()

    expect(storage.getItem('cookie')).toBeNull()
    expect(values.has('cookie')).toBe(false)
  })
})
