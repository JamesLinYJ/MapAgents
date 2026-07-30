// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 主进程组合根
//
//   文件:       index.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { app, session } from 'electron'

import { DesktopApiGateway } from './apiGateway.js'
import { installAppProtocol, registerPrivilegedAppScheme } from './appProtocol.js'
import { DesktopAuthGateway } from './authGateway.js'
import { DesktopControlGateway } from './controlGateway.js'
import { installDesktopPermissionPolicy } from './desktopPermissionPolicy.js'
import { DesktopShutdownCoordinator } from './desktopShutdownCoordinator.js'
import { DesktopDownloadService } from './downloadService.js'
import { createDesktopSystemLogger, type DesktopSystemLogger } from './desktopSystemLogger.js'
import { DesktopExportService } from './exportService.js'
import { FileHandleRegistry } from './fileHandleRegistry.js'
import { installDesktopIpcHandlers } from './ipcHandlers.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'
import { installNativeApplicationMenu } from './nativeMenus.js'
import { installResourceProtocol } from './resourceProtocol.js'
import { resolveDesktopRuntimeConfig } from './runtimeConfig.js'
import { handleSquirrelLifecycle } from './squirrelLifecycle.js'
import { safeStartupMessage } from './startupFailureDocument.js'
import { showStartupFailureWindow } from './startupFailureWindow.js'
import { DesktopSupervisorGateway } from './supervisorGateway.js'
import { DesktopTypedConfirmationWindow } from './typedConfirmationWindow.js'
import { WorkspaceWindowRegistry } from './windowRegistry.js'

const isSquirrelLifecycle = handleSquirrelLifecycle({
  platform: process.platform,
  arguments: process.argv,
  executablePath: process.execPath,
  quit: () => app.quit(),
})

if (!isSquirrelLifecycle) {
  registerPrivilegedAppScheme()
  const hasSingleInstanceLock = app.requestSingleInstanceLock()
  if (!hasSingleInstanceLock) {
    app.quit()
  } else {
    void launchDesktop().catch(async error => {
      await app.whenReady()
      console.error(`[desktop_startup_failed] ${safeStartupMessage(error)}`)
      showStartupFailureWindow(error)
    })
  }
  app.on('window-all-closed', () => app.quit())
}

async function launchDesktop(): Promise<void> {
  await app.whenReady()
  const logger = createDesktopSystemLogger()
  try {
    await startDesktop(logger)
  } catch (error) {
    logger.error('desktop_startup_failed', error)
    showStartupFailureWindow(error)
  }
}

async function startDesktop(logger: DesktopSystemLogger): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('GeoForge.Desktop')
  app.setAboutPanelOptions({
    applicationName: 'GeoForge',
    applicationVersion: app.getVersion(),
    copyright: 'GeoForge 地理智能平台',
    version: app.getVersion(),
  })
  const runtime = resolveDesktopRuntimeConfig(process.env)
  logger.info('desktop_starting', {
    profile: runtime.profile,
    runtimeManifestConfigured: runtime.runtimeManifestPath !== null,
    autoAuth: runtime.autoAuth !== null,
  })
  await installAppProtocol()

  const files = new FileHandleRegistry()
  const windows = new WorkspaceWindowRegistry(files)
  const auth = new DesktopAuthGateway(runtime.apiBaseUrl, { autoAuth: runtime.autoAuth })
  const microphone = new MicrophonePermissionGate()
  const revokeMicrophoneOnAuthChange = auth.onAuthorizationChanged(() => {
    microphone.revokeAll()
  })
  installDesktopPermissionPolicy(session.defaultSession, microphone)
  await installResourceProtocol(runtime.apiBaseUrl, auth)
  const control = new DesktopControlGateway(runtime.apiBaseUrl, auth)
  const supervisor = new DesktopSupervisorGateway(runtime, logger)
  const shutdown = new DesktopShutdownCoordinator(
    auth,
    supervisor,
    new DesktopTypedConfirmationWindow(),
    app,
  )
  const uninstallNativeMenu = installNativeApplicationMenu({
    authorization: auth,
    shutdown,
  })
  installDesktopIpcHandlers({
    api: new DesktopApiGateway(runtime.apiBaseUrl, auth),
    auth,
    control,
    downloads: new DesktopDownloadService(runtime.apiBaseUrl, auth),
    exports: new DesktopExportService(runtime.apiBaseUrl, auth),
    files,
    logger,
    microphone,
    supervisor,
    windows,
  })

  windows.openBootstrap()
  logger.info('desktop_ready', {
    profile: runtime.profile,
    autoAuth: runtime.autoAuth !== null,
  })
  app.on('second-instance', () => {
    const existing = windows.first()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
  })
  app.on('before-quit', () => {
    logger.info('desktop_stopping')
    uninstallNativeMenu()
    revokeMicrophoneOnAuthChange()
    control.close()
    supervisor.close()
    logger.close()
  })
  app.on('activate', () => {
    if (!windows.first()) {
      windows.openBootstrap()
    }
  })
}
