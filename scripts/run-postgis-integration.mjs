#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = path.join(root, 'apps', 'server')
const vitestRunner = path.join(serverRoot, 'scripts', 'run-vitest-with-env.mjs')
const testFile = 'src/db/postgis.integration.test.ts'
const child = spawn(process.execPath, [vitestRunner, 'run', testFile], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: { ...process.env, RUN_POSTGIS_INTEGRATION: '1' },
})

child.on('error', error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 1))
