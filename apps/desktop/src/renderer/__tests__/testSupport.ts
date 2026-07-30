export function requiredAt<T>(values: readonly T[], index: number, label = '测试数据'): T {
  const value = values[index]
  if (value === undefined) throw new Error(`${label} 缺少索引 ${index}`)
  return value
}
