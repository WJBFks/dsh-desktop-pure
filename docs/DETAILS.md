# DSH Desktop Pure · 详细说明

> 本文档收录面向**进阶用户与贡献者**的细节：行为说明、从源码运行、升级 DSH、安全说明、目录结构、打包发布。普通用户看 [README](../README.md) 即可。

**语言 / Language**：🇨🇳 [中文](./DETAILS.md)（默认） · 🇬🇧 [English](./DETAILS.en.md)

## 行为说明

- **生命周期**：`✕` / 「文件 → 最小化到托盘」= 隐藏到托盘（dsh 服务器继续运行）；托盘「退出」或「文件 → 退出」= 真正退出，并清理**自己拉起的** `dsh web` 进程树（Win: `taskkill /T /F`；POSIX: SIGTERM）。
- **内置 DSH Desktop Pure 页（「桌面端配置」）**：标题栏「文件」左侧的「页面」按钮可下拉切换 **桌面端配置 / DSH Web**。DSH Desktop Pure 是壳自带的独立页面（外观 / DSH Web / 更新日志 / 关于 四个分区，含全屏 / 卡片布局切换；DSH Web 分区为多端点 Tab：Windows 本机 / WSL 自动检测与拉起 `wsl → dsh web --host <WSL IP> --trusted-host <WSL IP>` / 自定义远程地址只读连接，持久化到 `userData/endpoints.json`），参考 DSH Web 设置页风格，支持浅色 / 深色，**完全独立于 dsh web**——服务未启动也不影响它。启动默认进入 DSH Web；若 dsh web 无法就绪则自动回退到该页，**不退出应用**。
- **复用的服务不归壳管**：复用了已有 `dsh web` 时，壳不持有它的进程句柄，退出时不会杀它（避免误杀你手动启动的实例）。
- **dsh web 意外退出 / 掉线**（仅自己拉起的实例）：**停留在该端点自己的路由层状态页**（已断开 / 加载失败组件，WSL 端点为三步引导页的状态原位刷新），不再跳转到「桌面端配置」页；标题栏同步提示原因，可从该页直接重试 / 重启（重启期间的退出被识别为有意行为，不退出应用）。仅用户主动操作（「页面」菜单选桌面端配置、编辑 / 重置端点设置）才切回设置页。
- **WSL 引导页检测纪律**：点击 WSL 页 = 进入路由层「加载中」并运行**首次检测**，检测完成才自动落到卡住的步骤；后台周期检测（60s）**不会移动用户正在阅读的步骤**，只原位刷新各步的状态行 / 底部状态栏；仅点击「我已安装，重新检测」（手动检测）或一键安装完成后的自动复检才会重新落步。
- **自测**：`npm run selftest` 验证端口策略辅助函数（空闲/占用探测、占用进程 PID + 名称识别；使用 3987 测试端口，不碰 3080）。
- **测试桩（开发用，不随包发布）**：`tools/fake-dsh.js` / `fake-dsh.cmd` 模拟 `dsh web`（解析 `web --no-open --port N`、打印与真实 dsh 一致的 URL 行、伺服一个「测试桩」页面），`tools/dummy-server.js` 模拟端口占用假服务。配合 `npm start -- --port=3987 --dsh=tools\fake-dsh.cmd` 可在不触碰真实 dsh 数据的情况下验证拉起 / 冲突全流程。

## 从源码运行（开发者 / macOS·Linux 用户）

**前置条件**：Node.js ≥ 18。

```bash
git clone https://github.com/WJBFks/dsh-desktop-pure.git
cd dsh-desktop-pure
npm install          # 首次安装 Electron（下载二进制较慢，属正常）
npm start            # 启动壳
npm run dev          # 同上 + 转发 dsh web 日志到终端（--verbose）
npm run selftest     # 端口策略自测（用 3987 测试端口，不碰 3080）
```

