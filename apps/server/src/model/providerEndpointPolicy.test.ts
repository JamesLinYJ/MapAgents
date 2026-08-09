import { describe, expect, it, vi } from 'vitest'

import {
  assertCustomProviderBaseUrl,
  createGuardedProviderDnsResolver,
  isPublicAddress,
} from './providerEndpointPolicy.js'

describe('custom Provider endpoint policy', () => {
  it('requires HTTPS and rejects literal private or metadata endpoints for public providers', () => {
    expect(() => assertCustomProviderBaseUrl('http://api.example.org/v1', 'public')).toThrow('HTTPS')
    expect(() => assertCustomProviderBaseUrl('https://127.0.0.1/v1', 'public')).toThrow('非公网')
    expect(() => assertCustomProviderBaseUrl('https://169.254.169.254/latest', 'public')).toThrow('非公网')
    expect(() => assertCustomProviderBaseUrl('https://localhost/v1', 'public')).toThrow('内部域名')
    expect(assertCustomProviderBaseUrl('https://api.provider.com/v1', 'public').hostname).toBe('api.provider.com')
  })

  it('limits local mode to explicit loopback endpoints', () => {
    expect(assertCustomProviderBaseUrl('http://localhost:11434/v1', 'loopback').port).toBe('11434')
    expect(assertCustomProviderBaseUrl('http://127.0.0.2:8000/v1', 'loopback').hostname).toBe('127.0.0.2')
    expect(() => assertCustomProviderBaseUrl('http://192.168.1.10/v1', 'loopback')).toThrow('只允许')
  })

  it('rechecks every DNS answer and blocks rebinding to a private address', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }])
    const resolver = createGuardedProviderDnsResolver('public', { lookup: lookup as never })

    await expect(resolver('api.provider.com', 0)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
    await expect(resolver('api.provider.com', 0)).rejects.toThrow('非公网地址')
  })

  it('classifies reserved ranges conservatively', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('203.0.113.10')).toBe(false)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicAddress('fd00::1')).toBe(false)
  })
})
