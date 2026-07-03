// +-------------------------------------------------------------------------
//
//   地理智能平台 - Turn Runner（模型流 → ConversationItem）
//
//   文件:       turnRunner.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { RunEvent } from '../schemas/types.js'
import type { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'

type AppendEvent = (event: RunEvent) => void | Promise<void>

export class RunEventSink {
  private pendingWrites: Promise<void>[] = []

  constructor(
    private appendEvent: AppendEvent,
    private runId: string,
    private threadId: string | null,
  ) {}

  emit(type: RunEvent['type'], message: string, payload: Record<string, unknown> = {}): RunEvent {
    const event: RunEvent = {
      eventId: makeId('evt'),
      runId: this.runId,
      threadId: this.threadId,
      type,
      message,
      timestamp: nowUtc(),
      payload,
    }
    const persisted = this.appendEvent(event)
    if (persisted && typeof persisted.then === 'function') this.pendingWrites.push(persisted)
    return event
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.length) {
      const pending = this.pendingWrites.splice(0)
      await Promise.all(pending)
    }
  }
}

// TurnFinalizer
//
// 运行终止协调：写入最终状态、发射终端事件。
export class TurnFinalizer {
  constructor(
    private eventSink: RunEventSink,
    private itemSink: ItemSink,
    private onComplete: (status: string) => Promise<unknown>,
  ) {}

  async complete(todos: unknown[] = []): Promise<void> {
    this.eventSink.emit('run.completed', '运行完成', { todos })
    this.itemSink.appendResult('success', { todos })
    await this.eventSink.flush()
    await this.itemSink.flush()
    await this.onComplete('completed')
  }

  async fail(error: string, errors: string[] = []): Promise<void> {
    const allErrors = errors.length ? errors : [error]
    this.eventSink.emit('run.failed', '运行失败', { errors: allErrors, message: error })
    this.itemSink.appendResult('failed', { errors: allErrors, message: error })
    await this.eventSink.flush()
    await this.itemSink.flush()
    await this.onComplete('failed')
  }

  async cancel(message = '运行已中断'): Promise<void> {
    this.eventSink.emit('run.failed', message, { cancelled: true, message })
    this.itemSink.appendResult('cancelled', { message })
    await this.eventSink.flush()
    await this.itemSink.flush()
    await this.onComplete('cancelled')
  }
}
