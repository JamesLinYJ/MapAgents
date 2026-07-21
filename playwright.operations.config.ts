// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台 Playwright 验收配置
//
//   文件:       playwright.operations.config.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH

export default defineConfig({
  testDir: './tests/e2e/operations',
  globalSetup: './tests/e2e/operationsGlobalSetup.ts',
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'output/playwright/operations-report', open: 'never' }]],
  outputDir: 'output/playwright/operations-results',
  use: {
    baseURL: process.env.PLAYWRIGHT_OPS_BASE_URL ?? 'http://127.0.0.1:8020',
    storageState: resolve('output/playwright/ops-admin-state.json'),
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
