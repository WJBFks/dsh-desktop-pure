# DSH Desktop Pure · Detailed Reference

> Details for **power users and contributors**: runtime behavior, running from source, upgrading DSH, security, directory layout, packaging. Regular users only need the [README](../README.en.md).

**Language**：🇨🇳 [中文](./DETAILS.md)（default） · 🇬🇧 [English](./DETAILS.en.md)

## Behavior

- **Lifecycle**: `✕` / "File → Minimize to tray" hides the window into the tray (the dsh server keeps running); tray "Quit" or "File → Quit" truly exits and cleans up the `dsh web` process tree **the shell itself spawned** (Win: `taskkill /T /F`; POSIX: SIGTERM).
- **Built-in DSH Desktop Pure page ("桌面端配置")**: the "页面" button left of `File` in the title bar opens a dropdown to switch **桌面端配置 / DSH Web**. The Pure page is a shell-owned, standalone page (five sections: Startup / Appearance / DSH Web / Changelog / About, plus a full-window / card layout toggle; the DSH Web section is a multi-endpoint tab bar: Windows local / WSL auto-detection & spawn via `wsl → dsh web --host <WSL IP> --trusted-host <WSL IP>` / view-only custom remote addresses, persisted in `userData/endpoints.json`) that mirrors the DSH Web settings-page style, supports light / dark, and is **fully independent of dsh web** — a downed server does not affect it. The shell page loads first, then performs DSH detection, startup, and authentication; if dsh web cannot be brought up it returns to the guide/error state and **does not exit**.
- **Startup settings and first-run environment choice**: startup settings can save Desktop Settings, Windows, or WSL as the default page for the next launch. On Windows, when WSL is detected and no preference is saved, the first launch offers Windows, WSL, or “Not now”; choosing an environment saves it and opens it immediately, while “Not now” opens Windows for this run without saving and asks again next time. A saved preference is not prompted again; if saved WSL is unavailable, the app returns to Desktop Settings while retaining the preference.
- **Startup flow and progress**: the shell loads first, then performs real DSH detection, startup, and authentication before loading the DSH web page. The startup overlay reports `checking`, `starting`, `authenticating`, and `loading`; these phases are not a real web-loading percentage. Web-page loading uses `did-finish-load` as its completion boundary; after 30 seconds it enters the error guide and offers retry.
- **Desktop changelog**: changelog content is read from `CHANGELOG.md` / `CHANGELOG.en.md` on the GitHub repository's `main` branch, rather than being manually hard-coded in `main.js`. The Chinese / English buttons switch languages, with Chinese shown by default; a read failure shows a notice and offers retry.
- **Changelog presentation**: the app hides introductory content before the first version; the newest version is expanded by default and the remaining versions are collapsed. The Chinese and English logs use a shared parser, checked by `npm run check:changelog` for version headings, continued entries, matching bilingual dates, semantic-version descending uniqueness, and valid dates. See [CHANGELOG_FORMAT](./CHANGELOG_FORMAT.md) for the format rules.
- **Changelog cache**: the Chinese and English logs are persisted separately under `userData/changelog-cache`. When the page opens, it reads the local cache first, then sends a background conditional request with the cached ETag / Last-Modified; a GitHub `304` marks the cache as verified. When the network is unavailable or the request otherwise fails, the old cache remains visible with an explicit unverified-content notice. Update visibility still depends on the network and CDN; GitHub commits are not guaranteed to appear immediately.
- **Remote-endpoint tokens**: custom remote endpoints use a separate password-type token field and also accept complete URLs containing a `token` parameter. Same-origin edits preserve the credential when it is not changed; a new token replaces it, and the user can explicitly clear it. Changing origin does not implicitly carry over the old token. Tokens are encrypted with Electron safeStorage and excluded from the Pure state snapshot; “open in browser” reconstructs the token-bearing runtime URL in the main process. A legacy plaintext token in an old URL is atomically migrated during initialization when possible; encryption or writing failure retains the original file, so not every legacy plaintext token is guaranteed to disappear immediately. New tokens are rejected when encryption is unavailable; decryption failure retains the original cipher and allows re-entry or explicit clearing.
- **Reused services are not the shell's to manage**: when reusing an existing `dsh web`, the shell holds no handle to it and will not kill it on exit (avoiding killing an instance you started manually).
- **Unexpected dsh web exit / drop** (self-spawned instances only): the window **stays on that endpoint's own router-layer state page** (disconnected / error component; the WSL endpoint's three-step guide updates its status in place) instead of jumping to the "桌面端配置" page; the title bar shows the reason and you can retry / restart from the page (exits during a restart are recognized as intentional — the app stays up). Only explicit user actions (choosing 桌面端配置 from the "页面" menu, editing / resetting endpoint settings) switch back to the settings page.
- **Server-menu operation scope**: the server menu includes “Close dsh server”; “Restart dsh server”, “Close dsh server”, and “Open in system browser” include the current page name. Close/restart is enabled only when the current page has a verifiable shell-owned child or a strictly matching Windows recovery candidate. The three server actions on the Pure settings page remain disabled without a suffix; close/restart for custom remote endpoints are shown disabled with the current page name. Failures are not relabeled as disconnected and do not broadly terminate the shell, remote endpoints, or other system services; custom remote endpoint processes are not managed by the shell.
- **After disconnect**: the app remains on the current endpoint's disconnected/error page and waits for an explicit user retry; the shell does not exit or reconnect automatically.
- **WSL setup-guide detection discipline**: opening the WSL page enters the router's "loading" state and runs the **first detection**; the steps land on the stuck step only when it finishes. Background periodic detection (60 s) **never moves the step the user is reading** — it only refreshes the per-step status lines and the bottom status bar in place. Only the manual "我已安装，重新检测" button (or the auto re-check after one-click install) re-lands the steps.
- **WSL distro information and detection failures**: displayed distro information comes from the actual `PRETTY_NAME` / version in the distro's `/etc/os-release`; the registered name `Ubuntu` does not itself identify the distro version. `VERSION` in `wsl --list --verbose` means WSL 1 or WSL 2. Detection failures retain their errors instead of being uniformly classified as not installed, helping diagnose permission, service, or timeout problems; this is not a guarantee that WSL issues on every machine are solved.
- **Windows local startup-failure guide**: external Node.js/npm, DSH, and startup connection are checked separately in three steps. The Node one-click action runs winget with `OpenJS.NodeJS.LTS`; if winget is unavailable, the guide points to nodejs.org for manual LTS installation. The DSH one-click action runs `npm install -g @deepseek-ai/dsh`. Installation is user-triggered only; the page supports copying manual commands, re-checking, and displaying progress and failure details. Windows and WSL share the “I installed/started it, re-check” footer; only verified readiness becomes disabled “Installed/Started”, while their platform-specific commands remain distinct.
- **Windows manual DSH authentication**: when the local DSH requires authentication, the guide accepts either a complete local authentication URL or a token-only input. The token remains in memory only and is not stored in plaintext. Automatic startup in this state is a forced start and requires a second confirmation before stopping the existing DSH and restarting; operation is allowed only after the DSH process identity is verified, and unknown port occupants are rejected. Normal connection states are unchanged.
- **Windows manually reused authenticated instance**: when reusing an authenticated local DSH instance, the title-bar status is redacted as `***` by default and reveals the complete URL/token only on hover; the Pure settings page never exposes the token. Closing or restarting a reused instance requires a second confirmation, defaulting to cancel; the listener process identity is rechecked before operation, and unknown occupants or a changed identity are rejected. These operations do not manage arbitrary remote processes.
- **Newer DSH startup handshake**: supports the flow where dsh emits a token URL on stdout and then authenticates through 303 + cookie; readiness is recognized immediately after startup instead of falsely waiting 120 seconds before terminating. Tokens are redacted when `--verbose` forwards logs; development tests include an HTTP regression fixture.
- **Windows token recovery**: after a newer token-based DSH starts successfully, the app stores only the minimum recovery credential encrypted with Windows safeStorage/DPAPI. If the desktop process exits abnormally while dsh web remains, the next launch verifies the listening-process identity (including a dynamic `--port 0` launch) and then strictly validates the token 303/cookie handshake before reuse; later health checks and session reuse use the same handshake. Normal exit stops only a process that still matches the recovery record and clears the credential only after success; an unexpected child exit clears it. An explicit DSH 401 fails fast without multiple grace waits; an arbitrary 401 is not treated as DSH. If another terminal started an instance and this app has never received its token, the token cannot be obtained automatically; use the complete URL printed by that terminal.
- **Self-test**: `npm run selftest` verifies the port-policy helpers (free/busy probing, occupant PID + name discovery; uses test port 3987, never touches 3080).
- **Test stubs (dev only, not shipped)**: `tools/fake-dsh.js` / `fake-dsh.cmd` emulate `dsh web` (parses `web --no-open --port N`, prints the same URL line as real dsh, serves a "test stub" page); `tools/dummy-server.js` emulates a port occupant. Combined with `npm start -- --port=3987 --dsh=tools\fake-dsh.cmd` you can verify the spawn/conflict flow without touching real dsh data.

