// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理面板
//
//   文件:       LayerManagerPanel.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Filter,
  Grid2X2Plus,
  Layers3,
  Map as MapIcon,
  Pencil,
  Pin,
  PinOff,
  Search,
  Table2,
  Tags,
  X,
} from 'lucide-react'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import type { LayerPanelView, LayerTreeNode, LayerVisibilityFilter } from './useLayerManager'
import { collectLayerIds } from './layerTreeUtils'
import {
  AddView,
  DrawOrderView,
  LabelsView,
  SelectionView,
  SourcesView,
  StyleView,
  TableView,
} from './LayerManagerViews'

interface LayerPanelProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  searchQuery: string
  totalCount: number
  visibleCount: number
  selectedNode?: LayerTreeNode
  activeView: LayerPanelView
  visibilityFilter: LayerVisibilityFilter
  referenceLayers: LayerDescriptor[]
  errorMessage?: string | null
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleAllVisibility: () => void
  onSetOpacity: (id: string, opacity: number) => void
  onRenameLayer: (id: string, name: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onRemoveLayer: (id: string) => void
  onCreateGroup: (name: string, memberIds: string[]) => void
  onToggleGroup: (id: string) => void
  onSetSearchQuery: (query: string) => void
  onSetColor: (id: string, color: string) => void
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
  onSetActiveView: (view: LayerPanelView) => void
  onSetVisibilityFilter: (filter: LayerVisibilityFilter) => void
  onSetLabelEnabled: (id: string, enabled: boolean) => void
  onSetLabelField: (id: string, fieldName: string) => void
  onImportManagedLayer: (file: File) => void
  onReplaceManagedLayer: (layerKey: string, file: File) => void
  onToggleReferenceLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteReferenceLayer: (layerKey: string) => void
  onRefreshReferenceLayers: () => void
  sceneManagedLayerKeys: string[]
  onAddReferenceLayer: (layerKey: string) => void
  onRemoveReferenceLayer: (layerKey: string) => void
  onClose: () => void
}

const PANEL_VIEWS: ReadonlyArray<{ id: LayerPanelView; label: string; icon: typeof Layers3 }> = [
  { id: 'drawOrder', label: '绘制顺序', icon: Layers3 },
  { id: 'sources', label: '数据源', icon: Database },
  { id: 'selection', label: '选择', icon: MapIcon },
  { id: 'style', label: '样式', icon: Pencil },
  { id: 'add', label: '添加', icon: Grid2X2Plus },
  { id: 'labels', label: '标注', icon: Tags },
  { id: 'table', label: '属性表', icon: Table2 },
]

