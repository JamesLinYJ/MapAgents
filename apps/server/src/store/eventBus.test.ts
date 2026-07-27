import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from './eventBus.js'

describe('InMemoryEventBus', () => {
  it('isolates subscriber failures and continues delivering to other subscribers', () => {
    const bus = new InMemoryEventBus<string>()
    const healthy = vi.fn()
    bus.subscribe('run-1', () => { throw new Error('subscriber failed') })
    bus.subscribe('run-1', healthy)

    expect(() => bus.publish('run-1', 'event')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith('event')
  })

  it('releases subscriber sets after the final unsubscribe', () => {
    const bus = new InMemoryEventBus<string>()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe('run-1', listener)

    unsubscribe()
    bus.publish('run-1', 'event')

    expect(listener).not.toHaveBeenCalled()
  })
})
