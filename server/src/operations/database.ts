// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维数据库边界校验
//
//   文件:       database.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { Database } from '../db/connection.js'
import { verifySchema } from '../security/database.js'

const OPERATIONS_TABLES: Record<string, string[]> = {
  platform_terminal_sessions: [
    'terminal_id', 'owner_user_id', 'label', 'state', 'shell', 'initial_cols', 'initial_rows',
    'current_cols', 'current_rows', 'pid', 'exit_code', 'failure_code', 'failure_message',
    'key_id', 'wrapped_data_key', 'key_wrap_nonce', 'key_wrap_auth_tag', 'recorded_bytes',
    'last_chunk_sequence', 'created_at', 'started_at', 'detached_at', 'last_activity_at',
    'expires_at', 'ended_at', 'retained_until',
  ],
  platform_terminal_transcript_chunks: [
    'terminal_id', 'sequence', 'content_hash', 'size_bytes', 'event_count',
    'first_event_milliseconds', 'last_event_milliseconds', 'created_at',
  ],
  platform_terminal_access_grants: [
    'grant_id', 'terminal_id', 'granted_to_user_id', 'reason', 'expires_at', 'used_at', 'created_at',
  ],
}

export function ensureOperationsTables(db: Database): Promise<void> {
  return verifySchema(db, OPERATIONS_TABLES)
}
