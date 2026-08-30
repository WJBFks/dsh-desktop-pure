'use strict';

/**
 * DSH Desktop Pure — thin Electron shell for the DeepSeek Harness Web GUI.
 *
 * Route A: this app contains NO DSH code. It is a hardened Chromium window
 * that either reuses an already-running `dsh web` server (e.g. the harness
 * GUI at http://127.0.0.1:3080) or spawns one on demand, then loads its URL.
 * The shell only READS from DSH (HTTP probes, child stdout, spawned-process
 * management); it never modifies DSH's own files or DOM.
 *
 * Cross-platform: targets Windows, macOS and Linux.
 *   - Windows / Linux: frameless window; the shell draws the window controls
 *     (minimize / maximize / close) on the right of the title bar.
 *   - macOS: titleBarStyle 'hidden' keeps the native traffic-light buttons on
 *     the left; the shell does NOT draw window controls there.
 *   - Process / port helpers already branch on process.platform
 *     (taskkill vs SIGTERM, netstat vs lsof, tasklist vs ps).
 *
 * Port policy (single port, no silent drift): the shell works on ONE port
 * (default 3080). If a harness already serves it → reuse. If the port is free
 * → spawn `dsh web` on it. If a foreign process holds it → show a dialog
 * naming the occupying process and its PID (never fall back to the next port).
 *
 * Top chrome: a one-row title bar holding the 文件 / 视图 / 服务器 menu
 * buttons, the connection status (centered), and the window controls. Each
 * menu button opens a shell-drawn dropdown (a WebContentsView stacked above the
 * harness) fixed directly beneath the button; while a menu is open, hovering
 * another top button switches to its menu. The dropdown is the shell's own
 * menu.html — it never touches the harness DOM.
 *
 * Theme: nativeTheme.themeSource (system / light / dark, persisted in
 * userData) drives Chromium's prefers-color-scheme, so the title bar and menus
 * re-skin via CSS media queries and — if the harness page opts in — it follows.
 * The shell never injects CSS into the harness (Route A).
 *
 * Version-drift safety: every place the shell READS DSH content (page markers,
 * stdout URL line) degrades to a warning instead of crashing.
 */

const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  Tray,
  dialog,
  shell,
  ipcMain,
  nativeTheme
} = require('electron');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { probe, probeWithGrace, findPortOwner } = require('./port-probe.js');

const DEFAULT_PORT = 3080;
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 300;
const WINDOW_TITLE = 'DSH Desktop Pure';
const TITLEBAR_HEIGHT = 40;
const MENU_WIDTH = 224;
const MENU_ITEM_H = 30;
const MENU_SEP_H = 9;
const MENU_PAD_V = 8;
const LIGHT_BG = '#f3f4f6';
const DARK_BG = '#111827';
const LAYOUT = ['full', 'card']; // Pure page: full-window vs centered-card
const DEFAULT_LAYOUT = 'full';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Configuration (--port=, --url=, --dsh=, --verbose + DSH_DESKTOP_* env; legacy DSH_ELECTRON_* still honored)
// ---------------------------------------------------------------------------

function readFlag(name) {
  const eqPrefix = `--${name}=`;
  const eqHit = process.argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqHit !== undefined) return eqHit.slice(eqPrefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function resolveConfig() {
  // Env vars: prefer DSH_DESKTOP_*, fall back to legacy DSH_ELECTRON_* (v0.1.0).
  const env = (sfx) => process.env['DSH_DESKTOP_' + sfx] ?? process.env['DSH_ELECTRON_' + sfx];
  const portRaw = readFlag('port') ?? env('PORT');
  const parsed = Number(portRaw);
  const port =
    portRaw !== undefined && Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
      ? parsed
      : DEFAULT_PORT;
  return {
    port,
    urlOverride: readFlag('url') ?? (env('URL') || undefined),
    dshBin: readFlag('dsh') ?? (env('DSH') || 'dsh'),
    verbose: process.argv.includes('--verbose') || env('VERBOSE') === '1'
  };
}

// ---------------------------------------------------------------------------
// dsh web process management
// ---------------------------------------------------------------------------

/**
 * Spawn `dsh web --no-open --port <port>`.
 * On Windows, npm's global bin is a `.cmd` shim, so the command is built for
 * cmd.exe. Each token is passed as its own argv element: Node quotes each one
 * individually and cmd's /s switch strips the outer pair, so paths containing
 * spaces or backslashes survive. `--no-open` stops dsh from handing the URL to
 * the system browser.
 */
function spawnDsh(dshBin, port) {
  const args = ['web', '--no-open', '--port', String(port)];
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', dshBin, ...args], {
      stdio,
      windowsHide: true
    });
  }
  return spawn(dshBin, args, { stdio });
}

/**
 * Forward child output (verbose only) and capture the
 * `dsh web: http://…` URL line — this is how `--port 0` (OS-assigned)
 * instances are discovered. If a future dsh release changes that line, the
 * fixed-port path still works; only OS-assigned discovery degrades, and it
 * degrades to a clear "not ready" timeout rather than a crash.
 */
function pipeChildOutput(child, verbose) {
  let discoveredUrl = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (verbose) process.stdout.write(chunk);
    try {
      const match = /dsh web:\s*(https?:\/\/\S+)/.exec(chunk);
      if (match !== null) discoveredUrl = match[1];
    } catch {
      /* keep whatever was last discovered; never let parsing crash the shell */
    }
  });
  child.stderr.on('data', (chunk) => {
    if (verbose) process.stderr.write(chunk);
  });
  return { discoveredUrl: () => discoveredUrl };
}

/** Kill the spawned tree (taskkill /T on Windows; SIGTERM elsewhere). */
function killChild(child) {
  if (child === null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return;
    }
    child.kill('SIGTERM');
  } catch {
    /* nothing left to do */
  }
}

/** Force-kill a PID by platform (taskkill /F on Windows; SIGKILL elsewhere). */
function forceKillPid(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* ignore — the port may already be free */
  }
}

// ---------------------------------------------------------------------------
// Server readiness
// ---------------------------------------------------------------------------

/**
 * Poll until the harness serves on the fixed (or dsh-reported) URL. Because we
 * just spawned this child ourselves, a plain HTTP 200 is enough to call it
 * ready (assumeHarness) — no dependence on DSH's page markup surviving.
 */
async function waitForServer(fixedUrl, urlProbe, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovered = urlProbe();
    if (discovered !== null && (await probe(discovered, { assumeHarness: true })) === 'harness') {
      return discovered;
    }
    if (fixedUrl !== null && (await probe(fixedUrl, { assumeHarness: true })) === 'harness') {
      return fixedUrl;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dsh web exited early (code ${String(child.exitCode)})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Port policy: reuse → spawn → conflict dialog (never the next port)
// ---------------------------------------------------------------------------

/** Ask the user how to proceed when a foreign process holds the port. */
function showPortConflictDialog(port, owner) {
  const who = owner
    ? `占用进程：${owner.name}\nPID：${owner.pid}`
    : '已确认端口被占用，但未能识别出具体进程。';
  let tip;
  if (process.platform === 'win32') {
    tip = owner
      ? `可在终端执行：taskkill /PID ${owner.pid} /F`
      : `可执行：netstat -ano | findstr :${port}  查看占用进程。`;
  } else {
    tip = owner
      ? `可在终端执行：kill ${owner.pid}`
      : `可执行：lsof -i :${port}  查看占用进程。`;
  }
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: '端口被占用',
    message: `端口 ${port} 已被其他进程占用，无法启动 dsh web：`,
    detail: `${who}\n\n${tip}\n\n结束该进程后点击「重试」，或关闭本程序。`,
    buttons: ['重试', '关闭'],
    defaultId: 1,
    cancelId: 1
  });
  return choice === 0; // true → retry
}

/** Spawn `dsh web --no-open --port <port>` and wait until it serves. */
async function spawnOnPort(cfg, port, dshBin) {
  const bin = dshBin || cfg.dshBin;
  const fixedUrl = port === 0 ? null : `http://127.0.0.1:${port}`;
  let spawnError = null;
  const child = spawnDsh(bin, port);
  child.on('error', (err) => {
    spawnError = err;
  });
  const urlSource = pipeChildOutput(child, cfg.verbose);
  try {
    const readyUrl = await waitForServer(fixedUrl, urlSource.discoveredUrl, child, READY_TIMEOUT_MS);
    if (readyUrl === null) {
      throw new Error(
        `dsh web 在 ${fixedUrl ?? 'OS 分配端口'} 上未能在 ${READY_TIMEOUT_MS / 1000} 秒内就绪`
      );
    }
    return { url: readyUrl, child };
  } catch (err) {
    killChild(child);
    if (spawnError !== null && spawnError.code === 'ENOENT') {
      throw new Error(
        `无法启动 '${bin}'（ENOENT）。\n` +
          '@deepseek-ai/dsh 是否已安装、且其 bin 目录在 PATH 上？\n' +
          '  npm install -g @deepseek-ai/dsh\n' +
          '或通过 DSH_DESKTOP_DSH 指定 dsh 的完整路径。'
      );
    }
    throw err;
  }
}

/**
 * Resolve the server to load:
 *   1. a harness already serves the port → reuse it;
 *   2. the port is free (no listener)    → spawn dsh web on it;
 *   3. a foreign process holds the port  → dialog with process name + PID,
 *      then retry or quit — never fall back to the next port.
 * Reuse detection is STRICT (needs a DSH structural marker) so a foreign HTTP
 * server is never mistaken for the harness.
 */