// 面板复用图层 hook 的视图状态，不直接访问地图实例。
//
// 所有影响地图或参考图层的动作通过回调回到资源控制器，避免 UI 自行伪造渲染状态。
export function LayerPanel({
  tree,
  selectedId,
  searchQuery,
  totalCount,
  visibleCount,
  selectedNode,
  activeView,
  visibilityFilter,
  referenceLayers,
  errorMessage,
  onSelectLayer,
  onToggleVisibility,
  onToggleAllVisibility,
  onSetOpacity,
  onRenameLayer,
  onMoveUp,
  onMoveDown,
  onRemoveLayer,
  onCreateGroup,
  onToggleGroup,
  onSetSearchQuery,
  onSetColor,
  onZoomToLayer,
  onExportLayer,
  onSetActiveView,
  onSetVisibilityFilter,
  onSetLabelEnabled,
  onSetLabelField,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleReferenceLayerStatus,
  onDeleteReferenceLayer,
  onRefreshReferenceLayers,
  sceneManagedLayerKeys,
  onAddReferenceLayer,
  onRemoveReferenceLayer,
  onClose,
}: LayerPanelProps) {
  const [groupName, setGroupName] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [selectedReferenceKey, setSelectedReferenceKey] = useState<string | null>(null)
  const selectableLayerIds = useMemo(() => collectLayerIds(tree), [tree])
  const selectedReferenceLayer = useMemo(
    () => referenceLayers.find(layer => layer.layerKey === selectedReferenceKey),
    [referenceLayers, selectedReferenceKey],
  )

  return (
    <section className={`arcgis-layer-panel${pinned ? ' arcgis-layer-panel--pinned' : ''}`} aria-label="图层管理">
      <header className="arcgis-layer-panel__titlebar">
        <div>
          <h3>图层管理</h3>
          <span>{visibleCount}/{totalCount} 个地图图层正在显示 · {referenceLayers.length} 个数据源</span>
        </div>
        <div className="arcgis-layer-panel__window-actions">
          <button type="button" aria-label={collapsed ? '展开图层管理面板' : '折叠图层管理面板'} title={collapsed ? '展开' : '折叠'} onClick={() => setCollapsed(current => !current)}>
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          <button type="button" aria-label={pinned ? '取消固定图层管理面板' : '固定图层管理面板'} title={pinned ? '取消固定' : '固定'} onClick={() => setPinned(current => !current)}>
            {pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button type="button" aria-label="关闭图层管理面板" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      {!collapsed ? (
        <>
          {errorMessage ? <p className="arcgis-layer-panel__error" role="alert">{errorMessage}</p> : null}
          <div className="arcgis-layer-panel__search-row">
            <button type="button" className="arcgis-layer-panel__filter-button" aria-label="打开图层过滤" onClick={() => setFilterOpen(current => !current)}>
              <Filter size={18} aria-hidden="true" />
            </button>
            <label className="arcgis-layer-panel__search">
              <span className="sr-only">搜索图层</span>
              <input value={searchQuery} placeholder="搜索结果图层、类型或空间摘要" onChange={(event) => onSetSearchQuery(event.target.value)} />
              <Search size={18} aria-hidden="true" />
            </label>
            <button type="button" className="arcgis-layer-panel__filter-button" aria-label="切换过滤条件" onClick={() => setFilterOpen(current => !current)}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>

          {filterOpen ? (
            <div className="arcgis-layer-panel__filters" aria-label="过滤条件">
              {([
                ['all', '全部'],
                ['visible', '仅显示'],
                ['hidden', '仅隐藏'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={visibilityFilter === value ? 'is-active' : ''}
                  onClick={() => onSetVisibilityFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="arcgis-layer-panel__toolbar" aria-label="图层管理视图切换">
            {PANEL_VIEWS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={activeView === id ? 'is-active' : ''}
                title={label}
                aria-label={label}
                aria-pressed={activeView === id}
                onClick={() => onSetActiveView(id)}
              >
                <Icon size={20} />
              </button>
            ))}
          </div>

          {activeView === 'drawOrder' ? (
            <DrawOrderView
              tree={tree}
              selectedId={selectedId}
              selectedNode={selectedNode}
              selectableLayerIds={selectableLayerIds}
              groupName={groupName}
              onGroupNameChange={setGroupName}
              onSelectLayer={onSelectLayer}
              onToggleVisibility={onToggleVisibility}
              onToggleAllVisibility={onToggleAllVisibility}
              onSetOpacity={onSetOpacity}
              onRenameLayer={onRenameLayer}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
              onRemoveLayer={onRemoveLayer}
              onCreateGroup={onCreateGroup}
              onToggleGroup={onToggleGroup}
              onSetColor={onSetColor}
              onZoomToLayer={onZoomToLayer}
              onExportLayer={onExportLayer}
            />
          ) : null}

          {activeView === 'sources' ? (
            <SourcesView
              referenceLayers={referenceLayers}
              selectedReferenceKey={selectedReferenceKey}
              onSelectReference={setSelectedReferenceKey}
              onImportManagedLayer={onImportManagedLayer}
              onReplaceManagedLayer={onReplaceManagedLayer}
              onToggleReferenceLayerStatus={onToggleReferenceLayerStatus}
              onDeleteReferenceLayer={onDeleteReferenceLayer}
              onRefreshReferenceLayers={onRefreshReferenceLayers}
              sceneManagedLayerKeys={sceneManagedLayerKeys}
              onAddReferenceLayer={onAddReferenceLayer}
              onRemoveReferenceLayer={onRemoveReferenceLayer}
            />
          ) : null}

          {activeView === 'selection' ? (
            <SelectionView
              selectedNode={selectedNode}
              selectedReferenceLayer={selectedReferenceLayer}
              onZoomToLayer={onZoomToLayer}
              onExportLayer={onExportLayer}
            />
          ) : null}

          {activeView === 'style' ? (
            <StyleView selectedNode={selectedNode} onSetColor={onSetColor} onSetOpacity={onSetOpacity} />
          ) : null}

          {activeView === 'add' ? <AddView onImportManagedLayer={onImportManagedLayer} /> : null}

          {activeView === 'labels' ? (
            <LabelsView selectedNode={selectedNode} onSetLabelEnabled={onSetLabelEnabled} onSetLabelField={onSetLabelField} />
          ) : null}

          {activeView === 'table' ? <TableView selectedNode={selectedNode} selectedReferenceLayer={selectedReferenceLayer} /> : null}
        </>
      ) : null}
    </section>
  )
}
