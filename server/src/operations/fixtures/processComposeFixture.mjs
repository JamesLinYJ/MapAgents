// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Process Compose 集成测试服务夹具
//
//   文件:       processComposeFixture.mjs
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const [mode, serviceId] = process.argv.slice(2)
if (!['web', 'api', 'worker', 'infra'].includes(serviceId ?? '')) process.exit(2)
if (mode === 'health') process.exit(0)
if (mode !== 'run') process.exit(2)

process.stdout.write(`${JSON.stringify({ level: 'info', msg: `${serviceId} fixture ready`, time: Date.now() })}\n`)
const timer = setInterval(() => {
  process.stdout.write(`${JSON.stringify({ level: 'debug', msg: `${serviceId} fixture heartbeat`, time: Date.now() })}\n`)
}, 250)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer)
    process.exit(0)
  })
}
