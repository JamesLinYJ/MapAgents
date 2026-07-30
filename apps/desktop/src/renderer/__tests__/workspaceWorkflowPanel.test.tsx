// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流文档面板测试
//
//   文件:       workspaceWorkflowPanel.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkspaceWorkflowPanel } from '../app/layout/WorkspaceWorkflowPanel'

describe('WorkspaceWorkflowPanel', () => {
  it('没有工作流时仍提供完整文档空状态和下一步', () => {
    const html = renderToStaticMarkup(<WorkspaceWorkflowPanel agentState={null} />)

    expect(html).toContain('aria-label="智能体工作流"')
    expect(html).toContain('尚未生成工作流')
    expect(html).toContain('这里会同步展示智能体的执行计划')
    expect(html).toContain('aria-label="开始工作流"')
    expect(html).toContain('在右侧智能对话中说明要解决的问题和期望成果')
    expect(html).toContain('下一步：在右侧智能对话输入目标并发送')
    expect(html).not.toBe('')
  })
})
