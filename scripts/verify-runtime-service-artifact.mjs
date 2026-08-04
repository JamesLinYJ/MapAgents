#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const artifactRoot = path.resolve(process.argv[2] ?? 'artifacts/runtime-service')
const manifestPath = path.join(artifactRoot, 'runtime-service-manifest.json')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
if (manifest.kind !== 'geo-agent-runtime-service' || manifest.schemaVersion !== 1) {
  throw new Error('运行服务 manifest 版本或类型不受支持。')
}

for (const entry of manifest.entries) {
  const filePath = path.join(artifactRoot, entry.path)
  const metadata = await stat(filePath)
  const content = await readFile(filePath)
  const actualHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (!metadata.isFile() || metadata.size !== entry.sizeBytes || actualHash !== entry.sha256) {
    throw new Error(`运行服务制品校验失败：${entry.path}`)
  }
}

const sbom = JSON.parse(await readFile(path.join(artifactRoot, 'runtime-service-sbom.spdx.json'), 'utf8'))
if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages)) {
  throw new Error('运行服务 SBOM 格式不受支持。')
}

const workerProject = await readFile(path.join(artifactRoot, 'worker/pyproject.toml'), 'utf8')
const workerLock = await readFile(path.join(artifactRoot, 'worker/uv.lock'), 'utf8')
const workerMeteorologyPackage = await stat(path.join(artifactRoot, 'worker/gis-meteorology'))
if (!workerMeteorologyPackage.isDirectory()
  || !/path\s*=\s*["']gis-meteorology["']/u.test(workerProject)
  || !/editable\s*=\s*["']gis-meteorology["']/u.test(workerLock)
  || workerProject.includes('../packages/gis-meteorology')
  || workerLock.includes('../packages/gis-meteorology')) {
  throw new Error('运行服务 Worker 制品的 gis-meteorology 相对路径无效。')
}

if (manifest.signing) {
  const signature = JSON.parse(await readFile(path.join(artifactRoot, manifest.signing.signatureFile), 'utf8'))
  const publicKey = createPublicKey(signature.publicKeyPem)
  const valid = verify(
    null,
    manifestBytes,
    publicKey,
    Buffer.from(signature.signatureBase64, 'base64'),
  )
  if (!valid) throw new Error('运行服务 manifest Ed25519 签名校验失败。')
}

process.stdout.write(`${artifactRoot}\n`)
