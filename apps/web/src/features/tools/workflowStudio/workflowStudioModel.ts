import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import type {
  ToolDescriptor,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
} from '@geo-agent-platform/shared-types'

export interface StudioNodeData extends Record<string, unknown> {
  workflowNode: WorkflowNode
  selected: boolean
}

export type StudioFlowNode = Node<StudioNodeData, 'workflowNode'>
export type StudioFlowEdge = Edge<{ sourcePort: WorkflowEdge['sourcePort'] }>

export function graphToFlow(graph: WorkflowGraph, selectedNodeId: string | null): {
  nodes: StudioFlowNode[]
  edges: StudioFlowEdge[]
} {
  return {
    nodes: graph.nodes.map(node => ({
      id: node.nodeId,
      type: 'workflowNode',
      position: node.position,
      data: { workflowNode: node, selected: node.nodeId === selectedNodeId },
    })),
    edges: graph.edges.map(edge => ({
      id: edge.edgeId,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: edge.sourcePort,
      targetHandle: 'target',
      type: 'smoothstep',
      animated: false,
      data: { sourcePort: edge.sourcePort },
    })),
  }
}

export function flowToGraph(
  previous: WorkflowGraph,
  nodes: StudioFlowNode[],
  edges: StudioFlowEdge[],
): WorkflowGraph {
  return {
    ...previous,
    nodes: nodes.map(node => ({ ...node.data.workflowNode, position: node.position })),
    edges: edges.map(edge => ({
      edgeId: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourcePort: normalizePort(edge.sourceHandle),
    })),
  }
}

export function createBlankWorkflowGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    entryNodeId: 'trigger',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      createWorkflowNode('trigger', { x: 80, y: 160 }),
      createWorkflowNode('output', { x: 720, y: 160 }),
    ],
    edges: [],
  }
}

export function createWorkflowNode(
  type: WorkflowNodeType,
  position: { x: number; y: number },
  tool?: ToolDescriptor,
): WorkflowNode {
  const nodeId = `${type}_${crypto.randomUUID().slice(0, 8)}`
  const base = { nodeId, type, label: nodeLabel(type, tool), description: '', position }
  if (type === 'trigger') return { ...base, nodeId: 'trigger', type, config: {} }
  if (type === 'tool') {
    if (!tool) throw new Error('创建工具节点必须指定工具。')
    return {
      ...base,
      type,
      config: {
        toolName: tool.name,
        arguments: Object.fromEntries(tool.parameters
          .filter(parameter => parameter.required)
          .map(parameter => [parameter.key, { source: 'literal' as const, value: parameter.defaultValue ?? '' }])),
        approvalMode: 'auto',
        retry: { maxAttempts: 1, backoffSeconds: 0 },
      },
    }
  }
  if (type === 'agent') return {
    ...base,
    type,
    config: {
      promptTemplate: '{{{input.prompt}}}',
      executionMode: 'auto',
      reasoning: true,
      retry: { maxAttempts: 1, backoffSeconds: 0 },
    },
  }
  if (type === 'condition') return {
    ...base,
    type,
    config: {
      left: { source: 'input', path: 'parameters.value' },
      operator: 'exists',
      right: null,
    },
  }
  if (type === 'approval') return {
    ...base,
    type,
    config: { title: '需要人工批准', question: '是否继续执行后续步骤？', description: '' },
  }
  return { ...base, type: 'output', config: { outputs: {} } }
}

export function layoutWorkflowGraph(graph: WorkflowGraph): WorkflowGraph {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 44, marginx: 28, marginy: 28 })
  for (const node of graph.nodes) layout.setNode(node.nodeId, { width: 230, height: 112 })
  for (const edge of graph.edges) layout.setEdge(edge.sourceNodeId, edge.targetNodeId)
  dagre.layout(layout)
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      const position = layout.node(node.nodeId) as { x: number; y: number } | undefined
      if (!position) return node
      return { ...node, position: { x: position.x - 115, y: position.y - 56 } }
    }),
  }
}

export function nextEdgeId(source: string, target: string): string {
  return `edge_${source}_${target}_${crypto.randomUUID().slice(0, 6)}`
}

function normalizePort(value: string | null | undefined): WorkflowEdge['sourcePort'] {
  return value === 'success' || value === 'error' || value === 'true' || value === 'false'
    || value === 'approved' || value === 'rejected'
    ? value
    : 'default'
}

function nodeLabel(type: WorkflowNodeType, tool?: ToolDescriptor): string {
  if (type === 'trigger') return '触发器'
  if (type === 'tool') return tool?.label ?? '工具'
  if (type === 'agent') return '智能体'
  if (type === 'condition') return '条件判断'
  if (type === 'approval') return '人工审批'
  return '输出'
}
