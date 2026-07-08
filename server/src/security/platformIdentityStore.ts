// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台身份投影存储
//
//   文件:       platformIdentityStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { asc, eq } from 'drizzle-orm'
import type { Database } from '../db/connection.js'
import { authSession, platformMemberships, platformUsers, platformWorkspaces } from '../db/schema.js'
import { platformRoleSchema, type PlatformRole } from '../schemas/types.js'
import { makeId } from '../utils/ids.js'
import type { AuthRoleBinding } from './types.js'

export class PlatformIdentityStore {
  constructor(private readonly db: Database) {}

  async getSubjectByPlatformUserId(platformUserId: string): Promise<string | null> {
    const rows = await this.db
      .select({ subject: platformUsers.subject })
      .from(platformUsers)
      .where(eq(platformUsers.userId, platformUserId))
      .limit(1)
    return rows[0]?.subject ?? null
  }

  async upsertUserProjection(input: {
    platformUserId: string
    subject: string
    email: string
    displayName: string
  }): Promise<{ created: boolean; user: PlatformUserProjection }> {
    const existing = await this.getUserBySubject(input.subject)
    const now = new Date()
    await this.db
      .insert(platformUsers)
      .values({
        userId: input.platformUserId,
        subject: input.subject,
        email: input.email,
        displayName: input.displayName,
        status: 'active',
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: platformUsers.subject,
        set: {
          email: input.email,
          displayName: input.displayName,
          lastLoginAt: now,
          updatedAt: now,
        },
      })

    const user = await this.getUserBySubject(input.subject)
    if (!user) throw new Error('平台用户投影写入后无法读取。')
    return { created: !existing, user }
  }

  async getUserBySubject(subject: string): Promise<PlatformUserProjection | null> {
    const rows = await this.db
      .select({
        userId: platformUsers.userId,
        status: platformUsers.status,
      })
      .from(platformUsers)
      .where(eq(platformUsers.subject, subject))
      .limit(1)
    return rows[0] ?? null
  }

  async ensurePersonalWorkspace(workspaceId: string, userId: string, displayName: string): Promise<void> {
    await this.db
      .insert(platformWorkspaces)
      .values({
        workspaceId,
        name: `${displayName} 的工作区`,
        description: '首次注册自动创建的个人工作区',
        status: 'active',
        createdByUserId: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: platformWorkspaces.workspaceId })
  }

  async ensureMembership(workspaceId: string, userId: string, role: PlatformRole): Promise<void> {
    await this.db
      .insert(platformMemberships)
      .values({
        membershipId: makeId('membership'),
        workspaceId,
        userId,
        role,
        createdAt: new Date(),
      })
      .onConflictDoNothing({
        target: [platformMemberships.workspaceId, platformMemberships.userId, platformMemberships.role],
      })
  }

  async listUserRoles(userId: string): Promise<AuthRoleBinding[]> {
    const rows = await this.db
      .select({
        workspaceId: platformMemberships.workspaceId,
        role: platformMemberships.role,
      })
      .from(platformMemberships)
      .where(eq(platformMemberships.userId, userId))
      .orderBy(asc(platformMemberships.role), asc(platformMemberships.workspaceId))
    return rows.flatMap(row => {
      const parsed = platformRoleSchema.safeParse(row.role)
      return parsed.success ? [{ workspaceId: row.workspaceId, role: parsed.data }] : []
    })
  }

  async isAuthSessionActive(authSessionId: string): Promise<boolean> {
    const rows = await this.db
      .select({
        expiresAt: authSession.expiresAt,
        status: platformUsers.status,
      })
      .from(authSession)
      .innerJoin(platformUsers, eq(platformUsers.subject, authSession.userId))
      .where(eq(authSession.id, authSessionId))
      .limit(1)
    const row = rows[0]
    if (!row || row.status !== 'active') return false
    return row.expiresAt.getTime() > Date.now()
  }

  async revokeBetterAuthSessions(authUserId: string): Promise<void> {
    await this.db.delete(authSession).where(eq(authSession.userId, authUserId))
  }
}

export interface PlatformUserProjection {
  userId: string
  status: string
}
