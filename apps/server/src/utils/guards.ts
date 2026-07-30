// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时类型守卫
//
//   文件:       guards.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 这些守卫只用于外部边界或 unknown 数据收口。领域对象的校验应使用对应
// Zod schema 或强类型构造函数，避免把宽松守卫当作业务校验层。
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

