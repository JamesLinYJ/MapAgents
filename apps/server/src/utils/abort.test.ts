import { describe, expect, it } from 'vitest'

import { abortSignalWithTimeout } from './abort.js'

describe('abortSignalWithTimeout', () => {
  it('propagates the caller cancellation reason', () => {
    const controller = new AbortController()
    const signal = abortSignalWithTimeout(controller.signal, 60_000)

    controller.abort('user_cancelled')

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('user_cancelled')
  })
})
