// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台 E2E 身份准备
//
//   文件:       operationsGlobalSetup.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { request, type FullConfig } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ADMIN_STATE = resolve('output/playwright/ops-admin-state.json')
const ANALYST_STATE = resolve('output/playwright/ops-analyst-state.json')

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = String(config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:8020')
  const password = process.env.PLAYWRIGHT_OPS_PASSWORD ?? 'GeoForge-Ops-E2E-Password-2026!'
  await mkdir(dirname(ADMIN_STATE), { recursive: true })
  await mkdir(resolve('output/playwright/operations'), { recursive: true })
  await prepareIdentity({
    baseURL,
    email: process.env.PLAYWRIGHT_OPS_ADMIN_EMAIL ?? 'geoforge-ops-e2e-admin@example.com',
    password,
    displayName: 'Ops E2E Admin',
    statePath: ADMIN_STATE,
    expectedBootstrapStatus: 200,
  })
  await prepareIdentity({
    baseURL,
    email: process.env.PLAYWRIGHT_OPS_ANALYST_EMAIL ?? 'geoforge-ops-e2e-analyst@example.com',
    password,
    displayName: 'Ops E2E Analyst',
    statePath: ANALYST_STATE,
    expectedBootstrapStatus: 403,
  })
}

async function prepareIdentity(input: {
  baseURL: string
  email: string
  password: string
  displayName: string
  statePath: string
  expectedBootstrapStatus: 200 | 403
}): Promise<void> {
  const api = await request.newContext({
    baseURL: input.baseURL,
    extraHTTPHeaders: { Origin: input.baseURL },
  })
  try {
    const signIn = await api.post('/ops/auth/sign-in/email', {
      data: { email: input.email, password: input.password },
    })
    if (!signIn.ok()) {
      const signUp = await api.post('/ops/auth/sign-up/email', {
        data: { name: input.displayName, email: input.email, password: input.password },
      })
      if (!signUp.ok()) {
        throw new Error(`运维 E2E 账号登录和注册均失败（HTTP ${signIn.status()}/${signUp.status()}）`)
      }
    }
    const bootstrap = await api.get('/ops/api/v1/bootstrap')
    if (bootstrap.status() !== input.expectedBootstrapStatus) {
      throw new Error(`运维 E2E 权限投影异常：${input.email} 返回 HTTP ${bootstrap.status()}，期望 ${input.expectedBootstrapStatus}`)
    }
    await api.storageState({ path: input.statePath })
  } finally {
    await api.dispose()
  }
}
