# 更新日志（Changelog）

**DSH Desktop Pure** 的所有重要变更都记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/)。

> 语言 / Language：🇨🇳 [中文](./CHANGELOG.md)（默认） · 🇬🇧 [English](./CHANGELOG.en.md)

---

## [0.2.0] — 2026-07-20

### 新增

- **内置设置页（「桌面端配置」）**：壳自带的独立页面，风格参考 DSH Web 设置面板——左侧导航（外观 / DSH Web / 关于）+ 居中内容主体，支持浅色 / 深色主题。
- **「页面」切换菜单**：标题栏 `文件` 左侧新增按钮，下拉切换 **桌面端配置** 与 **DSH Web**。
- **布局切换**：设置页提供 `全屏 / 卡片` 切换（持久化到 `userData/layout.json`）。

### 变更

- **切换保留 dsh web 会话**：在设置页与 DSH Web 之间切换时不再重新加载（两个常驻 `WebContentsView`，隐藏者移出屏幕而非销毁），对自建与复用实例均有效。
- **启动失败改为回退**到设置页，而不再退出应用。
- 端口冲突对话框改为：**重试 / 改用 DSH Desktop Pure / 退出**（原为 重试 / 关闭）。
- 标题栏状态：新增 `Pure 页` 状态；连接中文案更清晰。

### 修复

- 加载页不再覆盖纯页（改用独立的加载覆盖层）。
- 命名统一为 `DSH_DESKTOP_*`（旧 `DSH_ELECTRON_*` 仍兼容）。

---

## [0.1.0] — 2026-07-18

### 新增

- 首个发布版本；**Windows 安装包**。
- `dsh web` 的零侵入 Electron 套壳（不修改 DSH 任何代码 / 资源 / 配置，独立于 DSH 版本）。
- 单端口策略（绝不静默漂移）：复用已有 `dsh web` / 自动拉起 / 冲突对话框（进程名 + PID）。
- 自绘单行标题栏：`文件 / 视图 / 服务器` 菜单、居中连接状态、在浏览器中打开、窗口控制（Win/Linux）/ 原生交通灯（macOS）。
- 系统托盘：隐藏到托盘，dsh 服务器后台续跑。
- 一键**重启 dsh 服务器**（主题感知加载页，重启不退出应用）。
- 主题：浅色 / 深色 / 跟随系统（`nativeTheme`，持久化到 `userData/theme.json`）。
- 安全加固：渲染进程 `sandbox` + `contextIsolation` + 无 `nodeIntegration`；仅允许 loopback 导航；外链交系统浏览器；禁用 `<webview>`。