async function resolveServerFor(cfg, ep) {
  const port = ep.port != null ? ep.port : cfg.port;
  const dshBin = ep.dshBin || cfg.dshBin;
  // An explicit endpoint URL (via 编辑): reuse it when it answers, else fall
  // through to the port-based spawn below.
  if (ep.urlOverride) {
    if ((await probeWithGrace(ep.urlOverride)) === 'harness') {
      return { url: ep.urlOverride, child: null };
    }
  }
  // OS-assigned port: the URL only appears in dsh stdout; probe it directly.
  if (port === 0) return spawnOnPort(cfg, 0, dshBin);
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    const status = await probeWithGrace(url);
    if (status === 'harness') return { url, child: null };
    if (status === 'free') return spawnOnPort(cfg, port, dshBin);
    const owner = findPortOwner(port);
    if (!showPortConflictDialog(port, owner)) app.exit(0);
    // else: loop back and probe again
  }
}

// ---------------------------------------------------------------------------
// Multi-endpoint DSH Web: local (this OS) / WSL (Windows only) / custom
// (user-added remote servers). Each endpoint is tracked in appState.endpoints;
// the webView loads exactly one of them (appState.displayEndpoint).
// ---------------------------------------------------------------------------

function endpointsFile() {
  return path.join(app.getPath('userData'), 'endpoints.json');
}

/**
 * Persisted endpoint config: { local?: {name?,port?,dshBin?}, wsl?: {name?,port?,dsh?},
 * custom: [{name,url}] }. The legacy v0.3.0 format (a bare array of custom
 * endpoints) is still accepted.
 */
function loadEndpointsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(endpointsFile(), 'utf8'));
    if (Array.isArray(data)) return { local: null, wsl: null, custom: data };
    if (data && typeof data === 'object') {
      return {
        local: data.local && typeof data.local === 'object' ? data.local : null,
        wsl: data.wsl && typeof data.wsl === 'object' ? data.wsl : null,
        custom: Array.isArray(data.custom) ? data.custom : []
      };
    }
  } catch {
    /* missing/invalid file → defaults */
  }
  return { local: null, wsl: null, custom: [] };
}

/** Build custom endpoint objects from the persisted list. */
function loadCustomEndpoints() {
  const { custom } = loadEndpointsFile();
  return custom
    .filter(
      (e) =>
        e &&
        typeof e.name === 'string' &&
        e.name.trim() !== '' &&
        typeof e.url === 'string' &&
        /^https?:\/\//i.test(normalizeEndpointUrl(e.url))
    )
    .map((e) => ({
      id: 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      kind: 'custom',
      name: e.name.trim().slice(0, 40),
      url: normalizeEndpointUrl(e.url),
      child: null,
      childAlive: false,
      status: 'unknown',
      detail: ''
    }));
}

/** Persist every endpoint's user-customized settings (defaults omitted). */
function persistEndpoints() {
  const cfg = appState.cfg || {};
  const defPort = cfg.port != null ? cfg.port : DEFAULT_PORT;
  const obj = { custom: [] };
  for (const ep of appState.endpoints) {
    if (ep.kind === 'local') {
      const o = {};
      if (ep.name !== defaultLocalName()) o.name = ep.name;
      if (ep.port !== defPort) o.port = ep.port;
      if (ep.dshBin !== (cfg.dshBin || 'dsh')) o.dshBin = ep.dshBin;
      if (ep.urlOverride) o.url = ep.urlOverride;
      if (Object.keys(o).length) obj.local = o;
    } else if (ep.kind === 'wsl') {
      const o = {};
      if (ep.name !== 'WSL') o.name = ep.name;
      if (ep.port !== defPort) o.port = ep.port;
      if (ep.dshOverride) o.dsh = ep.dshOverride;
      if (ep.urlOverride) o.url = ep.urlOverride;
      if (Object.keys(o).length) obj.wsl = o;
    } else if (ep.kind === 'custom') {
      obj.custom.push({ name: ep.name, url: ep.url });
    }
  }
  try {
    fs.writeFileSync(endpointsFile(), JSON.stringify(obj, null, 2));
  } catch {
    /* best-effort persistence */
  }
}

function defaultLocalName() {
  return process.platform === 'win32' ? 'Windows' : '本机';
}

function makeLocalEndpoint() {
  const cfg = appState.cfg || {};
  return {
    id: 'local',
    kind: 'local',
    name: defaultLocalName(),
    port: cfg.port != null ? cfg.port : DEFAULT_PORT,
    dshBin: cfg.dshBin || 'dsh',
    urlOverride: null, // manual URL (via 编辑); null = derive from the port
    url: null,
    child: null,
    childAlive: false,
    status: 'unknown',
    detail: ''
  };
}

function makeWslEndpoint() {
  const cfg = appState.cfg || {};
  return {
    id: 'wsl',
    kind: 'wsl',
    name: 'WSL',
    port: cfg.port != null ? cfg.port : DEFAULT_PORT,
    dshOverride: null, // manual WSL-side dsh path; null = auto-detect
    urlOverride: null, // manual URL (via 编辑); null = derive from WSL IP + port
    url: null,
    child: null,
    childAlive: false,
    status: 'unknown',
    detail: '',
    wsl: null // { installed, dshBin, ip } once detected
  };
}

/** Apply persisted per-endpoint settings (name / port / dsh) to a fresh endpoint. */
function applySavedToEndpoint(ep, saved) {
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.name === 'string' && saved.name.trim() !== '') {
    ep.name = saved.name.trim().slice(0, 40);
  }
  const p = Number(saved.port);
  if (Number.isInteger(p) && p >= 0 && p <= 65535) ep.port = p;
  if (ep.kind === 'local' && typeof saved.dshBin === 'string' && saved.dshBin.trim() !== '') {
    ep.dshBin = saved.dshBin.trim();
  }
  if (ep.kind === 'wsl' && typeof saved.dsh === 'string' && saved.dsh.trim() !== '') {
    ep.dshOverride = saved.dsh.trim();
  }
  if (
    (ep.kind === 'local' || ep.kind === 'wsl') &&
    typeof saved.url === 'string' &&
    saved.url.trim() !== ''
  ) {
    const u = normalizeEndpointUrl(saved.url);
    try {
      const p = new URL(u);
      if (p.protocol === 'http:' || p.protocol === 'https:') ep.urlOverride = u;
    } catch {
      /* invalid saved URL → ignore */
    }
  }
}

/** Build the endpoint list (idempotent; settings + custom endpoints from disk). */
function initEndpoints(urlOverride) {
  const saved = loadEndpointsFile();
  const local = makeLocalEndpoint();
  applySavedToEndpoint(local, saved.local);
  const eps = [local];
  if (process.platform === 'win32') {
    const wsl = makeWslEndpoint();
    applySavedToEndpoint(wsl, saved.wsl);
    eps.push(wsl);
  }
  eps.push(...loadCustomEndpoints());
  // Explicit --url=/DSH_DESKTOP_URL becomes a registered endpoint, never a
  // raw untracked URL.
  if (
    urlOverride !== undefined &&
    eps.every((e) => e.url !== urlOverride)
  ) {
    eps.push({
      id: 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      kind: 'custom',
      name: '指定地址',
      url: urlOverride,
      child: null,
      childAlive: false,
      status: 'unknown',
      detail: ''
    });
  }
  appState.endpoints = eps;
  appState.activeEndpoint = 'local';
}

function getEndpoint(id) {
  return appState.endpoints.find((e) => e.id === id) || null;
}

// --- WSL (Windows only) ----------------------------------------------------

/** Run a `wsl` sub-command without blocking the main process. */
function wslExec(args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('wsl', args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolve({ err, stdout: stdout || '' });
      });
    } catch {
      resolve({ err: new Error('spawn failed'), stdout: '' });
    }
  });
}

/**
 * Detect WSL: is a default distribution installed, what is the distro's eth0
 * IP (WSL2) or 127.0.0.1 (WSL1 shares the host's loopback), and where is `dsh`
 * inside the distro (npm's global bin lands on the login-shell PATH).
 */
async function wslProbe() {
  const list = await wslExec(['-l', '-q'], 20_000);
  if (list.err || list.stdout.trim() === '') {
    return { installed: false, dshBin: null, ip: null };
  }
  let ip = null;
  const ipRes = await wslExec(['-e', 'hostname', '-I'], 20_000);
  if (!ipRes.err) {
    ip = ipRes.stdout.trim().split(/\s+/)[0] || null;
  }
  if (!ip) ip = '127.0.0.1'; // WSL1: the host can reach the distro via loopback
  // Locate a REAL Linux-side dsh. `command -v dsh` can resolve to a Windows
  // npm shim under /mnt/c (WSL merges the Windows PATH) — that binary runs on
  // the Windows network stack and cannot bind the WSL IP, so it is rejected.
  // Fall back to the usual Linux npm global locations.
  const detect = [
    'p=$(command -v dsh 2>/dev/null)',
    "case \"$p\" in /mnt/*|'') p='' ;; esac",
    'if [ -z "$p" ]; then for c in "$HOME/.local/share/.npm-global/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh "$HOME"/.nvm/versions/node/*/bin/dsh; do if [ -x "$c" ]; then p="$c"; break; fi; done; fi',
    'echo "$p"'
  ].join('; ');
  let dshBin = null;
  const dshRes = await wslExec(['-e', 'bash', '-lc', detect], 25_000);
  if (!dshRes.err) {
    const lines = dshRes.stdout.trim().split('\n');
    const last = lines[lines.length - 1] || '';
    if (last.startsWith('/')) dshBin = last;
  }
  return { installed: true, dshBin, ip };
}

