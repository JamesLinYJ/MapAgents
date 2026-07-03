# 🔍 d3d11.dll 深度逆向分析报告

> **分析引擎**: Claude Code Agent Team (7 Agents) + IDA Pro MCP
> **分析日期**: 2026-07-03
> **文件**: `C:\Users\James\Desktop\dx\x64\d3d11.dll`
> **总调用次数**: 156 MCP 调用 | **Token 消耗**: 530,624

---

## 1. 二进制文件概览

### 1.1 文件身份

| 属性 | 值 |
|---|---|
| 文件名 | d3d11.dll |
| 架构 | x64 |
| SHA256 | `4ff4916573be5bfa433286d61594d1cc6901953694681c5e61f3d1263c025b97` |
| MD5 | `255d2cacd57821f60d7b783076fe3481` |
| 基址 | `0x359050000` |
| 总大小 | `0x712000` (~7.1 MB) |
| 函数总数 | 12,459 |
| 已命名函数 | 458 (3.7%) |
| 未命名函数 | 12,001 |
| 字符串总数 | 26,822 |
| 调用图边数 | 63,757 |
| 叶子函数 | 3,794 |

### 1.2 段布局

| 段名 | 权限 | 大小 | 用途 |
|---|---|---|---|
| `.text` | r-x | 0x5ED000 (~6.1 MB) | 可执行代码 |
| `.rdata` | r-- | 0x9C000 (~638 KB) | 只读数据 (RTTI, vtable) |
| `.data` | rw- | 0x7000 (~28 KB) | 初始化读写数据 |
| `.pdata` | r-- | 0x25000 (~148 KB) | SEH 展开信息 |
| `.xdata` | r-- | 0x4B000 (~300 KB) | SEH 展开数据 |
| `.eh_frame` | rw- | 0x1000 (~4 KB) | DWARF/EH 帧 |
| `.bss` | rw- | 0x5000 (~20 KB) | 未初始化数据 |
| `.idata` | r-- | 0x3000 (~12 KB) | 导入表 (3 段) |
| `.tls` | rw- | 0x1000 (~4 KB) | 线程局部存储 |

---

## 2. 导出接口分析 (API Surface)

d3d11.dll 仅导出 **4 个公开 API 函数**（加上 TLS 回调和 DllEntryPoint）：

### 2.1 D3D11CreateDevice (Ordinal 22)
- **地址**: `0x359083DC0`, 大小: 95 字节
- **角色**: 标准 D3D11 设备创建入口。`sub_359083310` 核心工作函数的薄包装
- **参数**: `(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT flags, FeatureLevels*, ...) → ID3D11Device**, ID3D11DeviceContext**, D3D_FEATURE_LEVEL*`
- **调用链**: `D3D11CreateDevice → sub_359083310 → CreateDXGIFactory1 → 适配器枚举 → sub_359082200 (特征级别协商) → sub_359076D50 (设备对象实例化 + vtable 设置)`

### 2.2 D3D11CreateDeviceAndSwapChain (Ordinal 23)
- **地址**: `0x359083D80`, 大小: 59 字节
- **角色**: 设备 + 交换链组合创建。与 D3D11CreateDevice 完全相同的内部路径，额外传递 `DXGI_SWAP_CHAIN_DESC` 和 `IDXGISwapChain**`
- **调用链**: 共享 `sub_359083310`，设备创建后调用 DXGI 工厂的 `CreateSwapChain` vtable 方法

### 2.3 D3D11CoreCreateDevice (Ordinal 18)
- **地址**: `0x359083E20`, 大小: 108 字节
- **角色**: 低级设备创建导出，供诊断工具/运行时内部使用
- **差异**: 同样调用 `sub_359083310` 但抑制即时上下文输出 (`ppImmediateContext = 0`)，不创建交换链

### 2.4 D3D11On12CreateDevice (Ordinal 24) ⭐ 最复杂
- **地址**: `0x359080830`, 大小: **6,457 字节** (最大的导出)
- **角色**: D3D11On12 互操作桥接。验证 D3D12 设备和命令队列，协商特征级别，构建包装 D3D12 资源的 D3D11 设备
- **参数**: `(IUnknown *pDevice, UINT Flags, FeatureLevels*, IUnknown **ppCommandQueues, UINT NumQueues, UINT NodeMask) → ID3D11Device**, ID3D11DeviceContext**, D3D_FEATURE_LEVEL*`
- **关键子调用**: `sub_359076D50` (设备对象实例化), `sub_35912CA40` (适配器管理), `sub_3590B1950` (带适配器追踪的设备创建), 以及大量日志/错误处理

