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
