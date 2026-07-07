// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具参数 Schema 边界
//
//   文件:       schema.ts
//
//   日期:       2026年06月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'

export type ToolParameterSchema = z.ZodObject

export function deriveJsonSchema(parameters: ToolParameterSchema): Record<string, unknown> {
  const schema = z.toJSONSchema(parameters) as Record<string, unknown>
  const { $schema: _schema, ...rest } = schema
  return rest
}

export function ensureToolSchemas(tool: {
  name: string
  parameters?: ToolParameterSchema
  jsonSchema?: Record<string, unknown>
}): { parameters: ToolParameterSchema; jsonSchema: Record<string, unknown> } {
  if (tool.parameters) {
    tool.jsonSchema = tool.jsonSchema ?? deriveJsonSchema(tool.parameters)
    return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
  }
  if (!tool.jsonSchema) {
    throw new Error(`工具 "${tool.name}" 缺少 parameters`)
  }
  tool.parameters = parametersFromJsonSchema(tool.jsonSchema)
  return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
}

// Zod v4 内置 JSON Schema → Zod 转换。
// runtime 模式下 optional 字段仅允许省略；agents 模式下额外接受 null。
// JSON Schema 规范：未设置 additionalProperties 时默认允许额外字段。
// GeoForge 约定相反：未设置时默认拒绝未识别参数。
export function parametersFromJsonSchema(schema: Record<string, unknown>): ToolParameterSchema {
  const result = z.fromJSONSchema(schema)
  if (!(result instanceof z.ZodObject)) throw new Error('工具 parameters 顶层必须是 object')
  return schema.additionalProperties === true ? result.passthrough() : result.strict()
}

export function parametersForAgentsSdk(schema: Record<string, unknown>): ToolParameterSchema {
  return parametersFromJsonSchema(addNullableToOptional(schema))
}

// 深度遍历 JSON Schema，为不在 required 中的字段添加 null 类型。
// 在 JSON Schema 层面做变换，避免直接操作 Zod v4 内部结构。
function addNullableToOptional(schema: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(schema)
  const properties = cloned.properties as Record<string, unknown> | undefined
  if (!properties) return cloned
  const required = new Set(Array.isArray(cloned.required) ? cloned.required.map(String) : [])
  for (const [key, prop] of Object.entries(properties)) {
    if (!isRecord(prop)) continue
    if (!required.has(key)) {
      ;(prop as Record<string, unknown>).type = ['null', (prop as Record<string, unknown>).type ?? 'string']
    }
    // 递归处理嵌套 object
    if ((prop as Record<string, unknown>).properties) {
      ;(properties as Record<string, unknown>)[key] = addNullableToOptional(prop as Record<string, unknown>)
    }
  }
  return cloned
}

export function stripNullObjectValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => stripNullObjectValues(item)) as T
  if (!isRecord(value)) return value
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null) continue
    cleaned[key] = stripNullObjectValues(nested)
  }
  return cleaned as T
}

export function schemaParameters(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {}
    return {
      key,
      label: typeof property.title === 'string' ? property.title : key,
      dataType: typeof property.type === 'string' ? property.type : 'string',
      source: typeof property['x-source'] === 'string' ? property['x-source'] : 'text',
      required: required.has(key),
      description: typeof property.description === 'string' ? property.description : null,
      placeholder: null,
      defaultValue: property.default ?? null,
      options: Array.isArray(property.enum)
        ? property.enum.map(value => ({ label: String(value), value: String(value) }))
        : [],
      acceptedValueRefKinds: Array.isArray(property['x-value-ref-kinds'])
        ? property['x-value-ref-kinds'].map(String)
        : [],
    }
  })
}

export function valueRefRules(schema: Record<string, unknown>, prefix = ''): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const rules: string[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const kinds = valueRefKinds(raw)
    if (kinds.length) rules.push(`${path} 只接受 ${kinds.join(' / ')}`)
    rules.push(...valueRefRules(raw, path))
  }
  return rules
}

export function enrichValueRefDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
  return enrichSchema(schema) as Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function enrichSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const schema: Record<string, unknown> = { ...value }
  const kinds = valueRefKinds(schema)
  if (kinds.length) {
    const base = typeof schema.description === 'string' && schema.description.trim()
      ? schema.description.trim()
      : '必须使用当前 run 中已存在的 valueRef ID'
    schema.description = `${base}；允许的 valueRef kind: ${kinds.join(' / ')}；禁止传入其它 kind 的 valueRef。`
  }
  if (isRecord(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, nested]) => [key, enrichSchema(nested)]))
  }
  if (isRecord(schema.items)) schema.items = enrichSchema(schema.items)
  return schema
}

function valueRefKinds(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema['x-value-ref-kinds'])) return []
  return schema['x-value-ref-kinds'].map(String).filter(Boolean)
}
