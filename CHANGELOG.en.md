# Changelog

All notable changes to **DSH Desktop Pure** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

> Language：🇨🇳 [中文](./CHANGELOG.md)（default） · 🇬🇧 [English](./CHANGELOG.en.md)

---

## [0.2.5] — 2026-08-30

### Added

- **Multi-endpoint DSH Web**: the DSH Web section of the settings page is now a tab bar — **Windows local** (auto-detected from the host OS), **WSL** (on Windows: auto-detects WSL and dsh inside the distro), and **custom remote addresses** (user-added, persisted in `userData/endpoints.json`).
- **WSL dsh web auto-detection and spawn**: reuses an instance already running inside WSL; otherwise spawns one (`wsl` → `dsh web --host <WSL IP> --trusted-host <WSL IP> --no-open`), the WSL IP taken from the distro's eth0.
- Remote endpoints are **view-only**: no local spawn / restart; connection failures explain the likely cause (the remote side must declare `--trusted-host`).
- **Endpoint editing**: all endpoints (Windows / WSL / custom) support editing name, address (empty = auto-derived), and port. Extra settings (launch command / WSL dsh path) collapse at the bottom with a blue title + `*` marker. Saving only probes (no connect, no view switch).
- **In-shell router layer (router.html)**: clicking a page immediately enters the router layer (loading / error / not-connected state components) while the backend connects in parallel. On success, jumps to the backend; on failure, shows the router error page. Already-connected routes skip the router layer.
- **Per-endpoint WebContentsView**: switching endpoints does not re-navigate or re-boot React — sessions (DOM / memory / form state) are fully preserved. Undisplayed endpoint views are parked off-screen and destroyed on quit.
- **Launches directly into the Windows (local) endpoint** by default.

### Changed

- Navigation policy: in-window loading now permits loopback plus the host of any registered endpoint (WSL IP / remote address); all other external links still go to the system browser.
- "Restart dsh server" acts on the currently selected endpoint (local / WSL); remote addresses have no restart action.
- **"Pages" menu**: gray "DSH Web" heading + per-endpoint status dots (green = connected / yellow = connecting / gray = not connected / red = disconnected) + separator + Desktop Settings (blue dot). Clicking an endpoint opens that endpoint (no forced return to Desktop Settings). Active item uses a blue border (not background).
- **Title bar status**: shows only the **current page's** own status (not global). Gray = never connected (including failed attempts), red = was connected then dropped.
- **Loading state**: no longer a separate page — it is the endpoint's starting state (router-layer spinner + title bar "Connecting…").
- Menu dropdown: drop shadow (zero-offset, uniform) + 10px border-radius + 6px item hover radius + 6px side margin.
- WSL without dsh shows gray (not connected) instead of red error.
- Stale connection results only update the endpoint's state; they never steal the current view.

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