/** Spawn dsh web INSIDE the default WSL distribution (wsl.exe stays attached). */
function spawnWslDsh(dshBin, ip, port) {
  const inner = `exec "${dshBin}" web --no-open --host ${ip} --port ${port} --trusted-host ${ip}`;
  return spawn('wsl', ['-e', 'bash', '-lc', inner], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

/**
 * Resolve the WSL dsh web: reuse an instance already serving on the WSL IP,
 * otherwise spawn one. The spawn binds to the distro's eth0 IP (not 127.0.0.1,
 * which Windows could not reach under WSL2) and registers that IP with dsh's
 * /api browser-trust fence via --trusted-host, so the window's Host header
 * passes the fence.
 */
async function resolveWslServer(cfg, ep) {
  const info = ep.wsl;
  if (!info || !info.installed) throw new Error('未检测到 WSL（请安装 WSL 与一个默认发行版）');
  const dsh = ep.dshOverride || info.dshBin;
  if (!dsh) throw new Error('WSL 内未检测到 dsh。请先在 WSL 中执行：npm install -g @deepseek-ai/dsh，或在「编辑」中手动指定 dsh 路径');
  const port = ep.port != null ? ep.port : cfg.port;
  const ip = info.ip;
  // An explicit endpoint URL (via 编辑) is probed first and reused when it
  // answers; spawning still binds the WSL IP so the window can reach it.
  const probeUrl = ep.urlOverride || `http://${ip}:${port}`;
  const status = await probeWithGrace(probeUrl);
  if (status === 'harness') return { url: probeUrl, child: null };
  if (status !== 'free') {
    throw new Error(`端口 ${port} 已被占用（请在 WSL 终端执行 lsof -i :${port} 查看）`);
  }
  const fixedUrl = `http://${ip}:${port}`;
  const child = spawnWslDsh(dsh, ip, port);
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });
  const urlSource = pipeChildOutput(child, cfg.verbose);
  try {
    // WSL cold start (booting the distro) is slower than a local spawn.
    const readyUrl = await waitForServer(fixedUrl, urlSource.discoveredUrl, child, READY_TIMEOUT_MS + 60_000);
    if (readyUrl === null) {
      throw new Error(`WSL 内的 dsh web 未能在 ${READY_TIMEOUT_MS / 1000 + 60} 秒内就绪`);
    }
    return { url: readyUrl, child };
  } catch (err) {
    killChild(child);
    if (spawnError !== null && spawnError.code === 'ENOENT') {
      throw new Error('无法调用 wsl.exe（WSL 未安装或不可用）');
    }
    throw err;
  }
}

/** Detect the WSL endpoint once at startup (Windows only). */
async function detectWslEndpoint() {
  const ep = getEndpoint('wsl');
  if (ep === null) return;
  ep.status = 'starting';
  ep.detail = '正在检测 WSL…';
  pushPureInfo();
  try {
    ep.wsl = await wslProbe();
    if (!ep.wsl.installed) {
      ep.status = 'error';
      ep.detail = '未检测到 WSL';
    } else if (!ep.wsl.dshBin && !ep.dshOverride) {
      // A manual dsh path (via 编辑) counts even when auto-detection fails.
      ep.status = 'unknown';
      ep.detail = '';
    } else {
      ep.status = 'unknown';
      ep.detail = '';
    }
  } catch {
    ep.status = 'error';
    ep.detail = 'WSL 检测失败';
  }
  pushPureInfo();
}

