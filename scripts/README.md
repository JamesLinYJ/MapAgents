# 构建与运维脚本

脚本按“只做一件事、显式输入、失败即停”维护。运行入口优先使用根目录 `package.json` 中的 npm 命令；脚本文件只负责构建、校验、发布和本机服务适配，不承载业务事实或数据库迁移逻辑。

## 入口分类

| 类别 | 根命令/脚本 | 作用 |
| --- | --- | --- |
| 开发启动 | `npm run dev:windows`、`npm run dev` | 启动本机监督器及应用服务 |
| 构建校验 | `npm run build`、`npm run lint:desktop`、`npm run lint:terminology`、`npm run check:bundle` | 编译、静态检查和桌面包预算检查 |
| 发布制品 | `npm run release:runtime`、`npm run verify:runtime`、`scripts/make-desktop-release.ps1` | 生成/校验 Node/Worker 运行服务制品（含 DB、共享契约、监督器运行包、SPDX SBOM 和 checksum manifest）或 Electron 发布包；需要签名时显式传入 `--signing-key <Ed25519 私钥>` |
| 服务安装 | `scripts/install-winsw-service.ps1`、`scripts/install-desktop-runtime-manifest.ps1` | Windows 服务及桌面运行清单安装 |
| 数据维护 | `npm run migrate:file-lifecycle`、`npm run reset:conversations` | 旧上传 metadata 默认 dry-run 校验、显式导入，或显式确认后的开发数据清理 |
| Python/科学计算 | `scripts/run-worker.ps1`、`scripts/run-worker.sh` | 启动 Worker；算法代码归属 `packages/gis-meteorology` |

## 约定

- 新脚本必须有明确命名、参数说明和非零退出码；禁止在失败时返回伪成功结果。
- 会覆盖或删除数据的脚本必须要求显式目标或 `--confirm`/`--force`，不得通过猜测当前目录执行。
- `npm run migrate:file-lifecycle` 默认只读校验；只有追加 `-- --confirm` 才写入 `platform_file_objects`，并将旧 `_idempotency` 目录移动到 `runtime/migration-archive`，不提供运行时 fallback。
- 发布脚本必须验证输入路径存在、类型正确，并在输出中写入版本/协议/校验清单。
- 已签名 Runtime Service 必须用部署侧公钥验证：`npm run verify:runtime -- <制品目录> --require-signature --trusted-public-key <Ed25519 公钥>`；制品不携带可自证的信任根。
- 业务规则放在 `apps/server` 或 `packages` 的应用服务中；脚本不得直接成为第二事实源。
- `jay_lyrics_scraper.py`、`replace-isrecord-desktop.py` 等一次性维护脚本不属于运行时发布链，修改时应单独验证，不要混入服务启动脚本。
