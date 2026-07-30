// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情面板组件
//
//   文件:       DetailPanel.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 展示当前结果对象、导出入口、运行摘要与系统状态等辅助信息。

import { memo, useMemo } from 'react'
import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ConversationItem,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  RunSummary,
  SystemComponentsStatus,
} from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'

import { apiBaseUrl } from '../../api/client'
import type { LayerPanelView, LayerTreeNode, LayerVisibilityFilter } from '../layers/useLayerManager'
import { LayerPanel } from '../layers/LayerManagerPanel'
import { pickConversationHeadline } from '@geo-agent-platform/conversation-presentation'
import { buildDetailSummaryFacts } from './detailSummaryModel'
import { DetailSummaryPanel } from './DetailSummaryPanel'
import { DetailLayerOverviewPanel, type DetailMapLayer } from './DetailLayerOverviewPanel'
import { DetailHistoryPanel } from './DetailHistoryPanel'
import { DetailSourcesPanel } from './DetailSourcesPanel'
import { DetailComputePanel, DetailConfigPanel, DetailExportPanel } from './DetailActionPanels'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config' | 'layerManager' | 'tools'

export interface DetailPanelProps {
  panelMode: PanelMode
  currentRunId?: string
  runStatus?: AnalysisRun['status']
  agentState?: AgentState
  items: ConversationItem[]
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: DetailMapLayer[]
  layers: LayerDescriptor[]
  events: RunEvent[]
  sessionRuns: RunSummary[]
  hasMoreHistory?: boolean
  isHistoryLoading?: boolean
  progressItems: ReadonlyArray<ProgressItem>
  selectedArtifactId?: string
  uploadedLayerName?: string
  selectedBasemapName?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  isToolSubmitting: boolean
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
  onChangeArtifactOpacity: (artifactId: string, opacity: number) => void
  onSelectHistoryRun: (runId: string) => void
  onLoadMoreHistory?: () => void
  onDownloadArtifact: () => void
  onExportResults: () => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onImportManagedLayer: (file: DesktopFileSelectionHandle) => void
  onReplaceManagedLayer: (layerKey: string, file: DesktopFileSelectionHandle) => void
  onToggleLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteLayer: (layerKey: string) => void
  onRefreshManagedLayers: () => void
  onCloseLayerManager?: () => void
  // LayerPanel props
  layerTree?: LayerTreeNode[]
  layerSelectedId?: string | null
  layerSearchQuery?: string
  layerTotalCount?: number
  layerVisibleCount?: number
  layerSelectedNode?: LayerTreeNode | undefined
  layerActiveView: LayerPanelView
  layerVisibilityFilter: LayerVisibilityFilter
  layerOperationError?: string | null
  onLayerSelect: (id: string | null) => void
  onLayerToggleVisibility: (id: string) => void
  onLayerToggleAllVisibility: () => void
  onLayerSetOpacity: (id: string, opacity: number) => void
  onLayerRename: (id: string, name: string) => void
  onLayerMoveUp: (id: string) => void
  onLayerMoveDown: (id: string) => void
  onLayerMoveTo: (id: string, targetId: string) => void
  onLayerRemove: (id: string) => void
  onLayerCreateGroup: (name: string, memberIds: string[]) => void
  onLayerToggleGroup: (id: string) => void
  onLayerSetSearchQuery: (q: string) => void
  onLayerSetColor: (id: string, color: string) => void
  onLayerZoomTo: (id: string) => void
  onLayerExport: (id: string) => void
  onLayerSetActiveView: (view: LayerPanelView) => void
  onLayerSetVisibilityFilter: (filter: LayerVisibilityFilter) => void
  onLayerSetLabelEnabled: (id: string, enabled: boolean) => void
  onLayerSetLabelField: (id: string, fieldName: string) => void
  layerSceneManagedLayerKeys: string[]
  onLayerAddReference: (layerKey: string) => void
  onLayerRemoveReference: (layerKey: string) => void
  // 统一文件管理
  allFiles?: import('../../api/client').FileEntry[]
  onUploadFile?: (file: DesktopFileSelectionHandle) => void
  onDeleteFile?: (fileId: string) => void
  isFileSubmitting?: boolean
}

