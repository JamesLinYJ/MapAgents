import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const testTarget = path.join('runtime', 'atomic-write.json')

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function installFsMock(renameMock: ReturnType<typeof vi.fn>) {
  const handle = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const rmMock = vi.fn().mockResolvedValue(undefined)
  vi.doMock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(handle),
    readFile: vi.fn(),
    readdir: vi.fn(),
    rename: renameMock,
    rm: rmMock,
  }))
  vi.doMock('node:timers/promises', () => ({
    setTimeout: vi.fn().mockResolvedValue(undefined),
  }))
  return { handle, rmMock }
}

describe('fileConversationIo atomic writes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('node:fs/promises')
    vi.doUnmock('node:timers/promises')
  })

  it('retries transient Windows atomic replace locks', async () => {
    const renameMock = vi.fn()
      .mockRejectedValueOnce(errno('EPERM'))
      .mockResolvedValueOnce(undefined)
    const { handle, rmMock } = installFsMock(renameMock)
    const { atomicWriteText } = await import('./fileConversationIo.js')

    await atomicWriteText(testTarget, '{}')

    expect(handle.writeFile).toHaveBeenCalledWith('{}', 'utf8')
    expect(handle.sync).toHaveBeenCalledTimes(1)
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(renameMock).toHaveBeenCalledTimes(2)
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('cleans temporary files when atomic replace cannot be retried', async () => {
    const renameMock = vi.fn().mockRejectedValueOnce(errno('ENOENT'))
    const { rmMock } = installFsMock(renameMock)
    const { atomicWriteText } = await import('./fileConversationIo.js')

    await expect(atomicWriteText(testTarget, '{}')).rejects.toThrow('ENOENT')

    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it('round-trips safe history cursors', async () => {
    const { decodeCursor, encodeCursor } = await import('./fileConversationIo.js')

    expect(decodeCursor(encodeCursor(42))).toBe(42)
  })

  it('rejects malformed and unsafe history cursors with a typed error', async () => {
    const { decodeCursor, InvalidHistoryCursorError } = await import('./fileConversationIo.js')
    const unsafeCursor = Buffer.from(JSON.stringify({ sequence: Number.MAX_SAFE_INTEGER + 1 }), 'utf8').toString('base64url')

    expect(() => decodeCursor('not-json')).toThrow(InvalidHistoryCursorError)
    expect(() => decodeCursor(unsafeCursor)).toThrow(InvalidHistoryCursorError)
  })
})