### 2.5 DllEntryPoint
- **地址**: `0x3590511F0`, 大小: 305 字节
- **PROCESS_ATTACH**: CRT 初始化 → `sub_359425B70` (TLS 回调注册) → `sub_3594258D0` (TLS 索引分配) → 全局初始化标志 = 2
- **PROCESS_DETACH**: `sub_3594270C0` (基础设施拆卸) → CRT atexit 处理
- **THREAD_ATTACH/DETACH**: 线程局部初始化/清理
- **三个 TLS 回调**: `TlsCallback_0` (`0x359425910`), `TlsCallback_1` (`0x3594258F0`), `TlsCallback_2` (`0x3594371A0`)

---

## 3. 核心函数深度分析 (Top-15 最高频引用函数)

| # | 地址 | 名称 | Xrefs | 角色 | 分类 |
|---|---|---|---|---|---|
| 1 | `0x3594269F0` | `sub_3594269F0` | 3,506 | C++ 异常展开调度器 — RtlCaptureContext+RtlUnwindEx，无返回 | dispatcher |
| 2 | `0x3595BCCC0` | `sub_3595BCCC0` | 3,014 | SSO 感知释放 — 检查内联存储 vs 堆指针，释放堆缓冲区 (5 条指令) | wrapper |
| 3 | `0x35950E8E0` | `sub_35950E8E0` | 2,967 | 字节数组 SSO 析构函数 (阈值=8 字节) — 重置为 SIMD 空状态 | wrapper |
| 4 | `0x35950E2C0` | `sub_35950E2C0` | 1,793 | 指针数组 SSO 析构函数 (阈值=11 元素) | wrapper |
| 5 | `0x35950E4A0` | `sub_35950E4A0` | 1,213 | 动态指针数组 push_back — 容量翻倍、溢出检查、旧缓冲释放 | complex |
| 6 | `0x3595815B0` | `sub_3595815B0` | 1,051 | 链表节点批量销毁 — 遍历双向链表，释放每个节点的 SSO 缓冲区 | complex |
| 7 | `0x35922FE70` | `sub_35922FE70` | 1,004 | **D3D 资源句柄/对象表插入** — 12 位哈希表 (4096 桶, 184 字节条目) | complex |
| 8 | `0x359226040` | `sub_359226040` | 857 | 动态字节数组 push_back (SSO 阈值=8) | complex |
| 9 | `0x3595095A0` | `sub_3595095A0` | 840 | 描述符深层复制构造函数 — 复制字节向量 + 指针向量 (1211 字节函数体) | complex |
| 10 | `0x359509DA0` | `sub_359509DA0` | 793 | 描述符深层复制 (变体 2) — 分两阶段复制字节数组+指针数组 | complex |
| 11 | `0x3595AEA20` | `sub_3595AEA20` | 809 | COM Release — 原子递减，归零时级联子对象析构 | wrapper |
| 12 | `0x3595C04F0` | `sub_3595C04F0` | 512 | `std::string` 容量增长 — 溢出检查、翻倍或精确适配 | wrapper |
| 13 | `ReleaseSRWLockExclusive` | 导入 | 698 | 本机 SRW 解锁 (ntdll thunk) | thunk |
| 14 | `memcpy` | 导入 | 636 | 标准内存复制 (CRT thunk) | thunk |
| 15 | `0x359513450` | `sub_359513450` | 582 | 延迟释放引用计数递减 — 原子归零时排队到 SRWLock 保护的释放列表 | leaf |

### 关键代码路径

**路径 1—SSO 容器生命周期（主导，约 2/3 的热函数）**:
```
分配 → sub_3595F6D00 (带标签 malloc)
扩容 → sub_35950E4A0 / sub_359226040 (push_back)
     → sub_3595C04F0 (字符串容量计算)
销毁 → sub_35950E8E0 / sub_35950E2C0 (SSO 析构)
     → sub_3595BCCC0 (条件释放) / sub_3595F6CC0 (带标签 free)
```

