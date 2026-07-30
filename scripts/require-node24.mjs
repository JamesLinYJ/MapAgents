// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Desktop Forge Node 版本门槛
//
//   文件:       require-node24.mjs
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

const [major] = process.versions.node.split('.').map(Number)
if (major !== 24) {
  console.error(
    `GeoForge 开发、Desktop package/make 固定使用 Node 24 LTS（.node-version 为 24.14.0）；`
    + `当前为 ${process.version}。Node 25 已移除 Forge maker-zip 固定依赖所需的兼容 API。`,
  )
  process.exit(1)
}