/** Keep endpoint status dots fresh (5 s cadence; cheap probes only). */
let ticking = false;
async function tickEndpoints() {
  if (ticking) return;
  ticking = true;
  try {
    for (const ep of appState.endpoints) {
      if (ep.childAlive) {
        ep.status = 'online';
        continue;
      }
      // WSL endpoint in an error state (e.g. dsh not installed): re-detect
      // periodically so the endpoint recovers on its own once dsh is installed.
      if (
        ep.kind === 'wsl' &&
        ep.status === 'error' &&
        Date.now() - (ep._wslRetryAt || 0) > 30_000
      ) {
        ep._wslRetryAt = Date.now();
        detectWslEndpoint().catch(() => {});
        continue;
      }
      // Nothing connected yet: probe the address the CURRENT settings derive
      // to, so the 页面 menu / tab dots show whether dsh web is already
      // running (we only observe here — never spawn).
      let target = ep.url;
      if (target === null) {
        if (ep.urlOverride) target = ep.urlOverride;
        else if (ep.kind === 'custom') continue;
        else if (ep.kind === 'wsl' && ep.wsl && ep.wsl.ip) target = `http://${ep.wsl.ip}:${ep.port}`;
        else target = `http://127.0.0.1:${ep.port}`;
      }
      const st = await probeWithGrace(target);
      if (st === 'harness') ep.status = 'online';
      else if (st === 'free') {
        ep.status = 'offline';
        // The server we connected to went away: clear the displayed URL.
        if (appState.displayEndpoint === ep.id && appState.url === ep.url) {
          appState.url = null;
          appState.child = null;
          ep.url = ep.kind === 'custom' ? ep.url : null; // custom keeps its address
          if (ep.kind !== 'custom') appState.displayEndpoint = null;
          enterPureView(`${ep.name} 的 dsh web 已离线`);
        }
      } else {
        ep.status = 'offline';
      }
    }
    pushPureInfo();
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/**
 * Navigation policy for the webView: loopback http(s) plus the host of any
 * registered endpoint (WSL's eth0 IP, user-added remote servers). Endpoints
 * are explicit, user-managed entries, so trusting their host:port is
 * intentional; everything else still goes to the system browser.
 */
function isRegisteredEndpointUrl(raw) {
  try {
    const u = new URL(raw);
    return appState.endpoints.some((ep) => {
      if (ep.url === null || ep.url === undefined) return false;
      try {
        return new URL(ep.url).host === u.host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isAllowedNavigation(raw) {
  return isLoopbackHttp(raw) || isRegisteredEndpointUrl(raw);
}

/** Only loopback http(s) URLs are allowed inside the window. */
function isLoopbackHttp(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '::1' ||
      host === '127.0.0.1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

async function openExternalSafely(raw) {
  try {
    await shell.openExternal(raw);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Theme (light / dark / follow system; persisted in userData)
// ---------------------------------------------------------------------------

function themeFile() {
  return path.join(app.getPath('userData'), 'theme.json');
}

function loadTheme() {
  try {
    const raw = fs.readFileSync(themeFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && ['system', 'light', 'dark'].includes(obj.themeSource)) return obj.themeSource;
  } catch {
    /* missing/invalid → follow the system */
  }
  return 'system';
}

function persistTheme(source) {
  try {
    fs.writeFileSync(themeFile(), JSON.stringify({ themeSource: source }));
  } catch {
    /* best-effort persistence */
  }
}

// Pure-page layout preference (full-window default / centered card).
function layoutFile() {
  return path.join(app.getPath('userData'), 'layout.json');
}

function loadLayout() {
  try {
    const obj = JSON.parse(fs.readFileSync(layoutFile(), 'utf8'));
    if (obj && LAYOUT.includes(obj.layout)) return obj.layout;
  } catch {
    /* missing/invalid → default to full-window */
  }
  return DEFAULT_LAYOUT;
}

function persistLayout(mode) {
  try {
    fs.writeFileSync(layoutFile(), JSON.stringify({ layout: mode }));
  } catch {
    /* best-effort persistence */
  }
}

function setLayoutMode(mode) {
  if (!LAYOUT.includes(mode)) return;
  appState.layout = mode;
  persistLayout(mode);
  setStatus({}); // re-broadcast (carries the layout) so the Pure page re-renders
}

function currentWindowBg() {
  return nativeTheme.shouldUseLightColors ? LIGHT_BG : DARK_BG;
}

function setThemeSource(source) {
  if (!['system', 'light', 'dark'].includes(source)) return;
  try {
    nativeTheme.themeSource = source;
  } catch {
    return;
  }
  persistTheme(source);
  if (win !== null && !win.isDestroyed()) win.setBackgroundColor(currentWindowBg());
  // If a menu is open, refresh it so the theme radio group reflects the change.
  if (openMenu !== null) openMenuAt(openMenu, currentMenuLeft);
  // Keep the Pure page's "current theme" label in sync with the new theme.
  pushPureInfo();
}

// ---------------------------------------------------------------------------
// Window + view handles (module scope so menu / title bar / lifecycle reach them)
// ---------------------------------------------------------------------------

let win = null; // BaseWindow
let webView = null; // WebContentsView: the dsh web page (kept alive to preserve its session)
let pureView = null; // WebContentsView: the shell's own DSH Desktop Pure page (file://)
let loadingView = null; // WebContentsView: transient loading overlay (transparent when hidden)
let loadingVisible = false; // whether the loading overlay is currently shown
let titlebarView = null; // WebContentsView: the one-row title bar (middle)
let menuView = null; // WebContentsView: the dropdown menu (top, transparent)
let tray = null; // System tray icon (hide-to-tray; server keeps running while hidden)
let currentStatus = { state: 'starting', view: 'web' };
let openMenu = null; // 'file' | 'view' | 'server' | null
let currentMenuLeft = 0; // content-relative x of the open menu's button

/** Push a status to the title bar renderer. */
function setStatus(next) {
  // Every status carries the current view so the title bar can tell "on the
  // Pure page" apart from "on the dsh web page".
  currentStatus = Object.assign({ view: appState.view }, next);
  if (titlebarView !== null && !titlebarView.webContents.isDestroyed()) {
    titlebarView.webContents.send('dsh:status', currentStatus);
  }
  // If a menu is open, refresh it (enabled states may change with the status).
  if (openMenu !== null) openMenuAt(openMenu, currentMenuLeft);
}

/** Push maximize/restore state to the title bar (toggles the middle button). */
function pushMaximized(maximized) {
  if (titlebarView !== null && !titlebarView.webContents.isDestroyed()) {
    titlebarView.webContents.send('titlebar:maximized', Boolean(maximized));
  }
}

/** Apply the hardening policies to the harness webContents. */
function hardenWebContents(wc) {
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target) && !isAllowedNavigation(target)) {
      openExternalSafely(target);
    }
    return { action: 'deny' };
  });
  // Never let the app navigate away from the harness or a registered endpoint.
  wc.on('will-navigate', (event, target) => {
    if (!isAllowedNavigation(target)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) openExternalSafely(target);
    }
  });
  // No webviews of any kind.
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Lays the title bar on top and the active page (web or pure) beneath it. The
 * inactive page is parked off-screen (kept alive so its session is preserved),
 * never destroyed. The loading overlay (when shown) sits over the content area.
 * Menu is positioned on demand.
 */
function layout() {
  if (win === null || titlebarView === null || webView === null || pureView === null) return;
  const [width, height] = win.getContentSize();
  const y = TITLEBAR_HEIGHT;
  const h = Math.max(0, height - TITLEBAR_HEIGHT);
  titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
  const OFF = -100000; // off-screen: hides a view without destroying its webContents
  if (appState.view === 'pure') {
    pureView.setBounds({ x: 0, y, width, height: h });
    webView.setBounds({ x: OFF, y, width, height: h });
  } else {
    webView.setBounds({ x: 0, y, width, height: h });
    pureView.setBounds({ x: OFF, y, width, height: h });
  }
  // Loading overlay: cover the content area when visible, else park off-screen.
  if (loadingView !== null) {
    loadingView.setBounds(
      loadingVisible ? { x: 0, y, width, height: h } : { x: OFF, y, width: 0, height: 0 }
    );
  }
}

/** Platform-appropriate window options. */
function windowOptions() {
  const base = {
    width: 1360,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: path.join(__dirname, 'build', 'icon-256.png'),
    backgroundColor: currentWindowBg(),
    show: true
  };
  if (process.platform === 'darwin') {
    // Keep the native traffic-light buttons; hide only the title text.
    base.titleBarStyle = 'hidden';
    base.trafficLightPosition = { x: 14, y: 12 };
  } else {
    // Windows / Linux: fully frameless; we draw the window controls.
    base.frame = false;
  }
  return base;
}

function createWindow() {
  win = new BaseWindow(windowOptions());

  // dsh web page. Kept alive (parked off-screen when not shown) so its session
  // survives switching to/from the Pure page.
  webView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // The shell's own DSH Desktop Pure page (file://, independent of dsh web).
  pureView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'purepreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  // Timestamped query busts Electron's file:// disk cache so layout/theme edits
  // to pure.html are always picked up on (re)launch.
  pureView.webContents.loadFile(path.join(__dirname, 'pure.html'), {
    query: { v: String(Date.now()) }
  });

  // Transient loading overlay (transparent when hidden). Shown only while dsh
  // web is starting / restarting — it never replaces the web or pure page.
  loadingView = new WebContentsView();
  loadingView.setBackgroundColor('#00000000');
  loadingView.webContents.loadFile(path.join(__dirname, 'loading.html'));

  // One-row title bar (middle). Its drag region moves the window.
  titlebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'titlepreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Dropdown menu (top, transparent; positioned on demand).
  menuView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'menupreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  menuView.setBackgroundColor('#00000000'); // fully transparent outside the menu

  // Stacking order: later-added views sit on top. Only one of webView /
  // pureView is visible at a time (layout() hides the other off-screen); the
  // loading overlay sits above the content, below the title bar and menu.
  win.contentView.addChildView(webView);
  win.contentView.addChildView(pureView);
  win.contentView.addChildView(loadingView);
  win.contentView.addChildView(titlebarView);
  win.contentView.addChildView(menuView);
  layout();
  menuView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden until opened
  win.on('resize', layout);

  // Harden the dsh web page; the Pure page is a local file:// we fully control.
  hardenWebContents(webView.webContents);
  hardenWebContents(pureView.webContents);
  // Pin the window title (taskbar / window list) even though the page sets its own <title>.
  webView.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(WINDOW_TITLE);
  });

  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'));
  titlebarView.webContents.once('did-finish-load', () => {
    if (titlebarView === null || titlebarView.webContents.isDestroyed()) return;
    titlebarView.webContents.send('dsh:status', currentStatus);
    pushMaximized(win !== null && win.isMaximized());
  });

  menuView.webContents.loadFile(path.join(__dirname, 'menu.html'));

  win.on('maximize', () => pushMaximized(true));
  win.on('unmaximize', () => pushMaximized(false));

  win.on('close', (event) => {
    // Intercept real closes (macOS native red button, taskbar, etc.): hide into
    // the tray instead of exiting — unless we are truly quitting.
    if (!quitting && tray !== null) {
      event.preventDefault();
      hideToTray();
    }
  });

  win.on('closed', () => {
    win = null;
    webView = null;
    pureView = null;
    loadingView = null;
    loadingVisible = false;
    titlebarView = null;
    menuView = null;
    openMenu = null;
  });
}

/** Navigate (or re-navigate) the dsh web view to a URL. */
function loadWeb(url) {
  if (webView !== null && !webView.webContents.isDestroyed()) {
    webView.webContents.loadURL(url);
  }
}

/**
 * Show the theme-aware loading overlay (a dedicated WebContentsView) while dsh
 * web starts or restarts. It is a transient layer — it never replaces the
 * content of the web or pure page, so their sessions are preserved.
 */
function showLoading() {
  if (loadingView === null || loadingView.webContents.isDestroyed()) return;
  loadingVisible = true;
  layout();
}

/** Hide the loading overlay. */
function hideLoading() {
  loadingVisible = false;
  if (loadingView !== null && !loadingView.webContents.isDestroyed()) layout();
}

// ---------------------------------------------------------------------------
// View switching: the content area holds TWO live WebContentsViews — the dsh
// web page (webView) and the shell's own Pure page (pureView). Switching only
// changes which one is on-screen (layout() parks the other off-screen), so the
// dsh web session is PRESERVED — it is not reloaded on every switch. The Pure
// page is independent of the web server (file://); DSH Web is connected on
// demand. The title-bar DSH icon (and the Pure page's "Open DSH Web") switch.
// ---------------------------------------------------------------------------

/** Show the dsh web view without re-navigating (preserves its session). */
function showWebOnly() {
  appState.view = 'web';
  layout();
  if (appState.url !== null) {
    setStatus({ state: 'online', url: appState.url, port: appState.cfg.port, spawned: appState.childAlive });
  }
  refreshDshMenu();
}

/** Show the shell's own DSH Desktop Pure page (independent of dsh web). */
function enterPureView(reason) {
  appState.view = 'pure';
  layout();
  setStatus({ state: 'pure', reason });
  refreshDshMenu();
}

/**
 * Connect (or reconnect) to a DSH endpoint, then show it in the webView.
 * Session preservation applies per endpoint: if the window is already showing
 * a reachable copy of THIS endpoint, just reveal it — no reload. Switching
 * BETWEEN endpoints re-navigates (the servers are separate; their session
 * state lives on each server).
 */
async function connectEndpoint(id) {
  const cfg = appState.cfg;
  if (cfg === null) return;
  const ep = getEndpoint(id);
  if (ep === null) return;
  appState.activeEndpoint = ep.id;

  // Already showing this endpoint and it still answers → just reveal.
  if (appState.displayEndpoint === ep.id && appState.url !== null) {
    const reachable =
      ep.childAlive || (await probe(appState.url, { assumeHarness: true })) === 'harness';
    if (reachable) {
      showWebOnly();
      pushPureInfo();
      return;
    }
  }

  showLoading();
  setStatus({ state: 'starting', port: cfg.port });
  ep.status = 'starting';
  ep.detail = '';
  pushPureInfo();
  try {
    let url;
    let child = null;
    if (ep.kind === 'custom') {
      // View-only: the remote dsh web must already be running (and must have
      // been told to trust our host via --trusted-host).
      if (!ep.url) throw new Error('未设置地址');
      const st = await probe(ep.url, { assumeHarness: true });
      if (st !== 'harness') {
        throw new Error(
          '无法连接该远程地址。请确认远端 dsh web 正在运行，且启动时通过 --trusted-host 声明了本端访问的主机'
        );
      }
      url = ep.url;
    } else if (ep.kind === 'wsl') {
      ({ url, child } = await resolveWslServer(cfg, ep));
    } else {
      if (cfg.urlOverride !== undefined && ep.id === 'local' && appState.url === null) {
        // Explicit --url=/DSH_DESKTOP_URL at launch: no spawn, load it directly.
        url = cfg.urlOverride;
      } else {
        ({ url, child } = await resolveServerFor(cfg, ep));
      }
    }
    ep.url = url;
    ep.child = child;
    ep.childAlive = child !== null;
    ep.status = 'online';
    ep.detail = '';
    if (child !== null) bindChildExit(child, ep);
    appState.url = url;
    appState.child = child;
    appState.childAlive = child !== null;
    appState.displayEndpoint = ep.id;
    appState.view = 'web';
    layout();
    hideLoading();
    loadWeb(url);
    setStatus({ state: 'online', url, port: cfg.port, spawned: child !== null });
    if (cfg.verbose) {
      console.log(
        `[DSH Desktop Pure] web view -> ${url} (${ep.name}${child === null ? ', reused' : ', spawned'})`
      );
    }
  } catch (err) {
    // Connection failed: DO NOT force a view switch. From the 页面 menu the
    // window stays on the (blank) web view with the title bar reporting the
    // failure; from the Pure page the user simply stays put. The endpoint's
    // dot/detail show the reason, and 「打开 DSH Web」 can retry.
    ep.status = 'error';
    ep.detail = err.message;
    hideLoading();
    setStatus({ state: 'offline', reason: `无法连接「${ep.name}」：${err.message}` });
    return;
  } finally {
    pushPureInfo();
  }
  refreshDshMenu();
}

/** Connect to the endpoint the Pure page currently has selected. */
async function connectWeb() {
  await connectEndpoint(appState.activeEndpoint);
}

/**
 * Show the dsh web page. If a session is still there — our spawned child alive,
 * OR a previously-loaded URL that still answers (covers a reused external
 * dsh web, which has no child we track) — just reveal it, no reload. Only
 * connect / reconnect when nothing is actually serving the web URL.
 */
async function enterWebView() {
  const cfg = appState.cfg;
  if (cfg === null) return;
  if (appState.url !== null && appState.displayEndpoint !== null) {
    const ep = getEndpoint(appState.displayEndpoint);
    const reachable =
      (ep !== null && ep.childAlive) ||
      (await probe(appState.url, { assumeHarness: true })) === 'harness';
    if (reachable) {
      showWebOnly(); // preserve the existing session
      return;
    }
  }
  await connectEndpoint(appState.displayEndpoint || appState.activeEndpoint || 'local');
}

/** Re-render the open DSH icon menu (radio state) and refresh the Pure page. */
function refreshDshMenu() {
  if (openMenu === 'dsh') openMenuAt('dsh', currentMenuLeft);
  pushPureInfo();
}

/** Push the current state to the Pure page (only if it is the active view). */
function pushPureInfo() {
  const wc = mainContents();
  if (appState.view === 'pure' && wc && !wc.isDestroyed()) {
    wc.send('pure:info', buildPureInfo());
  }
}

// Complete release history shown in the Pure page's "更新日志" (Changelog)
// section. Kept in sync with CHANGELOG.md (Chinese, default) /
// CHANGELOG.en.md (English); entries ordered newest-first. The Pure page
// picks the list for the active UI language.
const PURE_CHANGELOG = {
  zh: [
    {
      version: '0.3.0',
      date: '2026-08-30',
      sections: [
        {
          title: '新增',
          items: [
            '多端点 DSH Web：「DSH Web」分区改为 Tab 栏——Windows 本机（自动判断当前系统）、WSL（Windows 系统自动检测 WSL 与 WSL 内 dsh）、自定义远程地址（用户添加，持久化到 `userData/endpoints.json`）。',
            'WSL dsh web 自动检测与拉起：复用 WSL 内已运行实例；未运行则自动拉起（`wsl` → `dsh web --host <WSL IP> --trusted-host <WSL IP> --no-open`），WSL IP 取自发行版 eth0。',
            '远程端点为只读：本端不启动 / 不重启，连接失败时给出原因提示（远端需通过 `--trusted-host` 声明本端主机）。'
          ]
        },
        {
          title: '变更',
          items: [
            '导航策略：除 loopback 外，已注册端点的主机（WSL IP / 远程地址）允许在窗口内加载；其余外链仍交系统浏览器。',
            '「重启 dsh 服务器」作用于当前选中的端点（本机 / WSL）；远程地址不显示重启入口。'
          ]
        }
      ]
    },
    {
      version: '0.2.0',
      date: '2026-08-30',
      sections: [
        {
          title: '新增',
          items: [
            '内置设置页（「桌面端配置」）：壳自带的独立页面，风格参考 DSH Web 设置面板——左侧导航（外观 / DSH Web / 更新日志 / 关于）+ 居中内容主体，支持浅色 / 深色主题。',
            '「页面」切换菜单：标题栏 `文件` 左侧新增按钮，下拉切换 **桌面端配置** 与 **DSH Web**。',
            '布局切换：设置页提供 `全屏 / 卡片` 切换（持久化到 `userData/layout.json`）。'
          ]
        },
        {
          title: '变更',
          items: [
            '切换保留 dsh web 会话：在设置页与 DSH Web 之间切换时不再重新加载（两个常驻 `WebContentsView`，隐藏者移出屏幕而非销毁），对自建与复用实例均有效。',
            '启动失败改为回退到设置页，而不再退出应用。',
            '端口冲突对话框改为：重试 / 改用 DSH Desktop Pure / 退出（原为 重试 / 关闭）。',
            '标题栏状态：新增 `Pure 页` 状态；连接中文案更清晰。'
          ]
        },
        {
          title: '修复',
          items: [
            '加载页不再覆盖纯页（改用独立的加载覆盖层）。',
            '命名统一为 `DSH_DESKTOP_*`（旧 `DSH_ELECTRON_*` 仍兼容）。'
          ]
        }
      ]
    },
    {
      version: '0.1.0',
      date: '2026-08-29',
      sections: [
        {
          title: '新增',
          items: [
            '首个发布版本；Windows 安装包。',
            '`dsh web` 的零侵入 Electron 套壳（不修改 DSH 任何代码 / 资源 / 配置，独立于 DSH 版本）。',
            '单端口策略（绝不静默漂移）：复用已有 `dsh web` / 自动拉起 / 冲突对话框（进程名 + PID）。',
            '自绘单行标题栏：`文件 / 视图 / 服务器` 菜单、居中连接状态、在浏览器中打开、窗口控制（Win/Linux）/ 原生交通灯（macOS）。',
            '系统托盘：隐藏到托盘，dsh 服务器后台续跑。',
            '一键重启 dsh 服务器（主题感知加载页，重启不退出应用）。',
            '主题：浅色 / 深色 / 跟随系统（`nativeTheme`，持久化到 `userData/theme.json`）。',
            '安全加固：渲染进程 `sandbox` + `contextIsolation` + 无 `nodeIntegration`；仅允许 loopback 导航；外链交系统浏览器；禁用 `<webview>`。'
          ]
        }
      ]
    }
  ],
  en: [
    {
      version: '0.3.0',
      date: '2026-08-30',
      sections: [
        {
          title: 'Added',
          items: [
            'Multi-endpoint DSH Web: the DSH Web section of the settings page is now a tab bar — Windows local (auto-detected from the host OS), WSL (on Windows: auto-detects WSL and dsh inside the distro), and custom remote addresses (user-added, persisted in `userData/endpoints.json`).',
            'WSL dsh web auto-detection and spawn: reuses an instance already running inside WSL; otherwise spawns one (`wsl` → `dsh web --host <WSL IP> --trusted-host <WSL IP> --no-open`), the WSL IP taken from the distro\'s eth0.',
            'Remote endpoints are view-only: no local spawn / restart; connection failures explain the likely cause (the remote side must declare `--trusted-host`).'
          ]
        },
        {
          title: 'Changed',
          items: [
            'Navigation policy: in-window loading now permits loopback plus the host of any registered endpoint (WSL IP / remote address); all other external links still go to the system browser.',
            '"Restart dsh server" acts on the currently selected endpoint (local / WSL); remote addresses have no restart action.'
          ]
        }
      ]
    },
    {
      version: '0.2.0',
      date: '2026-08-30',
      sections: [
        {
          title: 'Added',
          items: [
            'Built-in settings page ("桌面端配置"): a shell-owned, independent page styled after the DSH Web settings panel — left sidebar (Appearance / DSH Web / Changelog / About) plus a centered content body. Supports light / dark themes.',
            '"页面" switcher menu: a button left of `文件` in the title bar opens a dropdown to toggle between 桌面端配置 and DSH Web.',
            'Layout switch: the settings page offers a `全屏 / 卡片` toggle (persisted in `userData/layout.json`).'
          ]
        },
        {
          title: 'Changed',
          items: [
            'dsh web session preserved when toggling between the settings page and DSH Web (two live `WebContentsView`s; the hidden one is parked off-screen, not reloaded). Works for both shell-spawned and reused `dsh web` instances.',
            'Startup failure now degrades to the settings page instead of exiting the app.',
            'Port-conflict dialog: 重试 / 改用 DSH Desktop Pure / 退出 (was 重试 / 关闭).',
            'Title-bar status: added a `Pure 页` state; clearer connecting text.'
          ]
        },
        {
          title: 'Fixed',
          items: [
            'Loading page no longer overwrites the Pure page (dedicated loading overlay).',
            'Unified naming to `DSH_DESKTOP_*` (legacy `DSH_ELECTRON_*` still accepted).'
          ]
        }
      ]
    },
    {
      version: '0.1.0',
      date: '2026-08-29',
      sections: [
        {
          title: 'Added',
          items: [
            'First public release; Windows installer.',
            'Zero-intrusion Electron shell for `dsh web` (no DSH code, resources, or config modified; independent of DSH releases).',
            'Single-port policy (never silently drifts): reuse an existing `dsh web` / auto-spawn / conflict dialog with process name + PID.',
            'Self-drawn one-row title bar: `文件 / 视图 / 服务器` menus, centered connection status, open-in-browser, window controls (Win/Linux) / native traffic lights (macOS).',
            'System tray: hide-to-tray while the dsh server keeps running.',
            'One-click restart dsh server (theme-aware loading page; the app never quits on restart).',
            'Theme: light / dark / follow system (`nativeTheme`, persisted in `userData/theme.json`).',
            'Hardened renderer: `sandbox` + `contextIsolation` + no `nodeIntegration`; loopback-only navigation; remote links to the OS browser; `<webview>` disabled.'
          ]
        }
      ]
    }
  ]
};

// The Pure page's UI language (zh by default; follows the OS / Chromium locale).
function pureLang() {
  return /^zh/i.test(app.getLocale() || 'zh') ? 'zh' : 'en';
}

/** Snapshot of state the Pure page needs (version / theme / connection / …). */
function buildPureInfo() {
  const cfg = appState.cfg;
  return {
    version: app.getVersion(),
    themeSource: nativeTheme.themeSource,
    port: cfg ? cfg.port : DEFAULT_PORT,
    dshBin: cfg ? cfg.dshBin : 'dsh',
    layout: appState.layout,
    url: appState.url,
    view: appState.view,
    status: currentStatus,
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    changelog: PURE_CHANGELOG[pureLang()] || [],
    // DSH Web multi-endpoint state (tab bar + detail rows on the Pure page).
    endpoints: appState.endpoints.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      url: e.url || null,
      status: e.status,
      detail: e.detail || '',
      // Per-endpoint settings (for the 编辑 form).
      port: e.port != null ? e.port : null,
      dsh: e.kind === 'local' ? e.dshBin : null,
      dshOverride: e.kind === 'wsl' ? e.dshOverride || null : null,
      urlOverride: e.kind === 'local' || e.kind === 'wsl' ? e.urlOverride || null : null,
      wslIp: e.kind === 'wsl' && e.wsl ? e.wsl.ip : null,
      wslDsh: e.kind === 'wsl' && e.wsl ? e.wsl.dshBin : null
    })),
    activeEndpoint: appState.activeEndpoint,
    displayEndpoint: appState.displayEndpoint
  };
}

// ---------------------------------------------------------------------------
// System tray (hide-to-tray; the dsh web server keeps running while hidden)
// ---------------------------------------------------------------------------

/**
 * Tray icon path. Dark variants are used deliberately: Electron's Tray does NOT
 * auto-adapt a colored icon to the taskbar/menu-bar color, so we fix on the
 * dark icon (visible on a light taskbar; the logo is light on a dark square).
 */
function trayIconPath() {
  if (process.platform === 'win32') return path.join(__dirname, 'build', 'icon.ico');
  return path.join(__dirname, 'build', 'icon-256.png');
}

/** Reveal and focus the main window (tray click / second-instance / activate). */
function showWindow() {
  if (win === null) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Hide the main window into the tray (the dsh web server keeps running). */
function hideToTray() {
  if (win !== null && !win.isDestroyed()) win.hide();
}

/** Truly quit (tray "退出" / File→退出). before-quit cleans up the child. */
function reallyQuit() {
  quitting = true; // let the 'close' interceptor allow the window to actually close
  app.quit();
}

function createTray() {
  if (tray !== null) return;
  try {
    tray = new Tray(trayIconPath());
  } catch (err) {
    console.warn('[DSH Desktop Pure] 托盘创建失败：' + err.message);
    return;
  }
  tray.setToolTip(WINDOW_TITLE);
  const menu = Menu.buildFromTemplate([
    { label: '打开窗口', click: () => showWindow() },
    { label: '重启 dsh 服务器', click: () => restartServer() },
    { type: 'separator' },
    { label: '退出', click: () => reallyQuit() }
  ]);
  tray.setContextMenu(menu);
  // Left-click reveals the window (Windows/Linux); on macOS the menu takes over.
  tray.on('click', () => showWindow());
}

/** webContents of the currently-visible page (web or pure). */
function mainContents() {
  const view = appState.view === 'pure' ? pureView : webView;
  return view !== null && !view.webContents.isDestroyed() ? view.webContents : null;
}

// ---------------------------------------------------------------------------
// Dropdown menus (shell-drawn; fixed position + hover switching)
// ---------------------------------------------------------------------------

/** Display text for an accelerator, per platform. */
function accText(acc) {
  if (process.platform === 'darwin') return acc.replace('CmdOrCtrl+', '⌘');
  return acc.replace('CmdOrCtrl+', 'Ctrl+');
}

/** The three menus' items (labels, accelerators, enabled / radio state). */
function menuItems() {
  const src = nativeTheme.themeSource;
  return {
    // 页面 menu (left of 文件): a gray "DSH Web" heading followed by the
    // endpoint list (status dot each; the displayed one highlighted), then
    // the shell's own Pure page.
    dsh: [
      { type: 'heading', label: 'DSH Web' },
      ...appState.endpoints.map((ep) => ({
        id: 'endpoint-' + ep.id,
        label: ep.name,
        type: 'status',
        status: ep.status,
        active: appState.view === 'web' && appState.displayEndpoint === ep.id
      })),
      { type: 'separator' },
      { id: 'view-pure', label: '桌面端配置', type: 'radio', checked: appState.view === 'pure' }
    ],
    file: [
      { id: 'reload', label: '重新加载', accelerator: accText('CmdOrCtrl+R'), enabled: true },
      { id: 'reload-cache', label: '强制重新加载', accelerator: accText('CmdOrCtrl+Shift+R'), enabled: true },
      { type: 'separator' },
      { id: 'open-external', label: '在系统浏览器中打开', enabled: appState.url !== null },
      { type: 'separator' },
      { id: 'hide-to-tray', label: '最小化到托盘', enabled: true },
      { id: 'quit', label: '退出', accelerator: accText('CmdOrCtrl+Q'), enabled: true }
    ],
    view: [
      { id: 'devtools', label: '开发者工具', accelerator: accText('F12'), enabled: true },
      { id: 'fullscreen', label: '全屏', accelerator: accText('F11'), enabled: true },
      { type: 'separator' },
      { id: 'theme-system', label: '跟随系统', type: 'radio', checked: src === 'system' },
      { id: 'theme-light', label: '浅色', type: 'radio', checked: src === 'light' },
      { id: 'theme-dark', label: '深色', type: 'radio', checked: src === 'dark' }
    ],
    server: [
      // Always available: restart rebinds the port whether we spawned dsh web
      // or reused an existing instance.
      { id: 'restart', label: '重启 dsh 服务器', enabled: true }
    ]
  };
}

/** Pixel height of a menu (must match menu.html's item/separator/padding sizes). */
function menuHeight(items) {
  let h = MENU_PAD_V * 2;
  for (const it of items) h += it.type === 'separator' ? MENU_SEP_H : MENU_ITEM_H;
  return h;
}

/** Action handlers keyed by menu item id (shared by dropdown + accelerators). */
const menuActions = {
  'view-pure': () => enterPureView(),
  'view-web': () => enterWebView(),
  reload: () => {
    const wc = mainContents();
    if (wc) wc.reload();
  },
  'reload-cache': () => {
    const wc = mainContents();
    if (wc) wc.reloadIgnoringCache();
  },
  'open-external': () => {
    if (appState.url !== null) openExternalSafely(appState.url);
  },
  'hide-to-tray': () => hideToTray(),
  quit: () => app.quit(),
  devtools: () => {
    const wc = mainContents();
    if (wc) wc.toggleDevTools();
  },
  fullscreen: () => {
    if (win !== null) win.setFullScreen(!win.isFullScreen());
  },
  'theme-system': () => setThemeSource('system'),
  'theme-light': () => setThemeSource('light'),
  'theme-dark': () => setThemeSource('dark'),
  restart: () => restartServer()
};

/** Open (or switch to) a menu, docked directly beneath its button. */
function openMenuAt(name, relLeft) {
  if (win === null || menuView === null) return;
  if (!['dsh', 'file', 'view', 'server'].includes(name)) return;
  const items = menuItems()[name];
  const height = menuHeight(items);
  const [cw] = win.getContentSize();
  let x = Math.round(Number(relLeft) || 0);
  if (x + MENU_WIDTH > cw) x = Math.max(0, cw - MENU_WIDTH); // keep within the window
  menuView.setBounds({ x, y: TITLEBAR_HEIGHT, width: MENU_WIDTH, height });
  if (!menuView.webContents.isDestroyed()) {
    menuView.webContents.send('menu:show', { name, items });
  }
  openMenu = name;
  currentMenuLeft = x;
}

/** Hide the open menu. */
function closeMenu() {
  if (openMenu === null) return;
  openMenu = null;
  if (menuView !== null && !menuView.webContents.isDestroyed()) {
    menuView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    menuView.webContents.send('menu:hide');
  }
}

/**
 * The application menu: carries the accelerators (Ctrl/⌘+R, F12, F11,
 * Ctrl/⌘+Q) and standard Edit roles. On Windows/Linux it is not drawn
 * (frameless) but its accelerators stay active while the window is focused;
 * on macOS it appears in the system menu bar (macOS convention).
 */
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }
  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  });
  template.push({
    label: '视图',
    submenu: [
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => menuActions.reload() },
      { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: () => menuActions['reload-cache']() },
      { type: 'separator' },
      { label: '开发者工具', accelerator: 'F12', click: () => menuActions.devtools() },
      { label: '全屏', accelerator: 'F11', click: () => menuActions.fullscreen() }
    ]
  });
  template.push({
    label: '服务器',
    submenu: [{ label: '重启 dsh 服务器', click: () => menuActions.restart() }]
  });
  if (isMac) {
    template.push({ label: '窗口', role: 'windowMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Title bar + menu IPC
// ---------------------------------------------------------------------------

ipcMain.on('menu:toggle', (_event, name, relLeft) => {
  if (win === null) return;
  if (openMenu === name) closeMenu();
  else openMenuAt(name, relLeft);
});

ipcMain.on('menu:hover', (_event, name, relLeft) => {
  if (win === null) return;
  // Switch only while a menu is already open (hover does not open a menu).
  if (openMenu !== null && openMenu !== name) openMenuAt(name, relLeft);
});

ipcMain.on('menu:close', () => closeMenu());

ipcMain.on('menu:action', (_event, id) => {
  closeMenu();
  // Endpoint entries (页面 menu): open that endpoint's dsh web — reveal the
  // existing session if it's already showing & reachable, otherwise connect
  // (reusing a running dsh web, or starting one for local / WSL).
  if (typeof id === 'string' && id.startsWith('endpoint-')) {
    connectEndpoint(id.slice('endpoint-'.length)).catch(() => {});
    return;
  }
  const action = menuActions[id];
  if (action) {
    try {
      action();
    } catch {
      /* a bad action must never crash the shell */
    }
  }
});

// The harness page was clicked (via its preload) → dismiss any open menu.
ipcMain.on('harness:click', () => closeMenu());

ipcMain.on('titlebar:window-control', (_event, action) => {
  if (win === null) return;
  try {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') {
      // X hides into the tray (server keeps running); only quit via tray/退出.
      if (tray !== null) hideToTray();
      else reallyQuit();
    } else if (action === 'open-browser') {
      if (appState.url !== null) openExternalSafely(appState.url);
    }
  } catch {
    /* a window-control hiccup must never crash the shell */
  }
});

// ---------------------------------------------------------------------------
// DSH Desktop Pure page IPC (the shell's own, independent local page)
// ---------------------------------------------------------------------------

/** Snapshot of state for the Pure page (handled so the renderer can await). */
ipcMain.handle('pure:get-info', () => buildPureInfo());

/** Theme choice from the Pure page's appearance row (system / light / dark). */
ipcMain.on('pure:set-theme', (_event, source) => {
  setThemeSource(String(source));
});

/** "Open DSH Web" from the Pure page: resolve + load the given (or selected) endpoint. */
ipcMain.on('pure:open-web', (_event, id) => {
  connectEndpoint(typeof id === 'string' && id !== '' ? id : appState.activeEndpoint);
});

/** Hand a web URL to the system browser (about / repo links from the Pure page). */
ipcMain.on('pure:open-external', (_event, raw) => {
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) openExternalSafely(raw);
});

/** "Restart dsh server" from the Pure page (the given, displayed, or selected endpoint). */
ipcMain.on('pure:restart', (_event, id) => {
  restartServer(
    typeof id === 'string' && id !== ''
      ? id
      : appState.displayEndpoint || appState.activeEndpoint
  );
});

/** Select a DSH Web endpoint in the Pure page's tab bar (no connection yet). */
ipcMain.on('pure:select-endpoint', (_event, id) => {
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (ep === null) return;
  appState.activeEndpoint = ep.id;
  pushPureInfo();
});

/** Add a custom (remote) DSH endpoint from the Pure page. */
/** Normalize a user-entered endpoint URL: default to http:// when the scheme is omitted. */
function normalizeEndpointUrl(raw) {
  let u = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (u !== '' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'http://' + u;
  return u;
}

ipcMain.handle('pure:add-endpoint', (_event, name, url) => {
  const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  const u = normalizeEndpointUrl(url);
  if (n === '') return { ok: false, error: '请填写名称' };
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, error: '地址格式不正确（如：192.168.1.10:3080 或 http://host:port）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http / https 地址' };
  }
  if (appState.endpoints.some((e) => e.kind === 'custom' && e.url.replace(/\/+$/, '') === u)) {
    return { ok: false, error: '该地址已存在' };
  }
  appState.endpoints.push({
    id: 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    kind: 'custom',
    name: n,
    url: u,
    child: null,
    childAlive: false,
    status: 'unknown',
    detail: ''
  });
  persistEndpoints();
  appState.activeEndpoint = appState.endpoints[appState.endpoints.length - 1].id;
  pushPureInfo();
  return { ok: true };
});

