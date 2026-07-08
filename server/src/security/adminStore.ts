// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全管理后台资源存储
//
//   文件:       adminStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { asc, desc, eq } from 'drizzle-orm'
import type { Database } from '../db/connection.js'
import {
  platformAuditEvents,
  platformMemberships,
  platformRbacPolicies,
  platformUsers,
  platformWorkspaces,
} from '../db/schema.js'
import type { PlatformRole } from '../schemas/types.js'
import { makeId } from '../utils/ids.js'

export class SecurityAdminStore {
  constructor(private readonly db: Database) {}

  async listUsers(): Promise<AdminUserRecord[]> {
    const rows = await this.db
      .select()
      .from(platformUsers)
      .orderBy(desc(platformUsers.updatedAt))
      .limit(200)
    return rows.map(mapUserRow)
  }

  async updateUser(userId: string, fields: { displayName?: string | null; status?: string | null }): Promise<void> {
    const update: { displayName?: string; status?: string; updatedAt: Date } = { updatedAt: new Date() }
    if (fields.displayName) update.displayName = fields.displayName
    if (fields.status) update.status = fields.status
    await this.db.update(platformUsers).set(update).where(eq(platformUsers.userId, userId))
  }

  async listWorkspaces(input: { platformAdmin: boolean; userId: string }): Promise<AdminWorkspaceRecord[]> {
    const rows = input.platformAdmin
      ? await this.db
        .select()
        .from(platformWorkspaces)
        .orderBy(desc(platformWorkspaces.updatedAt))
        .limit(200)
      : await this.db
        .select({
          workspaceId: platformWorkspaces.workspaceId,
          name: platformWorkspaces.name,
          description: platformWorkspaces.description,
          status: platformWorkspaces.status,
          createdByUserId: platformWorkspaces.createdByUserId,
          createdAt: platformWorkspaces.createdAt,
          updatedAt: platformWorkspaces.updatedAt,
        })
        .from(platformWorkspaces)
        .innerJoin(platformMemberships, eq(platformMemberships.workspaceId, platformWorkspaces.workspaceId))
        .where(eq(platformMemberships.userId, input.userId))
        .orderBy(desc(platformWorkspaces.updatedAt))
    return rows.map(mapWorkspaceRow)
  }

  async createWorkspaceWithAdmin(input: {
    name: string
    description: string
    createdByUserId: string
  }): Promise<AdminWorkspaceRecord> {
    const workspaceId = makeId('workspace')
    const createdAt = new Date()
    await this.db.transaction(async tx => {
      await tx.insert(platformWorkspaces).values({
        workspaceId,
        name: input.name,
        description: input.description,
        status: 'active',
        createdByUserId: input.createdByUserId,
        createdAt,
        updatedAt: createdAt,
      })
      await tx.insert(platformMemberships).values({
        membershipId: makeId('membership'),
        workspaceId,
        userId: input.createdByUserId,
        role: 'workspace_admin',
        createdAt,
      })
    })
    return {
      workspaceId,
      name: input.name,
      description: input.description,
      status: 'active',
      createdByUserId: input.createdByUserId,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
    }
  }

  async listMemberships(workspaceId: string): Promise<AdminMembershipRecord[]> {
    const rows = await this.db
      .select({
        membershipId: platformMemberships.membershipId,
        workspaceId: platformMemberships.workspaceId,
        userId: platformMemberships.userId,
        role: platformMemberships.role,
        createdAt: platformMemberships.createdAt,
        email: platformUsers.email,
        displayName: platformUsers.displayName,
      })
      .from(platformMemberships)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformMemberships.userId))
      .where(eq(platformMemberships.workspaceId, workspaceId))
      .orderBy(asc(platformUsers.email), asc(platformMemberships.role))
    return rows.map(row => ({
      membershipId: row.membershipId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: row.role,
      email: row.email,
      displayName: row.displayName,
      createdAt: toIsoString(row.createdAt),
    }))
  }

  async addMembership(input: { workspaceId: string; userId: string; role: PlatformRole }): Promise<void> {
    await this.db
      .insert(platformMemberships)
      .values({
        membershipId: makeId('membership'),
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        createdAt: new Date(),
      })
      .onConflictDoNothing({
        target: [platformMemberships.workspaceId, platformMemberships.userId, platformMemberships.role],
      })
  }

  async getMembershipWorkspace(membershipId: string): Promise<string | null> {
    const rows = await this.db
      .select({ workspaceId: platformMemberships.workspaceId })
      .from(platformMemberships)
      .where(eq(platformMemberships.membershipId, membershipId))
      .limit(1)
    return rows[0]?.workspaceId ?? null
  }

  async deleteMembership(membershipId: string): Promise<void> {
    await this.db.delete(platformMemberships).where(eq(platformMemberships.membershipId, membershipId))
  }

  async listRoles(): Promise<Array<Record<string, string>>> {
    return this.db
      .select({
        ptype: platformRbacPolicies.ptype,
        v0: platformRbacPolicies.v0,
        v1: platformRbacPolicies.v1,
        v2: platformRbacPolicies.v2,
        v3: platformRbacPolicies.v3,
        v4: platformRbacPolicies.v4,
        v5: platformRbacPolicies.v5,
      })
      .from(platformRbacPolicies)
      .orderBy(
        asc(platformRbacPolicies.ptype),
        asc(platformRbacPolicies.v0),
        asc(platformRbacPolicies.v1),
        asc(platformRbacPolicies.v2),
      )
  }

  async listAuditEvents(): Promise<AdminAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(platformAuditEvents)
      .orderBy(desc(platformAuditEvents.createdAt))
      .limit(500)
    return rows.map(row => ({
      auditEventId: row.auditEventId,
      actorUserId: row.actorUserId,
      workspaceId: row.workspaceId,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      outcome: row.outcome,
      metadata: isRecord(row.metadataJson) ? row.metadataJson : {},
      createdAt: toIsoString(row.createdAt),
    }))
  }
}

export interface AdminUserRecord {
  userId: string
  subject: string
  email: string
  displayName: string
  status: string
  lastLoginAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface AdminWorkspaceRecord {
  workspaceId: string
  name: string
  description: string
  status: string
  createdByUserId: string
  createdAt: string | null
  updatedAt: string | null
}

export interface AdminMembershipRecord {
  membershipId: string
  workspaceId: string
  userId: string
  role: string
  email: string
  displayName: string
  createdAt: string | null
}

export interface AdminAuditRecord {
  auditEventId: string
  actorUserId: string | null
  workspaceId: string | null
  action: string
  objectType: string
  objectId: string | null
  outcome: string
  metadata: Record<string, unknown>
  createdAt: string | null
}

function mapUserRow(row: typeof platformUsers.$inferSelect): AdminUserRecord {
  return {
    userId: row.userId,
    subject: row.subject,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  }
}

function mapWorkspaceRow(row: typeof platformWorkspaces.$inferSelect): AdminWorkspaceRecord {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  }
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
