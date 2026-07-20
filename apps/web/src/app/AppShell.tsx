// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 应用壳
//
//   文件:       AppShell.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责装配路由、页面容器和六类控制器的 UI 投影。

import { Suspense, useCallback, useDeferredValue, useEffect, useMemo } from 'react'
import { domAnimation, LazyMotion, MotionConfig, useReducedMotion } from 'framer-motion'
import { useLocation } from 'react-router-dom'

import './AppShell.css'
import './styles/glass.css'
import './styles/markdown.css'
import './styles/conversation.css'
import './styles/map.css'
import './styles/layers.css'
import './styles/layout.css'
import './styles/tools-debug.css'
import { buildListItemVariants, buildListVariants } from '../shared/motion'
import { pickConversationHeadline } from '../features/conversation/items'
import { logout } from '../api/client'
import { LoginScreen } from './auth/LoginScreen'
import { TopBar } from './layout/TopBar'
import { WorkspaceConversationPanel } from './layout/WorkspaceConversationPanel'
import type { WorkspaceSidebarItem } from './layout/WorkspaceLayout'
import { WorkspaceInspectorPanel } from './layout/WorkspaceInspectorPanel'
import { WorkspaceMapPanel } from './layout/WorkspaceMapPanel'
import { WorkspaceToolPanel } from './layout/WorkspaceToolPanel'
import { WorkspaceWorkflowPanel } from './layout/WorkspaceWorkflowPanel'
import { AccountCenterPage, LegalPolicyPage, PublicSharePage, WorkspaceRouteHost } from './layout/WorkspaceRouteHost'
import { useWorkspaceMapActivation } from './layout/useWorkspaceMapActivation'
import {
  formatUiError,
  reportNonBlockingError,
} from './bootstrap'
import { projectTimeline } from '../features/conversation/timelineProjector'
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
  formatPanelMode,
  formatPrimaryNav,
  formatModelRunStatus,
  formatTopBarRunStatus,
} from './derivedState'
import { useWorkspaceRunProjection } from './controllers/useWorkspaceRunProjection'
import { useThreadLifecycleActions } from './controllers/useThreadLifecycleActions'
import { useRunLifecycleActions } from './controllers/useRunLifecycleActions'
import { useToolExecutionAction } from './controllers/useToolExecutionAction'

const SIDEBAR_ITEMS: ReadonlyArray<WorkspaceSidebarItem & { id: SidebarItemId }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令', shortLabel: '助手' },
  { id: 'query', icon: 'explore', label: '空间查询', shortLabel: '查询' },
  { id: 'sources', icon: 'database', label: '数据源', shortLabel: '数据' },
  { id: 'tools', icon: 'build', label: '工具管理', shortLabel: '工具' },
  { id: 'config', icon: 'settings_account_box', label: '模型配置', shortLabel: '模型' },
  { id: 'export', icon: 'ios_share', label: '导出', shortLabel: '导出' },
] as const

function useVoidCallback<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  return useCallback((...args: Args) => { void fn(...args) }, [fn])
}