/**
 * Edit an endpoint: name (all kinds), port + dsh executable (local),
 * port + manual dsh path (wsl), url (custom). A config change detaches the
 * endpoint's running state — 「打开 DSH Web」 reconnects with the new values.
 */
ipcMain.handle('pure:edit-endpoint', (_event, id, patch) => {
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (!ep) return { ok: false, error: '端点不存在' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: '无效的参数' };
  let changed = false;
  const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 40) : '';
  if (name !== '' && name !== ep.name) {
    ep.name = name;
    changed = true;
  }
  if (typeof patch.url === 'string' && patch.url.trim() !== '') {
    const u = normalizeEndpointUrl(patch.url);
    const current = ep.kind === 'custom' ? ep.url || '' : ep.urlOverride || '';
    if (u !== current) {
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        return { ok: false, error: '地址格式不正确（如：192.168.1.10:3080）' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: '仅支持 http / https 地址' };
      }
      if (ep.kind === 'custom') ep.url = u;
      else ep.urlOverride = u;
      changed = true;
    }
  } else if (ep.kind === 'local' || ep.kind === 'wsl') {
    if (ep.urlOverride !== null) {
      ep.urlOverride = null; // empty address = back to auto-derivation
      changed = true;
    }
  }
  if (ep.kind !== 'custom') {
    const pRaw = typeof patch.port === 'string' ? patch.port.trim() : patch.port;
    if (pRaw !== '' && pRaw !== null && pRaw !== undefined) {
      const p = Number(pRaw);
      if (Number.isInteger(p) && p >= 0 && p <= 65535 && p !== ep.port) {
        ep.port = p;
        changed = true;
      }
    }
    const d = typeof patch.dsh === 'string' ? patch.dsh.trim() : '';
    if (ep.kind === 'local') {
      if (d !== '' && d !== ep.dshBin) {
        ep.dshBin = d;
        changed = true;
      }
    } else {
      const ov = d !== '' ? d : null;
      if (ov !== (ep.dshOverride || null)) {
        ep.dshOverride = ov;
        changed = true;
        if (ov !== null) {
          // A manual path clears the "dsh not installed" error immediately.
          if (ep.status === 'error') {
            ep.status = 'unknown';
            ep.detail = '';
          }
        }
      }
    }
  }
  if (!changed) return { ok: true };
  // Config changed: detach the endpoint's running state.
  if (ep.child !== null) {
    killChild(ep.child);
    ep.child = null;
    ep.childAlive = false;
  }
  if (ep.kind !== 'custom') ep.url = null;
  ep.status = 'unknown';
  ep.detail = '';
  if (appState.displayEndpoint === ep.id) {
    appState.child = null;
    appState.childAlive = false;
    appState.url = null;
    appState.displayEndpoint = null;
    enterPureView(`「${ep.name}」设置已更新，点击「打开 DSH Web」重新连接`);
  }
  persistEndpoints();
  pushPureInfo();
  return { ok: true };
});