**路径 2—COM 对象生命周期**:
```
AddRef  → _InterlockedIncrement
Release → sub_3595AEA20 (标准) → 归零 → sub_3595AE500 (级联)
        → sub_359513450 (延迟模式) → 排队到 SRWLock 释放列表
```

**路径 3—资源句柄表管理**:
```
sub_35922FE70: 哈希键 → 查找桶 (12 位, 4096 桶)
  → 未找到 → sub_3595F6D00 (分配 0xA0 字节节点)
  → 跨桶链接 → 插入引用
```

---

## 4. 依赖关系图

```
应用程序
  └─> d3d11.dll
        ├─> dxgi.dll (1 函数)        —— CreateDXGIFactory1
        ├─> GDI32.dll (19 函数)      —— D3DKMT 内核 GPU 接口 ⭐ 最重要
        ├─> USER32.dll (20 函数)     —— 显示拓扑/模式设置/窗口管理
        ├─> SETUPAPI.dll (4 函数)    —— 硬件设备枚举
        ├─> ADVAPI32.dll (5 函数)    —— 注册表访问
        ├─> KERNEL32.dll (~45 函数)  —— 线程/同步/内存/文件 I/O
        └─> api-ms-win-crt-*.dll (~55 函数) —— CRT 完整工具链
```

### 4.1 D3DKMT 内核接口详解（19 个 GPU 驱动入口）

| 函数 | Thunk 地址 | 用途 |
|---|---|---|
| `D3DKMTCloseAdapter` | `0x359419010` | 关闭适配器句柄 |
| `D3DKMTCreateDCFromMemory` | `0x359419040` | 从内存创建 GDI DC (屏幕截图回退) |
| `D3DKMTCreateDevice` | `0x359419050` | 在 WDDM 驱动中创建 GPU 设备 |
| `D3DKMTCreateKeyedMutex2` | `0x359419060` | 创建密钥互斥体（跨 API 共享） |
| `D3DKMTDestroyAllocation` | `0x359419080` | 销毁 GPU 分配 |
| `D3DKMTDestroyDCFromMemory` | `0x359419090` | 销毁 GDI DC |
| `D3DKMTDestroyDevice` | `0x3594190A0` | 销毁 GPU 设备 |
| `D3DKMTDestroyKeyedMutex` | `0x3594190B0` | 销毁密钥互斥体 |
| `D3DKMTDestroySynchronizationObject` | `0x3594190C0` | 销毁同步对象 |
| `D3DKMTEscape` | `0x3594190D0` | 向内核驱动发送私有 IOCTL |
| `D3DKMTOpenAdapterFromLuid` | `0x3594190E0` | 从 LUID 打开适配器 |
| `D3DKMTOpenKeyedMutex` | `0x3594190F0` | 打开密钥互斥体（跨进程） |
| `D3DKMTOpenResource2` | `0x359419100` | 打开共享资源 |
| `D3DKMTOpenResourceFromNtHandle` | `0x359419110` | 从 NT 句柄打开资源 |
| `D3DKMTOpenSyncObjectFromNtHandle` | `0x359419120` | 从 NT 句柄打开同步对象 |
| `D3DKMTOpenSynchronizationObject` | `0x359419130` | 打开同步对象 |
| `D3DKMTQueryResourceInfo` | `0x359419150` | 查询资源信息 |
| `D3DKMTQueryResourceInfoFromNtHandle` | `0x359419160` | 从 NT 句柄查询资源信息 |
| `D3DKMTShareObjects` | `0x359419170` | 跨进程共享 GPU 对象 |

所有 D3DKMT 函数使用独特的 **二级间接模式**: `IAT 条目 (0x359758xxx) → 6 字节 thunk (0x359419xxx) → jmp [import_addr]`

### 4.2 核心设备创建示例
```
sub_3590B2140 (4,975 字节, 圈复杂度 41)
  ├─ D3DKMTOpenAdapterFromLuid
  ├─ D3DKMTCreateDevice
  ├─ Vulkan 设备创建尝试
  │    └─ 失败 → "Failed to create Vulkan device: " 错误字符串
  ├─ 回退到 "safe mode" 重试
  └─ D3DKMTCloseAdapter (清理)
```

