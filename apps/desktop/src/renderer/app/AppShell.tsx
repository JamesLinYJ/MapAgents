// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作台应用壳
//
//   文件:       AppShell.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//
//   维护记录 (2026-07-29):
//     作者: OpenAI Codex
//     说明: 迁移为 Electron 桌面文档工作台装配层。
// --------------------------------------------------------------------------

// 模块职责
//
// 负责装配桌面文档、工作区布局和领域控制器的 UI 投影。

import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { domAnimation, LazyMotion, MotionConfig } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'

import './AppShell.css'
import './styles/glass.css'
import './styles/markdown.css'
import './styles/conversation.css'
import './styles/map.css'
import './styles/layers.css'
import './styles/layout.css'
import './styles/tools-debug.css'
import './styles/desktop.css'
import { listAdminWorkspaces, logout, requestDesktopDownload } from '../api/client'
import { requireDesktopBridge } from '../api/transport'
import { TopBar } from './layout/TopBar'
import { WorkspaceConversationPanel } from './layout/WorkspaceConversationPanel'
import type { DesktopDocument } from './layout/WorkspaceLayout'
import { WorkspaceInspectorPanel } from './layout/WorkspaceInspectorPanel'
import { WorkspaceMapPanel } from './layout/WorkspaceMapPanel'
import { WorkspaceToolPanel } from './layout/WorkspaceToolPanel'
import { WorkspaceWorkflowPanel } from './layout/WorkspaceWorkflowPanel'
import {
  WorkspaceRestrictedContents,
  WorkspaceRestrictedConversation,
  WorkspaceRestrictedDocument,
} from './layout/WorkspaceRestrictedPanels'
import { AccountCenterPage, LegalPolicyPage, WorkspaceRouteHost } from './layout/WorkspaceRouteHost'
import { useWorkspaceMapActivation } from './layout/useWorkspaceMapActivation'
import {
  formatUiError,
  reportNonBlockingError,
} from './bootstrap'
import { projectTimeline } from '../features/conversation/timelineProjector'
import { exportWorkspaceResult } from '../features/export/desktopExport'
import {
  ExportWizard,
  type ExportWizardSelection,
} from '../features/export/ExportWizard'
import {
  useConnectionController,
  useNavigationController,
  useWorkspaceResources,
  useRunController,
  useSessionThreadController,
  useToolingController,
} from './controllers'
import type {
  SidebarItemId,
} from './types'
import { useMemoryEntries } from './useMemoryEntries'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap'
import { LoginScreen } from './auth/LoginScreen'
import {
  buildAgentTodoItems,
  buildDataReferences,
  buildProgressItems,
  extractActiveMcpServers,
  extractActiveSkills,
  extractCompactionLevel,
  extractDenialCounts,
  extractRunStats,
  extractTokenBudget,
  formatModelRunStatus,
} from './derivedState'
import { useWorkspaceRunProjection } from './controllers/useWorkspaceRunProjection'
import { useThreadLifecycleActions } from './controllers/useThreadLifecycleActions'
import { useRunLifecycleActions } from './controllers/useRunLifecycleActions'
import { useToolExecutionAction } from './controllers/useToolExecutionAction'
import { subscribeDesktopDocument } from './desktopNavigation'
import { useBackendAvailabilityStore } from './stores/backendAvailabilityStore'
import {
  deriveDesktopWorkspaceAccess,
  shouldShowDesktopLogin,
} from './workspaceAccess'

function useVoidCallback<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  return useCallback((...args: Args) => { void fn(...args) }, [fn])
}