/**
 * Reset a local / WSL endpoint to its defaults (name / port / dsh). WSL is
 * re-detected afterwards.
 */
ipcMain.on('pure:reset-endpoint', (_event, id) => {
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (!ep || ep.kind === 'custom') return; // view-only endpoints have no defaults
  const cfg = appState.cfg || {};
  if (ep.kind === 'local') {
    ep.name = defaultLocalName();
    ep.port = cfg.port != null ? cfg.port : DEFAULT_PORT;
    ep.dshBin = cfg.dshBin || 'dsh';
    ep.urlOverride = null;
  } else {
    ep.name = 'WSL';
    ep.port = cfg.port != null ? cfg.port : DEFAULT_PORT;
    ep.dshOverride = null;
    ep.urlOverride = null;
  }
  if (ep.child !== null) {
    killChild(ep.child);
    ep.child = null;
    ep.childAlive = false;
  }
  ep.url = null;
  ep.status = 'unknown';
  ep.detail = '';
  if (appState.displayEndpoint === ep.id) {
    appState.child = null;
    appState.childAlive = false;
    appState.url = null;
    appState.displayEndpoint = null;
    enterPureView(`「${ep.name}」已重置，点击「打开 DSH Web」重新连接`);
  }
  persistEndpoints();
  pushPureInfo();
  if (ep.kind === 'wsl') detectWslEndpoint().catch(() => {});
});

