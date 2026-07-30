// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久化领域错误
//
//   文件:       storeErrors.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreNotFoundError'
  }
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreConflictError'
  }
}

export class MemoryVersionConflictError extends StoreConflictError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(`memory 版本冲突：期望 ${expectedVersion}，当前 ${currentVersion}`)
    this.name = 'MemoryVersionConflictError'
  }
}
