// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台浏览器验收
//
//   文件:       operations.spec.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const password = process.env.PLAYWRIGHT_OPS_PASSWORD ?? 'GeoForge-Ops-E2E-Password-2026!'

test.describe.configure({ mode: 'serial' })

test.describe('平台管理员', () => {
  test('进入高密度总览并维持实时控制连接', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/operations/')
    await expect(page.getByText('运行总览')).toBeVisible()
    await expect(page.getByRole('region', { name: '主机指标' })).toBeVisible()
    await expect(page.getByRole('navigation').getByText('终端')).toBeVisible()
    await expect(page.getByText('实时连接正常')).toBeVisible()
    await expect(page.locator('.ops-service-list, .ops-table').filter({ hasText: '主 API' })).toBeVisible()
    await page.screenshot({ path: 'output/playwright/operations/overview.png', fullPage: true })
    expect(errors).toEqual([])
  })

  test('创建终端、执行中文命令、切页恢复、关闭并回放密文记录', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    const label = `E2E 终端 ${Date.now()}`
    const marker = `OPS_E2E_中文_${Date.now()}`
    await page.goto('/operations/#terminal')
    await expect(page.getByRole('heading', { name: '交互终端' })).toBeVisible()
    await page.getByRole('textbox', { name: '新终端名称' }).fill(label)
    await page.getByRole('button', { name: '新建终端' }).click()
    await completeStepUp(page)

    const terminalTab = page.getByRole('tab', { name: new RegExp(label) })
    await expect(terminalTab).toBeVisible()
    await expect(page.locator('.ops-terminal-toolbar')).toContainText('已连接')
    const terminalInput = page.locator('.ops-terminal-pane .xterm-helper-textarea')
    await terminalInput.focus()
    await page.keyboard.insertText(`Write-Output '${marker}'`)
    await page.keyboard.press('Enter')
    await expect(page.locator('.ops-terminal-pane .xterm-rows')).toContainText(marker)
    await page.waitForTimeout(300)
    expect(await page.locator('.ops-terminal-pane .xterm-rows').textContent()).not.toContain('?[1;2c')
    await page.screenshot({ path: 'output/playwright/operations/terminal.png', fullPage: true })

    await page.getByRole('link', { name: '日志' }).click()
    await expect(page.getByRole('heading', { name: '实时日志' })).toBeVisible()
    await page.getByRole('link', { name: '终端' }).click()
    await expect(terminalTab).toBeVisible()
    await terminalTab.click()
    await expect(page.locator('.ops-terminal-toolbar')).toContainText('已连接')
    await expect(page.locator('.ops-terminal-pane .xterm-rows')).toContainText(marker)

    await page.getByRole('button', { name: `关闭 ${label}` }).click()
    await page.getByRole('link', { name: '记录' }).click()
    const record = page.getByRole('row').filter({ hasText: label })
    await expect(record).toBeVisible()
    const castResponse = page.waitForResponse(response => response.url().includes('/cast') && response.request().method() === 'GET')
    await record.getByRole('button', { name: '回放' }).click()
    expect((await castResponse).headers()['cache-control']).toContain('no-store')
    await expect(page.locator('.ops-replay .xterm-rows')).toContainText(marker)
    expect(errors).toEqual([])
  })

  test('从运维页重启主 API 时 Gateway 与页面连接保持在线', async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_OPS_ALLOW_SERVICE_RESTART !== '1', '只在隔离的 Process Compose 夹具上执行服务重启')
    const errors = collectUnexpectedErrors(page)
    await page.goto('/operations/#services')
    const apiRow = page.locator('.ops-service-row').filter({ hasText: '主 API' })
    await expect(apiRow).toBeVisible()
    const previousPid = await serviceFact(apiRow, 'PID')
    await apiRow.getByRole('button', { name: '重启' }).click()
    const confirmation = page.getByRole('dialog', { name: '重启 主 API' })
    await confirmation.getByRole('textbox').fill('确认')
    await confirmation.getByRole('button', { name: '确认重启' }).click()
    await completeStepUp(page)
    await expect.poll(() => serviceFact(apiRow, 'PID'), { timeout: 30_000 }).not.toBe(previousPid)
    await expect(page.getByText('实时连接正常')).toBeVisible()
    await expect(page.getByRole('heading', { name: '服务管理' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('数据库中断后使用短期恢复会话重新启动基础设施', async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_OPS_ALLOW_DATABASE_OUTAGE !== '1', '只在独占的真实 PostGIS 夹具上执行数据库中断')
    test.setTimeout(120_000)
    let infraMayBeStopped = false
    try {
      await page.goto('/operations/#services')
      const infraRow = page.locator('.ops-service-row').filter({ hasText: '基础设施' })
      await expect(infraRow).toBeVisible()
      await infraRow.getByRole('button', { name: '停止' }).click()
      const confirmation = page.getByRole('dialog', { name: '停止 基础设施' })
      await confirmation.getByRole('textbox').fill('infra')
      infraMayBeStopped = true
      await confirmation.getByRole('button', { name: '确认停止' }).click()
      await completeStepUp(page)

      await expect.poll(async () => page.evaluate(async () => {
        const response = await fetch('/ops/api/v1/bootstrap', { cache: 'no-store', credentials: 'include' })
        if (!response.ok) return `HTTP ${response.status}`
        const payload: unknown = await response.json()
        return payload && typeof payload === 'object' && 'recoveryMode' in payload
          ? payload.recoveryMode
          : '协议错误'
      }), { timeout: 45_000 }).toBe(true)
      await page.reload()
      await expect(page.getByText('数据库恢复模式：仅允许启动或重启 infra')).toBeVisible()
      const recoveryInfraRow = page.locator('.ops-service-row').filter({ hasText: '基础设施' })
      await recoveryInfraRow.getByRole('button', { name: '启动' }).click()
      await expect.poll(async () => serviceFact(recoveryInfraRow, 'PID'), { timeout: 45_000 }).not.toBe('—')
      infraMayBeStopped = false

      await expect.poll(async () => {
        await page.reload()
        return page.getByText('数据库恢复模式：仅允许启动或重启 infra').count()
      }, { timeout: 45_000 }).toBe(0)
      await expect(page.getByText('实时连接正常')).toBeVisible()
    } finally {
      if (infraMayBeStopped) await ensureInfraStarted()
    }
  })
})