function AppShell() {
  // 主应用壳
  //
  // 装配会话、运行、资源、工具和导航控制器的页面投影。
  // 网络语义和实时订阅分别由控制器与 useRunState 所有。
  const location = useLocation()
  const isPublicShareRoute = location.pathname.startsWith('/share/')
  const isWorkspaceRoute = location.pathname === '/' || location.pathname.startsWith('/session/')
  const publicShareId = isPublicShareRoute ? readPublicShareId(location.pathname) : null
  const {
    activateMap,
    isMapActivated,
    mapFocusRequest,
    requestMapFocus,
  } = useWorkspaceMapActivation(location.pathname)

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
  const reducedMotion = useReducedMotion() ?? false
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
  const {
    activeNav,
    activeSidebarItem,
    changeWorkspaceMode,
    changePrimaryNav: handleNavChange,
    copyShareLink: handleCopyShareLink,
    focusQueryInput,
    inspectorOpen,
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
    toggleInspector,
    useNextTemplate: handleUseTemplate,
    workspaceMode,
  } = useNavigationController({
    currentThreadId,
    runId: run?.id,
    sessionId: session?.id,
    shareToken: session?.shareToken,
    setUiError,
  })
  const {
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
  const transcriptHeadline = useMemo(
    () => pickConversationHeadline(threadConversationItems, run?.status),
    [threadConversationItems, run?.status],
  )

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
  const primaryActionLabel = selectedArtifactId ? '发布结果' : '开始分析'
  const workspaceListVariants = buildListVariants(reducedMotion, 0.04, 0.02)
  const workspaceItemVariants = buildListItemVariants(reducedMotion, 16)

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

  const { authMe, authStatus, clearAuth, retryAuth } = useWorkspaceBootstrap({
    applyProviders,
    clearActiveRunState,
    getThreadHistory,
    hydrateRunState,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setCanonicalThreadItems,
    setUiError,
    syncUrl,
    disabled: isPublicShareRoute,
    syncWorkspaceUrl: isWorkspaceRoute,
  })
  const { memoryEntries, refreshMemoryEntries } = useMemoryEntries(
    authStatus === 'authenticated' && runtimeConfig?.context.memoryEnabled !== false,
  )

  useEffect(() => {
    if (!session?.id) return
    if (location.pathname !== '/debug' && panelMode !== 'history') return
    void loadRunHistory(session.id).catch(error => {
      setUiError(formatUiError(error, '运行历史加载失败。'))
    })
  }, [loadRunHistory, location.pathname, panelMode, session?.id, setUiError])

  const panelNeedsWorkspaceResources = panelMode === 'layers' || panelMode === 'sources' || panelMode === 'layerManager'
  const shouldLoadWorkspaceResources = isMapActivated || panelNeedsWorkspaceResources || location.pathname === '/debug'

  useEffect(() => {
    if (!session?.id || !shouldLoadWorkspaceResources) return
    void Promise.allSettled([
      loadBasemaps(),
      refreshLayers(session.id, currentThreadId),
    ]).then(results => {
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') reportNonBlockingError('workspaceResources', rejected.reason)
    })
  }, [currentThreadId, loadBasemaps, refreshLayers, session?.id, shouldLoadWorkspaceResources])

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

  if (isPublicShareRoute) {
    return (
      <Suspense fallback={<div className="dc-route-loading">正在加载分享页面…</div>}>
        <PublicSharePage shareId={publicShareId} />
      </Suspense>
    )
  }

  if (authStatus === 'checking') {
    return <div className="dc-route-loading">正在校验登录状态…</div>
  }

  if (authStatus !== 'authenticated' || !authMe) {
    return (
      <LoginScreen
        errorMessage={authStatus === 'error' ? uiError : undefined}
        onAuthenticated={retryAuth}
      />
    )
  }

  const handleLogout = async () => {
    try {
      await logout()
    } finally {
      clearAuth()
      setUiError(undefined)
    }
  }

  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载页面…</div>}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <WorkspaceRouteHost
            account={<AccountCenterPage authMe={authMe} onLogout={handleLogout} />}
            terms={<LegalPolicyPage kind="terms" />}
            privacy={<LegalPolicyPage kind="privacy" />}
            renderWorkspace={(Workspace) => (
              <Workspace
                topBar={
                  <TopBar
                    activeNav={activeNav}
                    artifactCount={artifacts.length}
                    providerLabel={providerLabel}
                    runStatusLabel={formatTopBarRunStatus(run?.status)}
                    authMe={authMe}
                    inspectorOpen={inspectorOpen}
                    onNavChange={handleNavChange}
                    onLogout={handleLogout}
                    onToggleInspector={toggleInspector}
                    onPrimaryAction={async () => {
                      if (selectedArtifactId) {
                        setPanelMode('export')
                        return
                      }
                      if (query.trim()) {
                        await handleSubmit()
                        return
                      }
                      focusQueryInput()
                    }}
                    primaryActionLabel={primaryActionLabel}
                  />
                }
                sidebarItems={SIDEBAR_ITEMS}
                activeSidebarItem={activeSidebarItem}
                onSidebarItemClick={(itemId) => handleSidebarItemClick(itemId as SidebarItemId)}
                runStatusLabel={formatTopBarRunStatus(run?.status)}
                hasActiveRun={Boolean(run?.id)}
                dataReferenceCount={dataReferences.length}
                selectedBasemapName={selectedBasemap.name}
                uploadedLayerName={uploadedLayerName}
                activeNavLabel={formatPrimaryNav(activeNav)}
                panelModeLabel={formatPanelMode(panelMode)}
                providerLabel={providerLabel}
                modelLabel={model || '默认'}
                modelStatusLabel={formatModelRunStatus(run?.status)}
                artifactCount={artifacts.length}
                selectedArtifactName={selectedArtifact?.name}
                transcriptTitle={transcriptHeadline.title}
                transcriptBody={transcriptHeadline.body}
                reducedMotion={reducedMotion}
                workspaceListVariants={workspaceListVariants}
                workspaceItemVariants={workspaceItemVariants}
                currentThreadId={currentThreadId}
                sessionThreads={sessionThreads}
                onNewTask={handleNewConversation}
                onSelectThread={onSelectTaskAction}
                workspaceMode={workspaceMode}
                onWorkspaceModeChange={changeWorkspaceMode}
                inspectorOpen={inspectorOpen}
                toolsMode={activeNav === 'tools'}
                toolsSlot={
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
                }
                mainSlot={
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
                }
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
                    onOpenLayerManager={() => setPanelMode('layerManager')}
                  />
                }
                workflowSlot={<WorkspaceWorkflowPanel agentState={agentState} />}
                inspectorSlot={
                  <WorkspaceInspectorPanel
                    panelMode={panelMode}
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
                    onCopyShareLink={() => {
                      void handleCopyShareLink()
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
                    onCloseLayerManager={() => setPanelMode('summary')}
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
                    tasks={progressTasks}
                    onOpenHistory={() => setPanelMode('history')}
                  />
                }
              />
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

function readPublicShareId(pathname: string): string | null {
  const match = /^\/share\/([^/?#]+)/u.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export default AppShell
