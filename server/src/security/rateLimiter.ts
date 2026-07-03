// +-------------------------------------------------------------------------
//
//   地理智能平台 - 滑动窗口限流
//
//   文件:       rateLimiter.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

/** 单进程令牌桶限流器。生产多实例部署时应替换为共享计数后端。 */
export class SlidingWindowRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>()

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
  ) {}

  /** 消费一个令牌。返回 true 表示允许，false 表示触发限流。 */
  consume(key: string): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key)

    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now })
      this.prune()
      return true
    }

    const elapsed = now - bucket.lastRefill
    if (elapsed >= this.windowMs) {
      bucket.tokens = this.maxTokens - 1
      bucket.lastRefill = now
      this.prune()
      return true
    }

    const refill = (elapsed / this.windowMs) * this.maxTokens
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill)
    bucket.lastRefill = now

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** 返回 key 还剩多少 token */
  remaining(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return this.maxTokens
    return Math.floor(bucket.tokens)
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs * 2
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key)
    }
  }
}

/** HTTP 限流工厂：按 IP 和 IP+邮箱 的默认窗口。 */
export function createAuthRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(10, 60_000) // 10 req/min
}

export function createApiRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(120, 60_000) // 120 req/min
}

/** 从 Request 提取客户端 IP */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  try {
    const url = new URL(request.url)
    return url.hostname
  } catch {
    return '127.0.0.1'
  }
}

/** WS 消息限流器：按连接总量和同一连接的命令类型分别限流。 */
export class WsMessageRateLimiter {
  private connectionLimiter: SlidingWindowRateLimiter
  private commandLimiters = new Map<string, SlidingWindowRateLimiter>()

  constructor(
    private readonly maxPerConnectionPerWindow: number = 60,
    private readonly windowMs: number = 60_000,
    private readonly maxPerCommandTypePerWindow: number = 20,
  ) {
    this.connectionLimiter = new SlidingWindowRateLimiter(maxPerConnectionPerWindow, windowMs)
  }

  /** 对指定连接的指定命令类型消费令牌。返回 true 表示允许。 */
  consume(connectionId: string, commandType: string): boolean {
    if (!this.connectionLimiter.consume(connectionId)) return false

    let cmdLimiter = this.commandLimiters.get(commandType)
    if (!cmdLimiter) {
      cmdLimiter = new SlidingWindowRateLimiter(this.maxPerCommandTypePerWindow, this.windowMs)
      this.commandLimiters.set(commandType, cmdLimiter)
    }
    return cmdLimiter.consume(connectionId)
  }
}