/**
 * One-shot status probe for an endpoint (used right after 保存 its settings):
 * updates the status dot without connecting or switching the view. local /
 * WSL probe the address their CURRENT settings derive to (port + override);
 * custom probes its URL.
 */
async function probeEndpointOnce(ep) {
  let target = null;
  if (ep.kind === 'custom') {
    target = ep.url;
  } else if (ep.urlOverride) {
    target = ep.urlOverride;
  } else if (ep.url) {
    target = ep.url;
  } else if (ep.kind === 'wsl' && ep.wsl && ep.wsl.ip) {
    target = `http://${ep.wsl.ip}:${ep.port}`;
  } else {
    target = `http://127.0.0.1:${ep.port}`;
  }
  if (!target) return;
  ep.status = 'starting';
  pushPureInfo();
  const st = await probeWithGrace(target);
  if (st === 'harness') {
    ep.status = 'online';
    ep.detail = '';
  } else if (st === 'free') {
    ep.status = 'offline';
    ep.detail =
      ep.kind === 'custom'
        ? '远端 dsh web 未运行'
        : 'dsh web 未运行（本端不会自动启动）';
  } else {
    ep.status = 'offline';
    ep.detail =
      ep.kind === 'custom'
        ? '地址可达，但不是 dsh web（远端需以 --trusted-host 声明本端主机）'
        : '该地址已被其他服务占用';
  }
  pushPureInfo();
}