export const DetailPanel = memo(function DetailPanel({
  panelMode,
  currentRunId,
  runStatus,
  agentState,
  items,
  artifacts,
  artifactData,
  mapLayers,
  layers,
  events,
  sessionRuns,
  hasMoreHistory,
  isHistoryLoading,
  progressItems,
  selectedArtifactId,
  uploadedLayerName,
  selectedBasemapName,
  provider,
  model,
  providers,
  systemComponents,
  isToolSubmitting,
  onSelectArtifact,
  onToggleArtifactVisibility,
  onChangeArtifactOpacity,
  onSelectHistoryRun,
  onLoadMoreHistory,
  onDownloadArtifact,
  onExportResults,
  onProviderChange,
  onModelChange,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleLayerStatus,
  onDeleteLayer,
  onRefreshManagedLayers,
  onCloseLayerManager,
  layerTree,
  layerSelectedId,
  layerSearchQuery,
  layerTotalCount,
  layerVisibleCount,
  layerSelectedNode,
  layerActiveView,
  layerVisibilityFilter,
  layerOperationError,
  onLayerSelect,
  onLayerToggleVisibility,
  onLayerToggleAllVisibility,
  onLayerSetOpacity,
  onLayerRename,
  onLayerMoveUp,
  onLayerMoveDown,
  onLayerMoveTo,
  onLayerRemove,
  onLayerCreateGroup,
  onLayerToggleGroup,
  onLayerSetSearchQuery,
  onLayerSetColor,
  onLayerZoomTo,
  onLayerExport,
  onLayerSetActiveView,
  onLayerSetVisibilityFilter,
  onLayerSetLabelEnabled,
  onLayerSetLabelField,
  layerSceneManagedLayerKeys,
  onLayerAddReference,
  onLayerRemoveReference,
  // 统一文件管理
  allFiles,
  onUploadFile,
  onDeleteFile,
  isFileSubmitting,
}: DetailPanelProps) {
  // 右侧详情面板
  //
  // 根据当前导航模式切换摘要、图层、历史、计算、配置等内容，
  // 并承接 artifact、运行历史和结果消费入口。
  // 这里不是纯展示区，而是“结果消费与后续动作面板”：
  // 用户看摘要、切换结果、回看历史、执行二次处理和导出结果都在这层完成。
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0],
    [artifacts, selectedArtifactId],
  )
  const selectedFileUrl = selectedArtifact && selectedArtifact.artifactType !== 'geojson'
    ? `${apiBaseUrl}${typeof selectedArtifact.metadata.imageUrl === 'string' ? selectedArtifact.metadata.imageUrl : selectedArtifact.uri}`
    : null
  const selectedCollection = selectedArtifact ? artifactData[selectedArtifact.artifactId] : undefined
  const summaryTitle = deriveSummaryTitle(agentState?.parsedIntent?.area ?? undefined, selectedArtifact?.name)
  const resultFeatureCount = useMemo(
    () => artifacts.reduce((total, artifact) => total + (artifactData[artifact.artifactId]?.features.length ?? 0), 0),
    [artifacts, artifactData],
  )
  const conversationHeadline = useMemo(
    () => pickConversationHeadline(items, runStatus),
    [items, runStatus],
  )
  const summaryBody =
    (conversationHeadline.title === '回答' ? conversationHeadline.body : '') ||
    (selectedArtifact
      ? `当前结果图层“${selectedArtifact.name}”已经生成，你可以继续查看对象分布、下载数据，或复制当前工作区链接。`
      : '分析完成后，这里会用更容易理解的语言总结地图结果和可执行建议。')
  const todoItems = agentState?.todos ?? []
  const subAgents = agentState?.subAgents ?? []
  const approvals = agentState?.approvals ?? []
  void uploadedLayerName
  void selectedBasemapName
  void isFileSubmitting
  const layerSummary = useMemo(() => buildLayerSummary(layers), [layers])
  const primaryItems = useMemo(() => artifacts.slice(0, 2), [artifacts])
  const cardLabels = useMemo(
    () => primaryItems.map(artifact => ({
      title: artifact.name,
      subtitle:
        artifact.artifactType === 'chart_png'
          ? '统计图表已生成，可直接预览或下载 PNG'
          : artifact.artifactType !== 'geojson'
            ? '文件结果已生成，可在详情面板预览或下载'
            :
        `${artifactData[artifact.artifactId]?.features.length ?? 0} 个对象 · ${mapLayers.find(layer => layer.artifact.artifactId === artifact.artifactId)?.geometrySummary ?? '矢量结果'}`,
    })),
    [primaryItems, artifactData, mapLayers],
  )
  const summaryFacts = useMemo(() => buildDetailSummaryFacts({
    runStatus,
    artifactCount: artifacts.length,
    resultFeatureCount,
    activeReferenceLayerCount: layerSummary.active,
    totalReferenceLayerCount: layerSummary.total,
  }), [artifacts.length, layerSummary.active, layerSummary.total, resultFeatureCount, runStatus])

  return (
    <div className="dc-detail-column">
      {panelMode === 'summary' ? (
        <DetailSummaryPanel
          artifactData={artifactData}
          approvals={approvals}
          cardLabels={cardLabels}
          primaryItems={primaryItems}
          selectedArtifact={selectedArtifact}
          selectedCollection={selectedCollection}
          selectedFileUrl={selectedFileUrl}
          subAgents={subAgents}
          summaryBody={summaryBody}
          summaryFacts={summaryFacts}
          summaryTitle={summaryTitle}
          todoItems={todoItems}
          onDownloadArtifact={onDownloadArtifact}
          onExportResults={onExportResults}
          onSelectArtifact={onSelectArtifact}
        />
      ) : null}

      {panelMode === 'layers' ? (
        <DetailLayerOverviewPanel
          layers={layers}
          layerSummary={layerSummary}
          mapLayers={mapLayers}
          selectedArtifact={selectedArtifact}
          onChangeArtifactOpacity={onChangeArtifactOpacity}
          onSelectArtifact={onSelectArtifact}
          onToggleArtifactVisibility={onToggleArtifactVisibility}
        />
      ) : null}

      {panelMode === 'history' ? (
        <DetailHistoryPanel
          currentRunId={currentRunId}
          events={events}
          hasMoreHistory={hasMoreHistory}
          isHistoryLoading={isHistoryLoading}
          progressItems={progressItems}
          sessionRuns={sessionRuns}
          subAgents={subAgents}
          todoItems={todoItems}
          onLoadMoreHistory={onLoadMoreHistory}
          onSelectHistoryRun={onSelectHistoryRun}
        />
      ) : null}

      {panelMode === 'compute' ? (
        <DetailComputePanel
          isToolSubmitting={isToolSubmitting}
          mapLayers={mapLayers}
          selectedArtifact={selectedArtifact}
          selectedCollection={selectedCollection}
          onExportResults={onExportResults}
          onSelectArtifact={onSelectArtifact}
          onToggleArtifactVisibility={onToggleArtifactVisibility}
        />
      ) : null}

      {panelMode === 'sources' ? (
        <DetailSourcesPanel
          allFiles={allFiles}
          onDeleteFile={onDeleteFile}
          onUploadFile={onUploadFile}
        />
      ) : null}

      {panelMode === 'layerManager' && layerTree ? (
        <LayerPanel
          tree={layerTree}
          selectedId={layerSelectedId ?? null}
          searchQuery={layerSearchQuery ?? ''}
          totalCount={layerTotalCount ?? 0}
          visibleCount={layerVisibleCount ?? 0}
          selectedNode={layerSelectedNode}
          activeView={layerActiveView}
          visibilityFilter={layerVisibilityFilter}
          referenceLayers={layers}
          errorMessage={layerOperationError}
          onSelectLayer={onLayerSelect}
          onToggleVisibility={onLayerToggleVisibility}
          onToggleAllVisibility={onLayerToggleAllVisibility}
          onSetOpacity={onLayerSetOpacity}
          onRenameLayer={onLayerRename}
          onMoveUp={onLayerMoveUp}
          onMoveDown={onLayerMoveDown}
          onMoveLayer={onLayerMoveTo}
          onRemoveLayer={onLayerRemove}
          onCreateGroup={onLayerCreateGroup}
          onToggleGroup={onLayerToggleGroup}
          onSetSearchQuery={onLayerSetSearchQuery}
          onSetColor={onLayerSetColor}
          onZoomToLayer={onLayerZoomTo}
          onExportLayer={onLayerExport}
          onSetActiveView={onLayerSetActiveView}
          onSetVisibilityFilter={onLayerSetVisibilityFilter}
          onSetLabelEnabled={onLayerSetLabelEnabled}
          onSetLabelField={onLayerSetLabelField}
          onImportManagedLayer={onImportManagedLayer}
          onReplaceManagedLayer={onReplaceManagedLayer}
          onToggleReferenceLayerStatus={onToggleLayerStatus}
          onDeleteReferenceLayer={onDeleteLayer}
          onRefreshReferenceLayers={onRefreshManagedLayers}
          sceneManagedLayerKeys={layerSceneManagedLayerKeys}
          onAddReferenceLayer={onLayerAddReference}
          onRemoveReferenceLayer={onLayerRemoveReference}
          onClose={onCloseLayerManager}
        />
      ) : null}

      {panelMode === 'export' ? (
        <DetailExportPanel
          selectedArtifact={selectedArtifact}
          onDownloadArtifact={onDownloadArtifact}
          onExportResults={onExportResults}
        />
      ) : null}

      {panelMode === 'config' ? (
        <DetailConfigPanel
          model={model}
          provider={provider}
          providers={providers}
          systemComponents={systemComponents}
          onModelChange={onModelChange}
          onProviderChange={onProviderChange}
        />
      ) : null}

      {runStatus === 'failed' ? <div className="dc-error-banner">这次分析没有完成，请调整问题后重新尝试。</div> : null}
    </div>
  )
})

function deriveSummaryTitle(area?: string, artifactName?: string) {
  if (area) {
    return `${area}分析`
  }
  if (artifactName) {
    return artifactName
  }
  return '空间分析结果'
}

function buildLayerSummary(layers: LayerDescriptor[]) {
  return layers.reduce(
    (summary, layer) => {
      const isSessionLayer = layer.sourceType.startsWith('session_') || layer.sourceType === 'upload'
      return {
        total: summary.total + 1,
        active: summary.active + (layer.status === 'active' ? 1 : 0),
        inactive: summary.inactive + (layer.status === 'active' ? 0 : 1),
        managed: summary.managed + (isSessionLayer ? 0 : 1),
        session: summary.session + (isSessionLayer ? 1 : 0),
        features: summary.features + (layer.featureCount ?? 0),
      }
    },
    { total: 0, active: 0, inactive: 0, managed: 0, session: 0, features: 0 },
  )
}

