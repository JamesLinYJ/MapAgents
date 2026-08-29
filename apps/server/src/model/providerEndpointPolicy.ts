// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider SSRF 防护
//
//   文件:       providerEndpointPolicy.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { lookup as systemLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { CustomProviderConfig } from '@geo-agent-platform/shared-types'

import type {
  DnsAddressResolver,
  DnsResolvedAddress,
} from './providers/openaiTransport.js'

type NetworkAccess = CustomProviderConfig['networkAccess']

export interface ProviderEndpointPolicyDependencies {
  lookup?: typeof systemLookup
}

export function assertCustomProviderBaseUrl(baseUrl: string, networkAccess: NetworkAccess): URL {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('自定义 Provider Base URL 无效。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`自定义 Provider 不支持协议 '${url.protocol}'。`)
  }
  if (url.username || url.password) throw new Error('自定义 Provider Base URL 不能包含用户凭据。')
  if (url.search || url.hash) throw new Error('自定义 Provider Base URL 不能包含查询参数或片段。')

  const hostname = normalizeHostname(url.hostname)
  if (networkAccess === 'public') {
    if (url.protocol !== 'https:') throw new Error('公网自定义 Provider 必须使用 HTTPS。')
    if (isLocalHostname(hostname)) throw new Error('公网自定义 Provider 不能指向本机或内部域名。')
    if (isIP(hostname) && !isPublicAddress(hostname)) {
      throw new Error(`公网自定义 Provider 不能指向非公网地址 '${hostname}'。`)
    }
  } else if (!isLoopbackHostname(hostname) && !(isIP(hostname) && isLoopbackAddress(hostname))) {
    throw new Error('本机 Provider 只允许 localhost、127.0.0.0/8 或 ::1。')
  }
  return url
}

export function createGuardedProviderDnsResolver(
  networkAccess: NetworkAccess,
  dependencies: ProviderEndpointPolicyDependencies = {},
): DnsAddressResolver {
  const lookup = dependencies.lookup ?? systemLookup
  return async (hostname, family) => {
    const normalized = normalizeHostname(hostname)
    const literalFamily = isIP(normalized)
    const addresses: DnsResolvedAddress[] = literalFamily
      ? [{ address: normalized, family: literalFamily as 4 | 6 }]
      : (await lookup(normalized, {
          all: true,
          verbatim: true,
          family: family === 4 || family === 6 ? family : 0,
        })).map(result => ({ address: result.address, family: result.family }))
    if (!addresses.length) throw new Error(`自定义 Provider 域名 '${normalized}' 没有可用地址。`)

    for (const address of addresses) {
      const allowed = networkAccess === 'public'
        ? isAllowedPublicProviderDnsAddress(normalized, address.address)
        : isLoopbackAddress(address.address)
      if (!allowed) {
        throw new Error(
          networkAccess === 'public'
            ? `自定义 Provider 域名 '${normalized}' 解析到了非公网地址 '${address.address}'。`
            : `本机 Provider 域名 '${normalized}' 解析到了非回环地址 '${address.address}'。`,
        )
      }
    }
    return addresses
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return Number(address.split('.')[0]) === 127
  if (family === 6) return normalizeIpv6(address) === '::1'
  return false
}

/**
 * 透明代理常把公网域名解析到 RFC 2544 基准测试网段，再在本机接管连接。
 * 仅当请求目标仍是域名时放行 198.18.0.0/15，TLS 主机名校验和真实连通性验证保持不变；
 * 用户直接填写该网段的 IP、内网地址和后续 DNS 重绑定结果仍会被拒绝。
 */
export function isAllowedPublicProviderDnsAddress(hostname: string, address: string): boolean {
  return isPublicAddress(address)
    || (isIP(normalizeHostname(hostname)) === 0 && isProxySyntheticIpv4Address(address))
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  const [a = -1, b = -1, c = -1] = octets
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function isProxySyntheticIpv4Address(address: string): boolean {
  if (isIP(address) !== 4) return false
  const octets = address.split('.').map(Number)
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)
}

function isPublicIpv6(address: string): boolean {
  const normalized = normalizeIpv6(address)
  if (normalized === '::' || normalized === '::1') return false
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
  if (/^fe[89ab]/u.test(normalized)) return false
  if (normalized.startsWith('ff')) return false
  if (normalized.startsWith('2001:db8')) return false
  // 当前只允许 RFC 4291 全局单播 2000::/3；未明确分类的地址按拒绝处理。
  return normalized.startsWith('2') || normalized.startsWith('3')
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/gu, '').split('%', 1)[0] ?? ''
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

function isLocalHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname)
    || ['.local', '.internal', '.home', '.lan', '.test', '.invalid', '.example', '.onion']
      .some(suffix => hostname.endsWith(suffix))
}
