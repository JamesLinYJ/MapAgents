import { describe, expect, it, vi } from 'vitest'

import {
  assertCustomProviderBaseUrl,
  createGuardedProviderDnsResolver,
  isAllowedPublicProviderDnsAddress,
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

  it('allows proxy synthetic DNS answers for HTTPS hostnames without accepting the range as public', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '198.18.2.163', family: 4 },
      { address: '198.19.255.254', family: 4 },
    ])
    const resolver = createGuardedProviderDnsResolver('public', { lookup: lookup as never })

    await expect(resolver('api.deepseek.com', 0)).resolves.toEqual([
      { address: '198.18.2.163', family: 4 },
      { address: '198.19.255.254', family: 4 },
    ])
    expect(isPublicAddress('198.18.2.163')).toBe(false)
    expect(isAllowedPublicProviderDnsAddress('api.deepseek.com', '198.18.2.163')).toBe(true)
  })

  it('keeps literal proxy addresses and real private DNS answers blocked', async () => {
    expect(() => assertCustomProviderBaseUrl('https://198.18.2.163/v1', 'public')).toThrow('非公网')
    expect(isAllowedPublicProviderDnsAddress('198.18.2.163', '198.18.2.163')).toBe(false)
    expect(isAllowedPublicProviderDnsAddress('api.provider.com', '10.0.0.8')).toBe(false)
    expect(isAllowedPublicProviderDnsAddress('api.provider.com', '169.254.169.254')).toBe(false)
  })

  it('classifies reserved ranges conservatively', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('203.0.113.10')).toBe(false)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicAddress('fd00::1')).toBe(false)
  })
})
