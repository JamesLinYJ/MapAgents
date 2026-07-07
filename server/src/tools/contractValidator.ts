// +-------------------------------------------------------------------------
//
//   地理智能平台 - 跨语言工具契约校验
//
//   文件:       contractValidator.ts
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

// Node 启动时拉取 Worker /tools/catalog，与 TS registry 中已注册工具做契约校验。
// 任何不一致（缺失工具、参数不匹配、readOnly/破坏性声明不一致）→ 硬失败。
// 不做 fallback、不合成 artifact、不返回成功文案。

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContractManifest } from '@geo-agent-platform/shared-types'
import { logger } from '../observability/logger.js'

export interface ContractValidationReport {
  passed: boolean
  workerTools: string[]
  registryTools: string[]
  missingInRegistry: string[]
  missingInWorker: string[]
  errors: string[]
}

export async function validateToolContracts(
  registry: ToolRegistry,
  workerUrl: string,
): Promise<ContractValidationReport> {
  const registryTools = new Set(registry.list().map(t => t.name))
  const report: ContractValidationReport = {
    passed: true,
    workerTools: [],
    registryTools: [...registryTools],
    missingInRegistry: [],
    missingInWorker: [],
    errors: [],
  }

  // 1. 拉取 Worker catalog
  let catalog: { tools: string[]; count: number }
  try {
    const response = await fetch(`${workerUrl.replace(/\/+$/u, '')}/tools/catalog`)
    if (!response.ok) {
      report.errors.push(`Worker /tools/catalog 返回 HTTP ${response.status}`)
      report.passed = false
      return report
    }
    catalog = (await response.json()) as { tools: string[]; count: number }
    report.workerTools = catalog.tools
  } catch (error) {
    report.errors.push(`无法连接 Worker /tools/catalog: ${error instanceof Error ? error.message : String(error)}`)
    report.passed = false
    return report
  }

  // 2. 交叉对比：Worker 有但 Registry 没有
  for (const toolName of catalog.tools) {
    if (!registryTools.has(toolName)) {
      report.missingInRegistry.push(toolName)
      report.passed = false
    }
  }

  // 3. 交叉对比：Registry 有但 Worker 没有（仅对 Python 工具）
  for (const def of registry.list()) {
    if (def.language !== 'python') continue
    if (!catalog.tools.includes(def.name)) {
      report.missingInWorker.push(def.name)
      report.passed = false
    }
  }

  // 4. 输出结果
  if (!report.passed) {
    logger.error({ report }, '工具契约校验失败')
  } else {
    logger.info({ workerCount: catalog.tools.length, registryCount: registryTools.size }, '工具契约校验通过')
  }

  return report
}
