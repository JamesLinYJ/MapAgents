// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 监督日志缓冲测试
//
//   文件:       logBuffer.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
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

  it('projects Pino JSON and native component prefixes into structured fields', () => {
    const buffer = new OperationsLogBuffer([])
    buffer.append({
      serviceId: 'api',
      stream: 'stdout',
      message: JSON.stringify({
        level: 40,
        time: '2026-07-29T06:00:00.000Z',
        pid: 8123,
        name: 'http',
        msg: '请求等待时间过长',
      }),
    })
    buffer.append({
      serviceId: 'infra',
      stream: 'stdout',
      processId: 9000,
      message: '[postgresql] database system is ready',
    })

    expect(buffer.tail(['api'], 1)[0]).toMatchObject({
      component: 'http',
      processId: 8123,
      level: 'warn',
      message: '请求等待时间过长',
      createdAt: '2026-07-29T06:00:00.000Z',
    })
    expect(buffer.tail(['infra'], 1)[0]).toMatchObject({
      component: 'postgresql',
      processId: 9000,
      message: 'database system is ready',
    })
  })

  it('filters logs by service, level, stream, text and sequence without arbitrary paths', () => {
    const buffer = new OperationsLogBuffer([])
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'INFO API ready' })
    const warning = buffer.append({ serviceId: 'worker', stream: 'stderr', message: 'WARNING 杭州数据延迟' })
    buffer.append({ serviceId: null, stream: 'supervisor', message: '监督器状态变化' })

    expect(buffer.query({
      services: ['worker'],
      levels: ['warn'],
      streams: ['stderr'],
      search: '杭州',
      includeSupervisor: false,
      afterSequence: warning.sequence - 1,
      tail: 20,
    })).toEqual([warning])
    expect(buffer.query({
      services: ['api'],
      levels: [],
      streams: [],
      search: '',
      includeSupervisor: true,
      afterSequence: null,
      tail: 20,
    }).map(entry => entry.serviceId)).toEqual(['api', null])
  })
})
