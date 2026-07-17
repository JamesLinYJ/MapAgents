import { useMemo, useRef, useState, type SetStateAction } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Bot,
  Braces,
  Check,
  CirclePlay,
  Copy,
  Download,
  FileCheck2,
  GitBranch,
  LayoutDashboard,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Square,
  Upload,
  Wrench,
  X,
} from 'lucide-react'
import {
  workflowDefinitionSchema,
  type ToolDescriptor,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRunRecord,
  type WorkflowValidationResult,
} from '@geo-agent-platform/shared-types'
import type {
  StartWorkflowPayload,
  WorkflowDraftPayload,
  WorkflowUpdatePayload,
} from '../../../api/client'
import { WorkflowNodeCard } from './WorkflowNodeCard'
import { WorkflowNodeInspector } from './WorkflowNodeInspector'
import {
  createBlankWorkflowGraph,
  createWorkflowNode,
  flowToGraph,
  graphToFlow,
  layoutWorkflowGraph,
  nextEdgeId,
  type StudioFlowEdge,
  type StudioFlowNode,
} from './workflowStudioModel'

const NODE_TYPES = { workflowNode: WorkflowNodeCard }

export interface WorkflowStudioProps {
  workflows: WorkflowDefinition[]
  validation: Record<string, WorkflowValidationResult>
  tools: ToolDescriptor[]
  workflowRuns: WorkflowRunRecord[]
  isSubmitting: boolean
  onValidate: (payload: WorkflowDraftPayload) => Promise<WorkflowValidationResult>
  onCreate: (payload: WorkflowDraftPayload) => Promise<WorkflowDefinition>
  onUpdate: (payload: WorkflowUpdatePayload) => Promise<WorkflowDefinition>
  onPublish: (workflowId: string, revision: number) => Promise<void>
  onDisable: (workflowId: string) => Promise<void>
  onStart: (payload: StartWorkflowPayload) => void
  onCancel: (workflowRunId: string) => void
  onRespondApproval: (workflowRunId: string, approvalId: string, decision: 'approved' | 'rejected') => Promise<void>
}

interface EditorDraft {
  workflowId: string | null
  sourceRevision: number | null
  name: string
  description: string
  version: string
  parametersSchemaText: string
  defaultParametersText: string
  timeoutSeconds: number
  outputType: string
  graph: WorkflowGraph
}

export function WorkflowStudio(props: WorkflowStudioProps) {
  return <ReactFlowProvider><WorkflowStudioInner {...props} /></ReactFlowProvider>
}