> Electron 下载受阻时（国内网络常见），先设置镜像再安装：
> PowerShell：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`
> CMD：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

**命令行配置**

| 参数 | 环境变量 | 说明 | 默认 |
| --- | --- | --- | --- |
| `--port=<n>` | `DSH_DESKTOP_PORT` | `dsh web` 监听端口（`0` = 系统分配） | `3080` |
| `--url=<url>` | `DSH_DESKTOP_URL` | 直接加载该地址，不 spawn、不探测 | 无 |
| `--dsh=<path>` | `DSH_DESKTOP_DSH` | `dsh` 可执行文件的完整路径 | `dsh`（走 PATH） |
| `--verbose` | `DSH_DESKTOP_VERBOSE=1` | 转发 dsh 日志到终端 | 关 |

示例：`npm start -- --port=8080`、`npm start -- --url=http://127.0.0.1:3080`

> 注：早期未正式命名时，仓库与环境变量前缀曾分别用 `dsh-electron` / `DSH_ELECTRON_*`；现已统一为 *DSH Desktop Pure* / `DSH_DESKTOP_*`。为兼容旧配置，`DSH_ELECTRON_*` 仍会被识别（新前缀优先）。

## 升级 DSH

```bash
npm update -g @deepseek-ai/dsh
# 重启 DSH Desktop Pure 即可 —— 壳无需重新打包
```

若某次 DSH 升级改变了页面结构、导致端口探测误判，控制台会打印 `[port-probe]` 警告并指向 `port-probe.js` 的 `HARNESS_MARKERS` 数组——按提示补充新标记即可。该降级路径保证应用**不会崩溃**，最坏表现为「把 Harness 误判为端口占用」并给出冲突弹窗。

## 安全说明

- 渲染进程保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，与普通浏览器标签同级；
- 窗口内仅允许 loopback http(s) 导航与弹窗，远程链接一律 `shell.openExternal` 交系统浏览器，禁用一切 `<webview>`；
- Harness 的 `/api` 仍由 `dsh web` 服务端的 browser-trust 栅栏（Host / Sec-Fetch-Site / Origin 校验）把关；
- 请勿为「加功能」放宽上述渲染进程设置——那会重新打开本地 RCE 攻击面，也违背本项目的套壳定位。

## 目录结构

```
dsh-desktop-pure/
├── main.js              # 主进程：端口策略 / spawn·复用 / 标题栏·菜单·托盘 / 主题 / 生命周期
├── port-probe.js        # 纯 Node 端口探测 + 占用进程识别（无 Electron 依赖，可独立自测）
├── titlebar.html        # 壳自有：单行标题栏（DSH 图标切换菜单 + 状态点 + 菜单按钮 + 浏览器打开 + 窗口控制 + 拖拽区）
├── menu.html            # 壳自有：下拉菜单（固定位置弹出、hover 切换、主题感知）
├── loading.html         # 壳自有：加载页（重启期间显示，主题感知）
├── pure.html            # 壳自有：内置 DSH Desktop Pure 页（独立于 dsh web，主题感知，参考 DSH 设置页）
├── preload.js           # Harness + Pure 页共用 preload：window.dshShell / window.dshPure + 被动点击通知
├── titlepreload.js      # 标题栏 preload：状态/最大化订阅 + 菜单/窗口控制 IPC
├── menupreload.js       # 菜单 preload：菜单数据订阅 + 动作回传
├── build/               # 图标：icon-256.png / icon.ico（深色）、icon-white-*（备用）
├── assets/              # dsh-whale.svg 官方鲸鱼 logo 素材
├── tools/               # make-icon.js（图标生成）/ selftest-port.js（自测）/ fake-dsh.*（测试桩）
├── .dsh/skills/         # 项目 skill（agent 自动发现）：dsh-electron-dev（开发工作流）、electron-webcontentsview（多视图编排）
├── docs/
│   ├── DETAILS.md       # 本文件（中文）
│   ├── DETAILS.en.md    # 英文版
│   └── PITFALLS.md      # 踩坑指南（现象→根因→规避→修复，供人与 agent 查阅）
├── CHANGELOG.md         # 更新日志（中文，默认）
├── CHANGELOG.en.md      # 更新日志（English）
├── LICENSE              # MIT
├── README.md            # 中文 README
└── README.en.md         # English README
```

## 打包发布（Windows）

建议用 `electron-builder`：

```bash
npm i -D electron-builder
npx electron-builder --win nsis     # Windows 安装包（当前发布目标）
```

**打包时不要把 `@deepseek-ai/dsh` 打进应用**——它是外部运行时依赖，保持「dsh 升级 ≠ 重新打包」这一核心性质。