test.describe('非平台管理员', () => {
  test.use({ storageState: resolve('output/playwright/ops-analyst-state.json') })

  test('直接访问由服务端返回稳定中文 403 页面', async ({ page }) => {
    const response = await page.goto('/operations/')
    expect(response?.status()).toBe(403)
    await expect(page.getByRole('heading', { name: '无权访问运维后台' })).toBeVisible()
    await expect(page.getByText('仅平台管理员可以访问此页面。')).toBeVisible()
  })
})

async function completeStepUp(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '重新验证管理员身份' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('当前账户密码').fill(password)
  await dialog.getByRole('button', { name: '验证并继续' }).click()
  await expect(dialog).toHaveCount(0)
}

async function serviceFact(row: Locator, label: string): Promise<string> {
  return (await row.locator('.ops-service-row__facts > span').filter({ hasText: label }).locator('b').textContent())?.trim() ?? ''
}

function collectUnexpectedErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function ensureInfraStarted(): Promise<void> {
  const baseUrl = process.env.PROCESS_COMPOSE_URL ?? 'http://127.0.0.1:8080'
  const token = (await readFile(
    process.env.PROCESS_COMPOSE_TOKEN_FILE ?? resolve('runtime/ops/process-compose.token'),
    'utf8',
  )).trim()
  const headers = { 'X-PC-Token-Key': token }
  const current = await fetch(new URL('/processes', baseUrl), { headers })
    .then(result => result.json() as Promise<unknown>)
  if (isInfraRunning(current)) return
  const response = await fetch(new URL('/process/start/infra', baseUrl), {
    method: 'POST',
    headers,
  })
  if (!response.ok) throw new Error(`数据库故障验收清理失败：infra 启动返回 HTTP ${response.status}`)
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const processes = await fetch(new URL('/processes', baseUrl), {
      headers,
    }).then(result => result.json() as Promise<unknown>)
    if (isInfraRunning(processes)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  }
  throw new Error('数据库故障验收清理失败：infra 未在 45 秒内恢复。')
}

function isInfraRunning(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) return false
  return value.data.some(item => item && typeof item === 'object'
    && 'name' in item && item.name === 'infra'
    && 'is_running' in item && item.is_running === true)
}
