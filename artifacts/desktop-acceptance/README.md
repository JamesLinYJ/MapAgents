# GeoForge Desktop 视觉验收

生成日期：2026-07-29  
运行环境：Windows 11、Electron 43.2.0、Playwright Electron  
验收命令：`npx playwright test --project electron-desktop --trace on`

截图来自真实 Electron 窗口。验收会等待 MapLibre 收到真实底图瓦片，并在
`style loaded + idle + all tiles loaded` 后才截图；不是浏览器页面或静态效果图。

## 工作台尺寸

| 场景 | 截图 | SHA256 |
|---|---|---|
| 1920×1080，100% | [desktop-1920x1080.png](./desktop-1920x1080.png) | `3D09FCD2AD2109EB12D67CCC6105FCB0950CADE7181CB1030A2E651FD38A2E90` |
| 1440×900，100% | [desktop-1440x900.png](./desktop-1440x900.png) | `F1850032A15399B8DBD6ED5DD391CABB3653EDC568A48B122F3BE22C66A586E3` |
| 1366×768，100% | [desktop-1366x768.png](./desktop-1366x768.png) | `12CD5C0055813F3CDD3217638F5BAD2380AFB0B7C5CB53B9190418F3C21676B7` |
| 1100×700，最小窗口 | [desktop-1100x700.png](./desktop-1100x700.png) | `8904E642197707FFE05F97DC5DA1E2189179604A473472A751BEA67F89A3E620` |
| 1366×768 DIP，150% 缩放 | [desktop-1366x768-scale-150.png](./desktop-1366x768-scale-150.png) | `53977DD1AF60EDCDB4428FE3EAE1C78C51A71D2D0A0CA14F79C4980B4090BE1C` |
| 后台离线、登录页屏蔽 | [desktop-auto-auth-offline.png](./desktop-auto-auth-offline.png) | `7BBC184837F47D4582D164575A74CCB75ACCFDC6AADFDD24C43CF1BC13175A7A` |

## 已核验区域

- Electron 安全协议 `geoforge://app` 与 MapLibre CSP Worker。
- 顶部命令栏、Ribbon、左侧内容树、中间地图文档区、右侧智能对话和底部地图状态栏。
- 左右停靠面板的鼠标拖动、折叠和键盘操作。
- 多工作区窗口隔离及同工作区窗口复用。
- 1100×700 最小窗口、常用桌面分辨率和 150% Windows 缩放下无区域裁切。
- 后台暂不可用时，桌面壳和本地地图仍可启动，远程操作保持 fail-closed。

真实模型对话与本机原生三服务链路使用独立验收记录，不由这些离线视觉截图替代。
