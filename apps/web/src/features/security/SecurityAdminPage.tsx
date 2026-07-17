// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全管理后台
//
//   文件:       SecurityAdminPage.tsx
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import type {
  AdminMembership,
  AuditEvent,
  PlatformRole,
  PlatformUser,
  PlatformWorkspace,
  RbacPolicyRow,
} from '@geo-agent-platform/shared-types'
import {
  createAdminMembership,
  createAdminWorkspace,
  deleteAdminMembership,
  listAdminMemberships,
  listAdminRoles,
  listAdminUsers,
  listAdminWorkspaces,
  listAuditEvents,
  updateAdminUser,
} from '../../api/client'

type View = 'users' | 'workspaces' | 'memberships' | 'roles' | 'audit'
type AdminTableRow = PlatformUser | PlatformWorkspace | AdminMembership | RbacPolicyRow | AuditEvent

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'users', label: '用户' },
  { id: 'workspaces', label: '工作区' },
  { id: 'memberships', label: '成员' },
  { id: 'roles', label: '权限矩阵' },
  { id: 'audit', label: '审计日志' },
]

export default function SecurityAdminPage() {
  const [view, setView] = useState<View>('users')
  const [users, setUsers] = useState<PlatformUser[]>([])
  const [workspaces, setWorkspaces] = useState<PlatformWorkspace[]>([])
  const [memberships, setMemberships] = useState<AdminMembership[]>([])
  const [roles, setRoles] = useState<RbacPolicyRow[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceDescription, setWorkspaceDescription] = useState('')
  const [memberUserId, setMemberUserId] = useState('')
  const [memberRole, setMemberRole] = useState<PlatformRole>('analyst')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [isLoading, setIsLoading] = useState(false)

  const defaultWorkspaceId = selectedWorkspaceId || workspaces[0]?.workspaceId || ''

  async function refresh() {
    setIsLoading(true)
    setErrorMessage(undefined)
    try {
      const [nextUsers, nextWorkspaces, nextRoles, nextAudit] = await Promise.all([
        listAdminUsers(),
        listAdminWorkspaces(),
        listAdminRoles(),
        listAuditEvents(),
      ])
      setUsers(nextUsers)
      setWorkspaces(nextWorkspaces)
      setRoles(nextRoles)
      setAuditEvents(nextAudit)
      const workspaceId = selectedWorkspaceId || nextWorkspaces[0]?.workspaceId || ''
      setSelectedWorkspaceId(workspaceId)
      setMemberships(workspaceId ? await listAdminMemberships(workspaceId) : [])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // 首次进入后台时加载完整安全投影；后续刷新由用户明确触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refreshMemberships(workspaceId = defaultWorkspaceId) {
    if (!workspaceId) return
    await runAdminMutation(async () => {
      setSelectedWorkspaceId(workspaceId)
      setMemberships(await listAdminMemberships(workspaceId))
    })
  }

  async function handleCreateWorkspace() {
    if (!workspaceName.trim()) return
    await runAdminMutation(async () => {
      await createAdminWorkspace({ name: workspaceName.trim(), description: workspaceDescription.trim() })
      setWorkspaceName('')
      setWorkspaceDescription('')
      await refresh()
    })
  }

  async function handleAddMembership() {
    if (!defaultWorkspaceId || !memberUserId) return
    await runAdminMutation(async () => {
      await createAdminMembership({ workspaceId: defaultWorkspaceId, userId: memberUserId, role: memberRole })
      setMemberships(await listAdminMemberships(defaultWorkspaceId))
    })
  }

  async function handleToggleUser(row: PlatformUser) {
    await runAdminMutation(async () => {
      await updateAdminUser(row.userId, { status: row.status === 'disabled' ? 'active' : 'disabled' })
      await refresh()
    })
  }

  async function handleDeleteMembership(row: AdminMembership) {
    await runAdminMutation(async () => {
      await deleteAdminMembership(row.membershipId)
      if (defaultWorkspaceId) setMemberships(await listAdminMemberships(defaultWorkspaceId))
    })
  }

  async function runAdminMutation(action: () => Promise<void>) {
    setErrorMessage(undefined)
    try {
      await action()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const currentRows = useMemo<AdminTableRow[]>(() => {
    if (view === 'users') return users
    if (view === 'workspaces') return workspaces
    if (view === 'memberships') return memberships
    if (view === 'roles') return roles
    return auditEvents
  }, [auditEvents, memberships, roles, users, view, workspaces])

  return (
    <main className="digital-cartographer dc-security-page">
      <section className="dc-security-shell">
        <header className="dc-security-header">
          <div>
            <span className="dc-card__eyebrow">安全管理</span>
            <h1>身份、工作区与权限</h1>
          </div>
          <button className="dc-action-button" type="button" onClick={() => void refresh()} disabled={isLoading}>
            刷新
          </button>
        </header>
        {errorMessage ? <p className="dc-auth-card__error">{errorMessage}</p> : null}
        <nav className="dc-security-tabs" aria-label="安全管理视图">
          {VIEWS.map(item => (
            <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => setView(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        {view === 'workspaces' ? (
          <form className="dc-security-form" onSubmit={(event) => { event.preventDefault(); void handleCreateWorkspace() }}>
            <input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="工作区名称" />
            <input value={workspaceDescription} onChange={event => setWorkspaceDescription(event.target.value)} placeholder="说明" />
            <button className="dc-action-button dc-action-button--primary" type="submit">创建工作区</button>
          </form>
        ) : null}
        {view === 'memberships' ? (
          <form className="dc-security-form" onSubmit={(event) => { event.preventDefault(); void handleAddMembership() }}>
            <select value={selectedWorkspaceId} onChange={event => void refreshMemberships(event.target.value)}>
              {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>)}
            </select>
            <select value={memberUserId} onChange={event => setMemberUserId(event.target.value)}>
              <option value="">选择用户</option>
              {users.map(user => <option key={user.userId} value={user.userId}>{user.email}</option>)}
            </select>
            <select value={memberRole} onChange={event => setMemberRole(event.target.value as PlatformRole)}>
              <option value="workspace_admin">workspace_admin</option>
              <option value="analyst">analyst</option>
              <option value="viewer">viewer</option>
            </select>
            <button className="dc-action-button dc-action-button--primary" type="submit">添加成员</button>
          </form>
        ) : null}
        <div className="dc-security-table-wrap">
          <table className="dc-security-table">
            <thead>
              <tr>
                {columnsFor(view).map(column => <th key={column}>{column}</th>)}
                {view === 'users' || view === 'memberships' ? <th>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {currentRows.map((row, index) => (
                <tr key={`${view}-${index}`}>
                  {columnsFor(view).map(column => <td key={column}>{formatCell(cellValue(row, column))}</td>)}
                  {view === 'users' && isPlatformUser(row) ? (
                    <td>
                      <button
                        type="button"
                        title={row.status === 'disabled' ? '恢复后用户可重新登录' : '禁用后该用户现有会话将失效'}
                        onClick={() => void handleToggleUser(row)}
                      >
                        {row.status === 'disabled' ? '恢复' : '禁用并失效会话'}
                      </button>
                    </td>
                  ) : null}
                  {view === 'memberships' && isAdminMembership(row) ? (
                    <td><button type="button" onClick={() => void handleDeleteMembership(row)}>移除</button></td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

function columnsFor(view: View): string[] {
  if (view === 'users') return ['email', 'displayName', 'status', 'lastLoginAt']
  if (view === 'workspaces') return ['workspaceId', 'name', 'status', 'createdByUserId']
  if (view === 'memberships') return ['email', 'displayName', 'role', 'workspaceId']
  if (view === 'roles') return ['ptype', 'v0', 'v1', 'v2', 'v3', 'v4']
  return ['createdAt', 'actorUserId', 'workspaceId', 'objectType', 'action', 'outcome']
}

function cellValue(row: AdminTableRow, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column]
}

function isPlatformUser(row: AdminTableRow): row is PlatformUser {
  return 'subject' in row && 'lastLoginAt' in row
}

function isAdminMembership(row: AdminTableRow): row is AdminMembership {
  return 'membershipId' in row && 'email' in row
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
