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
const { spawn, spawnSync } = require('node:child_process');
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
async function spawnOnPort(cfg, port) {
  const fixedUrl = port === 0 ? null : `http://127.0.0.1:${port}`;
  let spawnError = null;
  const child = spawnDsh(cfg.dshBin, port);
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
        `无法启动 '${cfg.dshBin}'（ENOENT）。\n` +
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
async function resolveServer(cfg) {
  const port = cfg.port;
  // OS-assigned port: the URL only appears in dsh stdout; probe it directly.
  if (port === 0) return spawnOnPort(cfg, 0);
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    const status = await probeWithGrace(url);
    if (status === 'harness') return { url, child: null };
    if (status === 'free') return spawnOnPort(cfg, port);
    const owner = findPortOwner(port);
    if (!showPortConflictDialog(port, owner)) app.exit(0);
    // else: loop back and probe again
  }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

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
    if (/^https?:/i.test(target) && !isLoopbackHttp(target)) {
      openExternalSafely(target);
    }
    return { action: 'deny' };
  });
  // Never let the app navigate away from the local harness.
  wc.on('will-navigate', (event, target) => {
    if (!isLoopbackHttp(target)) {
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
  pureView.webContents.loadFile(path.join(__dirname, 'pure.html'));

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

/** Connect (or reconnect) to dsh web, then show it. */
async function connectWeb() {
  const cfg = appState.cfg;
  if (cfg === null) return;
  showLoading();
  setStatus({ state: 'starting', port: cfg.port });
  try {
    let url;
    let child = null;
    if (cfg.urlOverride !== undefined) {
      url = cfg.urlOverride; // explicit --url=/DSH_DESKTOP_URL: no spawn
    } else {
      ({ url, child } = await resolveServer(cfg));
    }
    appState.url = url;
    appState.child = child;
    appState.childAlive = child !== null;
    if (child !== null) bindChildExit(child);
    appState.view = 'web';
    layout();
    hideLoading();
    loadWeb(url);
    setStatus({ state: 'online', url, port: cfg.port, spawned: child !== null });
    if (cfg.verbose) {
      console.log(
        `[DSH Desktop Pure] web view -> ${url}${child === null ? ' (reused)' : ' (spawned dsh web)'}`
      );
    }
  } catch (err) {
    // Degrade to the independent Pure page — never quit the app over dsh web.
    hideLoading();
    enterPureView(err.message);
    return;
  }
  refreshDshMenu();
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
  if (appState.url !== null) {
    const reachable = appState.childAlive
      ? true
      : (await probe(appState.url, { assumeHarness: true })) === 'harness';
    if (reachable) {
      showWebOnly(); // preserve the existing session
      return;
    }
  }
  await connectWeb();
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
    }
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
    // DSH icon menu (left of 文件): switches the harness area between the
    // shell's own Pure page and the dsh web page. Radio shows the active one.
    dsh: [
      { id: 'view-pure', label: 'DSH Desktop Pure', type: 'radio', checked: appState.view === 'pure' },
      { id: 'view-web', label: 'DSH Web', type: 'radio', checked: appState.view === 'web' }
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

/** "Open DSH Web" from the Pure page: resolve + load the web view. */
ipcMain.on('pure:open-web', () => {
  enterWebView();
});

/** Hand a web URL to the system browser (about / repo links from the Pure page). */
ipcMain.on('pure:open-external', (_event, raw) => {
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) openExternalSafely(raw);
});

/** "Restart dsh server" from the Pure page. */
ipcMain.on('pure:restart', () => {
  restartServer();
});

/** Full-window / centered-card layout from the Pure page's switch. */
ipcMain.on('pure:set-layout', (_event, mode) => {
  setLayoutMode(String(mode));
});

// ---------------------------------------------------------------------------
// Server restart
// ---------------------------------------------------------------------------

/**
 * Restart the dsh web server. Works whether the shell spawned it (child) or
 * reused an existing one: kill the child if we have one, wait for the port to
 * free, and if it's still occupied (a reused external dsh web) force-kill that
 * owner — safe because the port is serving the harness by definition — then
 * spawn a fresh instance and reload.
 */
async function restartServer() {
  const cfg = appState.cfg;
  if (cfg === null || win === null || restarting) return;
  restarting = true;
  setStatus({ state: 'starting', port: cfg.port });
  // Show the theme-aware loading page so the harness area doesn't flash a
  // Chromium "can't reach this page" error while the old server is killed.
  showLoading();
  try {
    // 1. Kill the shell-owned child, if any (its exit is ignored: restarting).
    if (appState.child !== null) {
      killChild(appState.child);
      appState.child = null;
    }
    // 2. Wait for the port to be released (covers child-exit delay).
    if (cfg.port !== 0) {
      const url = `http://127.0.0.1:${cfg.port}`;
      const deadline = Date.now() + 10_000;
      let free = false;
      while (Date.now() < deadline) {
        if ((await probeWithGrace(url)) === 'free') {
          free = true;
          break;
        }
        await sleep(300);
      }
      // 3. Still occupied (reused external dsh web): force-kill its owner.
      if (!free) {
        const owner = findPortOwner(cfg.port);
        if (owner) {
          forceKillPid(owner.pid);
          const d2 = Date.now() + 5_000;
          while (Date.now() < d2 && (await probeWithGrace(url)) !== 'free') {
            await sleep(300);
          }
        }
      }
    }
    // 4. Spawn a fresh dsh web, then point the web view at it.
    const { url, child } = await spawnOnPort(cfg, cfg.port);
    appState.url = url;
    appState.child = child;
    appState.childAlive = true;
    if (child !== null) bindChildExit(child);
    appState.view = 'web';
    hideLoading();
    loadWeb(url);
    layout();
    setStatus({ state: 'online', url, port: cfg.port, spawned: true });
    refreshDshMenu();
  } catch (err) {
    // Degrade to the independent Pure page (non-blocking): the user can retry
    // from the title bar or the Pure page — never quit the app.
    enterPureView(`重启 dsh 服务器失败：${err.message}`);
  } finally {
    restarting = false;
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const appState = { cfg: null, child: null, url: null, view: 'web', layout: 'full', childAlive: false };
let quitting = false;
// True while a restart is in flight: the child's intentional kill must NOT
// trigger the "dsh web exited" dialog / app quit.
let restarting = false;

function fatal(message) {
  dialog.showErrorBox('DSH Desktop Pure', message);
  app.exit(1);
}

function bindChildExit(child) {
  child.on('exit', (code, signal) => {
    // Ignore exits caused by us quitting or by a restart (intentional kill).
    if (quitting || restarting) return;
    const why = code !== null ? `code ${code}` : `signal ${signal}`;
    // The dsh web process died. Fall back to the independent Pure page rather
    // than quitting the whole app — the Pure page keeps working without the
    // server, and the user can retry from the title bar or the Pure page.
    appState.child = null;
    appState.childAlive = false;
    appState.url = null;
    enterPureView(`dsh web 已退出（${why}）`);
  });
}

async function main() {
  const cfg = resolveConfig();
  appState.cfg = cfg;

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
    nativeTheme.themeSource = loadTheme(); // default: follow the system
    appState.layout = loadLayout(); // default: full-window
    nativeTheme.on('updated', () => {
      // The OS theme changed (or themeSource is 'system'): re-skin the window
      // background. The title bar / menus re-skin via CSS media queries.
      if (win !== null && !win.isDestroyed()) win.setBackgroundColor(currentWindowBg());
    });
    buildAppMenu();
    createTray();
    main();
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (appState.child !== null) killChild(appState.child);
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
