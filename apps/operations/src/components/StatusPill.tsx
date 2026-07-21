// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维状态标签
//
//   文件:       StatusPill.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export function StatusPill({ value }: { value: string }) {
  const tone = /running|healthy|allowed|connected|完成|正常/iu.test(value)
    ? 'good'
    : /failed|unhealthy|denied|error|失败|拒绝/iu.test(value)
      ? 'bad'
      : /starting|pending|stopping|detached|恢复|等待/iu.test(value)
        ? 'warn'
        : 'neutral'
  return <span className={`ops-pill ops-pill--${tone}`}>{value}</span>
}
