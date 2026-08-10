// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 主进程组合根
//
//   文件:       index.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app, net, session, utilityProcess } from 'electron'
import path from 'node:path'
import {
  PLATFORM_DESKTOP_USER_MODEL_ID,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'

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
import { DesktopDiagnosticExportService } from './diagnosticExportService.js'
import { LocalDesktopIdentityBroker } from './localDesktopIdentityBroker.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'
import { installNativeApplicationMenu } from './nativeMenus.js'
import { installResourceProtocol } from './resourceProtocol.js'
import { DesktopProductSetupService } from './productSetup.js'
import { installDesktopProductSetupIpcHandlers } from './productSetupIpc.js'
import { RemoteDesktopOperationsGateway } from './remoteOperationsGateway.js'
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
  if (process.platform === 'win32') app.setAppUserModelId(PLATFORM_DESKTOP_USER_MODEL_ID)
  app.setAboutPanelOptions({
    applicationName: PRODUCT_CODENAME,
    applicationVersion: app.getVersion(),
    copyright: '地理智能平台',
    version: app.getVersion(),
  })
  const setup = new DesktopProductSetupService({
    profile: app.isPackaged ? 'production' : 'development',
    environment: process.env,
    applicationPath: app.getAppPath(),
    platform: process.platform,
    userSetupPath: path.join(app.getPath('userData'), 'product-setup.v1.json'),
    fetch: (input, init) => net.fetch(input, init),
  })
  const startup = await setup.resolve()
  logger.info('desktop_starting', {
    profile: app.isPackaged ? 'production' : 'development',
    deploymentMode: startup.state === 'configured' ? startup.deploymentMode : 'setup_required',
  })
  await installAppProtocol()

  const files = new FileHandleRegistry()
  const windows = new WorkspaceWindowRegistry(files)
  let restartScheduled = false
  installDesktopProductSetupIpcHandlers({
    setup,
    windows,
    scheduleRestart: () => {
      if (restartScheduled) return
      restartScheduled = true
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 120)
    },
  })
  registerWindowLifecycle(windows)
  if (startup.state === 'required') {
    windows.openBootstrap()
    logger.info('desktop_setup_required')
    app.once('before-quit', () => logger.close())
    return
  }

  const runtime = startup.runtime
  const apiBaseUrl = startup.apiBaseUrl
  const autoAuth = runtime?.autoAuth ?? null
  const auth = new DesktopAuthGateway(apiBaseUrl, {
    autoAuth,
    managedIdentity: runtime?.autoAuth
      ? new LocalDesktopIdentityBroker(runtime, {
        fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      })
      : null,
  })
  const microphone = new MicrophonePermissionGate()
  const revokeMicrophoneOnAuthChange = auth.onAuthorizationChanged(() => {
    microphone.revokeAll()
  })
  installDesktopPermissionPolicy(session.defaultSession, microphone)
  await installResourceProtocol(apiBaseUrl, auth)
  const control = new DesktopControlGateway(apiBaseUrl, auth)
  const supervisor = runtime
    ? new DesktopSupervisorGateway(runtime, logger)
    : new RemoteDesktopOperationsGateway(apiBaseUrl, setup)
  const shutdown = new DesktopShutdownCoordinator(
    auth,
    supervisor,
    new DesktopTypedConfirmationWindow(),
    app,
  )
  const uninstallNativeMenu = installNativeApplicationMenu({
    authorization: auth,
    shutdown,
    localServiceControl: startup.deploymentMode === 'local_managed',
  })
  installDesktopIpcHandlers({
    api: new DesktopApiGateway(apiBaseUrl, auth),
    auth,
    control,
    downloads: new DesktopDownloadService(apiBaseUrl, auth),
    diagnosticExports: new DesktopDiagnosticExportService(),
    exports: new DesktopExportService(apiBaseUrl, auth),
    files,
    logger,
    microphone,
    supervisor,
    windows,
  })

  windows.openBootstrap()
  logger.info('desktop_ready', {
    profile: runtime?.profile ?? 'production',
    deploymentMode: startup.deploymentMode,
    autoAuth: autoAuth !== null,
  })
  app.on('before-quit', () => {
    logger.info('desktop_stopping')
    uninstallNativeMenu()
    revokeMicrophoneOnAuthChange()
    control.close()
    supervisor.close()
    void auth.close().catch(error => logger.error('desktop_identity_close_failed', error))
    logger.close()
  })
}

function registerWindowLifecycle(windows: WorkspaceWindowRegistry): void {
  app.on('second-instance', () => {
    const existing = windows.first()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
  })
  app.on('activate', () => {
    if (!windows.first()) windows.openBootstrap()
  })
}