ipcMain.on('pure:probe-endpoint', (_event, id) => {
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (!ep || ep.kind === 'custom' ? false : !ep) return;
  probeEndpointOnce(ep).catch(() => {});
});

/** Remove a custom endpoint (local / WSL entries are permanent). */
ipcMain.on('pure:remove-endpoint', (_event, id) => {
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (ep === null || ep.kind !== 'custom') return;
  appState.endpoints = appState.endpoints.filter((e) => e.id !== ep.id);
  persistEndpoints();
  if (appState.activeEndpoint === ep.id) appState.activeEndpoint = 'local';
  // A removed endpoint may still be what the window shows (a remote server we
  // cannot stop) — keep the session, just retarget the selector.
  pushPureInfo();
});

/** Full-window / centered-card layout from the Pure page's switch. */
ipcMain.on('pure:set-layout', (_event, mode) => {
  setLayoutMode(String(mode));
});

// ---------------------------------------------------------------------------
// Server restart
// ---------------------------------------------------------------------------

/**
 * Restart a dsh web endpoint (local or WSL). Works whether the shell spawned
 * it (child) or reused an existing one: kill the child if we have one, wait
 * for the port to free, and if it's still occupied locally force-kill that
 * owner (safe — the port is serving the harness by definition) — then spawn a
 * fresh instance and reload. Remote (custom) endpoints are view-only.
 */
async function restartServer(epId) {
  const cfg = appState.cfg;
  if (cfg === null || win === null || restarting) return;
  const ep =
    getEndpoint(typeof epId === 'string' ? epId : '') ||
    getEndpoint(appState.displayEndpoint) ||
    getEndpoint(appState.activeEndpoint);
  if (ep === null || ep.kind === 'custom') return; // view-only endpoints
  restarting = true;
  const port = ep.port != null ? ep.port : cfg.port;
  const portUrl =
    ep.kind === 'wsl' && ep.wsl && ep.wsl.ip
      ? `http://${ep.wsl.ip}:${port}`
      : `http://127.0.0.1:${port}`;
  setStatus({ state: 'starting', port });
  // Show the theme-aware loading page so the harness area doesn't flash a
  // Chromium "can't reach this page" error while the old server is killed.
  showLoading();
  ep.status = 'starting';
  ep.detail = '';
  pushPureInfo();
  try {
    // 1. Kill the shell-owned child, if any (its exit is ignored: restarting).
    if (ep.child !== null) {
      killChild(ep.child);
      ep.child = null;
      ep.childAlive = false;
    }
    // 2. Wait for the port to be released (covers child-exit delay).
    if (port !== 0) {
      const deadline = Date.now() + 10_000;
      let free = false;
      while (Date.now() < deadline) {
        if ((await probeWithGrace(portUrl)) === 'free') {
          free = true;
          break;
        }
        await sleep(300);
      }
      // 3. Still occupied locally (reused external dsh web): force-kill owner.
      //    WSL processes are invisible to Windows-side tooling — we just wait.
      if (!free && ep.kind === 'local') {
        const owner = findPortOwner(port);
        if (owner) {
          forceKillPid(owner.pid);
          const d2 = Date.now() + 5_000;
          while (Date.now() < d2 && (await probeWithGrace(portUrl)) !== 'free') {
            await sleep(300);
          }
        }
      }
      if (!free && ep.kind === 'wsl') {
        throw new Error(`WSL 内端口 ${port} 仍被占用，请在 WSL 终端手动结束占用进程后重试`);
      }
    }
    // 4. Spawn a fresh dsh web, then point the web view at it.
    let url;
    let child;
    if (ep.kind === 'wsl') {
      ({ url, child } = await resolveWslServer(cfg, ep));
    } else {
      ({ url, child } = await spawnOnPort(cfg, port, ep.dshBin));
      if (ep.urlOverride) {
        // A manual address was configured: the fresh spawn may not sit at it,
        // so honor the configured URL when it answers (spawn was the intent).
        if ((await probeWithGrace(ep.urlOverride)) === 'harness') url = ep.urlOverride;
      }
    }
    ep.url = url;
    ep.child = child;
    ep.childAlive = child !== null;
    ep.status = 'online';
    ep.detail = '';
    if (child !== null) bindChildExit(child, ep);
    appState.url = url;
    appState.child = child;
    appState.childAlive = child !== null;
    appState.displayEndpoint = ep.id;
    appState.view = 'web';
    hideLoading();
    loadWeb(url);
    layout();
    setStatus({ state: 'online', url, port: cfg.port, spawned: child !== null });
    refreshDshMenu();
  } catch (err) {
    // Degrade to the independent Pure page (non-blocking): the user can retry
    // from the title bar or the Pure page — never quit the app.
    ep.status = 'error';
    ep.detail = err.message;
    if (appState.displayEndpoint === ep.id || appState.activeEndpoint === ep.id) {
      enterPureView(`重启「${ep.name}」失败：${err.message}`);
    }
  } finally {
    restarting = false;
    hideLoading();
    pushPureInfo();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const appState = {
  cfg: null,
  child: null, // the dsh web child process of the DISPLAYED endpoint (if we spawned it)
  url: null, // URL currently loaded in the webView
  displayEndpoint: null, // endpoint id currently loaded in the webView
  activeEndpoint: 'local', // endpoint selected in the Pure page's DSH Web tab bar
  view: 'web',
  layout: 'full',
  childAlive: false,
  endpoints: [] // [{id, kind: 'local'|'wsl'|'custom', name, url, child, childAlive, status, detail, wsl?}]
};
let quitting = false;
// True while a restart is in flight: the child's intentional kill must NOT
// trigger the "dsh web exited" dialog / app quit.
let restarting = false;

function fatal(message) {
  dialog.showErrorBox('DSH Desktop Pure', message);
  app.exit(1);
}

function bindChildExit(child, ep) {
  child.on('exit', (code, signal) => {
    // Ignore exits caused by us quitting or by a restart (intentional kill).
    if (quitting || restarting) return;
    const why = code !== null ? `code ${code}` : `signal ${signal}`;
    ep.child = null;
    ep.childAlive = false;
    if (ep.kind !== 'custom') ep.url = null;
    // The endpoint we are SHOWING died → fall back to the Pure page (which
    // keeps working without the server). A background endpoint dying only
    // updates its dot — the window stays where it is.
    if (appState.displayEndpoint === ep.id) {
      appState.child = null;
      appState.childAlive = false;
      appState.url = null;
      appState.displayEndpoint = null;
      enterPureView(`「${ep.name}」的 dsh web 已退出（${why}）`);
    } else {
      pushPureInfo();
    }
  });
}

async function main() {
  // The window appears immediately. The default view is DSH Web (per the user's
  // preference); if the server cannot be reached we fall back to the
  // independent DSH Desktop Pure page instead of exiting the app.
  createWindow();
  await enterWebView();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BaseWindow.getAllWindows()[0];
    if (w !== undefined) {
      if (w.isMinimized()) w.restore();
      w.show(); // it may be hidden in the tray
      w.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.deepseek-ai.dsh-desktop-pure');
    appState.cfg = resolveConfig();
    nativeTheme.themeSource = loadTheme(); // default: follow the system
    appState.layout = loadLayout(); // default: full-window
    nativeTheme.on('updated', () => {
      // The OS theme changed (or themeSource is 'system'): re-skin the window
      // background. The title bar / menus re-skin via CSS media queries.
      if (win !== null && !win.isDestroyed()) win.setBackgroundColor(currentWindowBg());
    });
    buildAppMenu();
    createTray();
    // Multi-endpoint DSH Web: local (always) + WSL (Windows) + user-added
    // remote servers; a light 5 s probe keeps the tab-bar dots fresh.
    initEndpoints(appState.cfg.urlOverride);
    if (process.platform === 'win32') detectWslEndpoint();
    setInterval(() => {
      tickEndpoints().catch(() => {});
    }, 5_000);
    main();
  });
}

app.on('before-quit', () => {
  quitting = true;
  // Kill every endpoint child we spawned (local and WSL alike).
  for (const ep of appState.endpoints) {
    if (ep.child !== null) killChild(ep.child);
  }
});

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive (relaunchable via the Dock); quit elsewhere.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // macOS: clicking the Dock icon re-shows the window (it may be hidden in the
  // tray); only re-create one if there is none at all.
  if (process.platform !== 'darwin') return;
  const w = BaseWindow.getAllWindows()[0];
  if (w !== undefined) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  } else if (appState.url !== null) {
    createWindow();
    showWebOnly();
    setStatus({ state: appState.childAlive ? 'online' : 'offline', url: appState.url });
  }
});
