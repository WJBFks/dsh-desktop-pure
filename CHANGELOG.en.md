# Changelog

All notable changes to **DSH Desktop Pure** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

> Language：🇨🇳 [中文](./CHANGELOG.md)（default） · 🇬🇧 [English](./CHANGELOG.en.md)

---

## [0.4.0] — 2026-09-08

### Changed

- **Title-bar URL redaction**: online status shows token query values as `***`; hovering the status area directly and temporarily renders the full URL/token, then redacts it on leave, window blur, or hide, without a native tooltip. The status area remains an Electron-native drag/double-click-maximize region; because DOM mouse events are unreliable there, main-process screen-coordinate polling performs the hit test.
- **Windows local startup-failure guide**: external Node.js/npm, DSH, and startup connection are checked separately in a three-step guide; installation runs only after the user clicks. Its footer feedback now matches the WSL guide (“I installed/started it, re-check” and only verified states become disabled “Installed/Started”).
- **Node.js installation**: the one-click action uses winget to install `OpenJS.NodeJS.LTS`; when winget is unavailable, the guide points to nodejs.org for manual LTS installation.
- **DSH installation and feedback**: the one-click action runs `npm install -g @deepseek-ai/dsh`; users can copy manual commands, re-check, and see install progress and failure details.
- **Desktop changelog**: changelog content is now read from `CHANGELOG.md` / `CHANGELOG.en.md` on the GitHub repository's `main` branch instead of being hard-coded manually in `main.js`. The Chinese / English buttons switch languages, with Chinese shown by default; a read failure shows a notice and offers retry.
- **Changelog cache and validation**: each language is persistently cached under `userData/changelog-cache`; the page shows the local cache first, then performs a background conditional request using ETag / Last-Modified, with `304` confirming that the cached copy is still valid. When offline or otherwise unavailable, the old cache remains visible with an explicit unverified-content notice. Visibility of updates still depends on the network and CDN; GitHub commits are not guaranteed to appear instantly.
- **Startup flow and progress**: the desktop shell loads first, then performs real DSH detection, startup, and authentication before loading the DSH web page; the startup overlay reports the `checking` / `starting` / `authenticating` / `loading` phases. Web-page loading completes at `did-finish-load`; after 30 seconds it enters the error guide and offers retry. These phases are not a real web-loading percentage.
- **Startup regression self-test**: added `tools/selftest-startup.js`, which uses extracted functions and mocks to cover startup-overlay, stale-result, page-load-timeout, and retry regressions without starting Electron or a DSH process.
- **Changelog presentation**: the app hides the introductory content before the first version; the newest version is expanded by default and the remaining versions are collapsed.
- **Changelog format validation**: added a shared parser and `npm run check:changelog` to validate version headings, categories, continued bullet lines, matching bilingual dates, unique descending versions, and valid dates.
- **Startup settings and first-run environment choice**: the Desktop Settings page now includes startup settings that can save Desktop Settings, Windows, or WSL as the default page for the next launch. On Windows, when WSL is detected and no preference is saved, the first launch offers Windows, WSL, or “Not now”; choosing an environment saves it and opens it immediately, while “Not now” opens Windows for this run without saving and asks again next time. A saved preference is not prompted again; if saved WSL is unavailable, the app returns to Desktop Settings while retaining the preference.
- **Startup-settings regression tests**: added `tools/selftest-startup-preferences.js` and `tools/selftest-startup-settings-ui.js` covering preference persistence, first-run choice, fallback, and settings-page interaction; no npm script was added.
- **Remote-endpoint tokens**: remote endpoints now support a separate password-type token field and also accept complete URLs containing a `token` parameter; editing can retain, replace, or explicitly clear the credential. Tokens are encrypted with Electron safeStorage and are excluded from the Pure state snapshot; the system-browser action reconstructs the runtime URL with its token in the main process. Remote authentication now uses the token-authenticated path, fixing the former initial custom-endpoint probe through the legacy path. Legacy plaintext tokens in URLs are attempted for atomic migration at initialization; if encryption or writing fails, the original file is retained, so not every legacy plaintext token is guaranteed to disappear immediately. New tokens are rejected when encryption is unavailable; decryption failure retains the original cipher and allows re-entry or explicit clearing.
- **Remote-endpoint token regression tests**: added `tools/selftest-remote-token.js` and `tools/selftest-remote-token-ui.js` covering parsing, encryption, migration boundaries, origin isolation, redacted snapshots, and editing interactions.
- **Server-menu operation scope**: added “Close dsh server”; “Restart dsh server”, “Close dsh server”, and “Open in system browser” include the current page name. Server operations are enabled only when the current page has a verifiable shell-owned child or a strictly matching Windows recovery candidate. The three server actions on the Pure settings page remain disabled without a suffix, and close/restart for custom remote endpoints are shown disabled with the current page name. Close/restart failures are not presented as disconnected and do not broadly terminate the shell, remote endpoints, or other system services.
- **Stay on the current page after disconnect**: when dsh goes offline, the app remains on the current endpoint's disconnected/error page; the user retries explicitly. The shell does not exit or reconnect automatically.
- **WSL distro information and detection errors**: displayed distro information comes from the distro's actual `PRETTY_NAME` / version in `/etc/os-release`; a registered name such as `Ubuntu` does not identify the distro version. `VERSION` in `wsl --list --verbose` means WSL 1 or WSL 2. Detection failures are no longer all shown as “not installed”; the error is retained to help diagnose permission, service, or timeout problems. This does not claim to solve WSL issues on every machine.
- **Compatibility with the newer DSH startup handshake**: supports a token URL emitted on stdout followed by 303 + cookie authentication; readiness can be recognized immediately after startup instead of waiting 120 seconds before terminating. Tokens are redacted in `verbose` logs; an HTTP regression fixture was added.
- **Windows token recovery**: after a newer token-based DSH starts successfully, the app stores only the minimum recovery credential, encrypted with Windows safeStorage/DPAPI. If the desktop process exits abnormally while dsh web remains, the next launch verifies the listening process identity (including a dynamic `--port 0` launch) and strictly validates the token 303/cookie handshake before reuse; health checks and session reuse use the same handshake. Normal exit stops only the still-matching process and clears the credential only after that succeeds; an unexpected child exit clears the record.
- **Windows token-recovery resilience**: a transient port-owner/CIM identity lookup or token-handshake failure now gets a bounded retry and retains the encrypted credential instead of deleting it. The record is cleared only for a confirmed listener identity mismatch, invalid record, or DSH's exact invalid-authentication response; changing the configured port does not delete an old-port credential. With no recovery record, a busy/auth-required listener — as well as an unavailable recovery — now reaches the existing Windows setup guide's actionable error state rather than blocking startup with an unknown-process termination dialog, and arbitrary 401 responses are never reused.
- **Authentication failure handling**: an explicit DSH 401 fails fast without multiple grace waits; an arbitrary 401 is never treated as DSH. An instance started manually from another terminal cannot have its token obtained automatically if this app has never received it; use the complete URL printed by that terminal.
- **Token-free local-address probing**: fixed stale token-authentication state causing a token-free local address to be misreported as a port conflict; the probe method is now selected from the URL being checked. Only an exact DSH 401 produces the instruction to use the complete authentication URL printed by the terminal; other 401 responses remain port conflicts. The app still cannot obtain the token of an instance started manually.
- **Windows manual DSH authentication guide**: when authentication is required, the Windows guide accepts either a complete local authentication URL or a token-only input. The token is kept in memory only and is not stored in plaintext. Automatic startup in this authentication state becomes a forced start: it asks for a second confirmation before stopping the existing DSH and restarting, and only a DSH process with a verified identity may be operated on; unknown occupants are rejected. Normal connection states are unchanged.
- **Windows manually reused authenticated instance**: when reusing an authenticated local DSH instance, the title-bar status shows `***` by default and reveals the complete URL/token only on hover; the Pure settings page never exposes the token. Closing or restarting a reused instance requires a second confirmation, defaulting to cancel; process identity is rechecked before operation, and unknown occupants or a changed listener identity are rejected. This does not extend to managing arbitrary remote processes.
- **Connection handoff after forced start**: after confirming that the old port is free, stale connection state is cleared and a new DSH connection is started. If the old process has already stopped and the port is confirmed free, startup proceeds safely without killing anything, while stale authentication messaging is cleared. A failed new instance remains in a retryable state.
- **Port-release probing fix**: fixed the case where `probe3080` reported the port free but `findPortOwnerAsync` returned PID 0, causing the port-release wait to fail. Netstat parsing no longer treats `TIME_WAIT` or established connections as listeners and excludes PID 0; synchronous and asynchronous port-owner parsing now agree.
- **DSH Web token compatibility**: DSH introduced Web-interface token authentication in `v0.1.2-alpha.1` (2026-08-27); the currently tested version is `0.1.2-rc.1`. v0.4.0 supports the Token URL and `303`/cookie handshake during automatic startup, complete-URL or token-only Windows manual input, remote-endpoint tokens, and title-bar token redaction with hover reveal. A token is not a model API key, and the app does not bypass authentication; future compatibility still depends on authentication/protocol changes. See the official [dsh-v0.1.2-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1).
- **Release check in About**: after the shell is ready, it performs one non-blocking automatic check of GitHub's latest stable Release; the About page still supports manual checks and shows `current` / `new` / `ahead` / `none` / `error` states. When an update is available, a yellow exclamation mark appears in the top-right; clicking it opens Desktop Settings → About and highlights the update area. No update notice is shown for an up-to-date result or a failed check. Release assets are offered as manual downloads through the system browser; the app never overwrites or executes an installer. Pre-releases are not default upgrade targets; rate limits or offline failures can be retried with Release-page fallback.
- Corrected legacy documentation that said Windows must be prepared in advance and the roadmap entry claiming automatic DSH installation.

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