---

## 5. 字符串情报

### 5.1 D3D11 运行时诊断（关键样本）

| 字符串 | 用途 |
|---|---|
| `"D3D11: Shader hash validation failed"` | 着色器哈希安全检查 |
| `"D3D11: Cannot create depth-stencil view:"` | 深度模板视图验证 |
| `"D3D11: Cannot create shader resource view:"` | SRV 验证拒绝 |
| `"D3D11: Unknown interface query"` | 未知 IID 查询 |
| `"D3D11: GetData called on a deferred context"` | 延迟上下文限制检查 |
| `"D3D11: FinishCommandList called on immediate context"` | 即时/延迟翻转错误 |
| `"D3D11: Counters not supported"` | 不支持的查询计数器 |
| `"D3D11: Unknown feature: "` | 未知特性级别 |
| `"Debug Utils are enabled. May affect performance."` | 调试层激活警告 |

### 5.2 Vulkan 设备创建错误
- `"Failed to create Vulkan device: "`
- `"Failed to initialize DXVK device."`
- `"Failed to load vulkan-1 library."`
- `"DXVK: No adapters found. Please check your device filter settings and Vulkan drivers."`

### 5.3 内部命名空间 (dxvk C++ RTTI, ~1200 vtables)

```
dxvk::D3D11Device              dxvk::DxvkDevice
dxvk::D3D11DeviceContext       dxvk::DxvkContext
dxvk::D3D11ImmediateContext    dxvk::D3D11DeferredContext
dxvk::D3D11Buffer              dxvk::D3D11CommonTexture
dxvk::D3D11SwapChain           dxvk::D3D11Shader
dxvk::D3D11InputLayout         dxvk::D3D11Fence
dxvk::D3D11ReflexDevice        dxvk::D3D11On12Device
dxvk::DxvkCommandList          dxvk::DxvkCsThread
dxvk::DxvkMemoryAllocator      dxvk::DxvkGraphicsPipeline
dxvk::DxvkSubmissionQueue      dxvk::DxvkKeyedMutex
dxvk::hud::HudFpsItem          dxvk::hud::HudGpuLoadItem
... (共 ~1200 个类)
```

### 5.4 游戏专用工作区 (100+)
```
\\\\kof(xiii|13_win32_Release)\\.exe$         // 拳皇 XIII
\\\\Rapture_Release\\.exe$                     // 生化奇兵无限
\\\\Homefront2_Release\\.exe$                  // 国土防线 2
```

覆盖 Fallout 4、Mafia 2-3、Splinter Cell、FIFA、Max Payne、FEAR 等 100+ 款游戏。

### 5.5 GPU 隐藏配置
- `dxgi.hideIntelGpu` / `dxgi.hideAmdGpu` / `dxgi.hideNvidiaGpu`
- `dxgi.customVendorId` / `dxgi.customDeviceId` / `dxgi.customDeviceDesc`

---

## 6. 安全特征评估

### 6.1 已启用/缺失的缓解机制

| 机制 | 状态 | 证据 |
|---|---|---|
| **ASLR** | ✅ 已启用 | DLL Characteristics `0x160` 包含 `DYNAMIC_BASE + HIGH_ENTROPY_VA` |
| **DEP/NX** | ✅ 已启用 | `NX_COMPAT` 标志 + x64 硬件强制执行 |
| **W^X** | ✅ 合规 | 全部 11 段：无任何段同时具有 W+X 权限 |
| **SafeSEH** | N/A | x64 不使用 SEH；使用 `.pdata`/`.xdata` 展开表 (12,629 条目) |
| **CFG** | ❌ **未启用** | `GUARD_CF (0x4000)` 未设置；Load Config Directory RVA=0 |
| **CET** | ❌ **未检测到** | 零个 `ENDBR64` 指令 |
| **/GS** | 待验证 | 需要检查 `__security_cookie` |

### 6.2 攻击面分析

