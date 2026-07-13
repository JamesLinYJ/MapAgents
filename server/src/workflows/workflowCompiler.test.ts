import { describe, expect, it } from 'vitest'
import type { ToolDef } from '../framework/types.js'
import { workflowDefinitionSchema, type WorkflowDefinition } from './schemas.js'
import { WorkflowCompiler } from './workflowCompiler.js'

const inspectTool = {
  name: 'inspect',
  label: '检查数据',
  jsonSchema: {
    type: 'object',
    properties: { dataset_id: { type: 'string' } },
    required: ['dataset_id'],
    additionalProperties: false,
  },
} as ToolDef

function compiler() {
  return new WorkflowCompiler({ get: name => name === 'inspect' ? inspectTool : undefined })
}

function definition(): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    workflowId: 'workflow_test',
    name: '测试工具流',
    description: '',
    version: '1.0.0',
    revision: 1,
    publishedRevision: 1,
    source: 'builtin',
    lifecycle: 'published',
    workspaceId: null,
    createdByUserId: null,
    enabled: true,
    parametersSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string' } },
      required: ['datasetId'],
      additionalProperties: false,
    },
    defaultParameters: { datasetId: 'latest_upload' },
    requiredTools: ['inspect'],
    requiresApproval: false,
    timeoutSeconds: 900,
    outputType: 'conversation',
    graph: {
      schemaVersion: 1,
      entryNodeId: 'trigger',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { nodeId: 'trigger', type: 'trigger', label: '触发', description: '', position: { x: 0, y: 0 }, config: {} },
        {
          nodeId: 'inspect', type: 'tool', label: '检查', description: '', position: { x: 200, y: 0 },
          config: {
            toolName: 'inspect',
            arguments: { dataset_id: { source: 'input', path: 'parameters.datasetId' } },
            approvalMode: 'auto',
            retry: { maxAttempts: 1, backoffSeconds: 0 },
          },
        },
        {
          nodeId: 'output', type: 'output', label: '输出', description: '', position: { x: 400, y: 0 },
          config: { outputs: { result: { source: 'node', nodeId: 'inspect', path: 'payload' } } },
        },
      ],
      edges: [
        { edgeId: 'a', sourceNodeId: 'trigger', targetNodeId: 'inspect', sourcePort: 'default' },
        { edgeId: 'b', sourceNodeId: 'inspect', targetNodeId: 'output', sourcePort: 'success' },
      ],
    },
  })
}

describe('WorkflowCompiler', () => {
  it('compiles a valid tool DAG and validates runtime parameters', () => {
    const compiled = compiler().compile(definition())
    expect(compiled.topologicalOrder).toEqual(['trigger', 'inspect', 'output'])
    expect(() => compiled.validateParameters({ datasetId: 'dataset_1' })).not.toThrow()
    expect(() => compiled.validateParameters({})).toThrow('Workflow 参数无效')
  })

  it('rejects cycles instead of attempting best-effort execution', () => {
    const value = definition()
    value.graph.edges.push({ edgeId: 'cycle', sourceNodeId: 'output', targetNodeId: 'inspect', sourcePort: 'default' })
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.code === 'graph_cycle' || issue.code === 'output_has_edges')).toBe(true)
  })

  it('rejects missing required tool arguments', () => {
    const value = definition()
    const node = value.graph.nodes.find(item => item.nodeId === 'inspect')
    if (!node || node.type !== 'tool') throw new Error('fixture missing tool node')
    node.config.arguments = {}
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'tool_argument_required', nodeId: 'inspect' }))
  })

  it('rejects bindings to nodes that are not upstream dependencies', () => {
    const value = definition()
    const output = value.graph.nodes.find(item => item.nodeId === 'output')
    if (!output || output.type !== 'output') throw new Error('fixture missing output node')
    output.config.outputs.result = { source: 'node', nodeId: 'output', path: 'payload' }
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.code === 'binding_not_ancestor')).toBe(true)
  })
})