function AppShell() {
  // 主应用壳
  //
  // 装配会话、运行、资源、工具和导航控制器的页面投影。
  // 网络语义和实时订阅分别由控制器与 useRunState 所有。
  const desktopPathname = '/'
  const [activeDesktopDocument, setActiveDesktopDocument] = useState<DesktopDocument>('map')
  const [exportWizardOpen, setExportWizardOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  useEffect(() => subscribeDesktopDocument(setActiveDesktopDocument), [])
  const {
    activateMap,
    isMapActivated,
    mapFocusRequest,
    requestMapFocus,
  } = useWorkspaceMapActivation(desktopPathname)

  const {
    run, agentState, intent, agentWorkflow,
    events, artifacts, isSubmitting, uiError,
    placeResolution,
    clearRun,
    items,
    hydrateRun,
    acceptRun,
    startRun,
    stopSubmitting,
    setError: setUiError,
    cancelRun,
    respondDecision,
    steerRun,
    startAnalysis,
    startThreadRun,
  } = useRunController()
  const {
    activeThreadId,
    canonicalThreadItems,
    clearCanonicalThreadItems,
    ensureActiveThread: ensureSessionActiveThread,
    getThread,
    getThreadHistory,
    forkFromMessage,
    hasMoreRunHistory,
    isRunHistoryLoading,
    loadRunHistory,
    loadWorkspaceBootstrap,
    purgeTrashedThread,
    refreshTrash,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    removeThread,
    renameThread,
    restoreTrashedThread,
    session,
    sessionRuns,
    sessionThreads,
    setActiveThreadId,
    setCanonicalThreadItems,
    setSession,
    setThreadRuns,
    threadRuns,
    trashedThreads,
  } = useSessionThreadController()
  const deferredEvents = useDeferredValue(events)
  const deferredItems = useDeferredValue(items)
  // 当前 run 快照只负责实时变化；完整 thread transcript 由 canonical history 投影补齐。
  const threadConversationItems = useMemo(
    () => projectTimeline(canonicalThreadItems, deferredItems),
    [canonicalThreadItems, deferredItems],
  )
  const {
    applyProviders,
    changeProvider: handleProviderChange,
    model,
    provider,
    providers,
    setModel,
    setProvider,
  } = useConnectionController()
  const currentThreadId = run?.threadId ?? agentState?.threadId ?? activeThreadId
  useEffect(() => {
    void requireDesktopBridge().window.command({
      action: 'set-taskbar-progress',
      progress: taskbarProgressForRun(run?.status),
    }).catch(error => {
      reportNonBlockingError('taskbarProgress', error)
    })
  }, [run?.status])
  useEffect(() => {
    return () => {
      void requireDesktopBridge().window.command({
        action: 'set-taskbar-progress',
        progress: { state: 'none', value: null },
      }).catch(() => undefined)
    }
  }, [])
  const {
    changeWorkspaceMode,
    focusQueryInput,
    openWorkflowInspector,
    panelMode,
    query,
    readWorkspacePointer,
    selectSample: handleSampleSelect,
    selectSidebarItem: handleSidebarItemClick,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    showSources,
    syncUrl,
    useNextTemplate: handleUseTemplate,
    workspaceMode,
  } = useNavigationController()
  const {
    applyToolDescriptors,
    availableTools,
    backgroundTasks,
    isRuntimeConfigSubmitting,
    isToolCatalogSubmitting,
    isToolSubmitting,
    isAutomationSubmitting,
    promoteTask: handlePromoteBackgroundTask,
    removeCatalogEntry: handleDeleteToolCatalogEntry,
    removeScheduledTask: handleDeleteScheduledTask,
    runtimeConfig,
    runTool,
    runAutomation: handleStartAutomation,
    saveCatalogEntry: handleUpsertToolCatalogEntry,
    saveRuntimeConfig: handleSaveRuntimeConfig,
    saveScheduledTask: handleSaveScheduledTask,
    setIsToolSubmitting,
    setToolRunResult,
    stopBackgroundTask: handleCancelBackgroundTask,
    stopAutomation: handleCancelAutomation,
    systemComponents,
    scheduledTasks,
    toolCatalogEntries,
    toolRunResult,
    tokenUsageSummary,
    automationDefinitions,
    automationDiagnostics,
    automationValidation,
    automationRuns,
    validateAutomationDraft: handleValidateAutomation,
    createAutomationDraft: handleCreateAutomation,
    updateAutomationDraft: handleUpdateAutomation,
    publishAutomationDraft: handlePublishAutomation,
    disableAutomationDefinition: handleDisableAutomation,
    respondToAutomationApproval: handleRespondAutomationApproval,
  } = useToolingController({
    loadDiagnostics: location.pathname === '/debug' || panelMode === 'compute' || panelMode === 'config' || panelMode === 'tools',
    setUiError,
  })
  const ensureActiveThread = useCallback(
    (title: string) => ensureSessionActiveThread(currentThreadId, syncUrl, title),
    [currentThreadId, ensureSessionActiveThread, syncUrl],
  )

  const {
    allFiles,
    artifactData,
    artifactMetadata,
    basemaps,
    changeArtifactOpacity: handleArtifactOpacityChange,
    clearArtifacts,
    clearUploads,
    exportLayer: handleExportLayer,
    importLayer: handleImportManagedLayer,
    isFileSubmitting,
    layerManager,
    layers,
    loadBasemaps,
    mapScene,
    mapLayers,
    refreshLayers,
    removeFile: handleDeleteAnyFile,
    removeLayer: handleDeleteLayer,
    replaceLayer: handleReplaceManagedLayer,
    selectedArtifactId,
    selectedBasemap,
    selectedBasemapKey,
    setSelectedArtifactId,
    setSelectedBasemapKey,
    toggleArtifactVisibility: handleToggleArtifactVisibility,
    toggleLayerStatus: handleToggleLayerStatus,
    uploadedLayerName,
    uploadFile: handleUploadAnyFile,
    uploadFiles: handleUploadFiles,
    uploadReferences,
  } = useWorkspaceResources({
    artifacts,
    currentThreadId,
    ensureActiveThread,
    layerPreferenceKey: `${currentThreadId ?? 'no-thread'}:${run?.id ?? 'no-run'}`,
    onSessionRecord: setSession,
    onShowSources: showSources,
    runStatus: run?.status,
    session,
    setUiError,
  })

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId),
    [artifacts, selectedArtifactId],
  )
  const providerLabel = providers.find((item) => item.provider === provider)?.displayName ?? provider
  const currentThreadTitle = sessionThreads.find((item) => item.id === currentThreadId)?.title
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    agentWorkflow,
    artifacts,
    events: deferredEvents,
  })
  const compactionLevel = useMemo(() => extractCompactionLevel(deferredEvents), [deferredEvents])
  const tokenBudget = useMemo(() => extractTokenBudget(events), [events])
  const activeSkills = useMemo(() => extractActiveSkills(deferredEvents, agentState), [agentState, deferredEvents])
  const activeMcpServers = useMemo(() => extractActiveMcpServers(deferredEvents, agentState), [agentState, deferredEvents])
  const runStats = useMemo(() => extractRunStats(events), [events])
  const denialCounts = useMemo(() => extractDenialCounts(agentState), [agentState])

  const progressTasks = useMemo(
    () => buildAgentTodoItems(agentState, agentWorkflow),
    [agentState, agentWorkflow],
  )

  const dataReferences = useMemo(
    () => buildDataReferences({ layers, uploadReferences, files: allFiles, artifacts, threadRuns, currentThreadId }),
    [allFiles, artifacts, currentThreadId, layers, threadRuns, uploadReferences],
  )
  const handleLayerZoomTo = useCallback((mapLayerId: string) => {
    const target = mapScene.layers.find(layer => layer.manifest.mapLayerId === mapLayerId)
    if (target?.manifest.artifactId) setSelectedArtifactId(target.manifest.artifactId)
    requestMapFocus(mapLayerId)
  }, [mapScene.layers, requestMapFocus, setSelectedArtifactId])

  const { clearActiveRunState, hydrateRunState } = useWorkspaceRunProjection({
    clearArtifacts,
    clearCanonicalThreadItems,
    clearRun,
    hydrateRun,
    setActiveThreadId,
    setModel,
    setProvider,
    setSelectedArtifactId,
    setThreadRuns,
    setToolRunResult,
    syncUrl,
  })

  const { authMe, authStatus, authMode, clearAuth, retryAuth } = useWorkspaceBootstrap({
    applyProviders,
    applyTools: applyToolDescriptors,
    clearActiveRunState,
    getThreadHistory,
    hydrateRunState,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setCanonicalThreadItems,
    setUiError,
    syncUrl,
    disabled: false,
    syncWorkspaceUrl: true,
  })
  const backendOnlineRevision = useBackendAvailabilityStore(state => state.onlineRevision)
  const backendAvailability = useBackendAvailabilityStore(state => state.availability)
  const backendError = useBackendAvailabilityStore(state => state.errorMessage)
  const workspaceAccess = useMemo(() => deriveDesktopWorkspaceAccess({
    authStatus,
    backendAvailability,
    backendError,
    authenticationError: uiError,
    hasAuthenticatedIdentity: Boolean(authMe),
    platformRoles: authMe?.platformRoles,
  }), [
    authMe,
    authStatus,
    backendAvailability,
    backendError,
    uiError,
  ])
  const previousBackendOnlineRevision = useRef(backendOnlineRevision)
  useEffect(() => {
    if (
      backendOnlineRevision > previousBackendOnlineRevision.current
      && authStatus === 'error'
    ) {
      retryAuth()
    }
    previousBackendOnlineRevision.current = backendOnlineRevision
  }, [authStatus, backendOnlineRevision, retryAuth])
  const visibleWorkspacesQuery = useQuery({
    queryKey: ['desktop', 'visible-workspaces', authMe?.user.userId],
    queryFn: listAdminWorkspaces,
    enabled: workspaceAccess.backendActionsEnabled,
    staleTime: 60_000,
  })
  const handleExportResults = useCallback(() => {
    const workspaceId = session?.workspaceId ?? authMe?.defaultWorkspace?.workspaceId
    if (!workspaceId || !session?.id || !currentThreadId) {
      setUiError('当前工作区或对话尚未就绪，无法导出成果。')
      return
    }
    setExportWizardOpen(true)
  }, [
    authMe?.defaultWorkspace?.workspaceId,
    currentThreadId,
    session?.id,
    session?.workspaceId,
    setUiError,
  ])
  const handleConfirmExport = useCallback(async (selection: ExportWizardSelection) => {
    const workspaceId = session?.workspaceId ?? authMe?.defaultWorkspace?.workspaceId
    if (!workspaceId || !session?.id || !currentThreadId) {
      setUiError('当前工作区或对话尚未就绪，无法导出成果。')
      return
    }
    setExportBusy(true)
    try {
      setActiveDesktopDocument('map')
      activateMap()
      await waitForDesktopPaint()
      const result = await exportWorkspaceResult({
        workspaceId,
        sessionId: session.id,
        threadId: currentThreadId,
        title: currentThreadTitle || 'GeoForge 分析成果',
        formats: selection.formats,
        artifactIds: selection.artifactIds,
      })
      if (!result.canceled) setExportWizardOpen(false)
    } catch (error) {
      setUiError(formatUiError(error, '成果导出失败。'))
    } finally {
      setExportBusy(false)
    }
  }, [
    activateMap,
    authMe?.defaultWorkspace?.workspaceId,
    currentThreadId,
    currentThreadTitle,
    session?.id,
    session?.workspaceId,
    setUiError,
  ])
  const handleDownloadArtifact = useCallback(async () => {
    if (!selectedArtifact) {
      setUiError('请先选择需要下载的结果。')
      return
    }
    const extension = selectedArtifact.artifactType === 'geojson' ? 'geojson' : 'bin'
    try {
      await requestDesktopDownload(
        `/api/v1/results/${encodeURIComponent(selectedArtifact.artifactId)}/${selectedArtifact.artifactType === 'geojson' ? 'geojson' : 'file'}`,
        `${selectedArtifact.name}.${extension}`,
      )
    } catch (error) {
      setUiError(formatUiError(error, '结果文件下载失败。'))
    }
  }, [selectedArtifact, setUiError])
  useEffect(() => {
    const desktopBridge = window.geoforgeDesktop
    if (!session?.workspaceId || !desktopBridge) return
    const defaultWorkspace = authMe?.defaultWorkspace
    const workspaceName = defaultWorkspace?.workspaceId === session.workspaceId
      ? defaultWorkspace.name
      : `工作区 ${session.workspaceId.slice(0, 12)}`
    void desktopBridge.window.command({
      action: 'bind-workspace',
      workspace: {
        workspaceId: session.workspaceId,
        workspaceName,
        sessionId: session.id,
        threadId: currentThreadId ?? null,
      },
    })
  }, [
    authMe?.defaultWorkspace,
    currentThreadId,
    session?.id,
    session?.workspaceId,
  ])
  const { memoryEntries, refreshMemoryEntries } = useMemoryEntries(
    workspaceAccess.backendActionsEnabled && runtimeConfig?.context.memoryEnabled !== false,
  )

  useEffect(() => {
    if (!workspaceAccess.backendActionsEnabled || !session?.id) return
    if (panelMode !== 'history') return
    void loadRunHistory(session.id).catch(error => {
      setUiError(formatUiError(error, '运行历史加载失败。'))
    })
  }, [loadRunHistory, panelMode, session?.id, setUiError, workspaceAccess.backendActionsEnabled])

  const panelNeedsWorkspaceResources = panelMode === 'layers' || panelMode === 'sources' || panelMode === 'layerManager'
  const shouldLoadWorkspaceResources = isMapActivated || panelNeedsWorkspaceResources

  useEffect(() => {
    if (!workspaceAccess.backendActionsEnabled || !session?.id || !shouldLoadWorkspaceResources) return
    void Promise.allSettled([
      loadBasemaps(),
      refreshLayers(session.id, currentThreadId),
    ]).then(results => {
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') reportNonBlockingError('workspaceResources', rejected.reason)
    })
  }, [
    currentThreadId,
    loadBasemaps,
    refreshLayers,
    session?.id,
    shouldLoadWorkspaceResources,
    workspaceAccess.backendActionsEnabled,
  ])

  const { handleInterruptRun, handleRespondDecision, handleSubmit } = useRunLifecycleActions({
    session,
    currentThreadId,
    query,
    items,
    providers,
    provider,
    model,
    run,
    acceptRun,
    cancelRun,
    clearArtifacts,
    clearCanonicalThreadItems,
    hydrateRunState,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    steerRun,
    setActiveNav,
    setActiveThreadId,
    setActiveSidebarItem,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    stopSubmitting,
    syncUrl,
  })

  const {
    handleDeleteThread,
    handleForkMessage,
    handleLoadMoreHistory,
    handleNewConversation,
    handlePurgeThread,
    handleRefreshMemories,
    handleRefreshTrash,
    handleRenameThread,
    handleRestoreThread,
    handleSelectThread,
  } = useThreadLifecycleActions({
    session,
    currentThreadId,
    clearActiveRunState,
    clearUploads,
    focusQueryInput,
    forkFromMessage,
    getThread,
    getThreadHistory,
    hasMoreRunHistory,
    hydrateRunState,
    isRunHistoryLoading,
    loadRunHistory,
    purgeTrashedThread,
    refreshMemoryEntries,
    refreshTrash,
    removeThread,
    renameThread,
    restoreTrashedThread,
    setActiveNav,
    setActiveSidebarItem,
    setActiveThreadId,
    setCanonicalThreadItems,
    setPanelMode,
    setQuery,
    setThreadRuns,
    setUiError,
    syncUrl,
  })

  const onRespondDecisionAction = useVoidCallback(handleRespondDecision)
  const onSelectTaskAction = useVoidCallback(handleSelectThread)
  const onRenameTaskAction = useVoidCallback(handleRenameThread)
  const onDeleteTaskAction = useVoidCallback(handleDeleteThread)
  const onForkMessageAction = useVoidCallback(handleForkMessage)
  const onRefreshMemoriesAction = useVoidCallback(handleRefreshMemories)
  const onRefreshTrashAction = useVoidCallback(handleRefreshTrash)
  const onRestoreThreadAction = useVoidCallback(handleRestoreThread)
  const onPurgeThreadAction = useVoidCallback(handlePurgeThread)
  const handleRunTool = useToolExecutionAction({
    sessionId: session?.id,
    threadId: currentThreadId,
    runId: run?.id,
    hydrateRunState,
    runTool,
    setIsToolSubmitting,
    setToolRunResult,
    setUiError,
    syncUrl,
  })
  const handleOpenWorkspace = useCallback((workspaceId: string) => {
    const workspace = visibleWorkspacesQuery.data?.find(item => item.workspaceId === workspaceId)
    const desktopBridge = window.geoforgeDesktop
    if (!workspace || !desktopBridge) return
    void desktopBridge.window.command({
      action: 'open-workspace',
      workspace: {
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        sessionId: null,
        threadId: null,
      },
    })
  }, [visibleWorkspacesQuery.data])

  const handleLogout = async () => {
    if (!authMe) {
      retryAuth()
      return
    }
    try {
      await logout()
    } finally {
      clearAuth()
      setUiError(undefined)
      if (authMode === 'local_auto') retryAuth()
    }
  }
  const remoteUnavailableReason = workspaceAccess.unavailableReason
    ?? '远程服务当前不可用。地图与本地布局仍可使用。'
  const showInteractiveLogin = shouldShowDesktopLogin({
    authMode,
    authStatus,
    backendAvailability,
    hasAuthenticatedIdentity: Boolean(authMe),
  })

  const renderInspectorPanel = (variant: 'contents' | 'results') => (
    <WorkspaceInspectorPanel
      panelMode={variant === 'contents' ? 'layerManager' : panelMode}
      showProgress={variant === 'results'}
      currentRunId={run?.id}
      runStatus={run?.status}
      agentState={agentState}
      items={deferredItems}
      artifacts={artifacts}
      artifactData={artifactData}
      mapLayers={mapLayers}
      layers={layers}
      events={deferredEvents}
      sessionRuns={sessionRuns}
      hasMoreHistory={hasMoreRunHistory}
      isHistoryLoading={isRunHistoryLoading}
      progressItems={progressItems}
      selectedArtifactId={selectedArtifactId}
      uploadedLayerName={uploadedLayerName}
      selectedBasemapName={selectedBasemap.name}
      provider={provider}
      model={model}
      providers={providers}
      systemComponents={systemComponents}
      isToolSubmitting={isToolSubmitting}
      onSelectArtifact={setSelectedArtifactId}
      onToggleArtifactVisibility={handleToggleArtifactVisibility}
      onChangeArtifactOpacity={handleArtifactOpacityChange}
      onSelectHistoryRun={(runId) => {
        void hydrateRunState(runId)
        setPanelMode('history')
        setActiveNav('history')
      }}
      onLoadMoreHistory={handleLoadMoreHistory}
      onDownloadArtifact={() => {
        void handleDownloadArtifact()
      }}
      onExportResults={() => {
        void handleExportResults()
      }}
      onProviderChange={handleProviderChange}
      onModelChange={setModel}
      onImportManagedLayer={(file) => {
        void handleImportManagedLayer(file)
      }}
      onReplaceManagedLayer={(layerKey, file) => {
        void handleReplaceManagedLayer(layerKey, file)
      }}
      onToggleLayerStatus={(layerKey, nextStatus) => {
        void handleToggleLayerStatus(layerKey, nextStatus)
      }}
      onDeleteLayer={(layerKey) => {
        void handleDeleteLayer(layerKey)
      }}
      onRefreshManagedLayers={() => {
        void refreshLayers(session?.id, currentThreadId)
      }}
      onCloseLayerManager={variant === 'results' ? () => setPanelMode('summary') : undefined}
      layerTree={layerManager.tree}
      layerSelectedId={layerManager.selectedId}
      layerSearchQuery={layerManager.searchQuery}
      layerTotalCount={layerManager.totalCount}
      layerVisibleCount={layerManager.visibleCount}
      layerSelectedNode={layerManager.selectedNode}
      layerActiveView={layerManager.activeView}
      layerVisibilityFilter={layerManager.visibilityFilter}
      layerOperationError={layerManager.operationError}
      onLayerSelect={layerManager.selectLayer}
      onLayerToggleVisibility={layerManager.toggleVisibility}
      onLayerToggleAllVisibility={layerManager.toggleAllVisibility}
      onLayerSetOpacity={layerManager.setOpacity}
      onLayerSetColor={layerManager.setColor}
      onLayerRename={layerManager.renameLayer}
      onLayerMoveUp={layerManager.moveUp}
      onLayerMoveDown={layerManager.moveDown}
      onLayerMoveTo={layerManager.moveTo}
      onLayerRemove={layerManager.removeLayer}
      onLayerCreateGroup={layerManager.createGroup}
      onLayerToggleGroup={layerManager.toggleGroup}
      onLayerSetSearchQuery={layerManager.setSearchQuery}
      onLayerZoomTo={handleLayerZoomTo}
      onLayerExport={handleExportLayer}
      onLayerSetActiveView={layerManager.setActiveView}
      onLayerSetVisibilityFilter={layerManager.setVisibilityFilter}
      onLayerSetLabelEnabled={layerManager.setLabelEnabled}
      onLayerSetLabelField={layerManager.setLabelField}
      layerSceneManagedLayerKeys={layerManager.sceneManagedLayerKeys}
      onLayerAddReference={layerManager.addReferenceLayer}
      onLayerRemoveReference={layerManager.removeReferenceLayer}
      allFiles={allFiles}
      onUploadFile={(file) => { void handleUploadAnyFile(file) }}
      onDeleteFile={(fileId) => { void handleDeleteAnyFile(fileId) }}
      isFileSubmitting={isFileSubmitting}
      tasks={variant === 'contents' ? [] : progressTasks}
      onOpenHistory={() => setPanelMode('history')}
    />
  )

  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载页面…</div>}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <WorkspaceRouteHost
            account={authMe && workspaceAccess.canAccessAccount
              ? <AccountCenterPage authMe={authMe} onLogout={handleLogout} />
              : <WorkspaceRestrictedDocument title="账号中心" reason={remoteUnavailableReason} />}
            canAccessDiagnostics={workspaceAccess.canAccessDiagnostics}
            canAccessSecurity={workspaceAccess.canAccessSecurity}
            terms={<LegalPolicyPage kind="terms" />}
            privacy={<LegalPolicyPage kind="privacy" />}
            renderWorkspace={(Workspace, desktopDocuments) => (
              <>
                {exportWizardOpen && (
                  <ExportWizard
                    open
                    title={currentThreadTitle || 'GeoForge 分析成果'}
                    artifacts={artifacts}
                    defaultArtifactId={selectedArtifact?.artifactId ?? artifacts.at(-1)?.artifactId}
                    busy={exportBusy}
                    onOpenChange={setExportWizardOpen}
                    onConfirm={handleConfirmExport}
                  />
                )}
                <Workspace
                  desktopDocuments={desktopDocuments}
                activeDesktopDocument={activeDesktopDocument}
                onDesktopDocumentChange={setActiveDesktopDocument}
                topBar={
                  <TopBar
                    authMe={authMe}
                    workspaces={visibleWorkspacesQuery.data ?? []}
                    activeWorkspaceId={session?.workspaceId ?? authMe?.defaultWorkspace?.workspaceId ?? null}
                    onLogout={handleLogout}
                    unavailableReason={workspaceAccess.unavailableReason}
                    onOpenDocument={setActiveDesktopDocument}
                    onOpenWorkspace={handleOpenWorkspace}
                  />
                }
                onSidebarItemClick={(itemId) => handleSidebarItemClick(itemId as SidebarItemId)}
                dataReferenceCount={dataReferences.length}
                selectedBasemapName={selectedBasemap.name}
                uploadedLayerName={uploadedLayerName}
                providerLabel={providerLabel}
                modelLabel={model || '默认'}
                modelStatusLabel={formatModelRunStatus(run?.status)}
                artifactCount={artifacts.length}
                selectedArtifactName={selectedArtifact?.name}
                currentThreadId={currentThreadId}
                workspaceLayoutKey={
                  session?.workspaceId
                    ?? authMe?.defaultWorkspace?.workspaceId
                    ?? 'unbound-workspace'
                }
                sessionThreads={sessionThreads}
                onNewTask={handleNewConversation}
                onSelectThread={onSelectTaskAction}
                workspaceMode={workspaceMode}
                onWorkspaceModeChange={changeWorkspaceMode}
                onContentsModeChange={(mode) => {
                  layerManager.setActiveView(mode === 'sources' ? 'sources' : 'drawOrder')
                }}
                onExportResults={() => {
                  void handleExportResults()
                }}
                backendActionDisabledReason={workspaceAccess.unavailableReason}
                canAccessAccount={workspaceAccess.canAccessAccount}
                canAccessDiagnostics={workspaceAccess.canAccessDiagnostics}
                canAccessSecurity={workspaceAccess.canAccessSecurity}
                toolsSlot={workspaceAccess.backendActionsEnabled ? (
                  <WorkspaceToolPanel
                    tools={availableTools}
                    artifacts={artifacts}
                    layers={layers}
                    valueRefs={agentState?.toolValueRefs ?? []}
                    runtimeConfig={runtimeConfig}
                    memories={memoryEntries}
                    activeSkills={activeSkills}
                    activeMcpServers={activeMcpServers}
                    toolRunResult={toolRunResult}
                    toolCatalogEntries={toolCatalogEntries}
                    systemComponents={systemComponents}
                    tokenUsageSummary={tokenUsageSummary}
                    automationDefinitions={automationDefinitions}
                    automationDiagnostics={automationDiagnostics}
                    automationValidation={automationValidation}
                    scheduledTasks={scheduledTasks}
                    automationRuns={automationRuns}
                    backgroundTasks={backgroundTasks}
                    isToolSubmitting={isToolSubmitting}
                    isAutomationSubmitting={isAutomationSubmitting}
                    isToolCatalogSubmitting={isToolCatalogSubmitting}
                    isRuntimeConfigSubmitting={isRuntimeConfigSubmitting}
                    onRunTool={(tool, args) => {
                      void handleRunTool(tool, args)
                    }}
                    onUpsertToolCatalogEntry={(tool, payload, sortOrder) => {
                      void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                    }}
                    onDeleteToolCatalogEntry={(tool) => {
                      void handleDeleteToolCatalogEntry(tool)
                    }}
                    onSaveRuntimeConfig={(nextConfig) => {
                      void handleSaveRuntimeConfig(nextConfig)
                    }}
                    onStartAutomation={(payload) => {
                      void handleStartAutomation(payload)
                    }}
                    onValidateAutomation={handleValidateAutomation}
                    onCreateAutomation={handleCreateAutomation}
                    onUpdateAutomation={handleUpdateAutomation}
                    onPublishAutomation={handlePublishAutomation}
                    onDisableAutomation={handleDisableAutomation}
                    onRespondAutomationApproval={handleRespondAutomationApproval}
                    onCancelAutomation={(automationRunId) => {
                      void handleCancelAutomation(automationRunId)
                    }}
                    onOpenAutomationRun={(sessionId, runId, threadId) => {
                      void hydrateRunState(runId).then((loadedRun) => {
                        if (loadedRun.sessionId !== sessionId || (threadId && loadedRun.threadId !== threadId)) {
                          throw new Error('Automation 交付运行归属与持久化导航目标不一致。')
                        }
                        setActiveNav('analysis')
                        setPanelMode('summary')
                        setActiveSidebarItem('assistant')
                      }).catch((error) => {
                        setUiError(formatUiError(error, 'Automation 交付运行加载失败，请稍后重试。'))
                      })
                    }}
                    onSaveScheduledTask={(payload) => {
                      void handleSaveScheduledTask(payload)
                    }}
                    onDeleteScheduledTask={(taskId) => {
                      void handleDeleteScheduledTask(taskId)
                    }}
                    onCancelBackgroundTask={(taskId) => {
                      void handleCancelBackgroundTask(taskId)
                    }}
                    onPromoteBackgroundTask={(taskId) => {
                      void handlePromoteBackgroundTask(taskId).then((task) => {
                        if (!task) return
                        const sessionId = typeof task.metadata.sessionId === 'string' ? task.metadata.sessionId : null
                        const threadId = typeof task.metadata.threadId === 'string' ? task.metadata.threadId : null
                        if (sessionId && task.runId) syncUrl(sessionId, task.runId, threadId ?? undefined)
                      })
                    }}
                    onRefreshMemories={onRefreshMemoriesAction}
                  />
                ) : (
                  <WorkspaceRestrictedDocument title="工具与自动化" reason={remoteUnavailableReason} />
                )}
                mainSlot={workspaceAccess.backendActionsEnabled ? (
                  <WorkspaceConversationPanel
                    artifactCount={artifacts.length}
                    runStatus={run?.status}
                    providerLabel={providerLabel}
                    query={query}
                    currentRunId={run?.id}
                    currentThreadId={currentThreadId}
                    currentThreadTitle={currentThreadTitle}
                    runCreatedAt={run?.createdAt}
                    isSubmitting={isSubmitting}
                    errorMessage={uiError}
                    uploadedLayerName={uploadedLayerName}
                    uploadReferences={uploadReferences}
                    decisions={agentState?.decisions ?? []}
                    sessionThreads={sessionThreads}
                    items={threadConversationItems}
                    runtimeConfig={runtimeConfig}
                    availableTools={availableTools}
                    onQueryChange={setQuery}
                    onSubmit={handleSubmit}
                    onInterrupt={handleInterruptRun}
                    onNewConversation={handleNewConversation}
                    onFillSample={handleSampleSelect}
                    onRespondDecision={onRespondDecisionAction}
                    onUseTemplate={handleUseTemplate}
                    onUploadFiles={(files) => {
                      void handleUploadFiles(files)
                    }}
                    onSelectArtifact={setSelectedArtifactId}
                    onSelectTask={onSelectTaskAction}
                    onRenameTask={onRenameTaskAction}
                    onDeleteTask={onDeleteTaskAction}
                    onForkMessage={onForkMessageAction}
                    onOpenWorkflow={openWorkflowInspector}
                    dataReferences={dataReferences}
                    trashedThreads={trashedThreads}
                    onLoadTrash={onRefreshTrashAction}
                    onRestoreThread={onRestoreThreadAction}
                    onPurgeThread={onPurgeThreadAction}
                    tokenBudget={tokenBudget}
                    activeSkills={activeSkills}
                    activeMcpServers={activeMcpServers}
                    compactionLevel={compactionLevel}
                    runStats={runStats}
                    denialCounts={denialCounts}
                    agentWorkflow={agentWorkflow}
                    tasks={progressTasks}
                  />
                ) : (
                  <WorkspaceRestrictedConversation reason={remoteUnavailableReason} onRetry={retryAuth} />
                )}
                mapSlot={
                  <WorkspaceMapPanel
                    artifactCount={artifacts.length}
                    basemaps={basemaps}
                    mapScene={mapScene}
                    isMapActivated={isMapActivated}
                    runStatus={run?.status}
                    selectedBasemapKey={selectedBasemapKey}
                    onSelectBasemap={setSelectedBasemapKey}
                    selectedArtifactId={selectedArtifactId}
                    selectedArtifactName={selectedArtifact?.name}
                    focusRequest={mapFocusRequest}
                    onSelectArtifact={setSelectedArtifactId}
                    placeResolution={placeResolution}
                    agentState={agentState}
                    onActivateMap={activateMap}
                  />
                }
                workflowSlot={workspaceAccess.backendActionsEnabled
                  ? <WorkspaceWorkflowPanel agentState={agentState} />
                  : <WorkspaceRestrictedDocument title="智能体工作流" reason={remoteUnavailableReason} />}
                contentsSlot={workspaceAccess.backendActionsEnabled
                  ? renderInspectorPanel('contents')
                  : <WorkspaceRestrictedContents basemapName={selectedBasemap.name} reason={remoteUnavailableReason} />}
                  inspectorSlot={workspaceAccess.backendActionsEnabled
                    ? renderInspectorPanel('results')
                    : <WorkspaceRestrictedDocument title="分析结果" reason={remoteUnavailableReason} />}
                />
                {showInteractiveLogin ? (
                  <div className="gf-login-overlay" role="dialog" aria-modal="true" aria-label="登录 GeoForge">
                    <LoginScreen onAuthenticated={retryAuth} />
                  </div>
                ) : null}
              </>
            )}
            renderDebug={(Debug) => (
              <Debug
                query={query}
                isSubmitting={isSubmitting}
                isToolSubmitting={isToolSubmitting}
                uploadedLayerName={uploadedLayerName}
                errorMessage={uiError}
                runStatus={run?.status}
                currentRunId={run?.id}
                currentSessionId={session?.id}
                provider={provider}
                model={model}
                providers={providers}
                currentRun={run}
                sessionRuns={sessionRuns}
                layers={layers}
                events={deferredEvents}
                items={deferredItems}
                intent={intent}
                agentWorkflow={agentWorkflow}
                agentState={agentState}
                artifacts={artifacts}
                artifactMetadata={artifactMetadata}
                selectedArtifactId={selectedArtifactId}
                toolRunResult={toolRunResult}
                toolCatalogEntries={toolCatalogEntries}
                runtimeConfig={runtimeConfig}
                systemComponents={systemComponents}
                tools={availableTools}
                isToolCatalogSubmitting={isToolCatalogSubmitting}
                onQueryChange={setQuery}
                onProviderChange={handleProviderChange}
                onModelChange={setModel}
                onSubmit={() => {
                  void handleSubmit()
                }}
                onUpload={(file) => {
                  void handleUploadFiles([file])
                }}
                onSelectArtifact={setSelectedArtifactId}
                onRunTool={(tool, args) => {
                  void handleRunTool(tool, args)
                }}
                onUpsertToolCatalogEntry={(tool, payload, sortOrder) => {
                  void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                }}
                onDeleteToolCatalogEntry={(tool) => {
                  void handleDeleteToolCatalogEntry(tool)
                }}
                onSaveRuntimeConfig={(nextConfig) => {
                  void handleSaveRuntimeConfig(nextConfig)
                }}
              />
            )}
          />
        </MotionConfig>
      </LazyMotion>
    </Suspense>
  )
}

export default AppShell

function waitForDesktopPaint(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

function taskbarProgressForRun(status?: string) {
  if (status === 'queued' || status === 'running') {
    return { state: 'indeterminate' as const, value: null }
  }
  if (
    status === 'waiting_approval'
    || status === 'clarification_needed'
    || status === 'requires_action'
  ) {
    return { state: 'paused' as const, value: 1 }
  }
  if (status === 'failed' || status === 'interrupted') {
    return { state: 'error' as const, value: 1 }
  }
  return { state: 'none' as const, value: null }
}
