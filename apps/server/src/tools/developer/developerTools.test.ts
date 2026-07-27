// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS/气象 Agent 开发工具测试
//
//   文件:       developerTools.test.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 这些测试约束开发工具的硬边界：它们只维护 GeoForge GIS/气象 Agent，
// 不提供泛用 shell/后台任务能力，也不能越过显式 allowlist 访问文件。

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateToolProvider } from '../../framework/validation.js'
import type { ToolContext } from '../../framework/types.js'
import developerProvider from './index.js'
import { editFileTool } from './editFile/definition.js'
import { globFilesTool } from './globFiles/definition.js'
import { grepFilesTool } from './grepFiles/definition.js'
import { readFileTool } from './readFile/definition.js'
import { todoWriteTool } from './todoWrite/definition.js'
import { writeFileTool } from './writeFile/definition.js'
import { globFiles } from './shared/glob.js'

describe('geo-platform-developer-tools', () => {
  let root: string
  let runtimeRoot: string
  const previousRoots = process.env.DEVELOPER_TOOL_ALLOWED_ROOTS
  const previousRuntimeRoot = process.env.RUNTIME_ROOT

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'geoforge-dev-tools-'))
    runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'geoforge-dev-runtime-'))
    process.env.DEVELOPER_TOOL_ALLOWED_ROOTS = root
    process.env.RUNTIME_ROOT = runtimeRoot
  })

  afterEach(async () => {
    restoreEnv('DEVELOPER_TOOL_ALLOWED_ROOTS', previousRoots)
    restoreEnv('RUNTIME_ROOT', previousRuntimeRoot)
    await rm(root, { recursive: true, force: true })
    await rm(runtimeRoot, { recursive: true, force: true })
  })

  it('exposes only scoped file, search, and todo tools with manifest parity', () => {
    validateToolProvider(developerProvider)
    expect(developerProvider.manifest.id).toBe('geo-platform-developer-tools')
    expect(developerProvider.tools().map(tool => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'glob_files',
      'grep_files',
      'todo_write',
    ])
    expect(developerProvider.tools().map(tool => tool.prompt)).toEqual(
      expect.arrayContaining([expect.stringContaining('GIS/气象 Agent')]),
    )
  })

  it('requires explicit allowed roots during provider installation', async () => {
    await expect(developerProvider.onInstall?.({
      config: { RUNTIME_ROOT: runtimeRoot },
      state: new Map(),
      log: () => undefined,
    })).rejects.toThrow('DEVELOPER_TOOL_ALLOWED_ROOTS')
  })

  it('reads, edits, and writes only inside configured roots', async () => {
    const target = path.join(root, 'server', 'src', 'meteorology-note.txt')
    await writeFileTool.handler({
      file_path: target,
      content: '气象工具链\n旧文案\n',
      create_parent_dirs: true,
    }, runtime())
    await readFileTool.handler({ file_path: target }, runtime())
    await editFileTool.handler({
      file_path: target,
      old_string: '旧文案',
      new_string: '新文案',
    }, runtime())

    expect(await readFile(target, 'utf8')).toBe('气象工具链\n新文案\n')
    await expect(readFileTool.handler({ file_path: path.join(os.tmpdir(), 'outside.txt') }, runtime()))
      .rejects.toThrow('路径不在允许根目录内')
  })

  it('denies secrets even when their parent directory is explicitly allowed', async () => {
    const envFile = path.join(root, '.env')
    const opsDirectory = path.join(runtimeRoot, 'ops')
    const rootSecret = path.join(opsDirectory, 'local-root.secret')
    await mkdir(opsDirectory, { recursive: true })
    await writeFile(envFile, 'MODEL_API_KEY=must-not-leak\n', 'utf8')
    await writeFile(rootSecret, 'must-not-leak\n', 'utf8')

    await expect(readFileTool.handler({ file_path: envFile }, runtime()))
      .rejects.toThrow('开发工具禁止访问')
    await expect(readFileTool.handler({ file_path: rootSecret }, runtime()))
      .rejects.toThrow('开发工具禁止访问')

    const globResult = await globFilesTool.handler({ pattern: '**/*', path: root }, runtime())
    expect(globResult.payload.matches).not.toContain('.env')
    const grepResult = await grepFilesTool.handler({ pattern: 'must-not-leak', path: root }, runtime())
    expect(grepResult.payload.count).toBe(0)
  })

  it('rejects edit_file before a complete read and after external changes', async () => {
    const target = path.join(root, 'agent.ts')
    await writeFile(target, 'export const name = "气象";\n', 'utf8')

    await expect(editFileTool.handler({
      file_path: target,
      old_string: '气象',
      new_string: 'GIS 气象',
    }, runtime())).rejects.toThrow('编辑前必须先完整读取')

    await readFileTool.handler({ file_path: target }, runtime())
    await writeFile(target, 'export const name = "外部修改";\n', 'utf8')
    await expect(editFileTool.handler({
      file_path: target,
      old_string: '气象',
      new_string: 'GIS 气象',
    }, runtime())).rejects.toThrow('读取后发生变化')
  })

  it('finds files with glob and grep without enabling shell tools', async () => {
    await writeFile(path.join(root, 'meteorology.ts'), 'export const label = "气象";\n', 'utf8')
    await writeFile(path.join(root, 'map.ts'), 'export const label = "GIS";\n', 'utf8')

    const globResult = await globFilesTool.handler({ pattern: '*.ts', path: root }, runtime())
    expect(globResult.payload.matches).toEqual(['map.ts', 'meteorology.ts'])

    const grepResult = await grepFilesTool.handler({ pattern: '气象', path: root, glob: '*.ts' }, runtime())
    expect(grepResult.payload.count).toBe(1)
    expect(JSON.stringify(grepResult.payload.matches)).toContain('meteorology.ts')
  })

  it('returns observable partial glob results when one directory cannot be read', async () => {
    const blocked = path.join(root, 'blocked')
    await mkdir(blocked)
    await writeFile(path.join(root, 'visible.ts'), 'export const visible = true\n', 'utf8')
    await writeFile(path.join(blocked, 'secret.ts'), 'export const secret = true\n', 'utf8')

    const result = await globFiles(root, '**/*.ts', 100, {
      readDirectory: async directory => {
        if (directory === blocked) {
          throw Object.assign(new Error('access denied'), { code: 'EPERM' })
        }
        return readdir(directory, { withFileTypes: true })
      },
    })

    expect(result.matches).toEqual(['visible.ts'])
    expect(result).toMatchObject({
      partial: true,
      issueCount: 1,
      issues: [{ path: 'blocked', reason: 'permission_denied' }],
    })
  })

  it('normalizes todo_write payload for run-state persistence', async () => {
    const result = await todoWriteTool.handler({
      todos: [
        { title: '检查气象工具 prompt', status: 'running' },
        { title: '补充 GIS 前端验收', status: 'pending' },
      ],
    }, runtime())

    expect(result.payload.todos).toEqual([
      expect.objectContaining({ title: '检查气象工具 prompt', status: 'running' }),
      expect.objectContaining({ title: '补充 GIS 前端验收', status: 'pending' }),
    ])
  })

  it('declares title as required in the todo_write boundary schema', () => {
    expect(todoWriteTool.jsonSchema.required).toEqual(['todos'])
    const properties = todoWriteTool.jsonSchema.properties as Record<string, Record<string, unknown>>
    const todos = properties.todos
    expect((todos?.items as Record<string, unknown>)?.required).toEqual(['title', 'status'])
  })
})

function runtime(): ToolContext {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    state: new Map(),
    resolveValueRef: () => {
      throw new Error('未知 valueRef')
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
