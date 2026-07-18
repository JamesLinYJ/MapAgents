// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开只读分享页面
//
//   文件:       PublicSharePage.tsx
//
//   日期:       2026年07月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Eye, LoaderCircle, LockKeyhole, MessageSquareText } from 'lucide-react'
import type { PublicShareSnapshot } from '@geo-agent-platform/shared-types'
import { getPublicShare } from '../../api/client'
import { transcriptEntriesToConversationItems } from '../../app/bootstrap'
import { useConversationEntries } from '../conversation/useConversation'
import { PublicShareTimeline } from './PublicShareTimeline'
import { mergePublicShareHistory } from './publicShareHistory'

interface PublicSharePageProps {
  shareId?: string | null
}

interface PublicShareLoadState {
  key: string
  snapshot: PublicShareSnapshot | null
  errorMessage: string | null
}

export function PublicSharePage({ shareId: explicitShareId }: PublicSharePageProps = {}) {
  const params = useParams()
  const shareId = explicitShareId ?? params.shareId
  const [loadState, setLoadState] = useState<PublicShareLoadState>({
    key: '',
    snapshot: null,
    errorMessage: null,
  })
  const [selectedThread, setSelectedThread] = useState<{ shareId: string; threadId: string } | null>(null)
  const [historyPageState, setHistoryPageState] = useState<{
    key: string
    loading: boolean
    errorMessage: string | null
  }>({ key: '', loading: false, errorMessage: null })
  const selectedThreadId = selectedThread && selectedThread.shareId === shareId ? selectedThread.threadId : null
  const requestKey = `${shareId ?? ''}:${selectedThreadId ?? ''}`
  const isCurrentRequest = loadState.key === requestKey
  const snapshot = isCurrentRequest ? loadState.snapshot : null
  const errorMessage = shareId ? (isCurrentRequest ? loadState.errorMessage : null) : '分享链接缺少 ID。'
  const loading = Boolean(shareId) && !isCurrentRequest
  const loadingEarlierHistory = historyPageState.key === requestKey && historyPageState.loading

  useEffect(() => {
    let disposed = false
    if (!shareId) return
    void getPublicShare(shareId, { threadId: selectedThreadId, limit: 100 })
      .then(next => {
        if (!disposed) {
          setLoadState({
            key: requestKey,
            snapshot: next,
            errorMessage: null,
          })
        }
      })
      .catch(error => {
        if (!disposed) {
          setLoadState({
            key: requestKey,
            snapshot: null,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => { disposed = true }
  }, [requestKey, shareId, selectedThreadId])

  const loadEarlierHistory = async () => {
    const cursor = snapshot?.history?.nextCursor
    const threadId = snapshot?.selectedThread?.id
    if (!shareId || !cursor || !threadId || loadingEarlierHistory) return

    setHistoryPageState({ key: requestKey, loading: true, errorMessage: null })
    try {
      const olderSnapshot = await getPublicShare(shareId, {
        threadId,
        cursor,
        limit: 100,
      })
      setLoadState(current => {
        if (current.key !== requestKey || !current.snapshot?.history || !olderSnapshot.history) return current
        return {
          ...current,
          snapshot: {
            ...current.snapshot,
            history: {
              entries: mergePublicShareHistory(
                current.snapshot.history.entries,
                olderSnapshot.history.entries,
              ),
              nextCursor: olderSnapshot.history.nextCursor,
            },
          },
        }
      })
      setHistoryPageState({ key: requestKey, loading: false, errorMessage: null })
    } catch (error) {
      setHistoryPageState({
        key: requestKey,
        loading: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const conversationItems = useMemo(
    () => transcriptEntriesToConversationItems(snapshot?.history?.entries ?? []),
    [snapshot?.history?.entries],
  )
  const entries = useConversationEntries(conversationItems)

  if (loading) return <main className="share-page"><div className="share-shell share-shell--state">正在加载分享内容...</div></main>
  if (errorMessage || !snapshot) {
    return (
      <main className="share-page">
        <div className="share-shell share-shell--state">
          <strong>无法打开分享</strong>
          <p>{errorMessage ?? '分享不存在或已失效。'}</p>
          <Link to="/">返回工作台</Link>
        </div>
      </main>
    )
  }

  return (
    <main className="share-page" aria-labelledby="share-title">
      <section className="share-shell">
        <header className="share-hero">
          <div>
            <span className="account-eyebrow">公开只读分享</span>
            <h1 id="share-title">{snapshot.selectedThread?.title ?? '对话分享'}</h1>
            <p>任何获得链接的人都可以阅读此对话。此页面不允许继续对话、上传文件、运行工具或修改工作区数据。</p>
          </div>
          <div className="share-hero__meta" aria-label="分享状态">
            <span><Eye size={14} /> 只读</span>
            <span><LockKeyhole size={14} /> 不含写权限</span>
            <span><MessageSquareText size={14} /> {snapshot.threads.length} 条对话</span>
          </div>
        </header>

        <div className="share-layout">
          <aside className="share-thread-list" aria-label="分享中的对话">
            {snapshot.threads.map(thread => (
              <button
                key={thread.id}
                className={thread.id === snapshot.selectedThread?.id ? 'share-thread share-thread--active' : 'share-thread'}
                type="button"
                data-thread-id={thread.id}
                disabled={thread.id === snapshot.selectedThread?.id}
                onClick={() => {
                  if (shareId) setSelectedThread({ shareId, threadId: thread.id })
                }}
              >
                <strong>{thread.title}</strong>
                <small>{thread.historyPreview || thread.latestUserQuery || '暂无摘要'}</small>
                <span>{thread.runCount} 次运行</span>
              </button>
            ))}
          </aside>

          <section className="share-conversation" id={snapshot.selectedThread ? `thread-${snapshot.selectedThread.id}` : undefined}>
            {snapshot.history?.nextCursor ? (
              <div className="share-history-pagination">
                <button
                  type="button"
                  disabled={loadingEarlierHistory}
                  onClick={() => { void loadEarlierHistory() }}
                >
                  {loadingEarlierHistory ? <LoaderCircle className="is-spinning" size={16} /> : null}
                  {loadingEarlierHistory ? '正在加载...' : '加载更早记录'}
                </button>
                {historyPageState.key === requestKey && historyPageState.errorMessage ? (
                  <p role="alert">{historyPageState.errorMessage}</p>
                ) : null}
              </div>
            ) : null}
            {entries.length ? (
              <PublicShareTimeline entries={entries} />
            ) : (
              <div className="share-empty">这条分享暂时没有可展示的对话内容。</div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}
