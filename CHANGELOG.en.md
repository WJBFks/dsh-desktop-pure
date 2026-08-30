# Changelog

All notable changes to **DSH Desktop Pure** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

> Language：🇨🇳 [中文](./CHANGELOG.md)（default） · 🇬🇧 [English](./CHANGELOG.en.md)

---

## [0.3.0] — 2026-08-30

### Added

- **Multi-endpoint DSH Web**: the DSH Web section of the settings page is now a tab bar — **Windows local** (auto-detected from the host OS), **WSL** (on Windows: auto-detects WSL and dsh inside the distro), and **custom remote addresses** (user-added, persisted in `userData/endpoints.json`).
- **WSL dsh web auto-detection and spawn**: reuses an instance already running inside WSL; otherwise spawns one (`wsl` → `dsh web --host <WSL IP> --trusted-host <WSL IP> --no-open`), the WSL IP taken from the distro's eth0.
- Remote endpoints are **view-only**: no local spawn / restart; connection failures explain the likely cause (the remote side must declare `--trusted-host`).

### Changed

- Navigation policy: in-window loading now permits loopback plus the host of any registered endpoint (WSL IP / remote address); all other external links still go to the system browser.
- "Restart dsh server" acts on the currently selected endpoint (local / WSL); remote addresses have no restart action.

---

## [0.2.0] — 2026-08-30

### Added

- **Built-in settings page** ("桌面端配置"): a shell-owned, independent page styled
  after the DSH Web settings panel — left sidebar (Appearance / DSH Web /
  Changelog / About) plus a centered content body. Supports light / dark themes.
- **"页面" switcher menu**: a button left of `文件` in the title bar opens a
  dropdown to toggle between **桌面端配置** and **DSH Web**.
- **Layout switch**: the settings page offers a `全屏 / 卡片` toggle (persisted in
  `userData/layout.json`).

### Changed

- **dsh web session preserved** when toggling between the settings page and
  DSH Web (two live `WebContentsView`s; the hidden one is parked off-screen,
  not reloaded). Works for both shell-spawned and reused `dsh web` instances.
- **Startup failure now degrades** to the settings page instead of exiting the
  app.
- Port-conflict dialog: **重试 / 改用 DSH Desktop Pure / 退出** (was 重试 / 关闭).
- Title-bar status: added a `Pure page` state; clearer connecting text.

### Fixed

- Loading page no longer overwrites the Pure page (dedicated loading overlay).
- Unified naming to `DSH_DESKTOP_*` (legacy `DSH_ELECTRON_*` still accepted).

---

## [0.1.0] — 2026-08-29

### Added

- First public release; **Windows installer**.
- Zero-intrusion Electron shell for `dsh web` (no DSH code, resources, or config
  modified; independent of DSH releases).
- Single-port policy (never silently drifts): reuse an existing `dsh web` /
  auto-spawn / conflict dialog with process name + PID.
- Self-drawn one-row title bar: `文件 / 视图 / 服务器` menus, centered connection
  status, open-in-browser, window controls (Win/Linux) / native traffic lights
  (macOS).
- System tray: hide-to-tray while the dsh server keeps running.
- One-click **restart dsh server** (theme-aware loading page; the app never quits
  on restart).
- Theme: light / dark / follow system (`nativeTheme`, persisted in
  `userData/theme.json`).
- Hardened renderer: `sandbox` + `contextIsolation` + no `nodeIntegration`;
  loopback-only navigation; remote links to the OS browser; `<webview>` disabled.
