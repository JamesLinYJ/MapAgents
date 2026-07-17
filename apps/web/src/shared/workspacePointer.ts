// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 URL 指针
//
//   文件:       workspacePointer.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface WorkspacePointer {
  activeSessionId?: string
  activeRunId?: string
  activeThreadId?: string
  sessionSource?: 'route' | 'query' | 'persisted'
}

const WORKSPACE_POINTER_KEY = 'geoforge.workspace.pointer.v1'

// URL 指针是可分享的轻量定位信息，不是运行历史事实源。
//
// session/thread/run 的结构化事实来自 PostgreSQL；大对象和诊断载荷通过受控接口读取。
export function readWorkspacePointer(search = window.location.search): WorkspacePointer {
  const params = new URLSearchParams(search)
  const persisted = readPersistedPointer()
  const routeSessionId = readSessionIdFromPath(window.location.pathname)
  const querySessionId = normalizeParam(params.get('session'))
  const activeSessionId = routeSessionId ?? querySessionId ?? persisted.activeSessionId
  return {
    activeSessionId,
    activeRunId: normalizeParam(params.get('run')) ?? persisted.activeRunId,
    activeThreadId: normalizeParam(params.get('thread')) ?? persisted.activeThreadId,
    sessionSource: routeSessionId
      ? 'route'
      : querySessionId
        ? 'query'
        : persisted.activeSessionId
          ? 'persisted'
          : undefined,
  }
}

export function buildWorkspaceShareUrl(
  origin: string,
  shareId?: string,
): string {
  const url = new URL(shareId ? `/share/${encodeURIComponent(shareId)}` : '/', origin)
  url.search = ''
  return url.toString()
}

export function syncCleanWorkspaceUrl(sessionId: string, runId?: string, threadId?: string) {
  persistPointer({ activeSessionId: sessionId, activeRunId: runId, activeThreadId: threadId })
  const url = new URL(window.location.href)
  url.pathname = `/session/${encodeURIComponent(sessionId)}`
  url.search = ''
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function readPersistedPointer(): WorkspacePointer {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_POINTER_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<WorkspacePointer>
    return {
      activeSessionId: normalizeStoredParam(parsed.activeSessionId),
      activeRunId: normalizeStoredParam(parsed.activeRunId),
      activeThreadId: normalizeStoredParam(parsed.activeThreadId),
    }
  } catch {
    return {}
  }
}

function persistPointer(pointer: WorkspacePointer) {
  try {
    window.localStorage.setItem(WORKSPACE_POINTER_KEY, JSON.stringify(pointer))
  } catch {
    // 浏览器禁用本地存储时，工作台仍保持当前内存态；刷新后回到默认会话。
  }
}

function normalizeParam(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function normalizeStoredParam(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeParam(value) : undefined
}

function readSessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/session\/([^/?#]+)/u.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}