## Running from source (developers / macOS·Linux users)

**Prerequisites**: Node.js ≥ 18.

```bash
git clone https://github.com/WJBFks/dsh-desktop-pure.git
cd dsh-desktop-pure
npm install          # first-time Electron download (slow, normal)
npm start            # launch the shell
npm run dev          # same + forward dsh web logs to the terminal (--verbose)
npm run selftest     # port-policy self-test (uses test port 3987, never 3080)
```

> If the Electron download is blocked (common on CN networks), set the mirror first:
> PowerShell: `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`
> CMD: `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

**Command-line configuration**

| Flag | Env var | Description | Default |
| --- | --- | --- | --- |
| `--port=<n>` | `DSH_DESKTOP_PORT` | port for `dsh web` (0 = OS-assigned) | `3080` |
| `--url=<url>` | `DSH_DESKTOP_URL` | load this URL directly (no spawn/probe) | none |
| `--dsh=<path>` | `DSH_DESKTOP_DSH` | full path to the `dsh` executable | `dsh` (PATH) |
| `--verbose` | `DSH_DESKTOP_VERBOSE=1` | forward dsh logs to the terminal (tokens redacted) | off |

Examples: `npm start -- --port=8080`, `npm start -- --url=http://127.0.0.1:3080`

> Note: before the official name, the repo and env-var prefix were `dsh-electron` / `DSH_ELECTRON_*`; these are now standardized to *DSH Desktop Pure* / `DSH_DESKTOP_*`. For backward compatibility `DSH_ELECTRON_*` is still recognized (the new prefix wins).

