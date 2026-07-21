// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Broker 内部请求认证
//
//   文件:       brokerAuthentication.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const SIGNATURE_TTL_MILLISECONDS = 60_000
const MAX_NONCES = 10_000

export interface BrokerSignatureHeaders {
  timestamp: string
  nonce: string
  signature: string
}

export class BrokerNonceCache {
  private readonly seen = new Map<string, number>()

  use(nonce: string, now = Date.now()): boolean {
    for (const [cached, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(cached)
    }
    if (this.seen.has(nonce)) return false
    if (this.seen.size >= MAX_NONCES) {
      const oldest = this.seen.keys().next().value
      if (typeof oldest === 'string') this.seen.delete(oldest)
    }
    this.seen.set(nonce, now + SIGNATURE_TTL_MILLISECONDS)
    return true
  }
}

export function signBrokerRequest(input: {
  method: string
  pathAndQuery: string
  body: Uint8Array
  secret: string
  now?: number
}): BrokerSignatureHeaders {
  const timestamp = String(input.now ?? Date.now())
  const nonce = randomBytes(18).toString('base64url')
  const signature = calculateSignature({ ...input, timestamp, nonce })
  return { timestamp, nonce, signature }
}

export function verifyBrokerRequest(input: {
  method: string
  pathAndQuery: string
  body: Uint8Array
  secret: string
  headers: Headers
  nonces: BrokerNonceCache
  now?: number
}): boolean {
  const timestamp = input.headers.get('x-geoforge-ops-timestamp')
  const nonce = input.headers.get('x-geoforge-ops-nonce')
  const signature = input.headers.get('x-geoforge-ops-signature')
  if (!timestamp || !nonce || !signature) return false
  const timestampNumber = Number(timestamp)
  const now = input.now ?? Date.now()
  if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber) > SIGNATURE_TTL_MILLISECONDS) return false
  const expected = calculateSignature({ ...input, timestamp, nonce })
  const actualBytes = Buffer.from(signature, 'base64url')
  const expectedBytes = Buffer.from(expected, 'base64url')
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) return false
  return input.nonces.use(nonce, now)
}

export function applyBrokerSignature(headers: Headers, signature: BrokerSignatureHeaders): void {
  headers.set('x-geoforge-ops-timestamp', signature.timestamp)
  headers.set('x-geoforge-ops-nonce', signature.nonce)
  headers.set('x-geoforge-ops-signature', signature.signature)
}

function calculateSignature(input: {
  method: string
  pathAndQuery: string
  body: Uint8Array
  secret: string
  timestamp: string
  nonce: string
}): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex')
  const canonical = [input.method.toUpperCase(), input.pathAndQuery, input.timestamp, input.nonce, bodyHash].join('\n')
  return createHmac('sha256', input.secret).update(canonical).digest('base64url')
}
