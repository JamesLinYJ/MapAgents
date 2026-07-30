// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge 跨版本 ZIP 打包器
//
//   文件:       desktopZipMaker.mjs
//
//   日期:       2026年07月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

export class DesktopZipMaker extends MakerBase {
  name = 'desktop-zip'
  defaultPlatforms = ['win32']

  isSupportedOnCurrentPlatform() {
    return true
  }

  async make({ dir, makeDir, packageJSON, targetArch, targetPlatform }) {
    const zipName = `${path.basename(dir)}-${packageJSON.version}.zip`
    const zipPath = path.resolve(makeDir, 'zip', targetPlatform, targetArch, zipName)
    await createZipArchive(dir, zipPath)
    return [zipPath]
  }
}

/**
 * ZIP 生成边界归项目所有，避免 Forge maker-zip 间接依赖 cross-zip 的
 * Node 25 不兼容文件系统调用。归档失败时删除半成品并原样抛出错误。
 */
export async function createZipArchive(sourceDirectory, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  await rm(destinationPath, { force: true })

  const output = createWriteStream(destinationPath)
  const archive = new ZipArchive({
    zlib: { level: 9 },
  })

  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const succeed = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = error => {
        if (settled) return
        settled = true
        output.destroy()
        archive.abort()
        reject(error)
      }

      output.once('close', succeed)
      output.once('error', fail)
      archive.once('error', fail)
      archive.once('warning', fail)
      archive.pipe(output)
      archive.directory(sourceDirectory, false)
      archive.finalize().catch(fail)
    })
  } catch (error) {
    await rm(destinationPath, { force: true })
    throw error
  }
}