## Upgrading DSH

```bash
npm update -g @deepseek-ai/dsh
# restart DSH Desktop Pure — no repackaging needed
```

If a DSH release changes the page structure and port probing misjudges, the console prints a `[port-probe]` warning pointing at the `HARNESS_MARKERS` array in `port-probe.js` — add the new marker as instructed. This degradation path guarantees the app **never crashes**; the worst case is "Harness misjudged as a port conflict" with a conflict dialog.

## Security

- The renderer keeps `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` — the same posture as a normal browser tab;
- Only loopback http(s) navigation/popups are allowed inside the window; remote links always go through `shell.openExternal` to the OS browser; all `<webview>` are disabled;
- The Harness `/api` remains gated by the `dsh web` server-side browser-trust fence (Host / Sec-Fetch-Site / Origin checks);
- Do **not** loosen the renderer settings "to add a feature" — it would re-open the local RCE attack surface and betray the shell's purpose.

## Directory layout

```
dsh-desktop-pure/
├── main.js              # main process: port policy / spawn·reuse / titlebar·menu·tray / theme / lifecycle
├── port-probe.js        # pure-Node port probing + occupant discovery (no Electron deps, self-testable)
├── titlebar.html        # shell-owned: one-row title bar (DSH icon switcher + status + menu buttons + open-in-browser + window controls + drag region)
├── menu.html            # shell-owned: dropdown menu (fixed position, hover-switch, theme-aware)
├── loading.html         # shell-owned: loading page (shown during restart, theme-aware)
├── pure.html            # shell-owned: built-in DSH Desktop Pure page (independent of dsh web, theme-aware, mirrors DSH settings page)
├── preload.js           # shared preload for Harness + Pure page: window.dshShell / window.dshPure + passive click notice
├── titlepreload.js      # title-bar preload: status/maximize subscriptions + menu/window-control IPC
├── menupreload.js       # menu preload: menu-data subscription + action callbacks
├── build/               # icons: icon-256.png / icon.ico (dark), icon-white-* (spare)
├── assets/              # dsh-whale.svg official whale logo source
├── tools/               # make-icon.js (icon gen) / selftest-port.js (port self-test) / selftest-startup.js (startup regression self-test) / selftest-startup-preferences.js, selftest-startup-settings-ui.js (startup-settings tests) / selftest-remote-token.js, selftest-remote-token-ui.js (remote-token tests) / fake-dsh.* (test stubs)
├── docs/
│   ├── DETAILS.md       # this file (Chinese)
│   └── DETAILS.en.md    # English
├── CHANGELOG.md         # changelog (Chinese, default)
├── CHANGELOG.en.md      # changelog (English)
├── LICENSE              # MIT
├── README.md            # Chinese README
└── README.en.md         # English README
```

## Packaging (Windows)

Recommended: `electron-builder`:

```bash
npm i -D electron-builder
npx electron-builder --win nsis     # Windows installer (current release target)
```

**Do NOT bundle `@deepseek-ai/dsh` into the app** — it is an external runtime dependency; bundling it would break the "dsh upgrade ≠ repackaging" invariant.