| 攻击面 | 存在 | 详情 |
|---|---|---|
| RPC 暴露 | ❌ | 无 RPC 服务器 |
| COM 暴露 | ✅ | 4 个导出 COM 工厂函数 |
| 文件解析 | ✅ | 着色器字节码解析 (dxbc_spv)、纹理数据、Shader Cache |
| 注册表访问 | ✅ | `RegOpenKeyExA`, `RegQueryValueExA/W`, `RegNotifyChangeKeyValue` |
| 设备 IOCTL | ✅ | `D3DKMTEscape` + `DeviceIoControl` (3 个调用者) |
| 间接调用风险 | ⚠️ **高** | **7,309 处间接控制流** — 无 CFG/CET 保护 |

### 6.3 危险函数

| 函数 | Xrefs | 风险 |
|---|---|---|
| `memcpy` | 604 | 中等 — 错误大小计算可导致缓冲溢出 |
| `VirtualProtect` | 2 | 中等 — TLS 回调和修补表迭代中使用 |
| `DeviceIoControl` | 3 | 中等 — 内核驱动 IOCTL 通道 |
| `SetThreadContext` | 1 | 中等 — 线程上下文操作 |

### 6.4 安全评估总结

**优势**: ASLR (高熵 64 位)、DEP/NX (硬件强制)、无 RWX 段 (W^X 合规)、无原始 `strcpy/sprintf/gets`、完整 SEH 展开表

**弱点**: **CFG 未启用**、**CET 未启用**、7,309 处间接控制流无保护、`VirtualProtect` 运行时更改内存权限、自定义内核 IOCTL 通道

---

## 7. 架构与代码模式

### 7.1 整体架构层次

```
┌─────────────────────────────────────────────┐
│  应用层 — D3D11 COM API                      │
├─────────────────────────────────────────────┤
│  DXVK 封装层 — dxvk::D3D11* (~1200 vtables) │
├─────────────────────────────────────────────┤
│  命令流线程架构 — DxvkCsThread + CsChunk     │
├─────────────────────────────────────────────┤
│  DXVK 核心层 — dxvk::Dxvk* (Vulkan 封装)    │
├─────────────────────────────────────────────┤
│  Vulkan API — vkCreate*, vkDestroy*, ...     │
├─────────────────────────────────────────────┤
│  WDDM 内核接口 — GDI32!D3DKMT* (19 函数)    │
└─────────────────────────────────────────────┘
```

### 7.2 命令流线程模型

```
D3D11 应用线程
  D3D11DeviceContext::Draw()
    → DxvkCsTypedCmd<Lambda>
      → DxvkCsChunkRef (命令分块)
        → DxvkCsThread (专用工作线程)
          → DxvkContext::draw/dispatch
            → DxvkSubmissionQueue (GPU 提交)
              → Vulkan API
```

### 7.3 同步原语使用

| 原语 | 用途 |
|---|---|
| `AcquireSRWLockExclusive` (305 调用点) | 命令流元数据保护 |
| `ReleaseSRWLockExclusive` (472 调用点) | 释放排他性 SRW 锁 |
| `SleepConditionVariableSRW` | 生产者-消费者信号 |
| `EnterCriticalSection` / `LeaveCriticalSection` | 设备创建排他访问 |
| `CreateEventA` / `SetEvent` / `ResetEvent` | GPU-CPU 同步 |
| `CreateSemaphoreA` / `ReleaseSemaphore` | 槽计数限制 |
| `TlsAlloc` / `TlsGetValue` / `TlsSetValue` | 线程局部存储 |

### 7.4 着色器编译管道

```
D3D11 → DXBC 字节码 → dxbc_spv (IR) → DxvkIrShader → SPIR-V
                       ↓
              DxvkDxbcSpirvLogger (诊断日志)
```

---

## 8. 总结与关键发现

### ⭐ 核心身份确认

> **此 d3d11.dll 是 DXVK v3.x 构建 — 将 D3D11 API 转换为 Vulkan，不是 Microsoft 原生 d3d11.dll。**

**确凿证据**:
1. `"Failed to create Vulkan device: "` 字符串在设备创建路径 `sub_3590B2140` 中
2. `"DXVK_SHADER_CACHE"` 环境变量在 `sub_3590FAAD0` 中引用
3. 自定义 `\\\\.\\SharedGpuResource` 设备 IOCTL (0x238004) 绕过标准 D3DKMT 共享 API
4. 最少 DXGI 依赖 — 仅导入 `CreateDXGIFactory1`
5. 完整的 `dxvk::` 命名空间 RTTI 类层次（~1200 个 vtable）
6. 配置前缀为 `d3d11.*, dxgi.*, dxvk.*, d3d9.*`

