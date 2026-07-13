// +-------------------------------------------------------------------------
//
//   地理智能平台 - 认证、分享与安全后台 API
//
//   文件:       authApi.ts
// --------------------------------------------------------------------------

import {
  authMeSchema,
  publicShareSnapshotSchema,
  type AuthMe,
  type PublicShareSnapshot,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import { signOutWithBetterAuth } from './authClient'
import { unknownRecordListSchema, unknownRecordSchema } from './responseSchemas'
import { csrfHeaders, requestJson, setAuthContext } from './transport'

const mutationResultSchema = z.record(z.string(), z.unknown())

export async function logout(): Promise<void> {
  await signOutWithBetterAuth()
  setAuthContext(null)
}

export async function getAuthMe(): Promise<AuthMe> {
  const auth = await requestJson<AuthMe>('/api/v1/auth/me', undefined, 30_000, authMeSchema)
  setAuthContext(auth)
  return auth
}

export interface PublicShareRequest {
  threadId?: string | null
  cursor?: string | null
  limit?: number
}

export function getPublicShare(
  shareId: string,
  request: PublicShareRequest = {},
): Promise<PublicShareSnapshot> {
  const query = new URLSearchParams()
  if (request.threadId) query.set('threadId', request.threadId)
  if (request.cursor) query.set('cursor', request.cursor)
  if (request.limit !== undefined) query.set('limit', String(request.limit))
  const suffix = query.size ? `?${query.toString()}` : ''
  return requestJson(
    `/api/share/${encodeURIComponent(shareId)}${suffix}`,
    undefined,
    30_000,
    publicShareSnapshotSchema,
  )
}

export function listAdminUsers(): Promise<Array<Record<string, unknown>>> {
  return requestJson('/api/v1/admin/users', undefined, 30_000, unknownRecordListSchema)
}

export function updateAdminUser(userId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  }, 30_000, mutationResultSchema)
}

export function listAdminWorkspaces(): Promise<Array<Record<string, unknown>>> {
  return requestJson('/api/v1/admin/workspaces', undefined, 30_000, unknownRecordListSchema)
}

export function createAdminWorkspace(payload: { name: string; description?: string }): Promise<Record<string, unknown>> {
  return requestJson('/api/v1/admin/workspaces', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  }, 30_000, unknownRecordSchema)
}

export function listAdminMemberships(workspaceId?: string | null): Promise<Array<Record<string, unknown>>> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return requestJson(`/api/v1/admin/memberships${query}`, undefined, 30_000, unknownRecordListSchema)
}

export function createAdminMembership(payload: {
  workspaceId: string
  userId: string
  role: string
}): Promise<Record<string, unknown>> {
  return requestJson('/api/v1/admin/memberships', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  }, 30_000, mutationResultSchema)
}

export function deleteAdminMembership(membershipId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  }, 30_000, mutationResultSchema)
}

export function listAdminRoles(): Promise<Array<Record<string, unknown>>> {
  return requestJson('/api/v1/admin/roles', undefined, 30_000, unknownRecordListSchema)
}

export function listAuditEvents(): Promise<Array<Record<string, unknown>>> {
  return requestJson('/api/v1/admin/audit-events', undefined, 30_000, unknownRecordListSchema)
}
