# Changelog

All notable changes to **DSH Desktop Pure** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

> Language：🇨🇳 [中文](./CHANGELOG.md)（default） · 🇬🇧 [English](./CHANGELOG.en.md)

---

## [0.3.0] — 2026-09-02

### Added

- **WSL distro selection**: the first WSL setup-guide step now offers three side-by-side choice buttons — `Ubuntu-24.04` (recommended), `Ubuntu-26.04` (latest), and `Ubuntu-22.04` (mature/stable). Each button shows two lines of text; clicking one runs the matching `wsl --install -d <distro>` and locks the other options.

### Changed

- **Endpoint pages (Windows / WSL / custom) no longer jump to the Desktop Settings page** while loading, on load failure, when disconnected, or when the dsh web process exits: they stay on that endpoint's own router-layer state component (loading / error / disconnected) and retry in place. Only explicit user actions (choosing Desktop Settings from the Pages menu, editing / resetting endpoint settings) switch back to the settings page.
- **WSL setup-guide detection discipline**: the first detection shows a "loading" state (no step pre-highlighted) and lands on the stuck step only when it finishes; background periodic detection (now every 60 s instead of 30 s) **never moves the step the user is reading** — it only refreshes the status line / status bar in place. Only the manual 「我已安装，重新检测」 button re-lands the steps.
- **WSL setup-guide visual hierarchy**: all four setup steps now include a full-width divider between the step content and the bottom action button. The divider matches the guide card border in color and thickness and reaches both sides of the border.
- **WSL setup-guide bottom button states**: the bottom “我已安装，重新检测 / 我已启动，重新检测” buttons now use a light-blue background and automatically become non-clickable “已安装 / 已启动” states when the corresponding WSL / Node / DSH / connection readiness check succeeds.
- **Unified WSL setup-guide step layout**: all four steps now follow “title → description → detection status → automatic install/start (recommended) button → collapsed manual installation section.” The previous command/body text moved into the collapsed manual area; steps 1 and 2 add automatic install requests (WSL via Windows elevation running `wsl --install`, Node via the WSL package manager). The automatic install button occupies its own centered row, shows “安装中...” while running, displays “安装中...（N%）” when a percentage can be parsed from installer output, and becomes a non-clickable “已安装 / 已启动” state once detection succeeds. Installer process output is mirrored to the main-process console to help diagnose failed installs. Automatic DSH installation now uses a user-level npm prefix to avoid global `/usr/lib/node_modules` `EACCES` failures; automatic Node installation now uses Node.js 22 to match the current DSH dependency requirements. A live status line under the automatic install button now shows the installer's last meaningful output line (for example npm's `added N packages in Xs`) so progress is visible in the GUI, not only in the main-process console. If a WSL connection fails with `dsh web exited early`, the shell now cleans stale `dsh web` processes, re-probes WSL, and may automatically reinstall DSH or upgrade to Node 22 before retrying once. DSH automatic / manual installation now uses `npm --loglevel=verbose`; automatic installation also writes the full install log to `~/dsh-install-dsh.log` inside WSL.

### Fixed

- **White-screen on load**: removed the CSS-injection based fade (on `file://` / `about:blank` it silently fails, leaving the content area at `opacity: 0` = a permanent white screen); each view now gets a theme-colored background (`view.setBackgroundColor`), so the gap before a fresh document paints shows the theme color instead of white, and theme switches re-sync all views.

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
