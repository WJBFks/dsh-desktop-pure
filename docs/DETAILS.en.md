# DSH Desktop Pure · Detailed Reference

> Details for **power users and contributors**: runtime behavior, running from source, upgrading DSH, security, directory layout, packaging. Regular users only need the [README](../README.en.md).

**Language**：🇨🇳 [中文](./DETAILS.md)（default） · 🇬🇧 [English](./DETAILS.en.md)

## Behavior

- **Lifecycle**: `✕` / "File → Minimize to tray" hides the window into the tray (the dsh server keeps running); tray "Quit" or "File → Quit" truly exits and cleans up the `dsh web` process tree **the shell itself spawned** (Win: `taskkill /T /F`; POSIX: SIGTERM).
- **Built-in DSH Desktop Pure page ("桌面端配置")**: the "页面" button left of `File` in the title bar opens a dropdown to switch **桌面端配置 / DSH Web**. The Pure page is a shell-owned, standalone page (four sections: Appearance / DSH Web / Changelog / About, plus a full-window / card layout toggle; the DSH Web section is a multi-endpoint tab bar: Windows local / WSL auto-detection & spawn via `wsl → dsh web --host <WSL IP> --trusted-host <WSL IP>` / view-only custom remote addresses, persisted in `userData/endpoints.json`) that mirrors the DSH Web settings-page style, supports light / dark, and is **fully independent of dsh web** — a downed server does not affect it. The app starts on DSH Web; if the server cannot be reached it falls back to the Pure page and **does not exit**.
- **Reused services are not the shell's to manage**: when reusing an existing `dsh web`, the shell holds no handle to it and will not kill it on exit (avoiding killing an instance you started manually).
- **Unexpected dsh web exit / drop** (self-spawned instances only): the window **stays on that endpoint's own router-layer state page** (disconnected / error component; the WSL endpoint's three-step guide updates its status in place) instead of jumping to the "桌面端配置" page; the title bar shows the reason and you can retry / restart from the page (exits during a restart are recognized as intentional — the app stays up). Only explicit user actions (choosing 桌面端配置 from the "页面" menu, editing / resetting endpoint settings) switch back to the settings page.
- **WSL setup-guide detection discipline**: opening the WSL page enters the router's "loading" state and runs the **first detection**; the steps land on the stuck step only when it finishes. Background periodic detection (60 s) **never moves the step the user is reading** — it only refreshes the per-step status lines and the bottom status bar in place. Only the manual "我已安装，重新检测" button (or the auto re-check after one-click install) re-lands the steps.
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
| `--verbose` | `DSH_DESKTOP_VERBOSE=1` | forward dsh logs to the terminal | off |

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
├── tools/               # make-icon.js (icon gen) / selftest-port.js (self-test) / fake-dsh.* (test stubs)
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
