// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 安全预加载桥
//
//   文件:       index.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
//
//   维护记录 (2026-07-29):
//     作者: OpenAI Codex
//     说明: 删除 Renderer 文件路径反查，只暴露选择、受限文本读取和上传句柄。
// --------------------------------------------------------------------------

import { contextBridge, ipcRenderer } from 'electron'
import {
  operationsOperationResultSchema,
  operationsLogEntrySchema,
  operationsLogQuerySchema,
  operationsSnapshotSchema,
} from '@geo-agent-platform/shared-types/operations'

import type { DesktopBridge } from '../contracts/desktopBridge.js'
import {
  DESKTOP_IPC_CHANNELS,
  desktopApiOperationSchema,
  desktopApiResponseSchema,
  desktopUploadOperationSchema,
  desktopAuthBootstrapResultSchema,
  desktopAuthCommandSchema,
  desktopAuthProjectionSchema,
  desktopClipboardWriteSchema,
  desktopConfirmationRequestSchema,
  desktopControlRequestSchema,
  desktopControlResponseSchema,
  desktopRendererDiagnosticSchema,
  desktopDownloadRequestSchema,
  desktopDownloadResultSchema,
  desktopExportRequestSchema,
  desktopExportResultSchema,
  desktopFileSelectionHandlesSchema,
  desktopFileSelectionRequestSchema,
  desktopTextFileReadRequestSchema,
  desktopTextFileReadResultSchema,
  desktopMicrophonePermissionRequestSchema,
  desktopMicrophonePermissionResultSchema,
  desktopWindowCommandSchema,
  type DesktopAuthCommand,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import { decodeDesktopControlResponse } from './controlResponseDecoder.js'
import { decodeDesktopEvent } from './eventTransportDecoder.js'

const desktopPlatform = readDesktopPlatform(process.platform)

const bridge: DesktopBridge = {
  platform: desktopPlatform,
  api: {
    async request(input) {
      return desktopApiResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiRequest,
          desktopApiOperationSchema.parse(input),
        ),
      )
    },
    async upload(input) {
      return desktopApiResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiUpload,
          desktopUploadOperationSchema.parse(input),
        ),
      )
    },
    async download(input) {
      return desktopDownloadResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.apiDownload,
          desktopDownloadRequestSchema.parse(input),
        ),
      )
    },
  },
  auth: {
    async request(input) {
      const request = desktopControlRequestSchema.parse(input)
      const command = desktopAuthCommandSchema.parse({
        command: request.command,
        payload: request.payload,
      })
      const response = desktopControlResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.authRequest,
          request,
        ),
      )
      return validateDesktopAuthResponse(command, response)
    },
  },
  clipboard: {
    async writeText(text) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.clipboardWrite,
        desktopClipboardWriteSchema.parse({ text }),
      )
    },
  },
  dialog: {
    async confirm(input) {
      const result: unknown = await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.dialogConfirm,
        desktopConfirmationRequestSchema.parse(input),
      )
      if (typeof result !== 'boolean') {
        throw new Error('桌面确认框返回了无效结果。')
      }
      return result
    },
  },
  diagnostics: {
    async report(input) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.diagnosticReport,
        desktopRendererDiagnosticSchema.parse(input),
      )
    },
  },
  control: {
    async request(input) {
      return await decodeDesktopControlResponse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.controlRequest,
          desktopControlRequestSchema.parse(input),
        ),
      )
    },
  },
  files: {
    async select(input) {
      return desktopFileSelectionHandlesSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.fileSelect,
          desktopFileSelectionRequestSchema.parse(input),
        ),
      )
    },
    async readText(input) {
      return desktopTextFileReadResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.fileReadText,
          desktopTextFileReadRequestSchema.parse(input),
        ),
      )
    },
  },
  permissions: {
    async requestSpeechMicrophone() {
      return desktopMicrophonePermissionResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.microphonePermission,
          desktopMicrophonePermissionRequestSchema.parse({
            purpose: 'speech-recognition',
          }),
        ),
      )
    },
  },
  export: {
    async create(input) {
      return desktopExportResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.exportRequest,
          desktopExportRequestSchema.parse(input),
        ),
      )
    },
  },
  supervisor: {
    async status() {
      return operationsSnapshotSchema.parse(
        await invokeSupervisor('status', {}),
      )
    },
    async startAll(operationId) {
      return operationsOperationResultSchema.parse(
        await invokeSupervisor('start', { target: 'all', operationId }),
      )
    },
    async logs(query) {
      return operationsLogEntrySchema.array().parse(
        await invokeSupervisor('logs', operationsLogQuerySchema.parse(query)),
      )
    },
  },
  window: {
    async command(input) {
      await ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.windowCommand,
        desktopWindowCommandSchema.parse(input),
      )
    },
  },
  events: {
    subscribe(listener) {
      const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
        void decodeDesktopEvent(input).then(listener).catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error))
        })
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.event, handler)
    },
  },
}

contextBridge.exposeInMainWorld('geoforgeDesktop', bridge)

async function invokeSupervisor(
  command: 'status' | 'start' | 'logs',
  payload: Record<string, unknown>,
): Promise<unknown> {
  const request = desktopControlRequestSchema.parse({
    version: 1,
    requestId: crypto.randomUUID(),
    command,
    payload,
  })
  const response = desktopControlResponseSchema.parse(
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.supervisorRequest, request),
  )
  if (!response.ok) {
    throw new Error(response.error?.message ?? '本机监督器请求失败。')
  }
  return response.data
}

function readDesktopPlatform(platform: NodeJS.Platform): DesktopBridge['platform'] {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  throw new Error(`GeoForge 桌面端不支持当前操作系统：${platform}`)
}

function validateDesktopAuthResponse(
  command: DesktopAuthCommand,
  response: DesktopControlResponse,
): DesktopControlResponse {
  if (!response.ok) return response
  if (command.command === 'bootstrap') {
    return {
      ...response,
      data: desktopAuthBootstrapResultSchema.parse(response.data),
    }
  }
  if (command.command === 'projection') {
    return {
      ...response,
      data: desktopAuthProjectionSchema.parse(response.data),
    }
  }
  if (response.data !== null) {
    throw new Error('桌面认证写操作返回了不允许投影到 Renderer 的数据。')
  }
  return response
}
