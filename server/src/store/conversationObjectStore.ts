// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话对象存储
//
//   文件:       conversationObjectStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ContentRef } from '../schemas/types.js'
import type { FileConversationStore } from './fileConversationStore.js'

// 会话对象存储只负责 content-addressed blob 的读写和 flush。
// session/thread/run 语义不得进入这里。
export class ConversationObjectStore {
  constructor(private readonly conversationStore: FileConversationStore) {}

  put(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    return this.conversationStore.putObject(content, mediaType)
  }

  read(reference: ContentRef): Promise<Uint8Array> {
    return this.conversationStore.readObject(reference)
  }

  flush(): Promise<void> {
    return this.conversationStore.flush()
  }
}

