// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话 Repository 与内容对象测试
//
//   文件:       fileConversationStore.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PostgresPlatformStore } from './platformStore.js'
import { PlatformStoreTestHarness } from '../../test-support/platformStoreHarness.js'
import { RuntimeFileStore } from './fileStore.js'

describe('conversation repository', () => {
  it('serializes concurrent parent-chain writes and restores them from the same repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-files-'))
    try {
      const harness = new PlatformStoreTestHarness()
      const store = await createStore(root, harness)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并发父链')

      await Promise.all(Array.from({ length: 24 }, (_, index) => store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: index % 2 ? 'assistant' : 'user', content: `消息 ${index + 1}` },
      })))

      const chain = await store.activeTranscript(thread.id)
      expect(chain).toHaveLength(24)
      expect(chain.map(entry => entry.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
      expect(new Set(chain.map(entry => entry.entryId)).size).toBe(24)

      const restored = await createStore(root, harness)
      expect((await restored.activeTranscript(thread.id)).map(entry => entry.payload.content)).toEqual(
        chain.map(entry => entry.payload.content),
      )
    } finally {
      await removeTestTree(root)
    }
  }, 15_000)

  it('forks a self-contained ancestor chain and supports trash restore and object dedupe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-fork-'))
    try {
      const harness = new PlatformStoreTestHarness()
      const store = await createStore(root, harness)
      const session = await store.createSession()
      const source = await store.createThread(session.id, '原线程')
      const sourceRun = await store.createRun(session.id, '原线程运行', { threadId: source.id })
      const user = await store.appendTranscript({ threadId: source.id, kind: 'message', payload: { role: 'user', content: '记住杭州。' } })
      const assistant = await store.appendTranscript({ threadId: source.id, kind: 'message', payload: { role: 'assistant', content: '已记住杭州。' } })

      const forked = await store.forkThread(source.id, assistant.entryId, '杭州分支')
      expect((await store.activeTranscript(forked.id)).map(entry => entry.payload.content)).toEqual(['记住杭州。', '已记住杭州。'])
      expect((await store.getThreadManifest(forked.id)).forkedFrom).toEqual({ threadId: source.id, entryId: assistant.entryId })

      const firstObject = await store.putConversationObject('same-content', 'text/plain')
      const secondObject = await store.putConversationObject('same-content', 'text/plain')
      expect(firstObject).toEqual(secondObject)

      await store.deleteThread(source.id)
      const restarted = await createStore(root, harness)
      expect(await restarted.listTrash(session.id)).toHaveLength(1)
      expect((await restarted.activeTranscript(forked.id)).at(-1)?.payload.content).toBe('已记住杭州。')
      await restarted.restoreThread(source.id)
      expect(restarted.getThread(source.id).status).toBe('active')
      expect(restarted.listRunsForThread(source.id).map(run => run.id)).toEqual([sourceRun.id])
      expect((await restarted.activeTranscript(source.id)).at(-1)?.entryId).toBe(assistant.entryId)
      expect(user.parentEntryId).toBeNull()
    } finally {
      await removeTestTree(root)
    }
  })

  it('commits thread and run lifecycle pointers atomically and restores them after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-lifecycle-'))
    try {
      const harness = new PlatformStoreTestHarness()
      const store = await createStore(root, harness)
      const session = await store.createSession()
      const firstThread = await store.createThread(session.id, '第一条线程')
      const firstRun = await store.createRun(session.id, '第一轮', { threadId: firstThread.id })
      const secondThread = await store.createThread(session.id, '第二条线程')
      const secondRun = await store.createRun(session.id, '第二轮', { threadId: secondThread.id })

      expect(store.getSession(session.id)).toMatchObject({
        latestThreadId: secondThread.id,
        latestRunId: secondRun.id,
      })
      expect(store.getThread(secondThread.id)).toMatchObject({
        latestRunId: secondRun.id,
        runCount: 1,
      })

      await store.deleteThread(secondThread.id)

      expect(store.getSession(session.id)).toMatchObject({
        latestThreadId: firstThread.id,
        latestRunId: firstRun.id,
      })
      const restarted = await createStore(root, harness)
      expect(restarted.getSession(session.id)).toMatchObject({
        latestThreadId: firstThread.id,
        latestRunId: firstRun.id,
      })
      expect(restarted.listThreadsForSession(session.id).map(thread => thread.id)).toEqual([firstThread.id])
      expect(restarted.listRunsForThread(firstThread.id).map(run => run.id)).toEqual([firstRun.id])
    } finally {
      await removeTestTree(root)
    }
  })

  it('does not mutate indexes when lifecycle transactions fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-rollback-'))
    try {
      const harness = new PlatformStoreTestHarness()
      const store = await createStore(root, harness)
      const session = await store.createSession()

      vi.spyOn(harness.conversationRepository, 'createThreadLifecycle')
        .mockRejectedValueOnce(new Error('线程事务已回滚'))
      await expect(store.createThread(session.id, '不会出现')).rejects.toThrow('线程事务已回滚')
      expect(store.listThreadsForSession(session.id)).toEqual([])
      expect(store.getSession(session.id)).toMatchObject({ latestThreadId: null, latestRunId: null })

      const thread = await store.createThread(session.id, '稳定线程')
      const sessionBeforeRun = store.getSession(session.id)
      const threadBeforeRun = store.getThread(thread.id)
      vi.spyOn(harness.conversationRepository, 'createRunLifecycle')
        .mockRejectedValueOnce(new Error('运行事务已回滚'))
      await expect(store.createRun(session.id, '不会出现', { threadId: thread.id }))
        .rejects.toThrow('运行事务已回滚')

      expect(store.listRunsForThread(thread.id)).toEqual([])
      expect(store.getSession(session.id)).toEqual(sessionBeforeRun)
      expect(store.getThread(thread.id)).toEqual(threadBeforeRun)
    } finally {
      vi.restoreAllMocks()
      await removeTestTree(root)
    }
  })

  it('retains PostgreSQL-referenced SDK checkpoints and thread memory during object GC', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-gc-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const protectedThread = await store.createThread(session.id, '保留对象')
      const run = await store.createRun(session.id, '保存检查点', { threadId: protectedThread.id })
      const sdkState = JSON.stringify({ state: 'durable' })
      await store.saveAgentsSdkState(run.id, sdkState, {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime-digest',
      })
      await store.updateThreadMemory(protectedThread.id, '需要长期保留的线程记忆', 0)
      const uploaded = await new RuntimeFileStore(root).save({
        name: 'sample.nc',
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      }, protectedThread.id)

      const disposable = await store.createThread(session.id, '触发垃圾回收')
      await store.deleteThread(disposable.id)
      await store.purgeThread(disposable.id)

      expect(await store.readAgentsSdkState(run.id)).toBe(sdkState)
      expect((await store.getThreadMemory(protectedThread.id)).content).toBe('需要长期保留的线程记忆')
      expect(await readFile(path.join(root, ...uploaded.relativePath.split('/')))).toEqual(Buffer.from([1, 2, 3, 4]))
    } finally {
      await removeTestTree(root)
    }
  })

})

async function createStore(root: string, harness = new PlatformStoreTestHarness()): Promise<PostgresPlatformStore> {
  const store = harness.create(root)
  await store.initialize()
  return store
}

function removeTestTree(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
