// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 监督日志缓冲测试
//
//   文件:       logBuffer.test.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { LineDecoder, OperationsLogBuffer } from './logBuffer.js'

describe('OperationsLogBuffer', () => {
  it('redacts secrets before storage and IPC retrieval', () => {
    const buffer = new OperationsLogBuffer(['highly-secret-value'])
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'token=highly-secret-value' })

    expect(buffer.tail(['api'], 1)[0]?.message).toBe('token=[REDACTED]')
  })

  it('enforces both entry and byte budgets', () => {
    const buffer = new OperationsLogBuffer([], 2, 10)
    buffer.append({ serviceId: 'api', stream: 'stdout', message: '12345' })
    buffer.append({ serviceId: 'api', stream: 'stdout', message: '67890' })
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'abcde' })

    expect(buffer.tail(['api'], 10).map(entry => entry.message)).toEqual(['67890', 'abcde'])
  })

  it('decodes split UTF-8 Chinese output without replacement corruption', () => {
    const decoder = new LineDecoder()
    const bytes = Buffer.from('杭州就绪\n下一行', 'utf8')
    const split = bytes.indexOf(Buffer.from('州')) + 1

    expect(decoder.push(bytes.subarray(0, split))).toEqual([])
    expect(decoder.push(bytes.subarray(split))).toEqual(['杭州就绪'])
    expect(decoder.finish()).toEqual(['下一行'])
  })

  it('derives severity from content and strips terminal control sequences', () => {
    const buffer = new OperationsLogBuffer([])
    buffer.append({ serviceId: 'worker', stream: 'stderr', message: '\u001b[32mINFO\u001b[0m: 服务就绪' })

    expect(buffer.tail(['worker'], 1)[0]).toMatchObject({
      stream: 'stderr',
      level: 'info',
      message: 'INFO: 服务就绪',
    })
  })
})