### 关键架构决定

1. **命令流线程模型**: 所有设备上下文操作异步分发到 `DxvkCsThread` 工作线程
2. **SSO 容器基础设施**: 运行时几乎完全构建在定制的高性能小缓冲区优化容器之上 (~9,844 xrefs 核心容器函数)
3. **12 位哈希表资源注册表**: `sub_35922FE70` (1,004 xref) 是 D3D 对象注册表核心
4. **分层延迟释放**: 标准 COM Release + 延迟排队释放
5. **完整 WDDM CCD 显示拓扑引擎**: `sub_359222A00` (7,300+ 字节) 集成 QueryDisplayConfig + SETUPAPI + Registry

### 20 项关键发现

| # | 发现 |
|---|---|
| 1 | **DXVK v3.x 构建** — 非 Microsoft 原生 d3d11.dll；Vulkan 翻译层 |
| 2 | **仅 4 个导出** — 极简 API 表面；全部桥接到同一内部工厂函数 |
| 3 | **无 CFG / 无 CET** — 7,309 处间接控制流不受保护，ROP/JOP/COP 攻击面大 |
| 4 | **NVIDIA Reflex 深度集成** — nvLowLatency2 + VK_NV_low_latency2 帧标记 |
| 5 | **NVIDIA CUDA/NVX 互操作** — CreateCubinComputeShaderWithNameNVX, GetCudaTextureObjectNVX |
| 6 | **OpenVR + OpenXR 集成** — VR/XR 头戴式设备渲染通过 Wine 层 |
| 7 | **100+ 游戏特定工作区** — 可执行名称正则匹配解决 |
| 8 | **SteamDeck 设备识别** — 设备特定优化路径 |
| 9 | **磁盘着色器缓存** — DXVK_SHADER_CACHE + CreateDirectoryW + ReadFile/WriteFile |
| 10 | **自定义 IOCTL 内核通道** — `\\\\.\\SharedGpuResource` + DeviceIoControl(0x238004) |
| 11 | **完整 HUD 系统** — 10+ 屏幕覆盖项: FPS/GPU 负载/延迟/内存/管线统计 |
| 12 | **D3D11On12 桥接** — 通过 vkd3d-proton 而非原生 D3D12 |
| 13 | **12,629 个 .pdata 条目** — 全面 SEH 展开表 |
| 14 | **两级间接 D3DKMT** — IAT + 6 字节 thunk 层 |
| 15 | **GDI 读回退路径** — D3DKMTCreateDCFromMemory 用于屏幕截图/兼容 |
| 16 | **注册表变更监视** — RegNotifyChangeKeyValue 运行时适应 GPU 配置 |
| 17 | **GPU 隐藏配置** — 按供应商隐藏集成/NVIDIA/AMD GPU 的兼容框架 |
| 18 | **硬件内存分配器** — DxvkMemoryAllocator 含碎片整理 + 可配置预算 |
| 19 | **可并行管线编译** — dxvk.numCompilerThreads 可配置 |
| 20 | **确定命令流重放** — d3d11.reproducibleCommandStream 用于调试 |

### 最终结论

d3d11.dll 是一个 **完整、高性能的 D3D11-to-Vulkan 翻译实现**（DXVK v3.x）。其 ~7.1 MB 代码体（12,459 函数）实现了完整的 D3D11.x COM 接口集、D3D10 向后兼容、D3D11On12 互操作、NVIDIA Reflex/CUDA/VX 集成、OpenVR/XR VR 支持，以及广泛的游戏专用兼容性工作区。架构核心是异步命令流线程模型，所有渲染操作通过 DxvkCsThread 分发。安全方面启用了 ASLR 和 DEP，但缺少 CFG 和 CET 保护，在 7,309 处间接控制流上构成攻击面。最热的代码路径围绕 SSO 容器操作 (~9,844 xref) 和 COM 引用计数 (~1,400 xref)。
