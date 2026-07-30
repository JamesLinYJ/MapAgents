// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Artifact 受控下载适配器测试
//
//   文件:       desktopArtifactDownload.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestDesktopDownload } = vi.hoisted(() => ({
  requestDesktopDownload: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  requestDesktopDownload,
}))

import {
  requestArtifactDownload,
  requestArtifactGeoJsonDownload,
} from './desktopArtifactDownload'

describe('desktop Artifact download boundary', () => {
  beforeEach(() => {
    requestDesktopDownload.mockReset()
    requestDesktopDownload.mockResolvedValue({
      canceled: false,
      displayName: '已保存文件.geojson',
    })
  })

  it('delegates an Artifact URI and suggested name to the Main-owned save boundary', async () => {
    await requestArtifactDownload({
      artifactId: 'artifact_1',
      artifactType: 'geojson',
      name: '杭州风险区划',
      uri: '/api/v1/results/artifact_1/file',
    })

    expect(requestDesktopDownload).toHaveBeenCalledWith(
      '/api/v1/results/artifact_1/file',
      '杭州风险区划.geojson',
    )
  })

  it('builds a fixed GeoJSON resource route instead of an external URL', async () => {
    await requestArtifactGeoJsonDownload({
      artifactId: 'artifact-map_1',
      name: '风险区划.geojson',
    })

    expect(requestDesktopDownload).toHaveBeenCalledWith(
      '/api/v1/results/artifact-map_1/geojson',
      '风险区划.geojson',
    )
  })

  it('fails before IPC when an Artifact has no server resource URI', async () => {
    expect(() => requestArtifactDownload({
      artifactId: 'artifact_1',
      artifactType: 'docx',
      name: '报告',
      uri: '  ',
    })).toThrow('没有可用的下载资源')
    expect(requestDesktopDownload).not.toHaveBeenCalled()
  })
})