function WorkflowStudioInner({
  workflows,
  validation,
  tools,
  workflowRuns,
  isSubmitting,
  onValidate,
  onCreate,
  onUpdate,
  onPublish,
  onDisable,
  onStart,
  onCancel,
  onRespondApproval,
}: WorkflowStudioProps) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const selectedDefinition = workflows.find(item => item.workflowId === selectedWorkflowId)
    ?? (selectedWorkflowId === null ? workflows[0] ?? null : null)
  const effectiveSelectedWorkflowId = selectedDefinition?.workflowId ?? ''
  const definitionDraft = selectedDefinition ? draftFromDefinition(selectedDefinition) : newDraft()
  const [draftState, setDraftState] = useState<EditorDraft | null>(null)
  const draft = draftState ?? definitionDraft
  const setDraft = (next: SetStateAction<EditorDraft>) => {
    setDraftState(current => typeof next === 'function' ? next(current ?? draft) : next)
  }
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [definitionQuery, setDefinitionQuery] = useState('')
  const [toolQuery, setToolQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [validationState, setValidationResult] = useState<WorkflowValidationResult | null | undefined>(undefined)
  const validationResult = validationState === undefined
    ? selectedDefinition ? validation[selectedDefinition.workflowId] ?? null : null
    : validationState
  const [editorMessage, setEditorMessage] = useState('')
  const [manualPrompt, setManualPrompt] = useState('')
  const [manualParameters, setManualParameters] = useState('{}')
  const [canvasDocumentVersion, setCanvasDocumentVersion] = useState(0)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<StudioFlowNode, StudioFlowEdge> | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const readOnly = selectedDefinition?.source === 'builtin' && draft.workflowId === selectedDefinition.workflowId
  const flow = useMemo(() => graphToFlow(draft.graph, selectedNodeId), [draft.graph, selectedNodeId])
  const selectedNode = draft.graph.nodes.find(node => node.nodeId === selectedNodeId) ?? null
  const filteredDefinitions = useMemo(() => workflows.filter(item => `${item.name} ${item.workflowId}`.toLowerCase().includes(definitionQuery.trim().toLowerCase())), [definitionQuery, workflows])
  const filteredTools = useMemo(() => tools.filter(item => item.available && `${item.label} ${item.name} ${item.group}`.toLowerCase().includes(toolQuery.trim().toLowerCase())), [toolQuery, tools])

  const updateGraph = (graph: WorkflowGraph) => {
    setDraft(current => ({ ...current, graph }))
    setDirty(true)
    setValidationResult(null)
  }
  const updateNode = (nextNode: WorkflowNode) => updateGraph({
    ...draft.graph,
    nodes: draft.graph.nodes.map(node => node.nodeId === nextNode.nodeId ? nextNode : node),
  })
  const addNode = (type: WorkflowNodeType, tool?: ToolDescriptor, position?: { x: number; y: number }) => {
    if (readOnly || (type === 'trigger' && draft.graph.nodes.some(node => node.type === 'trigger'))) return
    const node = createWorkflowNode(type, position ?? { x: 320 + draft.graph.nodes.length * 36, y: 120 + draft.graph.nodes.length * 22 }, tool)
    updateGraph({ ...draft.graph, entryNodeId: type === 'trigger' ? node.nodeId : draft.graph.entryNodeId, nodes: [...draft.graph.nodes, node] })
    setSelectedNodeId(node.nodeId)
  }
  const deleteNode = (nodeId: string) => {
    updateGraph({
      ...draft.graph,
      nodes: draft.graph.nodes.filter(node => node.nodeId !== nodeId),
      edges: draft.graph.edges.filter(edge => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
    })
    setSelectedNodeId(null)
  }
  const toPayload = (): WorkflowDraftPayload => ({
    ...(draft.workflowId ? { workflowId: draft.workflowId } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    version: draft.version.trim(),
    parametersSchema: parseObjectText(draft.parametersSchemaText, '参数 Schema'),
    defaultParameters: parseObjectText(draft.defaultParametersText, '默认参数'),
    timeoutSeconds: draft.timeoutSeconds,
    outputType: draft.outputType,
    graph: draft.graph,
  })

  const validateDraft = async () => {
    try {
      setEditorMessage('正在校验...')
      const result = await onValidate(toPayload())
      setValidationResult(result)
      setEditorMessage(result.valid ? '图结构、工具契约和参数 Schema 均通过校验。' : '校验发现需要修复的问题。')
      return result
    } catch (error) {
      setEditorMessage(errorMessage(error))
      return null
    }
  }
  const saveDraft = async () => {
    try {
      const result = await validateDraft()
      if (!result?.valid) return
      const payload = toPayload()
      const saved = draft.workflowId && draft.sourceRevision
        ? await onUpdate({ ...payload, workflowId: draft.workflowId, expectedRevision: draft.sourceRevision })
        : await onCreate(payload)
      setSelectedWorkflowId(saved.workflowId)
      setDraft(draftFromDefinition(saved))
      setDirty(false)
      setEditorMessage(`草稿修订 ${saved.revision} 已保存。`)
    } catch (error) {
      setEditorMessage(errorMessage(error))
    }
  }
  const publishDraft = async () => {
    try {
      if (!draft.workflowId || !draft.sourceRevision || dirty) {
        setEditorMessage('发布前请先保存当前草稿。')
        return
      }
      const result = await validateDraft()
      if (!result?.valid) return
      await onPublish(draft.workflowId, draft.sourceRevision)
      setEditorMessage(`修订 ${draft.sourceRevision} 已发布。`)
    } catch (error) {
      setEditorMessage(errorMessage(error))
    }
  }

  return (
    <div className="workflow-studio">
      <header className="workflow-studio__topbar">
        <div>
          <span>Workflow Studio</span>
          <strong>{draft.name || '未命名 Workflow'}</strong>
          <small>{dirty ? '有未保存更改' : draft.workflowId ? `修订 ${draft.sourceRevision ?? 1}` : '新草稿'}</small>
        </div>
        <div className="workflow-studio__toolbar">
          <button type="button" title="新建工作流" onClick={() => { setSelectedWorkflowId(''); setDraft(newDraft()); setValidationResult(null); setDirty(true); setSelectedNodeId(null); setCanvasDocumentVersion(current => current + 1) }}><Plus size={16} /><span>新建</span></button>
          <button type="button" title="复制为工作区草稿" disabled={!selectedDefinition} onClick={() => { if (!selectedDefinition) return; setSelectedWorkflowId(''); setDraft({ ...draftFromDefinition(selectedDefinition), workflowId: null, sourceRevision: null, name: `${selectedDefinition.name} 副本` }); setValidationResult(null); setDirty(true); setSelectedNodeId(null); setCanvasDocumentVersion(current => current + 1) }}><Copy size={16} /><span>复制</span></button>
          <button type="button" title="自动布局" disabled={readOnly} onClick={() => updateGraph(layoutWorkflowGraph(draft.graph))}><LayoutDashboard size={16} /><span>布局</span></button>
          <button type="button" title="导入 JSON" disabled={readOnly} onClick={() => importInputRef.current?.click()}><Upload size={16} /><span>导入</span></button>
          <button type="button" title="导出 JSON" onClick={() => exportDraft(draft)}><Download size={16} /><span>导出</span></button>
          <button type="button" title="服务端校验" onClick={() => { void validateDraft() }}><FileCheck2 size={16} /><span>校验</span></button>
          <button type="button" className="is-primary" title="保存新修订" disabled={readOnly || isSubmitting} onClick={() => { void saveDraft() }}><Save size={16} /><span>保存</span></button>
          <button type="button" className="is-publish" title="发布当前修订" disabled={readOnly || isSubmitting || dirty || !draft.workflowId} onClick={() => { void publishDraft() }}><Check size={16} /><span>发布</span></button>
          <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importDraft(file, setDraft, setDirty, setEditorMessage, () => setCanvasDocumentVersion(current => current + 1)); event.currentTarget.value = '' }} />
        </div>
      </header>

      <div className="workflow-studio__body">
        <aside className="workflow-palette">
          <section>
            <h3>Workflow</h3>
            <label className="workflow-search"><Search size={14} /><input value={definitionQuery} placeholder="搜索定义" onChange={event => setDefinitionQuery(event.target.value)} /></label>
            <div className="workflow-definition-list">
              {filteredDefinitions.map(definition => (
                <button type="button" className={definition.workflowId === effectiveSelectedWorkflowId ? 'is-active' : ''} key={definition.workflowId} onClick={() => { if (dirty && !window.confirm('当前更改尚未保存，确定切换吗？')) return; setDirty(false); setSelectedWorkflowId(definition.workflowId); setDraft(draftFromDefinition(definition)); setValidationResult(validation[definition.workflowId] ?? null); setSelectedNodeId(null); setCanvasDocumentVersion(current => current + 1) }}>
                  <strong>{definition.name}</strong><span>{definition.source === 'builtin' ? '内置' : `r${definition.revision}`} · {lifecycleLabel(definition.lifecycle)}</span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>控制节点</h3>
            <div className="workflow-palette__grid">
              <PaletteButton icon={Bot} label="智能体" disabled={readOnly} onAdd={() => addNode('agent')} />
              <PaletteButton icon={GitBranch} label="条件" disabled={readOnly} onAdd={() => addNode('condition')} />
              <PaletteButton icon={ShieldCheck} label="审批" disabled={readOnly} onAdd={() => addNode('approval')} />
              <PaletteButton icon={Braces} label="输出" disabled={readOnly} onAdd={() => addNode('output')} />
            </div>
          </section>
          <section className="workflow-palette__tools">
            <h3>工具节点</h3>
            <label className="workflow-search"><Search size={14} /><input value={toolQuery} placeholder="搜索工具" onChange={event => setToolQuery(event.target.value)} /></label>
            <div className="workflow-tool-list">
              {filteredTools.map(tool => (
                <button type="button" draggable={!readOnly} disabled={readOnly} key={tool.name} onDragStart={event => { event.dataTransfer.setData('application/geoforge-tool', tool.name); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => addNode('tool', tool)}>
                  <Wrench size={14} /><span><strong>{tool.label}</strong><small>{tool.group} · {tool.description}</small></span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className="workflow-canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => {
          event.preventDefault()
          if (readOnly || !flowInstance) return
          const toolName = event.dataTransfer.getData('application/geoforge-tool')
          const tool = tools.find(item => item.name === toolName)
          if (!tool) return
          addNode('tool', tool, flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }}>
          <ReactFlow<StudioFlowNode, StudioFlowEdge>
            key={`${selectedDefinition?.workflowId ?? 'workspace-draft'}:${canvasDocumentVersion}`}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.25}
            maxZoom={1.75}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            onInit={setFlowInstance}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            onNodesChange={changes => {
              if (readOnly) return
              const positions = new Map(changes.flatMap(change => (
                change.type === 'position' && change.position
                  ? [[change.id, change.position] as const]
                  : []
              )))
              if (positions.size === 0) return
              updateGraph({
                ...draft.graph,
                nodes: draft.graph.nodes.map(node => {
                  const position = positions.get(node.nodeId)
                  return position ? { ...node, position } : node
                }),
              })
            }}
            onNodesDelete={deletedNodes => {
              if (readOnly || deletedNodes.length === 0) return
              const deletedIds = new Set(deletedNodes.map(node => node.id))
              updateGraph({
                ...draft.graph,
                nodes: draft.graph.nodes.filter(node => !deletedIds.has(node.nodeId)),
                edges: draft.graph.edges.filter(edge => !deletedIds.has(edge.sourceNodeId) && !deletedIds.has(edge.targetNodeId)),
              })
              if (selectedNodeId && deletedIds.has(selectedNodeId)) setSelectedNodeId(null)
            }}
            onEdgesDelete={deletedEdges => {
              if (readOnly || deletedEdges.length === 0) return
              const deletedIds = new Set(deletedEdges.map(edge => edge.id))
              updateGraph({
                ...draft.graph,
                edges: draft.graph.edges.filter(edge => !deletedIds.has(edge.edgeId)),
              })
            }}
            isValidConnection={connection => validConnection(connection, draft.graph)}
            onConnect={connection => {
              if (readOnly || !connection.source || !connection.target) return
              const edge: StudioFlowEdge = {
                id: nextEdgeId(connection.source, connection.target),
                source: connection.source,
                target: connection.target,
                sourceHandle: connection.sourceHandle,
                targetHandle: connection.targetHandle,
                type: 'smoothstep',
                data: { sourcePort: normalizeConnectionPort(connection.sourceHandle) },
              }
              updateGraph(flowToGraph(draft.graph, flow.nodes, [...flow.edges, edge]))
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
          {readOnly ? <div className="workflow-canvas__readonly">内置 Workflow 为只读。点击“复制”后可编辑。</div> : null}
        </main>

        <WorkflowNodeInspector node={selectedNode} graph={draft.graph} tools={tools} readOnly={readOnly} onChange={updateNode} onDelete={deleteNode} />
      </div>

      <section className="workflow-studio__settings">
        <div className="workflow-definition-form">
          <label><span>名称</span><input disabled={readOnly} value={draft.name} onChange={event => { setDraft(current => ({ ...current, name: event.target.value })); setDirty(true) }} /></label>
          <label><span>版本</span><input disabled={readOnly} value={draft.version} onChange={event => { setDraft(current => ({ ...current, version: event.target.value })); setDirty(true) }} /></label>
          <label><span>超时秒数</span><input disabled={readOnly} type="number" min={30} max={86400} value={draft.timeoutSeconds} onChange={event => { setDraft(current => ({ ...current, timeoutSeconds: Number(event.target.value) })); setDirty(true) }} /></label>
          <label className="is-wide"><span>说明</span><input disabled={readOnly} value={draft.description} onChange={event => { setDraft(current => ({ ...current, description: event.target.value })); setDirty(true) }} /></label>
          <label className="is-wide"><span>参数 JSON Schema</span><textarea disabled={readOnly} value={draft.parametersSchemaText} onChange={event => { setDraft(current => ({ ...current, parametersSchemaText: event.target.value })); setDirty(true) }} /></label>
          <label className="is-wide"><span>默认参数</span><textarea disabled={readOnly} value={draft.defaultParametersText} onChange={event => { setDraft(current => ({ ...current, defaultParametersText: event.target.value })); setDirty(true) }} /></label>
        </div>
        <ValidationPanel result={validationResult} message={editorMessage} />
      </section>

      <WorkflowRunPanel
        workflows={workflows}
        selectedWorkflowId={effectiveSelectedWorkflowId}
        runs={workflowRuns}
        prompt={manualPrompt}
        parameters={manualParameters}
        isSubmitting={isSubmitting}
        onPromptChange={setManualPrompt}
        onParametersChange={setManualParameters}
        onStart={() => {
          if (!effectiveSelectedWorkflowId) return
          try { onStart({ workflowId: effectiveSelectedWorkflowId, prompt: manualPrompt.trim(), parameters: parseObjectText(manualParameters, '运行参数') }) }
          catch (error) { setEditorMessage(errorMessage(error)) }
        }}
        onCancel={onCancel}
        onRespondApproval={onRespondApproval}
        onDisable={async () => { if (selectedDefinition?.source === 'workspace') await onDisable(selectedDefinition.workflowId) }}
      />
    </div>
  )
}

function WorkflowRunPanel({ workflows, selectedWorkflowId, runs, prompt, parameters, isSubmitting, onPromptChange, onParametersChange, onStart, onCancel, onRespondApproval, onDisable }: {
  workflows: WorkflowDefinition[]
  selectedWorkflowId: string
  runs: WorkflowRunRecord[]
  prompt: string
  parameters: string
  isSubmitting: boolean
  onPromptChange: (value: string) => void
  onParametersChange: (value: string) => void
  onStart: () => void
  onCancel: (workflowRunId: string) => void
  onRespondApproval: WorkflowStudioProps['onRespondApproval']
  onDisable: () => Promise<void>
}) {
  const definition = workflows.find(item => item.workflowId === selectedWorkflowId)
  const relatedRuns = runs.filter(run => !selectedWorkflowId || run.workflowId === selectedWorkflowId).slice(0, 10)
  return (
    <section className="workflow-runs">
      <div className="workflow-run-launcher">
        <header><div><span>试运行</span><strong>{definition?.name ?? '选择 Workflow'}</strong></div>{definition?.source === 'workspace' ? <button type="button" onClick={() => { void onDisable() }}><X size={14} />停用</button> : null}</header>
        <textarea value={prompt} placeholder="描述本次运行目标。" onChange={event => onPromptChange(event.target.value)} />
        <label><span>运行参数 JSON</span><textarea value={parameters} onChange={event => onParametersChange(event.target.value)} /></label>
        <button type="button" className="workflow-run-launcher__start" disabled={!definition?.enabled || definition.publishedRevision === null || !prompt.trim() || isSubmitting} onClick={onStart}><CirclePlay size={16} />启动 Workflow</button>
      </div>
      <div className="workflow-run-history">
        <header><span>最近运行</span><strong>{relatedRuns.length}</strong></header>
        {relatedRuns.map(run => (
          <article className="workflow-run-card" key={run.workflowRunId}>
            <div className="workflow-run-card__header"><div><strong>{run.workflowId}</strong><span>r{run.workflowRevision} · {statusLabel(run.status)} · {formatDateTime(run.startedAt)}</span></div>{['queued', 'running', 'waiting_approval'].includes(run.status) ? <button type="button" aria-label="取消运行" onClick={() => onCancel(run.workflowRunId)}><Square size={14} /></button> : null}</div>
            <div className="workflow-run-card__steps">
              {run.nodeRuns.map(node => <span className={`is-${node.status}`} key={node.nodeId}><i />{node.label}<small>{node.status}</small></span>)}
            </div>
            {run.pendingApproval?.status === 'pending' ? (
              <div className="workflow-run-card__approval"><strong>{run.pendingApproval.title}</strong><p>{run.pendingApproval.question}</p><div><button type="button" className="is-reject" onClick={() => { void onRespondApproval(run.workflowRunId, run.pendingApproval!.approvalId, 'rejected') }}>拒绝</button><button type="button" className="is-approve" onClick={() => { void onRespondApproval(run.workflowRunId, run.pendingApproval!.approvalId, 'approved') }}>批准并继续</button></div></div>
            ) : null}
            {run.errorMessage ? <p className="workflow-run-card__error">{run.errorMessage}</p> : null}
          </article>
        ))}
        {!relatedRuns.length ? <p className="workflow-runs__empty">暂无运行记录。</p> : null}
      </div>
    </section>
  )
}

function ValidationPanel({ result, message }: { result: WorkflowValidationResult | null; message: string }) {
  return (
    <aside className="workflow-validation">
      <header><span>编译校验</span><strong>{result ? result.valid ? '通过' : `${result.issues.filter(issue => issue.severity === 'error').length} 个错误` : '尚未校验'}</strong></header>
      {message ? <p>{message}</p> : null}
      {result?.issues.map((issue, index) => <div className={`workflow-validation__issue is-${issue.severity}`} key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? index}`}><span>{issue.severity === 'error' ? '错误' : '提醒'}</span><p>{issue.message}</p></div>)}
      {result?.valid ? <div className="workflow-validation__success"><Check size={15} />执行顺序：{result.topologicalOrder.join(' → ')}</div> : null}
    </aside>
  )
}

function PaletteButton({ icon: Icon, label, disabled, onAdd }: { icon: typeof Bot; label: string; disabled: boolean; onAdd: () => void }) {
  return <button type="button" disabled={disabled} onClick={onAdd}><Icon size={15} /><span>{label}</span></button>
}

function draftFromDefinition(definition: WorkflowDefinition): EditorDraft {
  return {
    workflowId: definition.workflowId,
    sourceRevision: definition.revision,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    parametersSchemaText: JSON.stringify(definition.parametersSchema, null, 2),
    defaultParametersText: JSON.stringify(definition.defaultParameters, null, 2),
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    graph: structuredClone(definition.graph),
  }
}

function newDraft(): EditorDraft {
  return {
    workflowId: null,
    sourceRevision: null,
    name: '新建工具流',
    description: '使用可审计工具节点完成一项业务流程。',
    version: '1.0.0',
    parametersSchemaText: JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }, null, 2),
    defaultParametersText: '{}',
    timeoutSeconds: 900,
    outputType: 'conversation',
    graph: createBlankWorkflowGraph(),
  }
}

function validConnection(connection: Connection | StudioFlowEdge, graph: WorkflowGraph): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  const source = graph.nodes.find(node => node.nodeId === connection.source)
  const target = graph.nodes.find(node => node.nodeId === connection.target)
  if (!source || !target || source.type === 'output' || target.type === 'trigger') return false
  const port = connection.sourceHandle ?? 'default'
  return !graph.edges.some(edge => edge.sourceNodeId === source.nodeId && edge.sourcePort === port)
}

function normalizeConnectionPort(value: string | null | undefined): 'default' | 'success' | 'error' | 'true' | 'false' | 'approved' | 'rejected' {
  return value === 'success' || value === 'error' || value === 'true' || value === 'false' || value === 'approved' || value === 'rejected'
    ? value
    : 'default'
}

function parseObjectText(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`${label}不是有效 JSON。`) }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON object。`)
  return parsed as Record<string, unknown>
}

function exportDraft(draft: EditorDraft): void {
  const content = JSON.stringify({
    workflowId: draft.workflowId ?? 'workspace_workflow', name: draft.name, description: draft.description,
    version: draft.version, revision: draft.sourceRevision ?? 1, publishedRevision: null, source: 'workspace', lifecycle: 'draft',
    workspaceId: null, createdByUserId: null, enabled: true,
    parametersSchema: parseObjectText(draft.parametersSchemaText, '参数 Schema'),
    defaultParameters: parseObjectText(draft.defaultParametersText, '默认参数'),
    requiredTools: [], requiresApproval: draft.graph.nodes.some(node => node.type === 'approval'),
    timeoutSeconds: draft.timeoutSeconds, outputType: draft.outputType, graph: draft.graph,
    createdAt: null, updatedAt: null,
  }, null, 2)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `${safeFilename(draft.name)}.workflow.json`; link.click(); URL.revokeObjectURL(url)
}

async function importDraft(
  file: File,
  setDraft: (draft: EditorDraft) => void,
  setDirty: (dirty: boolean) => void,
  setMessage: (message: string) => void,
  onImported: () => void,
): Promise<void> {
  try {
    const parsed = workflowDefinitionSchema.parse(JSON.parse(await file.text()))
    setDraft({ ...draftFromDefinition(parsed), workflowId: null, sourceRevision: null })
    setDirty(true)
    onImported()
    setMessage('Workflow JSON 已导入为新草稿，请校验后保存。')
  } catch (error) { setMessage(`导入失败：${errorMessage(error)}`) }
}

function lifecycleLabel(value: WorkflowDefinition['lifecycle']): string {
  return value === 'published' ? '已发布' : value === 'draft' ? '草稿' : '已停用'
}

function statusLabel(value: WorkflowRunRecord['status']): string {
  if (value === 'queued') return '排队中'; if (value === 'running') return '运行中'; if (value === 'waiting_approval') return '等待审批'
  if (value === 'completed') return '已完成'; if (value === 'cancelled') return '已取消'; return '失败'
}

function formatDateTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function safeFilename(value: string): string { return value.replace(/[<>:"/\\|?*]+/gu, '_').trim() || 'workflow' }
function errorMessage(error: unknown): string { return error instanceof Error && error.message.trim() ? error.message : '操作失败。' }
