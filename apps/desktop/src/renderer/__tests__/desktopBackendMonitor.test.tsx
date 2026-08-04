// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面后台可用性监视器测试
//
//   文件:       desktopBackendMonitor.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BackendStatusNotice,
  DesktopBackendMonitor,
  assertRuntimeCapabilities,
} from '../app/DesktopBackendMonitor'
import { useBackendAvailabilityStore } from '../app/stores/backendAvailabilityStore'

describe('DesktopBackendMonitor', () => {
  beforeEach(() => {
    useBackendAvailabilityStore.setState({
      availability: 'checking',
      snapshot: null,
      errorMessage: null,
      onlineRevision: 0,
    })
  })

  it('mounts the renderer content before backend services become healthy', () => {
    const html = renderToStaticMarkup(
      <DesktopBackendMonitor>
        <main data-testid="desktop-workbench">独立桌面工作台</main>
      </DesktopBackendMonitor>,
    )

    expect(html).toContain('独立桌面工作台')
    expect(html).toContain('正在检查本机服务')
    expect(html).toContain('工作台已启动')
  })

  it('keeps the renderer content visible while showing a recoverable offline state', () => {
    const html = renderToStaticMarkup(
      <>
        <main>地图与本地布局</main>
        <BackendStatusNotice
          availability="offline"
          snapshot={null}
          errorMessage="平台 API 未运行。"
          onRetry={() => undefined}
          onOpenLogs={() => undefined}
        />
      </>,
    )

    expect(html).toContain('地图与本地布局')
    expect(html).toContain('当前处于离线工作台')
    expect(html).toContain('平台 API 未运行')
    expect(html).toContain('系统日志')
    expect(html).toContain('重新连接')
  })

  it('rejects an API/Desktop protocol mismatch before marking services online', () => {
    expect(() => assertRuntimeCapabilities({
      apiProtocolVersion: 99,
      minDesktopProtocol: 1,
      maxDesktopProtocol: 1,
    })).toThrow('运行时 API 协议不兼容')
    expect(() => assertRuntimeCapabilities({
      apiProtocolVersion: 1,
      minDesktopProtocol: 2,
      maxDesktopProtocol: 3,
    })).toThrow('桌面协议不兼容')
  })
})
