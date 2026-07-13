import { describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '@geo-agent-platform/shared-types'
import {
  createBlankWorkflowGraph,
  createWorkflowNode,
  flowToGraph,
  graphToFlow,
  layoutWorkflowGraph,
} from './workflowStudioModel'

const tool: ToolDescriptor = {
  name: 'inspect',
  label: '检查数据',
  description: '',
  group: '气象',
  toolKind: 'provider',
  providerId: 'meteorology',
  language: 'typescript',
  isReadOnly: true,
  isDestructive: false,
  available: true,
  tags: [],
  parameters: [{
    key: 'dataset_id', label: '数据集', dataType: 'string', source: 'text', required: true,
    description: null, placeholder: null, defaultValue: 'latest_upload', options: [], acceptedValueRefKinds: [],
  }],
  error: null,
  meta: {},
}

describe('workflowStudioModel', () => {
  it('creates a minimal graph with one trigger and one output', () => {
    const graph = createBlankWorkflowGraph()
    expect(graph.nodes.map(node => node.type)).toEqual(['trigger', 'output'])
    expect(graph.entryNodeId).toBe('trigger')
  })

  it('creates tool nodes from the real tool descriptor contract', () => {
    const node = createWorkflowNode('tool', { x: 100, y: 80 }, tool)
    expect(node.type).toBe('tool')
    if (node.type !== 'tool') throw new Error('fixture did not create a tool node')
    expect(node.config.toolName).toBe('inspect')
    expect(node.config.arguments.dataset_id).toEqual({ source: 'literal', value: 'latest_upload' })
  })

  it('round-trips React Flow coordinates and edge ports without changing domain semantics', () => {
    const graph = createBlankWorkflowGraph()
    graph.edges = [{ edgeId: 'edge', sourceNodeId: 'trigger', targetNodeId: graph.nodes[1]!.nodeId, sourcePort: 'default' }]
    const flow = graphToFlow(graph, null)
    expect(flow.edges[0]).toMatchObject({
      sourceHandle: 'default',
      targetHandle: 'target',
    })
    flow.nodes[0]!.position = { x: 220, y: 130 }
    const restored = flowToGraph(graph, flow.nodes, flow.edges)
    expect(restored.nodes[0]!.position).toEqual({ x: 220, y: 130 })
    expect(restored.edges).toEqual(graph.edges)
  })

  it('lays out the graph while keeping node and edge identities stable', () => {
    const graph = createBlankWorkflowGraph()
    graph.edges = [{ edgeId: 'edge', sourceNodeId: 'trigger', targetNodeId: graph.nodes[1]!.nodeId, sourcePort: 'default' }]
    const laidOut = layoutWorkflowGraph(graph)
    expect(laidOut.nodes.map(node => node.nodeId)).toEqual(graph.nodes.map(node => node.nodeId))
    expect(laidOut.edges).toEqual(graph.edges)
    expect(laidOut.nodes[1]!.position.x).toBeGreaterThan(laidOut.nodes[0]!.position.x)
  })
})
