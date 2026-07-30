// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面桥接口
//
//   文件:       desktopBridge.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  DesktopApiOperation,
  DesktopApiResponse,
  DesktopControlRequest,
  DesktopControlResponse,
  DesktopConfirmationRequest,
  DesktopRendererDiagnostic,
  DesktopDownloadRequest,
  DesktopDownloadResult,
  DesktopEvent,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopFileSelectionHandle,
  DesktopFileSelectionRequest,
  DesktopTextFileReadRequest,
  DesktopTextFileReadResult,
  DesktopMicrophonePermissionResult,
  DesktopWindowCommand,
  DesktopUploadOperation,
} from './desktopIpc.js'
import type {
  OperationsOperationResult,
  OperationsLogEntry,
  OperationsLogQuery,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'

export interface DesktopBridge {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly api: {
    request(operation: DesktopApiOperation): Promise<DesktopApiResponse>
    upload(operation: DesktopUploadOperation): Promise<DesktopApiResponse>
    download(request: DesktopDownloadRequest): Promise<DesktopDownloadResult>
  }
  readonly auth: {
    request(request: DesktopControlRequest): Promise<DesktopControlResponse>
  }
  readonly clipboard: {
    writeText(text: string): Promise<void>
  }
  readonly dialog: {
    confirm(request: DesktopConfirmationRequest): Promise<boolean>
  }
  readonly diagnostics: {
    report(diagnostic: DesktopRendererDiagnostic): Promise<void>
  }
  readonly control: {
    request(request: DesktopControlRequest): Promise<DesktopControlResponse>
  }
  readonly files: {
    select(request: DesktopFileSelectionRequest): Promise<DesktopFileSelectionHandle[]>
    readText(request: DesktopTextFileReadRequest): Promise<DesktopTextFileReadResult>
  }
  readonly permissions: {
    requestSpeechMicrophone(): Promise<DesktopMicrophonePermissionResult>
  }
  readonly export: {
    create(request: DesktopExportRequest): Promise<DesktopExportResult>
  }
  readonly supervisor: {
    status(): Promise<OperationsSnapshot>
    startAll(operationId: string): Promise<OperationsOperationResult>
    logs(query: OperationsLogQuery): Promise<OperationsLogEntry[]>
  }
  readonly window: {
    command(command: DesktopWindowCommand): Promise<void>
  }
  readonly events: {
    subscribe(listener: (event: DesktopEvent) => void): () => void
  }
}
