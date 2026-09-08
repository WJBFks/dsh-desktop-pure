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
  screen,
  ipcMain,
  nativeTheme,
  safeStorage
} = require('electron');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { probe, probeSpawnedTokenUrl, probeWithGrace, findPortOwner, findPortOwnerAsync } = require('./port-probe.js');
const { fetchChangelog } = require('./changelog.js');
const { checkLatestRelease } = require('./release-update.js');

const DEFAULT_PORT = 3080;
const STARTUP_PAGES = new Set(['pure', 'local', 'wsl']);
const WINDOWS_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// WSL runs its own dsh web on a separate port, so it never clashes with the
// Windows-side harness on 3080 (or with WSL's own loopback usage).
const WSL_DEFAULT_PORT = 13080;
const READY_TIMEOUT_MS = 120_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;
const WINDOW_TITLE = 'DSH Desktop Pure';
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_STATUS_HOVER_INTERVAL_MS = 80;
const MENU_WIDTH = 300;
const MENU_ITEM_H = 30;
const MENU_SEP_H = 9;
// Must match menu.html #menu's padding-top (box is flush with the view top).
const MENU_PAD_V = 8;
const LIGHT_BG = '#f3f4f6';
const DARK_BG = '#111827';
const LAYOUT = ['full', 'card']; // Pure page: full-window vs centered-card
const DEFAULT_LAYOUT = 'full';

// Refreshed only by an explicit About-page check. Never persist or expose
// download URLs to a renderer; the map binds an asset ID to this verification.
let verifiedReleaseAssets = new Map();
let releaseCheckInFlight = null;
let releaseAutoRefreshStarted = false;
const releaseUpdateState = { checking: false, result: null };
let releaseUpdateRevision = 0;
let pendingPureSection = null;

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
      windowsHide: true,
      env: refreshedWindowsEnv()
    });
  }
  return spawn(dshBin, args, { stdio });
}

/** Replace token-bearing URLs before they can reach a diagnostic log. */
function redactTokenUrls(output) {
  return String(output).replace(/https?:\/\/\S+/g, (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (!parsed.searchParams.has('token')) return candidate;
      parsed.searchParams.set('token', 'REDACTED');
      return parsed.toString();
    } catch {
      // A malformed URL cannot reliably contain a parsed token parameter.
      return candidate;
    }
  });
}

// Windows recovery is intentionally narrow: its only purpose is to retain a
// token URL for a DSH process this shell started, if the shell itself crashes.
// The URL is DPAPI-encrypted through Electron safeStorage; never log it.
function windowsRecoveryFile() {
  return path.join(app.getPath('userData'), 'dsh-local-recovery.bin');
}

function clearWindowsRecovery() {
  if (process.platform !== 'win32') return;
  try { fs.unlinkSync(windowsRecoveryFile()); } catch { /* already absent */ }
}

function readWindowsRecovery() {
  if (process.platform !== 'win32') return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = Buffer.from(fs.readFileSync(windowsRecoveryFile(), 'utf8').trim(), 'base64');
    const record = JSON.parse(safeStorage.decryptString(encrypted));
    return record && typeof record === 'object' ? record : null;
  } catch {
    clearWindowsRecovery();
    return null;
  }
}

function writeWindowsRecovery(record) {
  if (process.platform !== 'win32') return false;
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(windowsRecoveryFile(), safeStorage.encryptString(JSON.stringify(record)).toString('base64'), {
      encoding: 'utf8', mode: 0o600
    });
    return true;
  } catch {
    clearWindowsRecovery();
    return false;
  }
}

function isExpectedWindowsDshCommand(commandLine, port) {
  const command = String(commandLine || '');
  return /@deepseek-ai[\\/]dsh(?:[\\/\s]|$)/i.test(command) &&
    /(?:^|\s)web(?:\s|$)/i.test(command) &&
    // With --port 0 DSH binds an OS-assigned port, so its command line never
    // contains the listener's final port. The caller still verifies that this
    // exact PID owns the recorded port before accepting this narrower case.
    new RegExp(`(?:^|\\s)--port(?:=|\\s+)(?:${Number(port)}|0)(?:\\s|$)`, 'i').test(command);
}

function windowsProcessIdentity(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const script = `Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`;
    const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000
    }).stdout || '';
    const value = JSON.parse(output.trim());
    if (!value || Number(value.ProcessId) !== pid || !value.CreationDate || typeof value.CommandLine !== 'string') return null;
    return { pid, creationTime: String(value.CreationDate), commandLine: value.CommandLine };
  } catch {
    return null;
  }
}

/** Startup-only non-blocking counterpart of windowsProcessIdentity(). */
function windowsProcessIdentityAsync(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`;
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (data) => { output += data.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 5_000);
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const value = JSON.parse(output.trim());
        finish(value && Number(value.ProcessId) === pid && value.CreationDate && typeof value.CommandLine === 'string'
          ? { pid, creationTime: String(value.CreationDate), commandLine: value.CommandLine }
          : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function persistWindowsDshRecovery(url) {
  if (process.platform !== 'win32') return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.searchParams.has('token') || !Number.isInteger(port)) return null;
    const owner = await findPortOwnerAsync(port);
    const identity = owner && await windowsProcessIdentityAsync(owner.pid);
    if (!identity || !isExpectedWindowsDshCommand(identity.commandLine, port)) return null;
    const record = { version: 1, savedAt: Date.now(), url: parsed.toString(), port, pid: identity.pid, creationTime: identity.creationTime };
    return writeWindowsRecovery(record)
      ? { pid: record.pid, port: record.port, creationTime: record.creationTime }
      : null;
  } catch {
    // Recovery is optional. A successful DSH launch must not fail because it
    // cannot be made crash-resilient on this machine.
    return null;
  }
}

async function tryRestoreWindowsDsh(configuredPort, onProgress) {
  const record = readWindowsRecovery();
  if (!record) return null;
  // Do not turn a momentary netstat/CIM/HTTP failure into an irreversible
  // credential deletion. A failed restore is reported to the router instead
  // of falling through to the generic "unknown process" port dialog.
  const reject = (reason) => { clearWindowsRecovery(); return { unavailable: true, retained: false, reason }; };
  const unavailable = (reason) => ({ unavailable: true, retained: true, reason });
  try {
    if (record.version !== 1 || !Number.isInteger(record.port) ||
      !Number.isInteger(record.pid) || typeof record.creationTime !== 'string' ||
      typeof record.url !== 'string' || !Number.isFinite(record.savedAt) ||
      Date.now() - record.savedAt < 0 || Date.now() - record.savedAt > WINDOWS_RECOVERY_MAX_AGE_MS) return reject('恢复记录无效或已过期');
    // A changed fixed-port setting does not invalidate a valid credential for
    // the old listener. Leave it available if the user restores that setting.
    if (configuredPort !== 0 && record.port !== configuredPort) return null;
    const parsed = new URL(record.url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.searchParams.has('token') || Number(parsed.port || 80) !== record.port) return reject('恢复记录的本机地址无效');
    let lastFailure = '恢复检查暂不可用';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owner = await findPortOwnerAsync(record.port);
      // An owner with another PID is a definite listener mismatch. An absent
      // owner can also mean a transient netstat failure, so retry and retain.
      if (owner && owner.pid !== record.pid) return reject('端口监听进程已变更');
      const identity = owner && await windowsProcessIdentityAsync(record.pid);
      // A different creation time/command is likewise definite; a missing CIM
      // result is not.
      if (identity && (identity.creationTime !== record.creationTime ||
        !isExpectedWindowsDshCommand(identity.commandLine, record.port))) return reject('监听进程身份不匹配');
      if (owner && identity) {
        if (typeof onProgress === 'function') onProgress('authenticating', '正在验证保存的 DSH 认证连接…');
        const handshake = await probeSpawnedTokenUrl(parsed.toString());
        if (handshake === 'harness') {
          return { url: parsed.toString(), child: null, tokenAuth: true, recoveryIdentity: { pid: record.pid, port: record.port, creationTime: record.creationTime } };
        }
        // Only DSH's exact authentication-required response proves this token
        // is unusable. Never accept an arbitrary 401, nor delete on a timeout.
        if (handshake === 'auth_required') return reject('DSH 已明确拒绝保存的认证');
        lastFailure = handshake === 'unavailable' ? 'token 握手暂时不可用' : 'token 握手尚未通过验证';
      } else {
        lastFailure = owner ? '进程身份查询暂时不可用' : '端口所有者查询暂时不可用';
      }
      if (attempt < 2) await sleep(250);
    }
    return unavailable(lastFailure);
  } catch {
    return unavailable('恢复检查暂时异常');
  }
}

/** Stop only the still-verified listener represented by the encrypted record. */
function stopWindowsRecoveryOnQuit() {
  if (process.platform !== 'win32') return true;
  const record = readWindowsRecovery();
  if (!record) return true;
  if (!Number.isInteger(record.pid) || !Number.isInteger(record.port) || typeof record.creationTime !== 'string') {
    clearWindowsRecovery();
    return true;
  }
  const owner = findPortOwner(record.port);
  if (!owner || owner.pid !== record.pid) {
    clearWindowsRecovery();
    return true;
  }
  const identity = windowsProcessIdentity(record.pid);
  if (!identity) return false; // transient CIM failure: preserve recoverability
  if (identity.creationTime !== record.creationTime || !isExpectedWindowsDshCommand(identity.commandLine, record.port)) {
    clearWindowsRecovery();
    return true;
  }
  if (!forceKillPid(record.pid)) return false;
  const remaining = findPortOwner(record.port);
  if (remaining && remaining.pid === record.pid) return false;
  clearWindowsRecovery();
  return true;
}

/**
 * A token handshake is meaningful only for the URL that carries that token.
 * `ep.tokenAuth` is historical display state, not a credential: using it on a
 * bare fixed-port URL turns DSH's exact auth-required response into "busy".
 */
async function probeEndpointUrl(ep, url, options) {
  try {
    if (new URL(url).searchParams.has('token')) return probeSpawnedTokenUrl(url);
  } catch { /* regular probe classifies malformed URLs */ }
  return probeWithGrace(url, options);
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
  let tail = '';
  let stdoutDiscoveryTail = '';
  let stdoutVerboseTail = '';
  let stderrVerboseTail = '';
  let stdoutVerboseDropping = false;
  let stderrVerboseDropping = false;
  const MAX_VERBOSE_LINE = 16 * 1024;
  const remember = (chunk) => {
    tail += chunk.toString('utf8');
    if (tail.length > 16384) tail = tail.slice(-16384);
  };
  const writeVerbose = (stream, chunk) => {
    if (!verbose) return;
    let pending = stream === 'stdout' ? stdoutVerboseTail : stderrVerboseTail;
    let dropping = stream === 'stdout' ? stdoutVerboseDropping : stderrVerboseDropping;
    pending += chunk;
    while (pending) {
      if (dropping) {
        const newline = pending.indexOf('\n');
        if (newline === -1) { pending = ''; break; }
        pending = pending.slice(newline + 1);
        dropping = false;
        continue;
      }
      const newline = pending.indexOf('\n');
      if (newline === -1) {
        if (pending.length > MAX_VERBOSE_LINE) {
          // Do not emit a prefix: a token URL may span chunks and its value
          // might not have ended yet. Drop this entire physical line instead.
          process[stream].write(`[${stream} verbose line omitted: exceeds ${MAX_VERBOSE_LINE} bytes]\n`);
          pending = '';
          dropping = true;
        }
        break;
      }
      process[stream].write(redactTokenUrls(pending.slice(0, newline + 1)));
      pending = pending.slice(newline + 1);
    }
    if (stream === 'stdout') {
      stdoutVerboseTail = pending;
      stdoutVerboseDropping = dropping;
    } else {
      stderrVerboseTail = pending;
      stderrVerboseDropping = dropping;
    }
  };
  const flushVerbose = (stream) => {
    if (!verbose) return;
    const pending = stream === 'stdout' ? stdoutVerboseTail : stderrVerboseTail;
    const dropping = stream === 'stdout' ? stdoutVerboseDropping : stderrVerboseDropping;
    if (stream === 'stdout') { stdoutVerboseTail = ''; stdoutVerboseDropping = false; }
    else { stderrVerboseTail = ''; stderrVerboseDropping = false; }
    if (!pending || dropping) return;
    process[stream].write(redactTokenUrls(pending));
  };
  const discoverUrls = (completeOutput) => {
    const matches = completeOutput.matchAll(/dsh web:\s*(https?:\/\/\S+)/g);
    for (const match of matches) discoveredUrl = match[1];
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    remember(chunk);
    writeVerbose('stdout', chunk);
    try {
      stdoutDiscoveryTail += chunk;
      const newline = stdoutDiscoveryTail.lastIndexOf('\n');
      if (newline !== -1) {
        discoverUrls(stdoutDiscoveryTail.slice(0, newline + 1));
        stdoutDiscoveryTail = stdoutDiscoveryTail.slice(newline + 1);
      }
      if (stdoutDiscoveryTail.length > 16384) stdoutDiscoveryTail = '';
    } catch {
      /* keep whatever was last discovered; never let parsing crash the shell */
    }
  });
  child.stderr.on('data', (chunk) => {
    remember(chunk);
    writeVerbose('stderr', chunk);
  });
  child.stdout.on('end', () => {
    // EOF terminates the final physical line, so a URL split across chunks
    // remains discoverable without ever treating a partial chunk as complete.
    try { discoverUrls(stdoutDiscoveryTail); } catch { /* keep last URL */ }
    stdoutDiscoveryTail = '';
    flushVerbose('stdout');
  });
  child.stderr.on('end', () => flushVerbose('stderr'));
  return { discoveredUrl: () => discoveredUrl, tail: () => tail };
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
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return result.status === 0;
    } else {
      process.kill(pid, 'SIGKILL');
      return true;
    }
  } catch {
    /* ignore — the port may already be free */
    return false;
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
async function waitForServer(fixedUrl, urlProbe, child, timeoutMs, onProgress) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovered = urlProbe();
    if (discovered !== null) {
      let discoveredHasToken = false;
      try {
        discoveredHasToken = new URL(discovered).searchParams.has('token');
      } catch {
        // Let the regular probe classify malformed/future stdout as before.
      }
      if (discoveredHasToken && typeof onProgress === 'function') onProgress('authenticating', '正在验证 DSH 认证连接…');
      const status = discoveredHasToken
        ? await probeSpawnedTokenUrl(discovered)
        : await probe(discovered, { assumeHarness: true });
      if (status === 'harness') return discovered;
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
async function spawnOnPort(cfg, port, dshBin, onProgress) {
  const bin = dshBin || cfg.dshBin;
  const fixedUrl = port === 0 ? null : `http://127.0.0.1:${port}`;
  let spawnError = null;
  const child = spawnDsh(bin, port);
  if (typeof onProgress === 'function') onProgress('starting', '正在启动 DSH 服务…');
  child.on('error', (err) => {
    spawnError = err;
  });
  const urlSource = pipeChildOutput(child, cfg.verbose);
  try {
    const readyUrl = await waitForServer(fixedUrl, urlSource.discoveredUrl, child, READY_TIMEOUT_MS, onProgress);
    if (readyUrl === null) {
      throw new Error(
        `dsh web 在 ${fixedUrl ?? 'OS 分配端口'} 上未能在 ${READY_TIMEOUT_MS / 1000} 秒内就绪`
      );
    }
    // Fixed-port DSH versions may expose a token URL only on stdout. Persist
    // only when we actually received that URL and can strictly identify its
    // final listener (the cmd shim's PID is not necessarily that listener).
    const recoveryIdentity = await persistWindowsDshRecovery(readyUrl);
    let tokenAuth = false;
    try { tokenAuth = new URL(readyUrl).searchParams.has('token'); } catch { /* malformed URL handled by readiness */ }
    return { url: readyUrl, child, tokenAuth, recoveryIdentity };
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
async function resolveServerFor(cfg, ep, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const port = ep.port != null ? ep.port : cfg.port;
  // A freshly detected Windows npm shim may not yet be in Electron's inherited
  // PATH. Prefer the verified path (including an explicit --dsh path) instead
  // of making the user restart the desktop shell after installation.
  const dshBin = (process.platform === 'win32' && ep.windows && ep.windows.dshPath) || ep.dshBin || cfg.dshBin;
  // A manually supplied authentication URL is memory-only. Reuse it before a
  // bare fixed-port probe, which intentionally cannot authenticate itself.
  if (ep.authUrl && (await probeEndpointUrl(ep, ep.authUrl)) === 'harness') {
    return { url: ep.authUrl, child: null, tokenAuth: true };
  }
  // An explicit endpoint URL (via 编辑): reuse it when it answers, else fall
  // through to the port-based spawn below.
  if (ep.urlOverride) {
    if ((await probeEndpointUrl(ep, ep.urlOverride)) === 'harness') {
      return { url: ep.urlOverride, child: null };
    }
  }
  // A crash can leave our Windows DSH child running. This check deliberately
  // precedes normal reuse and accepts only the encrypted URL plus matching
  // listener PID, creation time, command line and token handshake.
  report('checking', '正在检查本机 DSH 服务…');
  // A force-start that already proved the old listener is gone must not be
  // blocked by an optional, retained recovery record whose owner lookup is
  // temporarily unavailable. The record remains untouched for later startup.
  const skipRecovery = ep._skipWindowsRecoveryOnce === true;
  delete ep._skipWindowsRecoveryOnce;
  const restored = skipRecovery ? null : await tryRestoreWindowsDsh(port, report);
  if (restored !== null) {
    if (restored.unavailable) {
      if (cfg.verbose) console.warn(`[DSH Desktop Pure] Windows recovery unavailable: ${restored.reason}`);
      const credentialState = restored.retained
        ? '凭据已保留，未结束任何进程。'
        : '不安全或失效的凭据已清理，未结束任何进程。';
      throw new Error(`无法验证先前 DSH 的恢复凭据（${restored.reason}）。请稍后重试；${credentialState}`);
    }
    return restored;
  }
  // OS-assigned port: absent a valid recovery record, the URL only appears in
  // fresh dsh stdout and the OS chooses a new port.
  if (port === 0) return spawnOnPort(cfg, 0, dshBin, report);
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    const status = await probeEndpointUrl(ep, url);
    if (status === 'harness') return { url, child: null };
    if (status === 'free') return spawnOnPort(cfg, port, dshBin, report);
    // Windows has a dedicated, actionable local-start guide. Do not block its
    // router page behind a synchronous native dialog when a listener is busy
    // or DSH requires a token we do not possess (including no recovery file).
    if (process.platform === 'win32') {
      const err = new Error(status === 'auth_required'
        ? '已检测到 DSH，但该实例需要认证 URL。请使用 dsh web 输出的完整地址。'
        : `端口 ${port} 已被占用，无法确认是可复用的 DSH。请检查该进程后重试。`);
      err.code = status;
      throw err;
    }
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

function startupFile() {
  return path.join(app.getPath('userData'), 'startup.json');
}

function loadStartupPagePreference() {
  try {
    const record = JSON.parse(fs.readFileSync(startupFile(), 'utf8'));
    return record && STARTUP_PAGES.has(record.page) ? record.page : null;
  } catch {
    return null;
  }
}

function saveStartupPagePreference(page) {
  if (!STARTUP_PAGES.has(page)) return { ok: false, error: '无效的启动页面' };
  try {
    fs.writeFileSync(startupFile(), JSON.stringify({ page }), { encoding: 'utf8', mode: 0o600 });
    startupPagePreference = page;
    return { ok: true };
  } catch {
    return { ok: false, error: '无法保存启动设置' };
  }
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
    .map((e) => {
      const parsed = parseCustomEndpoint(e.url);
      if (!parsed.ok) return null;
      let token = null;
      let tokenError = false;
      if (typeof e.encryptedToken === 'string') {
        token = decryptCustomToken(e.encryptedToken);
        tokenError = token === null;
      } else if (parsed.token) {
        token = parsed.token; // legacy plaintext; initEndpoints migrates if possible
      }
      return {
      id: 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      kind: 'custom',
      name: e.name.trim().slice(0, 40),
      url: parsed.url,
      token,
      encryptedToken: typeof e.encryptedToken === 'string' ? e.encryptedToken : null,
      tokenError,
      needsTokenMigration: !e.encryptedToken && Boolean(parsed.token),
      child: null,
      childAlive: false,
      wasOnline: false,
      status: 'unknown',
      detail: tokenError ? '保存的认证凭据无法读取，请重新输入 token' : ''
    };
    })
    .filter(Boolean);
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
      const saved = { name: ep.name, url: ep.url };
      if (ep.token) {
        const encryptedToken = encryptCustomToken(ep.token);
        if (encryptedToken === null) return false;
        saved.encryptedToken = encryptedToken;
      } else if (ep.encryptedToken) {
        // A credential we cannot decrypt must survive unrelated settings saves
        // until the user explicitly replaces or clears it.
        saved.encryptedToken = ep.encryptedToken;
      }
      obj.custom.push(saved);
    }
  }
  try {
    const file = endpointsFile();
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    for (const ep of appState.endpoints) if (ep.kind === 'custom') ep.needsTokenMigration = false;
    return true;
  } catch {
    return false;
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
    wasOnline: false, // connected at least once since this launch (灰点 vs 红点)
    url: null,
    child: null,
    childAlive: false,
    tokenAuth: false,
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
    port: WSL_DEFAULT_PORT,
    dshOverride: null, // manual WSL-side dsh path; null = auto-detect
    urlOverride: null, // manual URL (via 编辑); null = derive from WSL IP + port
    wasOnline: false, // connected at least once since this launch (灰点 vs 红点)
    url: null,
    child: null,
    childAlive: false,
    tokenAuth: false,
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
      wasOnline: false,
      status: 'unknown',
      detail: ''
    });
  }
  appState.endpoints = eps;
  // A legacy custom URL may have contained token= in plaintext. Rewrite only
  // after encryption succeeds; otherwise retain the source file untouched.
  if (eps.some((ep) => ep.kind === 'custom' && ep.needsTokenMigration)) persistEndpoints();
  appState.activeEndpoint = 'local';
}

function getEndpoint(id) {
  return appState.endpoints.find((e) => e.id === id) || null;
}

// --- WSL (Windows only) ----------------------------------------------------

/** Run a `wsl` sub-command without blocking the main process. */
function wslExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (root && process.arch === 'ia32') return path.join(root, 'Sysnative', 'wsl.exe');
  return root ? path.join(root, 'System32', 'wsl.exe') : 'wsl.exe';
}

function wslExec(args, timeoutMs, raw = false) {
  return new Promise((resolve) => {
    try {
      execFile(wslExecutable(), args, { timeout: timeoutMs, windowsHide: true, encoding: raw ? null : 'utf8' }, (err, stdout, stderr) => {
        const errorOutput = stderr || (err && (err.stderr || err.stdout));
        resolve({ err, stdout: raw ? stdout || Buffer.alloc(0) : stdout || '', stderr: raw ? errorOutput || Buffer.alloc(0) : errorOutput || '' });
      });
    } catch {
      resolve({ err: new Error('spawn failed'), stdout: raw ? Buffer.alloc(0) : '', stderr: raw ? Buffer.alloc(0) : '' });
    }
  });
}

function decodeWslList(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.alloc(data.length - 2);
    for (let i = 2; i + 1 < data.length; i += 2) { swapped[i - 2] = data[i + 1]; swapped[i - 1] = data[i]; }
    return swapped.toString('utf16le');
  }
  let nul = 0;
  for (const byte of data) if (byte === 0) nul += 1;
  return nul > data.length / 4 ? data.toString('utf16le') : data.toString('utf8');
}

function wslDistroArgs(distro, args) {
  return distro ? ['-d', distro].concat(args) : args;
}

function parseWslList(value, quiet) {
  const lines = decodeWslList(value).replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (quiet) return lines.map((line) => line.replace(/^\*\s*/, '').trim()).filter(Boolean);
  const marked = lines.find((line) => /^\*/.test(line));
  if (marked) return [marked.replace(/^\*\s*/, '').split(/\s+/)[0]].filter(Boolean);
  // `wsl -l` always includes one header line. Do not identify it by its
  // English spelling: Windows localizes that header.
  return lines.length > 1 ? [lines[1].replace(/^\*\s*/, '').split(/\s+/)[0]].filter(Boolean) : [];
}

function markedWslDistro(value, candidates) {
  const marked = decodeWslList(value).replace(/\r/g, '').split('\n').map((line) => line.trim()).find((line) => /^\*/.test(line));
  if (!marked) return null;
  const row = marked.replace(/^\*\s*/, '');
  return candidates.slice().sort((a, b) => b.length - a.length).find((name) => row === name || row.startsWith(name + ' ')) || null;
}

function parseOsRelease(value) {
  const fields = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = /^(PRETTY_NAME|NAME|VERSION_ID)=(.*)$/.exec(line);
    if (!match) continue;
    let text = match[2].trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replace(/\\([\\"`$])/g, '$1');
    fields[match[1]] = text.replace(/[\u0000-\u001f]/g, '').trim();
  }
  return fields.PRETTY_NAME || (fields.NAME && fields.VERSION_ID ? `${fields.NAME} ${fields.VERSION_ID}` : '');
}

function wslProbeFailure(err, stderr, stdout) {
  if (err && (err.killed || err.code === 'ETIMEDOUT')) return 'WSL 枚举超时，请稍后重新检测';
  const stderrText = decodeWslList(stderr).replace(/[\u0000-\u001f]+/g, ' ').trim();
  const stdoutText = decodeWslList(stdout).replace(/[\u0000-\u001f]+/g, ' ').trim();
  const output = stderrText || stdoutText;
  if (output) return `无法枚举 WSL 发行版：${output}`;
  const message = String((err && err.message) || '').trim();
  return message ? `无法枚举 WSL 发行版：${message.slice(0, 160)}` : '无法枚举 WSL 发行版';
}

function isWslExecutableMissing(err) {
  return Boolean(err && err.code === 'ENOENT');
}

/**
 * Detect WSL: is a default distribution installed, what is the distro's eth0
 * IP (WSL2) or 127.0.0.1 (WSL1 shares the host's loopback), and where is `dsh`
 * inside the distro (npm's global bin lands on the login-shell PATH).
 */
async function wslProbeWithExec(executor) {
  let list = await executor(['-l', '-q'], 20_000, true);
  let distros = !list.err ? parseWslList(list.stdout, true) : [];
  // Older WSL releases do not support `--quiet`; their normal list is still
  // enough to establish installation, without depending on localized headers.
  if (list.err) {
    const legacy = await executor(['-l'], 20_000, true);
    if (legacy.err) {
      if (isWslExecutableMissing(legacy.err)) return { installed: false, dshBin: null, ip: null, node: null, npm: null, distro: null, distroLabel: null, dshVersion: null, error: null };
      return { installed: null, dshBin: null, ip: null, node: null, npm: null, distro: null, distroLabel: null, dshVersion: null, error: wslProbeFailure(legacy.err, legacy.stderr, legacy.stdout) };
    }
    list = legacy;
    distros = parseWslList(list.stdout, false);
  }
  if (distros.length === 0) return { installed: false, dshBin: null, ip: null, node: null, npm: null, distro: null, distroLabel: null, dshVersion: null, error: null };
  // Default distribution name (the line marked `*` in `wsl -l -v`; else the
  // first non-header line). `wsl -l` emits UTF-16LE, so read it raw + decode.
  let distro = null;
  {
    const lv = await executor(['-l', '-v'], 20_000, true);
    if (!lv.err && lv.stdout) {
      distro = markedWslDistro(lv.stdout, distros);
    }
  }
  let ip = null;
  const ipRes = await executor(wslDistroArgs(distro, ['-e', 'hostname', '-I']), 20_000);
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
  // `-ic` (interactive) so the login-shell .bashrc is sourced — that is where
  // nvm / volta / asdf put their shims on PATH. `-lc` alone would miss them.
  const dshRes = await executor(wslDistroArgs(distro, ['-e', 'bash', '-ic', detect]), 25_000);
  if (!dshRes.err) {
    const lines = dshRes.stdout.trim().split('\n');
    const last = lines[lines.length - 1] || '';
    if (last.startsWith('/')) dshBin = last;
  }
  // dsh version (only when a dsh binary was actually found).
  let dshVersion = null;
  if (dshBin) {
    const vRes = await executor(
      wslDistroArgs(distro, ['-e', 'bash', '-lc', `exec "${dshBin}" --version 2>/dev/null | tail -n 1`]),
      15_000
    );
    if (!vRes.err) dshVersion = vRes.stdout.trim().split('\n').pop() || null;
  }
  // Detect a REAL Linux-side Node.js / npm inside the distro (prerequisite for
  // installing dsh). WSL merges the Windows PATH, so `command -v` can resolve
  // /mnt/c/... (Windows) binaries — reject those, exactly like the dsh check.
  let node = null;
  let npm = null;
  const nodeRes = await executor(
    wslDistroArgs(distro, [
      '-e',
      'bash',
      '-ic',
      [
        'n=$(command -v node 2>/dev/null)',
        "case \"$n\" in /mnt/*|'') n='' ;; esac",
        'if [ -n "$n" ]; then n=$("$n" --version 2>/dev/null || true); fi',
        'm=$(command -v npm 2>/dev/null)',
        "case \"$m\" in /mnt/*|'') m='' ;; esac",
        'if [ -n "$m" ]; then m=$("$m" --version 2>/dev/null || true); fi',
        'printf "NODE=%s\\nNPM=%s\\n" "$n" "$m"'
      ].join('; ')
    ]),
    15_000
  );
  if (!nodeRes.err) {
    const mn = /NODE=(.*)/.exec(nodeRes.stdout);
    const mm = /NPM=(.*)/.exec(nodeRes.stdout);
    if (mn && mn[1].trim()) node = mn[1].trim();
    if (mm && mm[1].trim()) npm = mm[1].trim();
  }
  let distroLabel = null;
  const release = await executor(wslDistroArgs(distro, ['-e', 'sh', '-c', 'test -r /etc/os-release && cat /etc/os-release']), 10_000);
  if (!release.err) distroLabel = parseOsRelease(release.stdout) || null;
  // Missing metadata must not turn a usable distro into a failure; it merely
  // means the UI has no friendly version label. Shell command failures do
  // distinguish an installed-but-unavailable distro from a missing install.
  const failed = [dshRes, nodeRes].find((result) => result.err);
  const error = failed ? wslProbeFailure(failed.err, failed.stderr, failed.stdout).replace('无法枚举 WSL 发行版：', 'WSL 发行版无法启动或响应：') : null;
  return { installed: true, dshBin, ip, node, npm, distro, distroLabel, dshVersion, error };
}

async function wslProbe() {
  return wslProbeWithExec(wslExec);
}

/** Spawn dsh web INSIDE the default WSL distribution (wsl.exe stays attached).
 *  dsh web binds the distro's loopback; the Windows side reaches it through
 *  WSL2 localhost-forwarding (127.0.0.1:<port>), so no --host is needed.
 *  `-ic` sources .bashrc so nvm/volta node is on PATH for dsh's shebang. */
function spawnWslDsh(dshBin, port, distro) {
  const inner = `exec "${dshBin}" web --no-open --port ${port}`;
  return spawn(wslExecutable(), wslDistroArgs(distro, ['-e', 'bash', '-ic', inner]), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function runWslScript(script, timeoutMs, user = null, distro = null) {
  const inner = user ? ['-u', user, '-e', 'bash', '-lc', script] : ['-e', 'bash', '-lc', script];
  const args = wslDistroArgs(distro, inner);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(wslExecutable(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ ok: false, err, out: '' });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ ok: false, err: new Error('timeout'), out });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (out.length > 16384) out = out.slice(-16384);
    });
    child.stderr.on('data', (d) => {
      out += d.toString('utf8');
      if (out.length > 16384) out = out.slice(-16384);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, err, out });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out });
    });
  });
}

async function recoverWslDshEarlyExit(cfg, ep, dsh, port, output) {
  const portSafe = String(port || '').replace(/[^\d]/g, '') || '13080';
  console.log('[wsl-recover] dsh web early exit; cleaning stale WSL dsh web and re-probing');
  await runWslScript(
    `pkill -f "dsh web --no-open --port ${portSafe}" 2>/dev/null || true; sleep 1; true`,
    15_000, null, ep.wsl && ep.wsl.distro
  );
  const probe = await wslProbe();
  ep.wsl = probe;
  console.log('[wsl-recover] reprobe after early exit:', JSON.stringify(probe));
  const freshDsh = ep.dshOverride || probe.dshBin || dsh;
  if (!probe.dshBin && !ep.dshOverride) {
    console.log('[wsl-recover] dsh missing; reinstalling to user npm prefix');
    await runWslScript(
      [
        'export npm_config_prefix="$HOME/.local/share/.npm-global"',
        'mkdir -p "$npm_config_prefix/bin" "$npm_config_prefix/lib/node_modules"',
        'npm install -g @deepseek-ai/dsh --loglevel=verbose 2>&1 | tee "$HOME/dsh-install-dsh.log"; exit ${PIPESTATUS[0]}'
      ].join('; '),
      5 * 60_000, null, ep.wsl && ep.wsl.distro
    );
    const probe2 = await wslProbe();
    ep.wsl = probe2;
    return ep.dshOverride || probe2.dshBin || freshDsh;
  }
  const nodeMajor = parseInt(String(probe.node || '').replace(/^v/, ''), 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
    console.log(`[wsl-recover] Node ${probe.node} detected; upgrading to Node 22`);
    await runWslScript(
      [
        'set -e',
        'export DEBIAN_FRONTEND=noninteractive',
        'if command -v apt-get >/dev/null 2>&1; then',
        '  if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; fi',
        '  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
        '  apt-get install -y nodejs',
        'elif command -v dnf >/dev/null 2>&1; then',
        '  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
        '  dnf install -y nodejs',
        'elif command -v yum >/dev/null 2>&1; then',
        '  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
        '  yum install -y nodejs',
        'fi',
        'node --version && npm --version'
      ].join('\n'),
      5 * 60_000,
      'root', ep.wsl && ep.wsl.distro
    );
    const probe3 = await wslProbe();
    ep.wsl = probe3;
    console.log('[wsl-recover] reprobe after Node upgrade:', JSON.stringify(probe3));
  }
  return ep.dshOverride || probe.dshBin || freshDsh;
}

/**
 * Resolve the WSL dsh web: reuse an instance already serving on 127.0.0.1
 * (reachable from Windows via WSL2 localhost-forwarding), otherwise spawn
 * `dsh web --no-open --port <port>` inside the distro.
 */
async function resolveWslServer(cfg, ep, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const info = ep.wsl;
  if (info && info.error) throw new Error(info.error);
  if (!info || info.installed !== true) throw new Error((info && info.error) || '未检测到 WSL（请安装 WSL 与一个默认发行版）');
  const port = ep.port != null ? ep.port : cfg.port;
  // An explicit endpoint URL (via 编辑) is probed first and reused when it
  // answers; otherwise we reach the distro through 127.0.0.1 (WSL2 forwards
  // the Windows loopback into it).
  const probeUrl = ep.urlOverride || `http://127.0.0.1:${port}`;
  const status = await probeWithGrace(probeUrl);
  if (status === 'harness') return { url: probeUrl, child: null };
  if (status !== 'free') {
    throw new Error(`端口 ${port} 已被占用（请在 WSL 终端执行 lsof -i :${port} 查看）`);
  }
  let dsh = ep.dshOverride || info.dshBin;
  if (!dsh) throw new Error('WSL 内未检测到 dsh。请先在 WSL 中执行：npm install -g @deepseek-ai/dsh，或在「编辑」中手动指定 dsh 路径');
  const fixedUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    report('starting', '正在启动 WSL 的 DSH 服务…');
    const child = spawnWslDsh(dsh, port, info.distro);
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });
    const urlSource = pipeChildOutput(child, cfg.verbose);
    try {
      // WSL cold start (booting the distro) is slower than a local spawn.
      const readyUrl = await waitForServer(fixedUrl, urlSource.discoveredUrl, child, READY_TIMEOUT_MS + 60_000, report);
      if (readyUrl === null) {
        throw new Error(`WSL 内的 dsh web 未能在 ${READY_TIMEOUT_MS / 1000 + 60} 秒内就绪`);
      }
      return { url: readyUrl, child };
    } catch (err) {
      killChild(child);
      if (spawnError !== null && spawnError.code === 'ENOENT') {
        throw new Error('无法调用 wsl.exe（WSL 未安装或不可用）');
      }
      const output = urlSource.tail ? urlSource.tail() : '';
      const earlyExit = /exited early/.test(String(err && err.message));
      if (earlyExit && attempt === 1) {
        console.log('[wsl-recover] initial dsh web output tail:\n' + redactTokenUrls(output).slice(-4000));
        dsh = await recoverWslDshEarlyExit(cfg, ep, dsh, port, output);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Detect the WSL endpoint (at startup / on user action / periodically).
 * `kind`:
 *   'first'   — 首次检测: the WSL guide page shows 加载中 during the probe and
 *               lands on the stuck step when it finishes (step lands here).
 *   'manual'  — 手动检测: the user clicked 「重新检测」— the step may re-land.
 *   'auto'    — background re-detection: updates the dot / detail only and
 *               NEVER moves the step the user is currently reading.
 */
let wslProbeSeq = 0; // monotonically increasing probe-generation counter
/**
 * Detect the WSL endpoint (at startup / on user action / periodically).
 * `kind`:
 *   'first'   — 首次检测: the WSL guide page shows 加载中 during the probe and
 *               lands on the stuck step when it finishes (step lands here).
 *   'manual'  — 手动检测: the user clicked 「重新检测」— the step may re-land.
 *   'auto'    — background re-detection: updates the dot / detail only and
 *               NEVER moves the step the user is currently reading.
 * Probes never block each other; a newer probe's generation (wslProbeSeq)
 * supersedes an older one, whose stale result is discarded.
 */
async function detectWslEndpoint(kind) {
  const ep = getEndpoint('wsl');
  if (ep === null) return null;
  const my = ++wslProbeSeq;
  const isAuto = kind === 'auto';
  if (!isAuto) {
    ep.status = 'starting';
    ep.detail = '正在检测 WSL…';
  }
  ep._wslLastDetectKind = isAuto ? 'auto' : kind; // 'first' / 'manual' / 'auto'
  ep._wslDetectInFlight = true;
  pushWslStatus(ep);
  let info;
  try {
    info = await wslProbe();
  } catch {
    ep._wslDetectInFlight = false;
    if (my !== wslProbeSeq) return null; // superseded
    ep.status = 'error';
    ep.detail = 'WSL 检测失败';
    pushWslStatus(ep);
    pushPureInfo();
    setStatus({});
    return { installed: null, error: ep.detail };
  }
  if (my !== wslProbeSeq) return null; // superseded (a newer probe started after)
  ep._wslDetectInFlight = false;
  ep.wsl = info;
  console.log('[wsl-probe]', JSON.stringify(info));
  if (!isAuto) {
    // Status + dot transitions happen only on first / manual detection.
    if (info.installed === false) {
      // WSL itself is missing (environment problem): error, re-detect later.
      ep.status = 'error';
      ep.detail = '未检测到 WSL';
    } else if (info.installed !== true) {
      ep.status = 'error';
      ep.detail = info.error || 'WSL 检测失败';
    } else if (info.error) {
      ep.status = 'error';
      ep.detail = info.error;
    } else if (!info.node) {
      // WSL is fine but Node.js is missing inside it: gray (unknown).
      ep.status = 'unknown';
      ep.detail = 'WSL 内未安装 Node.js';
    } else if (!info.dshBin && !ep.dshOverride) {
      // WSL is fine but dsh is not installed there: never connected → gray
      // (unknown), with the hint kept in detail.
      ep.status = 'unknown';
      ep.detail = 'WSL 内未安装 dsh';
    } else {
      ep.status = 'unknown';
      ep.detail = '';
    }
  }
  pushWslStatus(ep);
  pushPureInfo();
  setStatus({});
  // 首次 / 手动检测结束 → 把引导页（重新）加载为带最新状态的 URL，落到
  // 卡住的步骤；自动后台检测不触碰该页（用户正在阅读的步骤保持不变，仅
  // 圆点 / 详情 / 状态栏经 live push 更新）。
  if (!isAuto) {
    const v = appState.views['wsl'];
    if (
      appState.view === 'web' &&
      appState.currentPage === 'wsl' &&
      ep.status !== 'online' &&
      v !== null &&
      v !== undefined &&
      !v.webContents.isDestroyed()
    ) {
      v.webContents.loadURL(wslRouterUrl(ep));
    }
  }
  // 兜底：loadURL 是程序化导航，页面脚本完成渲染的时间不确定（快速重载 /
  // 首次导航 / 磁盘缓存）。检测结束后延迟一拍再推一次完整状态（kind 为
  // 首次/手动，携带最新 wsl 探测结果）：此时页面若已渲染完成 → 原位落步；
  // 若还没渲染完 → 页面脚本读取推送值作为初始状态，渲染出来就是新的。
  if (!isAuto) {
    setTimeout(() => {
      pushWslStatus(getEndpoint('wsl'));
    }, 600);
  }
  return info;
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
        ep.wasOnline = true;
        continue;
      }
      // WSL endpoint whose last detection found a problem: re-detect in the
      // BACKGROUND (kind 'auto' — never re-lands the guide page's step; only
      // the dot / detail / status bar update) so the endpoint recovers on its
      // own once WSL / dsh is installed.
      if (
        ep.kind === 'wsl' &&
        (ep.status === 'error' || ep.status === 'unknown') &&
        Date.now() - (ep._wslRetryAt || 0) > 60_000
      ) {
        ep._wslRetryAt = Date.now();
        detectWslEndpoint('auto').catch(() => {});
        continue;
      }
      // Nothing connected yet: probe the address the CURRENT settings derive
      // to, so the 页面 menu / tab dots show whether dsh web is already
      // running (we only observe here — never spawn).
      let target = ep.kind === 'custom' ? customRuntimeUrl(ep) : (ep.authUrl || ep.url);
      if (target === null) {
        if (ep.urlOverride) target = ep.urlOverride;
        else if (ep.kind === 'custom') continue;
        else target = `http://127.0.0.1:${ep.port}`;
      }
      const st = await probeEndpointUrl(ep, target);
      if (st === 'harness') {
        ep.status = 'online';
        ep.wasOnline = true;
      } else {
        // 红（offline）仅用于"曾经连上过、现在没了"；从未连上过（含尝试过
        // 但失败）一律保持灰（unknown）。
        if (ep.wasOnline) ep.status = 'offline';
        else ep.status = 'unknown';
        // The server we connected to went away: clear the displayed URL and
        // show the in-page 已断开 component (the window STAYS on this page —
        // the user retries from there; only 重启 / 编辑 / 重置 take the view
        // back to the shell page).
        if (
          st === 'free' &&
          ep.wasOnline &&
          ep.url !== null &&
          appState.url !== null &&
          appState.displayEndpoint === ep.id &&
          appState.url === ep.url
        ) {
          appState.url = null;
          appState.child = null;
          ep.url = ep.kind === 'custom' ? ep.url : null; // custom keeps its address
          appState.displayEndpoint = ep.id;
          layout();
          const v = appState.views[ep.id];
          if (v && !v.webContents.isDestroyed()) {
            if (ep.kind === 'wsl') {
              // Stay on the setup guide: the 连接 step flips to 已断开 via a
              // live push — no page reload (the user's current step is kept).
              pushWslStatus(ep);
            } else {
              v.webContents.loadURL(routerUrl(ep.id, 'offline', ep.name));
            }
          }
          setStatus({ reason: `${ep.name} 的 dsh web 已离线` });
        }
      }
    }
    pushPureInfo();
    setStatus({}); // endpoint state changed → the title bar (current page) updates
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
  if (raw === 'about:blank') return true;
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
  // Keep every view's background in sync with the new theme (pre-paint color).
  for (const v of Object.values(appState.views)) {
    if (!v.webContents.isDestroyed()) v.setBackgroundColor(currentWindowBg());
  }
  // If a menu is open, refresh it so the theme radio group reflects the change.
  if (openMenu !== null) openMenuAt(openMenu, currentMenuLeft);
  // Keep the Pure page's "current theme" label in sync with the new theme.
  pushPureInfo();
}

// ---------------------------------------------------------------------------
// Window + view handles (module scope so menu / title bar / lifecycle reach them)
// ---------------------------------------------------------------------------

let win = null; // BaseWindow
let webView = null; // WebContentsView: currently-shown endpoint view (dynamic reference)
let pureView = null; // WebContentsView: the shell's own DSH Desktop Pure page (file://)
let startupView = null; // router.html overlay, retained until the backend document is ready
let startupState = null; // { endpointId, sequence, phase, detail }

let titlebarView = null; // WebContentsView: the one-row title bar (middle)
let menuView = null; // WebContentsView: the dropdown menu (top, transparent)
let tray = null; // System tray icon (hide-to-tray; server keeps running while hidden)
let currentStatus = { state: 'starting', view: 'web' };
let openMenu = null; // 'file' | 'view' | 'server' | null
let currentMenuLeft = 0; // content-relative x of the open menu's button
let titlebarStatusHitbox = null; // fixed, content-relative redacted status rect
let titlebarStatusHover = false;
let titlebarStatusHoverTimer = null;

/**
 * Status of the CURRENT PAGE (the title bar always reflects it). Every page
 * has its own state: 桌面端配置 is the shell's own page (always "ready");
 * an endpoint page mirrors that endpoint's connection state.
 */
function pageStatus() {
  if (appState.currentPage === 'pure' || appState.currentPage === null) {
    return { state: 'pure', pageName: '桌面端配置' };
  }
  const ep = getEndpoint(appState.currentPage);
  if (ep === null) return { state: 'unknown', reason: '未连接', pageName: '未知' };
  if (ep.status === 'online' || ep.childAlive) {
    // authUrl is deliberately memory-only. The title bar receives the actual
    // runtime URL for its existing hover reveal; Pure snapshots redact it.
    return { state: 'online', url: pageEndpointRuntimeUrl(ep) || appState.url, spawned: ep.childAlive, pageName: ep.name };
  }
  if (ep.status === 'starting') return { state: 'starting', pageName: ep.name };
  // 红点（已断开）：本次启动后成功连接过、但后来断开 / 出错。
  // 灰点（未连接）：从未连接过（含"没连上就报错"的情况）。
  if (ep.status === 'offline') return { state: 'offline', pageName: ep.name };
  if (ep.status === 'error') {
    return ep.wasOnline
      ? { state: 'offline', pageName: ep.name }
      : { state: 'unknown', reason: '未连接', pageName: ep.name };
  }
  return { state: 'unknown', reason: '未连接', pageName: ep.name };
}

/** Re-broadcast the current page's status to the title bar. */
function setStatus(extra) {
  currentStatus = Object.assign(pageStatus(), extra || {}, { view: appState.view });
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

/** Whether a screen-space cursor is within a content-relative rectangle. */
function isScreenPointInContentRect(point, contentBounds, rect) {
  if (!point || !contentBounds || !rect) return false;
  const values = [point.x, point.y, contentBounds.x, contentBounds.y, rect.x, rect.y, rect.width, rect.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
  const left = contentBounds.x + rect.x;
  const top = contentBounds.y + rect.y;
  return point.x >= left && point.x < left + rect.width && point.y >= top && point.y < top + rect.height;
}

function shouldRevealTitlebarStatus(point, contentBounds, hitbox, focused, visible) {
  return Boolean(focused && visible && isScreenPointInContentRect(point, contentBounds, hitbox));
}

function setTitlebarStatusHover(hovered) {
  const next = Boolean(hovered);
  if (titlebarStatusHover === next) return false;
  titlebarStatusHover = next;
  if (titlebarView !== null && !titlebarView.webContents.isDestroyed()) {
    titlebarView.webContents.send('titlebar:status-hover', next);
  }
  return true;
}

function clearTitlebarStatusHover() {
  setTitlebarStatusHover(false);
}

function pollTitlebarStatusHover() {
  if (win === null || titlebarStatusHitbox === null) return clearTitlebarStatusHover();
  try {
    setTitlebarStatusHover(shouldRevealTitlebarStatus(
      screen.getCursorScreenPoint(), win.getContentBounds(), titlebarStatusHitbox,
      win.isFocused(), win.isVisible()
    ));
  } catch {
    clearTitlebarStatusHover();
  }
}

function startTitlebarStatusHoverPolling() {
  if (titlebarStatusHoverTimer !== null) return;
  titlebarStatusHoverTimer = setInterval(pollTitlebarStatusHover, TITLEBAR_STATUS_HOVER_INTERVAL_MS);
}

function stopTitlebarStatusHoverPolling() {
  if (titlebarStatusHoverTimer !== null) clearInterval(titlebarStatusHoverTimer);
  titlebarStatusHoverTimer = null;
  titlebarStatusHitbox = null;
  clearTitlebarStatusHover();
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
 * Get (or lazily create) the WebContentsView for an endpoint. Each endpoint
 * has its OWN view so switching preserves sessions (no re-navigation, no
 * React re-boot). Views are parked off-screen when not displayed, never
 * destroyed while the app runs.
 */
function getEndpointView(epId) {
  if (appState.views[epId]) return appState.views[epId];
  const v = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  // Theme-colored background: before the first document paints (and on a
  // cross-URL navigation) the view shows the shell's theme color instead of
  // a white flash; re-synced on every theme change.
  v.setBackgroundColor(currentWindowBg());
  hardenWebContents(v.webContents);
  v.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    if (win !== null) win.setTitle(WINDOW_TITLE);
  });
  v.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && startupState && startupState.endpointId === epId && /^https?:/i.test(url)) {
      v.webContents._startupNavigationSequence = startupState.sequence;
    }
  });
  v.webContents.on('did-finish-load', () => {
    // Keep the themed progress surface up through the actual backend document,
    // not merely until its HTTP listener/token handshake becomes ready.
    if (startupState && startupState.endpointId === epId &&
      v.webContents._startupNavigationSequence === startupState.sequence && /^https?:/i.test(v.webContents.getURL())) {
      hideStartupOverlay(epId, startupState.sequence);
    }
  });
  v.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    if (!validatedURL || validatedURL.startsWith('file://') || validatedURL === 'about:blank') return;
    // Only the endpoint's LIVE backend URL may trigger the in-page error /
    // offline component. While the router page itself (file://) is showing
    // (加载中 / 加载失败), or while the view is loading about:blank after a
    // failed restart, the component is already up — do NOT re-navigate (that
    // would swap in the shell page).
    if (!epHostMatched(validatedURL, epId)) return;
    if (appState.view !== 'web' || appState.currentPage !== epId) return;
    const ep = getEndpoint(epId);
    const name = ep ? ep.name : '';
    const detail = errorDescription || '连接失败';
    if (ep) { ep.status = 'offline'; ep.detail = detail; }
    hideStartupOverlay(epId);
    appState.url = null;
    // WSL gets its setup-guide page; everything else the generic error page.
    v.webContents.loadURL(ep && ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(epId, 'error', name, detail));
    setStatus({ reason: `连接断开：${detail}` });
    pushPureInfo();
  });
  // Register first so layout() can find it.
  appState.views[epId] = v;
  // Add to content view. Re-adding the static views moves them back to the
  // top of the z-order (addChildView appends to the end = topmost), keeping
  // titlebar / menu clickable above endpoint views.
  win.contentView.addChildView(v);
  if (pureView) win.contentView.addChildView(pureView);
  if (startupView) win.contentView.addChildView(startupView);
  if (titlebarView) win.contentView.addChildView(titlebarView);
  if (menuView) win.contentView.addChildView(menuView);
  v.setBounds({ x: -100000, y: 0, width: 0, height: 0 });
  return v;
}

function layout() {
  if (win === null || titlebarView === null || pureView === null) return;
  const [width, height] = win.getContentSize();
  const y = TITLEBAR_HEIGHT;
  const h = Math.max(0, height - TITLEBAR_HEIGHT);
  const OFF = -100000;
  titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
  if (appState.view === 'pure') {
    pureView.setBounds({ x: 0, y, width, height: h });
    for (const v of Object.values(appState.views)) {
      v.setBounds({ x: OFF, y, width: 0, height: 0 });
    }
    webView = null;
  } else {
    pureView.setBounds({ x: OFF, y, width: 0, height: 0 });
    webView = null;
    for (const [epId, v] of Object.entries(appState.views)) {
      if (epId === appState.currentPage) {
        v.setBounds({ x: 0, y, width, height: h });
        webView = v;
      } else {
        v.setBounds({ x: OFF, y, width: 0, height: 0 });
      }
    }
  }
  if (startupView !== null) {
    const visible = startupState !== null && appState.view === 'web' &&
      appState.currentPage === startupState.endpointId;
    startupView.setBounds(visible ? { x: 0, y, width, height: h } : { x: OFF, y, width: 0, height: 0 });
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

  // The shell's own DSH Desktop Pure page (file://, independent of dsh web).
  // Endpoint views are created lazily via getEndpointView().
  pureView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'purepreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  pureView.setBackgroundColor(currentWindowBg());
  // Timestamped query busts Electron's file:// disk cache so layout/theme edits
  // to pure.html are always picked up on (re)launch.
  pureView.webContents.loadFile(path.join(__dirname, 'pure.html'), {
    query: { v: String(Date.now()) }
  });
  pureView.webContents.on('did-finish-load', () => {
    if (pureView === null || pureView.webContents.isDestroyed()) return;
    pureView.webContents.send('pure:release-update', releaseUpdateSnapshot());
    flushPendingPureSection();
  });

  startupView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true
    }
  });
  startupView.setBackgroundColor(currentWindowBg());
  hardenWebContents(startupView.webContents);
  startupView.webContents.on('did-finish-load', () => {
    // Progress emitted while file:// was loading is intentionally replayed.
    if (startupState !== null && !startupView.webContents.isDestroyed()) {
      startupView.webContents.send('router:startup-progress', {
        sequence: startupState.sequence, phase: startupState.phase, detail: startupState.detail
      });
    }
  });

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

  // Stacking order: later-added views sit on top. Endpoint views are added
  // lazily (getEndpointView); the Pure page, title bar, and menu are static.
  win.contentView.addChildView(pureView);
  win.contentView.addChildView(startupView);
  win.contentView.addChildView(titlebarView);
  win.contentView.addChildView(menuView);
  layout();
  menuView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden until opened
  win.on('resize', layout);

  // The Pure page is a local file:// we fully control.
  hardenWebContents(pureView.webContents);

  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'));
  titlebarView.webContents.once('did-finish-load', () => {
    if (titlebarView === null || titlebarView.webContents.isDestroyed()) return;
    clearTitlebarStatusHover();
    titlebarView.webContents.send('dsh:status', currentStatus);
    titlebarView.webContents.send('titlebar:release-update', releaseUpdateSnapshot());
    pushMaximized(win !== null && win.isMaximized());
  });

  menuView.webContents.loadFile(path.join(__dirname, 'menu.html'));

  win.on('maximize', () => pushMaximized(true));
  win.on('unmaximize', () => pushMaximized(false));
  // App-region drag areas do not consistently deliver DOM mouseenter/leave.
  // Native window state plus screen-space polling remains reliable over status.
  win.on('blur', clearTitlebarStatusHover);
  win.on('hide', clearTitlebarStatusHover);
  win.on('focus', pollTitlebarStatusHover);
  win.on('show', pollTitlebarStatusHover);
  startTitlebarStatusHoverPolling();

  win.on('close', (event) => {
    // Intercept real closes (macOS native red button, taskbar, etc.): hide into
    // the tray instead of exiting — unless we are truly quitting.
    if (!quitting && tray !== null) {
      event.preventDefault();
      hideToTray();
    }
  });

  win.on('closed', () => {
    stopTitlebarStatusHoverPolling();
    for (const v of Object.values(appState.views)) {
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    appState.views = {};
    win = null;
    webView = null;
    pureView = null;
    startupView = null;
    startupState = null;
    titlebarView = null;
    menuView = null;
    openMenu = null;
  });
}

/**
 * Navigate (or re-navigate) the dsh web view to a URL.
 * The view's background is the shell's theme bg (set at creation / theme
 * change), so a fresh page transition shows the theme color, never a white
 * flash — no CSS fade is needed (insertCSS on file:// / about:blank silently
 * fails and would leave a stuck `opacity: 0` = permanent white).
 */

/** True when two URLs share protocol+host+port (path/query/hash ignored). */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function loadWeb(url) {
  if (webView === null || webView.webContents.isDestroyed()) return;
  webView.webContents.loadURL(url);
}

function startupRouterUrl(ep, sequence, phase, detail) {
  const params = new URLSearchParams({ overlay: '1', ep: ep.id, startup: String(sequence), phase, detail: detail || '' });
  return 'file://' + path.join(__dirname, 'router.html') + '?' + params.toString();
}

function showStartupOverlay(ep, sequence, phase, detail) {
  startupState = { endpointId: ep.id, sequence, phase, detail: detail || '' };
  if (startupView === null || startupView.webContents.isDestroyed()) return;
  startupView.webContents.loadURL(startupRouterUrl(ep, sequence, phase, detail));
  layout();
}

function pushStartupProgress(ep, sequence, phase, detail) {
  if (!startupState || startupState.endpointId !== ep.id || startupState.sequence !== sequence) return;
  startupState.phase = phase;
  startupState.detail = detail || '';
  if (startupView !== null && !startupView.webContents.isDestroyed()) {
    startupView.webContents.send('router:startup-progress', { sequence, phase, detail: startupState.detail });
  }
}

function hideStartupOverlay(endpointId, sequence) {
  if (startupState === null || (endpointId && startupState.endpointId !== endpointId) ||
    (sequence != null && startupState.sequence !== sequence)) return;
  startupState = null;
  layout();
}

function failStartupPageLoad(ep, sequence, detail) {
  if (ep._connectSequence !== sequence || appState.currentPage !== ep.id) return;
  hideStartupOverlay(ep.id, sequence);
  ep.status = 'error';
  ep.detail = detail;
  appState.url = null;
  if (process.platform === 'win32' && ep.kind === 'local') {
    ep._windowsOriginalDetail = detail;
    ep._windowsDetecting = true;
    loadWeb(windowsRouterUrl(ep));
    detectWindowsEndpoint('first').catch(() => {});
  } else {
    loadWeb(ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(ep.id, 'error', ep.name, detail));
  }
  setStatus({ reason: `加载「${ep.name}」失败：${detail}` });
  pushPureInfo();
}

function loadStartupPage(ep, sequence, url) {
  if (webView === null || webView.webContents.isDestroyed()) return;
  const contents = webView.webContents;
  const onFinish = () => {
    if (webView && webView.webContents === contents && contents._startupNavigationSequence === sequence) {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onFinish);
    }
  };
  const timer = setTimeout(() => {
    if (startupState && startupState.endpointId === ep.id && startupState.sequence === sequence &&
      webView && webView.webContents === contents && contents._startupNavigationSequence === sequence) {
      contents.removeListener('did-finish-load', onFinish);
      failStartupPageLoad(ep, sequence, 'DSH 网页加载超时，请重试连接');
    }
  }, PAGE_LOAD_TIMEOUT_MS);
  contents.on('did-finish-load', onFinish);
  contents.loadURL(url).catch(() => {
    clearTimeout(timer);
    contents.removeListener('did-finish-load', onFinish);
    failStartupPageLoad(ep, sequence, 'DSH 网页无法加载，请重试连接');
  });
}

/**
 * Navigate the given endpoint's view directly (independent of which view is
 * currently on-screen). The router page is a file:// URL — always allowed.
 */


/**
 * Show the theme-aware loading overlay (a dedicated WebContentsView) while dsh
 * web starts or restarts. It is a transient layer — it never replaces the
 * content of the web or pure page, so their sessions are preserved.
 */
/**
 * "Loading" is no longer a page: it is the STARTING STATE of the endpoint
 * itself (yellow dot + title bar 正在连接…). Kept as no-ops for the call
 * sites; the state broadcast happens where ep.status is set.
 */
function showLoading() {}
function hideLoading() {}

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
  if (appState.url !== null) appState.currentPage = appState.displayEndpoint || appState.currentPage;
  layout();
  setStatus({});
  refreshDshMenu();
}

/** Show the shell's own DSH Desktop Pure page (independent of dsh web). */
function enterPureView(reason) {
  appState.view = 'pure';
  appState.currentPage = 'pure';
  layout();
  setStatus({ reason });
  refreshDshMenu();
}

/**
 * True when `rawUrl` points at the given endpoint's LIVE backend — i.e. not
 * the in-shell router page (file://), not about:blank, and (for a non-custom
 * endpoint) matching the host:port the endpoint's address derives to. Used to
 * decide whether a load failure is a real backend failure worth the in-page
 * error component, versus the router page's own (already-handled) lifecycle.
 */
function epHostMatched(rawUrl, epId) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return false;
    const ep = getEndpoint(epId);
    if (ep === null) return false;
    if (ep.kind === 'custom') return u.host === new URL(ep.url).host;
    const derived = new URL(ep.urlOverride || `http://127.0.0.1:${ep.port}`);
    return u.host === derived.host;
  } catch {
    return false;
  }
}

/** Build the in-shell router page URL for an endpoint (loading / error / offline). */
function routerUrl(epId, status, name, detail) {
  const params = new URLSearchParams({ ep: epId || '', status: status || 'starting' });
  if (name) params.set('name', name);
  if (detail) params.set('detail', detail);
  return 'file://' + path.join(__dirname, 'router.html') + '?' + params.toString();
}

/**
 * Which step a WSL endpoint is stuck at:
 *   install-wsl  → no WSL distribution detected
 *   install-node → WSL is fine but Node.js is missing inside it
 *   install-dsh  → Node.js is fine but dsh is not installed inside it
 *   connect      → all present; the failure is in the connect phase
 */
function wslStep(ep) {
  if (ep.wsl && ep.wsl.error) return 'install-wsl';
  if (!ep.wsl || !ep.wsl.installed) return 'install-wsl';
  if (!ep.wsl.node) return 'install-node';
  if (!ep.wsl.dshBin && !ep.dshOverride) return 'install-dsh';
  return 'connect';
}

/**
 * Push the current WSL endpoint state to its setup-guide page (main →
 * renderer, live): the page keeps the step the user is reading and only
 * updates its status line / status bar in place. `kind` is 'first' /
 * 'manual' / 'auto' — 'auto' must never move the step.
 */
function pushWslStatus(ep) {
  if (appState.view !== 'web' || appState.currentPage !== 'wsl') return;
  const v = appState.views['wsl'];
  if (v === null || v.webContents.isDestroyed()) return;
  v.webContents.send('wsl:status', {
    kind: ep._wslLastDetectKind || 'auto',
    status: ep.status,
    detail: ep.detail || '',
    wslInstalled: ep.wsl && ep.wsl.installed === true,
    wslError: (ep.wsl && ep.wsl.error) || '',
    dshPath: (ep.wsl && ep.wsl.dshBin) || ep.dshOverride || '',
    node: (ep.wsl && ep.wsl.node) || '',
    npm: (ep.wsl && ep.wsl.npm) || '',
    distro: (ep.wsl && ep.wsl.distro) || '',
    distroLabel: (ep.wsl && ep.wsl.distroLabel) || '',
    dshVersion: (ep.wsl && ep.wsl.dshVersion) || '',
    port: String(ep.port != null ? ep.port : (appState.cfg ? appState.cfg.port : 3080))
  });
}

function pushWslInstallProgress(step, payload = {}) {
  if (appState.view !== 'web' || appState.currentPage !== 'wsl') return;
  const v = appState.views['wsl'];
  if (v === null || v.webContents.isDestroyed()) return;
  v.webContents.send('wsl:install-progress', Object.assign({ step: step }, payload));
}

function parsePercent(text) {
  if (typeof text !== 'string') return null;
  const matches = text.match(/\b(\d{1,3})\b\s*%/g);
  if (!matches) return null;
  const last = matches[matches.length - 1];
  const n = parseInt(last, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function lastMeaningfulLine(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== '') return line.slice(0, 120);
  }
  return '';
}

/**
 * The WSL setup-guide router page: a three-step walkthrough (安装 WSL /
 * 安装 DSH / 连接 WSL DSH) that lands on the step the endpoint is stuck at.
 * Carries the probe summary so the page can show live status.
 */
function wslRouterUrl(ep) {
  // Timestamp forces a fresh load every time: file:// URLs with identical
  // params would otherwise be cache hits, and a cached (stale-param) page
  // would render an outdated step / status.
  const params = new URLSearchParams({
    ep: ep.id,
    kind: 'wsl',
    status: ep.status || 'unknown',
    name: ep.name,
    step: wslStep(ep),
    wslInstalled: String(ep.wsl && ep.wsl.installed === true),
    wslError: (ep.wsl && ep.wsl.error) || '',
    dshPath: (ep.wsl && ep.wsl.dshBin) || ep.dshOverride || '',
    wslIp: '127.0.0.1',
    port: String(ep.port != null ? ep.port : (appState.cfg ? appState.cfg.port : 3080)),
    node: (ep.wsl && ep.wsl.node) || '',
    npm: (ep.wsl && ep.wsl.npm) || '',
    distro: (ep.wsl && ep.wsl.distro) || '',
    distroLabel: (ep.wsl && ep.wsl.distroLabel) || '',
    dshVersion: (ep.wsl && ep.wsl.dshVersion) || '',
    detail: ep.detail || '',
    v: String(Date.now())
  });
  return 'file://' + path.join(__dirname, 'router.html') + '?' + params.toString();
}

function windowsRouterUrl(ep) {
  const w = ep.windows || {};
  const params = new URLSearchParams({
    ep: ep.id,
    kind: 'windows',
    authRequired: ep._windowsAuthRequired === true ? '1' : '0',
    // Wait for the first Windows probe before selecting a setup step; an
    // empty startup-failure snapshot would otherwise select Node by default.
    status: ep._windowsDetecting ? 'starting' : (ep.status || 'unknown'),
    name: ep.name,
    step: windowsStep(ep),
    node: w.node || '', npm: w.npm || '',
    dshPath: w.dshPath || '', dshVersion: w.dshVersion || '',
    port: String(ep.port), detail: ep.detail || '', v: String(Date.now())
  });
  return 'file://' + path.join(__dirname, 'router.html') + '?' + params.toString();
}

function windowsStep(ep) {
  const w = ep.windows || {};
  if (!w.node || !w.npm) return 'install-node';
  if (!w.dshPath) return 'install-dsh';
  return 'connect';
}

function windowsExecFile(file, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env: refreshedWindowsEnv() }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function windowsWhere(name) {
  return windowsExecFile('where.exe', [name]).then((r) => {
    if (r.err) return null;
    const paths = r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const electron = path.resolve(process.execPath).toLowerCase();
    const usable = paths.find((p) => path.resolve(p).toLowerCase() !== electron && !/\\electron(?:\.exe)?$/i.test(p));
    return usable || null;
  });
}

function windowsTool(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    // PowerShell's call operator receives the executable and argv separately;
    // this remains correct for .cmd shims and paths containing spaces.
    const psLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const script = `$toolFile=${psLiteral(file)};$toolArgs=@(${args.map(psLiteral).join(',')});& $toolFile @toolArgs; exit $LASTEXITCODE`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: refreshedWindowsEnv()
    });
    let out = '';
    const add = (d) => {
      out += d.toString('utf8');
      if (out.length > 16384) out = out.slice(-16384);
    };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, code: null, out, error: new Error('timeout') }); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, code: null, out, error }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
  });
}

function refreshedWindowsEnv() {
  const env = Object.assign({}, process.env);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const paths = [pathKey ? env[pathKey] : ''];
  for (const root of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    const r = spawnSync('reg.exe', ['query', root, '/v', 'Path'], { windowsHide: true, encoding: 'utf8' });
    const m = /Path\s+REG_(EXPAND_)?SZ\s+(.+)/i.exec(r.stdout || '');
    if (m && m[2]) paths.push(m[1] ? expandWindowsVars(m[2].trim(), env) : m[2].trim());
  }
  // npm's Windows global bin is normally %APPDATA%\\npm. It is not always in
  // a running Electron process' PATH immediately after `npm install -g`.
  const appData = env.APPDATA || env.AppData || '';
  if (appData) paths.push(path.join(appData, 'npm'));
  const seen = new Set();
  const mergedPath = paths.join(';').split(';').map((x) => x.trim()).filter((x) => {
    const key = x.replace(/[\\/]+$/, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(';');
  // Windows environment keys are case-insensitive. Leaving both PATH and Path
  // lets child-process resolution choose an arbitrary stale value.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = mergedPath;
  return env;
}

function expandWindowsVars(value, env) {
  return value.replace(/%([^%]+)%/g, (_m, key) => env[key] ?? env[key.toUpperCase()] ?? _m);
}

function validWindowsVersion(value) {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || '').trim());
}

async function windowsVersion(file) {
  if (!file) return '';
  const r = await windowsTool(file, ['--version']);
  if (!r.ok || /(?:^|\n)npm ERR!|\berror\b/i.test(r.out)) return '';
  const values = r.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = values.length - 1; i >= 0; i--) {
    const exact = values[i];
    if (validWindowsVersion(exact)) return exact;
    const match = /(?:^|\s)(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(exact);
    if (match) return match[1];
  }
  return '';
}

async function windowsNpmPrefix(npmPath) {
  if (!npmPath) return '';
  const r = await windowsTool(npmPath, ['config', 'get', 'prefix']);
  if (!r.ok || /(?:^|\n)npm ERR!|\berror\b/i.test(r.out)) return '';
  const value = r.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
  // npm prints an absolute Windows directory here; reject diagnostics and
  // relative values before turning it into an executable path.
  return path.isAbsolute(value) ? value : '';
}

async function windowsProbe(ep = null) {
  const nodePath = await windowsWhere('node.exe');
  const npmPath = await windowsWhere('npm.cmd');
  const configuredDsh = ep && ep.dshBin && ep.dshBin !== 'dsh' ? ep.dshBin : null;
  const node = await windowsVersion(nodePath);
  const npm = await windowsVersion(npmPath);
  const npmPrefix = npm ? await windowsNpmPrefix(npmPath) : '';
  const candidates = [
    configuredDsh,
    await windowsWhere('dsh.cmd'),
    await windowsWhere('dsh.exe'),
    npmPrefix ? path.join(npmPrefix, 'dsh.cmd') : null,
    npmPrefix ? path.join(npmPrefix, 'dsh.exe') : null
  ].filter(Boolean);
  let dshPath = '';
  let dshVersion = '';
  for (const candidate of candidates) {
    const version = await windowsVersion(candidate);
    if (version) { dshPath = candidate; dshVersion = version; break; }
  }
  return {
    node: node || '', npm: npm || '', nodePath, npmPath,
    dshPath, dshVersion, npmPrefix
  };
}

let windowsProbeSeq = 0;
let windowsProbeInFlight = null;
let windowsInstallInFlight = false;
let windowsStartInFlight = false;
let windowsAuthInFlight = false;

function isWindowsBusy() {
  return !!(windowsProbeInFlight || windowsInstallInFlight || windowsStartInFlight || windowsAuthInFlight);
}

async function detectWindowsEndpoint(kind) {
  if (process.platform !== 'win32') return;
  const ep = getEndpoint('local'); if (!ep) return;
  if (isWindowsBusy()) return windowsProbeInFlight || Promise.resolve();
  const seq = ++windowsProbeSeq;
  const originalDetail = ep._windowsOriginalDetail || ep.detail;
  const originalStatus = ep.status;
  ep.status = 'starting'; ep.detail = '正在检测 Windows Node.js、npm 与 DSH…';
  windowsProbeInFlight = Promise.resolve().then(async () => {
  try {
    const info = await windowsProbe(ep);
    if (seq !== windowsProbeSeq) return;
    ep.windows = info;
    // A recheck is informational: never turn an established connection into
    // "unknown", and never discard the startup error that opened this guide.
    ep.status = originalStatus === 'online' || originalStatus === 'error' ? originalStatus : 'unknown';
    ep.detail = originalDetail;
    delete ep._windowsOriginalDetail;
    pushWindowsStatus(ep, kind);
    // Keep the router instance alive: it owns the selected setup step and
    // expanded manual-install panels. The status IPC below updates it in place.
  } catch (err) {
    if (seq !== windowsProbeSeq) return;
    ep.status = 'error'; ep.detail = `Windows 环境检测失败：${err.message || err}`;
    pushWindowsStatus(ep, kind);
  } finally {
    windowsProbeInFlight = null;
    delete ep._windowsDetecting;
    // The earlier state push intentionally carried busy:true. Notify the
    // router once more after releasing the lock so its actions re-enable.
    if (seq === windowsProbeSeq) pushWindowsStatus(ep, kind);
  }
  });
  // Set the shared lock before broadcasting the temporary busy state so a
  // fast renderer click cannot start a competing install or connection.
  pushWindowsStatus(ep, kind);
  return windowsProbeInFlight;
}

function pushWindowsStatus(ep, kind = 'manual') {
  if (appState.view !== 'web' || appState.currentPage !== 'local') return;
  const v = appState.views.local;
  if (!v || v.webContents.isDestroyed()) return;
  const w = ep.windows || {};
  v.webContents.send('windows:status', { kind, status: ep.status, detail: ep.detail || '', node: w.node || '', npm: w.npm || '', dshPath: w.dshPath || '', dshVersion: w.dshVersion || '', port: String(ep.port), busy: isWindowsBusy(), authRequired: ep._windowsAuthRequired === true });
}

function pushWindowsInstallProgress(step, payload = {}) {
  if (appState.view !== 'web' || appState.currentPage !== 'local') return;
  const v = appState.views.local;
  if (v && !v.webContents.isDestroyed()) v.webContents.send('windows:install-progress', Object.assign({ step, busy: isWindowsBusy() }, payload));
}

/**
 * Switch to an endpoint's PAGE (the in-shell router). The page owns its
 * components: 加载中 / 加载失败 / 主内容(后端). Rules:
 *   1. Click → enter the router page IMMEDIATELY (loading component)
 *   2. Backend connects in parallel
 *   3. Success → update global state (ep.status = online)
 *   4. Success + still on this route → jump to the backend
 *   5. Success + already switched away → state only, no navigation
 *   6. Next visit to an already-connected route → jump straight to the
 *      backend (skip the router page)
 */
function connectEndpoint(id) {
  const ep = getEndpoint(id);
  if (ep === null || ep === undefined) return Promise.resolve();
  if (ep._pendingConnect) {
    // The work is shared, but an explicit second click must still bring its
    // in-progress route back after the user visited Pure/another endpoint.
    appState.activeEndpoint = ep.id;
    appState.view = 'web';
    appState.currentPage = ep.id;
    appState.displayEndpoint = ep.id;
    getEndpointView(ep.id);
    layout();
    refreshDshMenu();
    setStatus({});
    return ep._pendingConnect;
  }
  const pending = connectEndpointAttempt(id);
  ep._pendingConnect = pending;
  const cleanup = () => {
    if (ep._pendingConnect === pending) ep._pendingConnect = null;
  };
  pending.then(cleanup, cleanup);
  return pending;
}

function isCurrentEndpointAttempt(ep, sequence) {
  return getEndpoint(ep.id) === ep && ep._connectSequence === sequence;
}

async function connectEndpointAttempt(id) {
  const cfg = appState.cfg;
  if (cfg === null) return;
  const ep = getEndpoint(id);
  if (ep === null) return;
  const sequence = (ep._connectSequence || 0) + 1;
  ep._connectSequence = sequence;
  // A new click supersedes any pending endpoint connection and its overlay.
  hideStartupOverlay();
  appState.activeEndpoint = ep.id;
  appState.view = 'web';
  appState.currentPage = ep.id;
  refreshDshMenu();

  // Same harness INSTANCE already on screen (the endpoint's target address
  // resolves to the host we are displaying, whether or not it is "the same
  // endpoint") → instant switch: zero re-navigation, session untouched.
  let targetHost = null;
  try {
    const target =
      ep.kind === 'custom'
        ? customRuntimeUrl(ep)
        : ep.urlOverride || `http://127.0.0.1:${ep.port}`;
    if (target) targetHost = new URL(target).host;
  } catch {
    /* unparseable target → no shortcut */
  }
  if (appState.url !== null && targetHost !== null) {
    let curHost = null;
    try {
      curHost = new URL(appState.url).host;
    } catch {
      /* ignore */
    }
    if (
      curHost === targetHost &&
      (ep.childAlive || (await probeEndpointUrl(ep, appState.url, { assumeHarness: true })) === 'harness')
    ) {
      if (!isCurrentEndpointAttempt(ep, sequence)) return;
      const currentLocalToken = ep.kind === 'local' && (() => {
        try { return new URL(appState.url).searchParams.has('token'); } catch { return false; }
      })();
      ep.authUrl = currentLocalToken ? appState.url : null;
      ep.url = ep.kind === 'custom' || currentLocalToken ? stripTokenUrl(appState.url) : appState.url;
      ep.status = 'online';
      ep.wasOnline = true;
      ep.detail = '';
      if (appState.displayEndpoint === null || appState.displayEndpoint === ep.id) {
        appState.displayEndpoint = ep.id;
        appState.url = ep.kind === 'custom' ? customRuntimeUrl(ep) : ep.url;
      }
      showWebOnly();
      pushPureInfo();
      return;
    }
  }

  // Already showing THIS endpoint (its own recorded URL) and it answers →
  // keep the session as-is.
  if (appState.displayEndpoint === ep.id && appState.url !== null) {
    const reachable =
      ep.childAlive || (await probeEndpointUrl(ep, appState.url, { assumeHarness: true })) === 'harness';
    if (reachable) {
      if (!isCurrentEndpointAttempt(ep, sequence)) return;
      ep.status = 'online';
      ep.wasOnline = true;
      ep.detail = '';
      showWebOnly();
      pushPureInfo();
      return;
    }
  }

  // ⑥ Backend already connected → jump straight to the backend (skip router).
  if (ep.status === 'online' && ep.url !== null) {
    getEndpointView(ep.id); // ensure the view exists
    const endpointUrl = ep.kind === 'custom' ? customRuntimeUrl(ep) : ep.url;
    appState.url = endpointUrl;
    appState.displayEndpoint = ep.id;
    layout(); // webView is now this endpoint's own view
    // If this view is ALREADY showing the same backend (same origin), bring it
    // on-screen as-is — do NOT re-navigate, so its session/state is preserved.
    // (First visit / still on the router page / blank → sameOrigin false → we
    //  do loadWeb.)
    const wc =
      webView !== null && !webView.webContents.isDestroyed() ? webView.webContents : null;
    if (wc === null || !sameOrigin(wc.getURL(), endpointUrl)) {
      loadWeb(endpointUrl);
    }
    setStatus({});
    pushPureInfo();
    refreshDshMenu();
    return;
  }

  // ① Enter the ROUTER page immediately (in-shell, loading component).
  //    The backend connects in parallel; on success we jump to the real
  //    dsh web URL, on failure the router shows the error component.
  //    WSL: the router page's 加载中 runs the FIRST detection, which lands
  //    the three-step guide on the stuck step when it finishes.
  getEndpointView(ep.id); // ensure the view exists
  ep.status = 'starting';
  ep.detail = '';
  appState.displayEndpoint = ep.id;
  appState.url = null; // showing the router page, not a backend
  layout();
  showStartupOverlay(ep, sequence, 'checking', '正在检查 DSH 服务…');
  if (ep.kind === 'wsl') {
    loadWeb(wslRouterUrl(ep));
    detectWslEndpoint('first').catch(() => {});
  } else {
    loadWeb(routerUrl(ep.id, 'starting', ep.name));
  }
  pushPureInfo();
  setStatus({});

  // --- Connect in the background --------------------------------
  try {
    let url;
    let child = null;
    let tokenAuth = false;
    let recoveryIdentity = null;
    if (ep.kind === 'custom') {
      if (ep.tokenError) {
        throw new Error('保存的认证凭据无法读取，请重新输入 token 后重试');
      }
      pushStartupProgress(ep, sequence, 'checking', '正在检测远程 DSH 服务…');
      // View-only: the remote dsh web must already be running (and must have
      // been told to trust our host via --trusted-host).
      const remoteUrl = customRuntimeUrl(ep);
      if (!remoteUrl) throw new Error('未设置地址');
      const st = await probeEndpointUrl(ep, remoteUrl, { assumeHarness: true });
      if (st !== 'harness') {
        throw new Error(
          '无法连接该远程地址。请确认远端 dsh web 正在运行，且启动时通过 --trusted-host 声明了本端访问的主机'
        );
      }
      url = remoteUrl;
    } else if (ep.kind === 'wsl') {
      pushStartupProgress(ep, sequence, 'starting', '正在检测并启动 WSL 的 DSH…');
      ({ url, child } = await resolveWslServer(
        cfg, ep, (phase, detail) => pushStartupProgress(ep, sequence, phase, detail)
      ));
    } else {
      pushStartupProgress(ep, sequence, 'checking', '正在检测本机 DSH 与认证状态…');
      if (cfg.urlOverride !== undefined && ep.id === 'local' && appState.url === null) {
        // Explicit --url=/DSH_DESKTOP_URL at launch: no spawn, load it directly.
        url = cfg.urlOverride;
      } else {
        ({ url, child, tokenAuth, recoveryIdentity } = await resolveServerFor(
          cfg, ep, (phase, detail) => pushStartupProgress(ep, sequence, phase, detail)
        ));
      }
    }
    if (!isCurrentEndpointAttempt(ep, sequence)) return;
    const localTokenUrl = ep.kind === 'local' && (() => {
      try { return new URL(url).searchParams.has('token'); } catch { return false; }
    })();
    ep.authUrl = localTokenUrl ? url : null;
    ep.url = ep.kind === 'custom' || localTokenUrl ? stripTokenUrl(url) : url;
    ep.child = child;
    ep.childAlive = child !== null;
    ep.recoveryIdentity = recoveryIdentity || null;
    ep.tokenAuth = tokenAuth || (ep.kind === 'custom' && Boolean(ep.token));
    ep.status = 'online';
    if (ep.kind === 'local') ep._windowsAuthRequired = false;
    ep.wasOnline = true;
    ep.detail = '';
    if (child !== null) bindChildExit(child, ep);
    // The user may have switched away while this was running (e.g. test →
    // Windows): then the result only updates the endpoint's STATE (dot /
    // detail) — it must NOT take over the view.
    const current = appState.currentPage === ep.id;
    if (current) {
      const renav = url !== appState.url; // entered on a different/blank page?
      appState.url = url;
      appState.child = child;
      appState.childAlive = child !== null;
      appState.displayEndpoint = ep.id;
      if (renav) {
        pushStartupProgress(ep, sequence, 'loading', 'DSH 已就绪，正在加载网页…');
        loadStartupPage(ep, sequence, url);
      } else {
        hideStartupOverlay(ep.id, sequence);
      }
      setStatus({});
    }
    if (cfg.verbose) {
      console.log(
        `[DSH Desktop Pure] web view -> ${redactTokenUrls(url)} (${ep.name}${child === null ? ', reused' : ', spawned'})`
      );
    }
  } catch (err) {
    if (!isCurrentEndpointAttempt(ep, sequence)) return;
    // 加载失败组件 (router page, red dot) — but ONLY when the user is still
    // on this page; a stale failure must never yank the view away.
    ep.status = 'error';
    ep.detail = err.message;
    ep._windowsAuthRequired = process.platform === 'win32' && ep.kind === 'local' && err.code === 'auth_required';
    if (appState.currentPage === ep.id) {
      hideStartupOverlay(ep.id, sequence);
      appState.url = null;
      appState.child = null;
      appState.childAlive = false;
      appState.displayEndpoint = ep.id;
      layout();
      // WSL shows the setup-guide page (land on the stuck step); others show
      // the generic error page.
      if (process.platform === 'win32' && ep.kind === 'local') {
        ep._windowsOriginalDetail = err.message || 'DSH 启动失败';
        ep._windowsDetecting = true;
        loadWeb(windowsRouterUrl(ep));
        detectWindowsEndpoint('first').catch(() => {});
      } else {
        loadWeb(ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(ep.id, 'error', ep.name, err.message));
      }
      setStatus({ reason: `无法连接「${ep.name}」：${err.message}` });
    }
    return;
  } finally {
    pushPureInfo();
    setStatus({}); // re-broadcast the CURRENT page's state (may have changed)
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
  if (tray !== null) refreshTrayMenu();
  if (process.platform === 'darwin') buildAppMenu();
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
  const wsl = getEndpoint('wsl');
  const wslAvailable = Boolean(wsl && wsl.wsl && wsl.wsl.installed === true);
  return {
    version: app.getVersion(),
    themeSource: nativeTheme.themeSource,
    port: cfg ? cfg.port : DEFAULT_PORT,
    dshBin: cfg ? cfg.dshBin : 'dsh',
    layout: appState.layout,
    url: stripTokenUrl(appState.url),
    view: appState.view,
    status: Object.assign({}, currentStatus, { url: stripTokenUrl(currentStatus && currentStatus.url) }),
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    // DSH Web multi-endpoint state (tab bar + detail rows on the Pure page).
    endpoints: appState.endpoints.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      url: stripTokenUrl(e.url) || null,
      status: e.status,
      detail: e.detail || '',
      // Per-endpoint settings (for the 编辑 form).
      port: e.port != null ? e.port : null,
      dsh: e.kind === 'local' ? e.dshBin : null,
      dshOverride: e.kind === 'wsl' ? e.dshOverride || null : null,
      urlOverride: e.kind === 'local' || e.kind === 'wsl' ? e.urlOverride || null : null,
      wslIp: e.kind === 'wsl' && e.wsl ? e.wsl.ip : null,
      wslDsh: e.kind === 'wsl' && e.wsl ? e.wsl.dshBin : null
      , hasToken: e.kind === 'custom' ? Boolean(e.token || e.encryptedToken) : false
    })),
    activeEndpoint: appState.activeEndpoint,
    displayEndpoint: appState.displayEndpoint,
    startup: {
      page: startupPagePreference,
      prompt: startupPromptActive,
      wslAvailable,
      detecting: Boolean(wsl && wsl._wslDetectInFlight)
    },
    releaseUpdate: releaseUpdateSnapshot()
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
  refreshTrayMenu();
  // Left-click reveals the window (Windows/Linux); on macOS the menu takes over.
  tray.on('click', () => showWindow());
}

function refreshTrayMenu() {
  if (tray === null) return;
  const ep = currentPageEndpoint();
  const suffix = ep ? ` (${ep.name})` : '';
  const enabled = canSafelyOperatePageServer(ep);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开窗口', click: () => showWindow() },
    { label: `重启 dsh 服务器${suffix}`, enabled, click: () => restartCurrentPageServer() },
    { label: `关闭 dsh 服务器${suffix}`, enabled, click: () => stopCurrentPageServer() },
    { type: 'separator' },
    { label: '退出', click: () => reallyQuit() }
  ]));
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

/** The endpoint actually represented by the visible page, never the selected tab. */
function currentPageEndpoint() {
  if (appState.currentPage === 'pure' || typeof appState.currentPage !== 'string') return null;
  return getEndpoint(appState.currentPage);
}

function pageEndpointRuntimeUrl(ep) {
  if (ep === null) return null;
  if (ep.kind === 'custom') return customRuntimeUrl(ep) || null;
  return ep.authUrl || ep.url || null;
}

// The shell menu must never acquire the older restart flow's authority to kill
// a reused listener. A tracked child is owned; a Windows recovery identity is
// only a candidate and is re-verified asynchronously before any stop.
function canSafelyOperatePageServer(ep) {
  return Boolean(ep && ep.kind !== 'custom' &&
    !ep._stopping && !restarting &&
    ((ep.child && ep.childAlive) || isReusedWindowsAuthEndpoint(ep)));
}

/** The three menus' items (labels, accelerators, enabled / radio state). */
function menuItems() {
  const src = nativeTheme.themeSource;
  const pageEndpoint = currentPageEndpoint();
  const pageSuffix = pageEndpoint ? ` (${pageEndpoint.name})` : '';
  const pageUrl = pageEndpointRuntimeUrl(pageEndpoint);
  const canOperateServer = canSafelyOperatePageServer(pageEndpoint);
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
      {
        id: 'view-pure',
        label: '桌面端配置',
        type: 'status',
        status: 'pure',
        active: appState.view === 'pure'
      }
    ],
    file: [
      { id: 'reload', label: '重新加载', accelerator: accText('CmdOrCtrl+R'), enabled: true },
      { id: 'reload-cache', label: '强制重新加载', accelerator: accText('CmdOrCtrl+Shift+R'), enabled: true },
      { type: 'separator' },
      { id: 'open-external', label: `在系统浏览器中打开${pageSuffix}`, enabled: pageUrl !== null },
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
      { id: 'restart-current', label: `重启 dsh 服务器${pageSuffix}`, enabled: canOperateServer },
      { id: 'stop-current', label: `关闭 dsh 服务器${pageSuffix}`, enabled: canOperateServer }
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
    const url = pageEndpointRuntimeUrl(currentPageEndpoint());
    if (url !== null) openExternalSafely(url);
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
  'restart-current': () => restartCurrentPageServer(),
  'stop-current': () => stopCurrentPageServer()
};

/** Shadow margin: the view extends this far left/right/below the box. */
const MENU_SHADOW = 6;

/** Open (or switch to) a menu, docked directly beneath its button. */
function openMenuAt(name, relLeft) {
  if (win === null || menuView === null) return;
  if (!['dsh', 'file', 'view', 'server'].includes(name)) return;
  // Ensure menuView is on top of all other views (z-order).
  win.contentView.removeChildView(menuView);
  win.contentView.addChildView(menuView);
  const items = menuItems()[name];
  const height = menuHeight(items);
  const [cw, ch] = win.getContentSize();
  let x = Math.round(Number(relLeft) || 0);
  if (x + MENU_WIDTH > cw) x = Math.max(0, cw - MENU_WIDTH); // keep within the window
  // The view extends MENU_SHADOW beyond the box to the left/right and below
  // (not above — the top shadow would be hidden by the title bar anyway,
  // and the view must not overlap it) so the drop shadow is not clipped.
  // The box sits 12px right inside the view, flush with its top.
  menuView.setBounds({
    x: x - MENU_SHADOW,
    y: TITLEBAR_HEIGHT,
    width: MENU_WIDTH + MENU_SHADOW * 2,
    height: height + MENU_SHADOW
  });
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
  const ep = currentPageEndpoint();
  const suffix = ep ? ` (${ep.name})` : '';
  const serverEnabled = canSafelyOperatePageServer(ep);
  const browserUrl = pageEndpointRuntimeUrl(ep);
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
    label: '文件',
    submenu: [{ label: `在系统浏览器中打开${suffix}`, enabled: browserUrl !== null, click: () => menuActions['open-external']() }]
  });
  template.push({
    label: '服务器',
    submenu: [
      { label: `重启 dsh 服务器${suffix}`, enabled: serverEnabled, click: () => menuActions['restart-current']() },
      { label: `关闭 dsh 服务器${suffix}`, enabled: serverEnabled, click: () => menuActions['stop-current']() }
    ]
  });
  if (isMac) {
    template.push({ label: '窗口', role: 'windowMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Title bar + menu IPC
// ---------------------------------------------------------------------------

ipcMain.on('menu:toggle', (event, name, relLeft) => {
  if (!isTitlebarSender(event)) return;
  if (win === null) return;
  if (openMenu === name) closeMenu();
  else openMenuAt(name, relLeft);
});

ipcMain.on('menu:hover', (event, name, relLeft) => {
  if (!isTitlebarSender(event)) return;
  if (win === null) return;
  // Switch only while a menu is already open (hover does not open a menu).
  if (openMenu !== null && openMenu !== name) openMenuAt(name, relLeft);
});

ipcMain.on('menu:close', (event) => {
  if (isTitlebarSender(event) || isMenuSender(event)) closeMenu();
});

function isTitlebarSender(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  if (titlebarView === null || titlebarView.webContents.isDestroyed() || event.sender !== titlebarView.webContents) return false;
  return event.sender.getURL() === pathToFileURL(path.join(__dirname, 'titlebar.html')).href;
}

ipcMain.on('titlebar:status-hitbox', (event, rawRect) => {
  if (!isTitlebarSender(event) || !rawRect || typeof rawRect !== 'object') return;
  const rect = {
    x: Number(rawRect.x), y: Number(rawRect.y),
    width: Number(rawRect.width), height: Number(rawRect.height)
  };
  const bounds = titlebarView.getBounds();
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height) return;
  titlebarStatusHitbox = rect;
  pollTitlebarStatusHover();
});

/** Titlebar's update affordance can only reveal an already-confirmed update. */
ipcMain.on('titlebar:open-update-about', (event) => {
  if (!isTitlebarSender(event) || !releaseUpdateState.result || releaseUpdateState.result.ok !== true || releaseUpdateState.result.updateAvailable !== true) return;
  pendingPureSection = 'about';
  enterPureView();
  flushPendingPureSection();
});

function isMenuSender(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  if (menuView === null || menuView.webContents.isDestroyed() || event.sender !== menuView.webContents) return false;
  return event.sender.getURL() === pathToFileURL(path.join(__dirname, 'menu.html')).href;
}

ipcMain.on('menu:action', (event, id) => {
  if (!isMenuSender(event)) return;
  closeMenu();
  // Endpoint entries (页面 menu): open that endpoint's dsh web — reveal the
  // existing session if it's already showing & reachable, otherwise connect
  // (reusing a running dsh web, or starting one for local / WSL).
  if (typeof id === 'string' && id.startsWith('endpoint-')) {
    connectEndpoint(id.slice('endpoint-'.length)).catch(e => console.error('[menu] connectEndpoint error:', e));
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

function isPureSender(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  if (pureView === null || pureView.webContents.isDestroyed() || event.sender !== pureView.webContents) return false;
  try {
    const actual = new URL(event.sender.getURL());
    const expected = pathToFileURL(path.join(__dirname, 'pure.html'));
    return actual.protocol === 'file:' && actual.pathname === expected.pathname && actual.host === '';
  } catch {
    return false;
  }
}

function wslStartupAvailable() {
  const ep = getEndpoint('wsl');
  // A WSL distribution is selectable even when its Node/DSH setup needs the
  // existing guide; availability here must not require DSH itself.
  return Boolean(ep && ep.wsl && ep.wsl.installed === true);
}

async function runStartupPreference() {
  if (startupFlowStarted) return;
  startupFlowStarted = true;
  const generation = ++startupFlowGeneration;
  const page = startupPagePreference;
  const probeWslInBackground = () => {
    if (process.platform === 'win32' && getEndpoint('wsl') !== null) {
      detectWslEndpoint('first').catch(() => {});
    }
  };
  if (page === 'pure') {
    probeWslInBackground();
    return;
  }
  if (page === 'local') {
    probeWslInBackground();
    connectEndpoint('local').catch(() => {});
    return;
  }
  if (process.platform !== 'win32' || getEndpoint('wsl') === null) {
    if (page === 'wsl') enterPureView('无法检测 WSL；已保留启动偏好');
    else connectEndpoint('local').catch(() => {});
    return;
  }
  // WSL preference and the first-run chooser both wait for an actual probe
  // result. A failed/superseded probe is unknown, never evidence of absence.
  pushPureInfo();
  const info = await detectWslEndpoint('first');
  if (generation !== startupFlowGeneration || page !== startupPagePreference) return;
  if (info === null) {
    if (page === 'wsl') enterPureView('WSL 状态尚未确定；已保留启动偏好');
    else connectEndpoint('local').catch(() => {});
    pushPureInfo();
    return;
  }
  if (wslStartupAvailable()) {
    if (page === 'wsl') {
      connectEndpoint('wsl').catch(() => {});
    } else {
      startupPromptActive = true;
      enterPureView('请选择本次默认展示的 DSH 页面');
      pushPureInfo();
    }
    return;
  }
  if (page === 'wsl') {
    enterPureView('WSL 当前不可用；已保留启动偏好');
  } else if (info.installed === false) {
    // No WSL is a valid local fallback, but deliberately remains unsaved so a
    // future WSL installation can still trigger the chooser.
    connectEndpoint('local').catch(() => {});
  } else {
    // Unknown is not proof that WSL is missing. Use the historical local page
    // for this run only; do not write a default or suppress a future chooser.
    connectEndpoint('local').catch(() => {});
  }
  pushPureInfo();
}

/** Snapshot of state for the Pure page (handled so the renderer can await). */
ipcMain.handle('pure:get-info', () => buildPureInfo());

ipcMain.handle('pure:set-startup-page', (event, page) => {
  if (!isPureSender(event) || !STARTUP_PAGES.has(page)) return { ok: false, error: 'unavailable' };
  if (page === 'wsl' && !wslStartupAvailable()) return { ok: false, error: 'WSL 当前不可用' };
  const result = saveStartupPagePreference(page);
  if (result.ok) {
    startupFlowGeneration += 1;
    startupPromptActive = false;
    pushPureInfo();
  }
  return result;
});

ipcMain.handle('pure:choose-startup-page', (event, page) => {
  if (!isPureSender(event) || !startupPromptActive || (page !== 'local' && page !== 'wsl' && page !== null)) {
    return { ok: false, error: 'unavailable' };
  }
  if (page === null) {
    startupPromptActive = false;
    pushPureInfo();
    // "暂不选择" means no persistence, not no launch: keep the historical
    // Windows-local default for this run and ask again next time.
    connectEndpoint('local').catch(() => {});
    return { ok: true };
  }
  if (page === 'wsl' && !wslStartupAvailable()) return { ok: false, error: 'WSL 当前不可用' };
  const result = saveStartupPagePreference(page);
  if (!result.ok) return result;
  startupPromptActive = false;
  startupFlowGeneration += 1;
  pushPureInfo();
  connectEndpoint(page).catch(() => {});
  return { ok: true };
});

/** Fetch the selected repository changelog; language is fixed to zh/en only. */
ipcMain.handle('pure:get-changelog', (event, language, options) => {
  if (!isPureSender(event)) return { ok: false, error: 'unavailable' };
  return fetchChangelog(language === 'en' ? 'en' : 'zh', {
    cacheDir: path.join(app.getPath('userData'), 'changelog-cache'),
    cachedOnly: Boolean(options && options.cachedOnly === true)
  });
});

async function refreshReleaseUpdate() {
  if (releaseCheckInFlight !== null) return releaseCheckInFlight;
  // A new verification revokes the old browser-open authorization immediately.
  verifiedReleaseAssets = new Map();
  releaseUpdateState.checking = true;
  releaseUpdateState.result = null;
  publishReleaseUpdate();
  const request = checkLatestRelease(app.getVersion()).then((result) => {
    verifiedReleaseAssets = result.ok && result.updateAvailable === true && result.assetUrls instanceof Map ? result.assetUrls : new Map();
    releaseUpdateState.checking = false;
    releaseUpdateState.result = releaseUpdatePublicResult(result);
    publishReleaseUpdate();
    return result;
  }, () => {
    verifiedReleaseAssets = new Map();
    const result = { ok: false, currentVersion: app.getVersion(), latestVersion: null, updateAvailable: false, status: 'none', releaseUrl: 'https://github.com/WJBFks/dsh-desktop-pure/releases', assets: [], error: 'offline' };
    releaseUpdateState.checking = false;
    releaseUpdateState.result = result;
    publishReleaseUpdate();
    return result;
  });
  releaseCheckInFlight = request;
  request.then(() => { releaseCheckInFlight = null; }, () => { releaseCheckInFlight = null; });
  return request;
}

function releaseUpdatePublicResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    currentVersion: typeof result.currentVersion === 'string' ? result.currentVersion : '',
    latestVersion: typeof result.latestVersion === 'string' ? result.latestVersion : null,
    updateAvailable: result.updateAvailable === true,
    status: ['update', 'current', 'ahead', 'none'].includes(result.status) ? result.status : 'none',
    releaseUrl: typeof result.releaseUrl === 'string' ? result.releaseUrl : 'https://github.com/WJBFks/dsh-desktop-pure/releases',
    assets: Array.isArray(result.assets) ? result.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size })) : [],
    ...(typeof result.error === 'string' ? { error: result.error } : {})
  };
}

function releaseUpdateSnapshot() {
  return { revision: releaseUpdateRevision, checking: releaseUpdateState.checking === true, result: releaseUpdateState.result ? releaseUpdatePublicResult(releaseUpdateState.result) : null };
}

function publishReleaseUpdate() {
  releaseUpdateRevision += 1;
  const snapshot = releaseUpdateSnapshot();
  if (titlebarView !== null && !titlebarView.webContents.isDestroyed()) titlebarView.webContents.send('titlebar:release-update', snapshot);
  if (pureView !== null && !pureView.webContents.isDestroyed()) pureView.webContents.send('pure:release-update', snapshot);
  pushPureInfo();
}

function startAutomaticReleaseUpdate() {
  if (releaseAutoRefreshStarted) return;
  releaseAutoRefreshStarted = true;
  Promise.resolve().then(() => refreshReleaseUpdate()).catch(() => {});
}

function flushPendingPureSection() {
  if (pendingPureSection === null || pureView === null || pureView.webContents.isDestroyed()) return;
  // file:// can still be loading when a titlebar click switches into Pure;
  // keep the request for its did-finish-load replay instead of losing it.
  if (typeof pureView.webContents.isLoadingMainFrame === 'function' && pureView.webContents.isLoadingMainFrame()) return;
  pureView.webContents.send('pure:show-section', pendingPureSection);
  pendingPureSection = null;
}

/** Explicit About-page check. Assets contain metadata only; no download URL crosses IPC. */
ipcMain.handle('pure:check-update', (event) => {
  if (!isPureSender(event)) return { ok: false, error: 'unavailable' };
  return refreshReleaseUpdate();
});

/** Open only a URL validated from this process's most recent GitHub response. */
ipcMain.handle('pure:download-update', async (event, assetId) => {
  if (!isPureSender(event) || !Number.isSafeInteger(assetId)) return { ok: false, error: 'unavailable' };
  const url = verifiedReleaseAssets.get(assetId);
  if (!url) return { ok: false, error: 'unavailable' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch {
    return { ok: false, error: '无法打开下载器；请在 Release 页面手动下载。' };
  }
});

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
ipcMain.on('pure:restart', (event, id) => {
  if (!isPureSender(event)) return;
  restartServer(
    typeof id === 'string' && id !== ''
      ? id
      : appState.displayEndpoint || appState.activeEndpoint
  );
});

/**
 * WSL setup-guide page → 「重新检测」(manual re-detection; the step MAY
 * re-land on the stuck step). The guide page itself stays in place: the
 * 加载中 component is already showing, and the page refreshes when the
 * detection finishes (inside detectWslEndpoint('manual')).
 */
ipcMain.on('router:wsl-recheck', () => {
  const ep = getEndpoint('wsl');
  if (ep === null) return;
  // The user explicitly asked for a fresh check — reset the auto-retry timer;
  // a newer probe generation supersedes any background auto-detect in flight
  // (its stale result is discarded inside detectWslEndpoint).
  ep._wslRetryAt = Date.now();
  detectWslEndpoint('manual').catch(() => {});
});

/** WSL setup-guide page → (re)connect the WSL endpoint. */
ipcMain.on('router:wsl-retry', () => {
  connectEndpoint('wsl').catch(() => {});
});

/**
 * WSL setup-guide page → one-click install dsh inside the distro. Runs in an
 * interactive shell (so nvm's PATH is loaded), then re-probes and refreshes
 * the guide. Fire-and-forget; the page updates when the probe lands.
 */
ipcMain.on('router:wsl-install-dsh', () => {
  const ep = getEndpoint('wsl');
  if (!ep || !ep.wsl || ep.wsl.installed !== true || ep.wsl.error) return;
  const cmd = [
    'export npm_config_prefix="$HOME/.local/share/.npm-global"',
    'mkdir -p "$npm_config_prefix/bin" "$npm_config_prefix/lib/node_modules"',
    'npm install -g @deepseek-ai/dsh --loglevel=verbose 2>&1 | tee "$HOME/dsh-install-dsh.log"; exit ${PIPESTATUS[0]}'
  ].join('; ');
  const child = spawn(wslExecutable(), wslDistroArgs(ep.wsl.distro, ['-e', 'bash', '-ic', cmd]), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  pushWslInstallProgress('install-dsh', { status: 'running', percent: null, detail: '正在执行 npm install -g @deepseek-ai/dsh…' });
  let tail = '';
  let lastPercent = null;
  const tick = (data, label) => {
    const text = data.toString('utf8');
    if (text) console.log(label, redactTokenUrls(text));
    tail += text;
    if (tail.length > 8192) tail = tail.slice(-8192);
    const p = parsePercent(tail);
    if (p !== null) lastPercent = p;
    pushWslInstallProgress('install-dsh', { status: 'running', percent: lastPercent, detail: lastMeaningfulLine(tail) || 'npm 正在安装…' });
  };
  child.stdout.on('data', (d) => tick(d, '[wsl-install-dsh]'));
  child.stderr.on('data', (d) => tick(d, '[wsl-install-dsh:err]'));
  child.on('error', (err) => pushWslInstallProgress('install-dsh', { status: 'error', detail: String((err && err.message) || err) }));
  child.on('close', () => {
    pushWslInstallProgress('install-dsh', { status: 'done', percent: 100 });
    detectWslEndpoint('manual').catch(() => {});
  });
});

/**
 * WSL setup-guide page → request Windows to install WSL. Requires UAC elevation
 * because `wsl --install` must run as administrator. The elevated PowerShell
 * window remains visible so the user can follow progress and complete reboot.
 */
const WSL_INSTALL_DISTROS = ['Ubuntu-24.04', 'Ubuntu-26.04', 'Ubuntu-22.04'];

ipcMain.on('router:wsl-install-wsl', (_event, rawDistro) => {
  const distro = WSL_INSTALL_DISTROS.includes(rawDistro) ? rawDistro : 'Ubuntu-24.04';
  const log = path.join(os.tmpdir(), 'dsh-wsl-install.log');
  try { fs.rmSync(log, { force: true }); } catch { /* best effort */ }
  const inner = 'wsl --install -d ' + distro + ' *> "' + log + '"';
  const ps = [
    '$ErrorActionPreference="Stop"',
    'try {',
    "  $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList @('-NoProfile','-Command','" + JSON.stringify(inner) + "') -PassThru",
    '  $p.WaitForExit()',
    '} catch { exit 1 }'
  ].join('; ');
  const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
  pushWslInstallProgress('install-wsl', { status: 'running', percent: null, detail: '正在请求 Windows 安装 WSL ' + distro + '…', distro });
  let lastLogLen = 0;
  const timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* file may not exist yet */ }
    if (text.length > lastLogLen) {
      const chunk = text.slice(lastLogLen);
      if (chunk) console.log('[wsl-install-wsl]', redactTokenUrls(chunk));
      lastLogLen = text.length;
    } else if (text.length < lastLogLen) {
      lastLogLen = text.length;
    }
    pushWslInstallProgress('install-wsl', { status: 'running', percent: parsePercent(text), detail: lastMeaningfulLine(text) || '正在等待 WSL ' + distro + ' 安装输出…', distro });
  }, 500);
  child.stdout.on('data', (d) => console.log('[wsl-install-wsl:wrapper]', redactTokenUrls(d.toString('utf8'))));
  child.stderr.on('data', (d) => console.log('[wsl-install-wsl:wrapper:err]', redactTokenUrls(d.toString('utf8'))));
  child.on('error', (err) => {
    clearInterval(timer);
    pushWslInstallProgress('install-wsl', { status: 'error', detail: String((err && err.message) || err), distro });
  });
  child.on('close', (code) => {
    clearInterval(timer);
    pushWslInstallProgress('install-wsl', { status: code === 0 ? 'done' : 'error', percent: code === 0 ? 100 : null, detail: code === 0 ? '' : 'WSL ' + distro + ' 安装未完成（可能被拒绝或需要重启）', distro });
    if (code === 0) detectWslEndpoint('manual').catch(() => {});
  });
});

/**
 * WSL setup-guide page → install Node.js inside the default WSL distribution.
 * Uses the distro root account where available, then re-probes manually so the
 * guide can move to the next step once Node appears.
 */
ipcMain.on('router:wsl-install-node', () => {
  const ep = getEndpoint('wsl');
  if (!ep || !ep.wsl || ep.wsl.installed !== true || ep.wsl.error) return;
  const script = [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; fi',
    '  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    '  apt-get install -y nodejs',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
    '  dnf install -y nodejs',
    'elif command -v yum >/dev/null 2>&1; then',
    '  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
    '  yum install -y nodejs',
    'elif command -v pacman >/dev/null 2>&1; then',
    '  pacman -Sy --noconfirm nodejs npm',
    'elif command -v zypper >/dev/null 2>&1; then',
    '  zypper refresh',
    '  zypper install -y nodejs nodejs-npm',
    'fi',
    'node --version && npm --version'
  ].join('\n');
  const child = spawn(wslExecutable(), wslDistroArgs(ep.wsl.distro, ['-u', 'root', '-e', 'bash', '-lc', script]), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let tail = '';
  let lastPercent = null;
  const onOutput = (label) => (data) => {
    const text = data.toString('utf8');
    if (text) console.log(label, redactTokenUrls(text));
    tail += text;
    if (tail.length > 8192) tail = tail.slice(-8192);
    const p = parsePercent(tail);
    if (p !== null) lastPercent = p;
    pushWslInstallProgress('install-node', { status: 'running', percent: lastPercent, detail: lastMeaningfulLine(tail) || '正在安装 Node.js…' });
  };
  pushWslInstallProgress('install-node', { status: 'running', percent: null, detail: '正在在 WSL 中安装 Node.js…' });
  child.stdout.on('data', onOutput('[wsl-install-node]'));
  child.stderr.on('data', onOutput('[wsl-install-node:err]'));
  child.on('error', (err) => pushWslInstallProgress('install-node', { status: 'error', detail: String((err && err.message) || err) }));
  child.on('close', () => {
    pushWslInstallProgress('install-node', { status: 'done', percent: 100 });
    detectWslEndpoint('manual').catch(() => {});
  });
});

function isLocalRouterSender(event) {
  if (process.platform !== 'win32') return false;
  return isRouterSender(event, 'local');
}

function isRouterSender(event, expectedId) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  if (appState.view !== 'web' || appState.currentPage !== expectedId) return false;
  const url = event.sender.getURL();
  const expected = pathToFileURL(path.join(__dirname, 'router.html')).href;
  return url.startsWith(expected + '?') && getEndpointView(expectedId).webContents === event.sender;
}

ipcMain.on('router:retry', (event) => {
  const id = appState.currentPage;
  if (typeof id !== 'string' || !isRouterSender(event, id)) return;
  connectEndpoint(id).catch(() => {});
});

function runWindowsInstall(step, file, args, detail) {
  // The IPC handler obtains the shared lock before its asynchronous `where`.
  // Keep this helper usable only while that lock is held.
  if (!windowsInstallInFlight) return;
  pushWindowsInstallProgress(step, { status: 'running', percent: null, detail });
  const psLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `$toolFile=${psLiteral(file)};$toolArgs=@(${args.map(psLiteral).join(',')});& $toolFile @toolArgs; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: refreshedWindowsEnv()
  });
  let tail = '';
  const onOutput = (d) => {
    tail += d.toString('utf8');
    if (tail.length > 8192) tail = tail.slice(-8192);
    pushWindowsInstallProgress(step, { status: 'running', percent: parsePercent(tail), detail: lastMeaningfulLine(tail) || detail });
  };
  child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
  let settled = false;
  const finishError = (message) => {
    if (settled) return;
    settled = true;
    windowsInstallInFlight = false;
    pushWindowsInstallProgress(step, { status: 'error', detail: message });
  };
  child.on('error', (error) => finishError(error.message || String(error)));
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    windowsInstallInFlight = false;
    if (code !== 0) {
      pushWindowsInstallProgress(step, { status: 'error', detail: `${step === 'install-node' ? 'Node.js' : 'DSH'} 安装失败（退出码 ${code == null ? '未知' : code}）` });
      return;
    }
    pushWindowsInstallProgress(step, { status: 'done', percent: 100, detail: '安装完成，正在重新检测…' });
    detectWindowsEndpoint('manual').catch(() => {});
  });
}

ipcMain.on('router:windows-recheck', (event) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return;
  detectWindowsEndpoint('manual').catch(() => {});
});
ipcMain.on('router:windows-retry', (event) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return;
  windowsStartInFlight = true;
  connectEndpoint('local').catch(() => {}).finally(() => {
    windowsStartInFlight = false;
    // connectEndpoint catches its own startup failures. Its first-run probe
    // was deliberately blocked by the start lock, so run a fresh probe only
    // after release to populate the failure guide.
    const ep = getEndpoint('local');
    if (ep && ep.status === 'error') detectWindowsEndpoint('retry').catch(() => {});
  });
});

function windowsAuthUrl(raw, port) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || input.length > 4096) return { ok: false, error: '请输入完整认证 URL 或 token' };
  let url;
  if (/^https?:\/\//i.test(input)) {
    try { url = new URL(input); } catch { return { ok: false, error: '认证 URL 格式无效' }; }
    const local = url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]');
    const actualPort = Number(url.port || 80);
    if (!local || actualPort !== port || url.username || url.password || url.hash) return { ok: false, error: '认证 URL 必须指向当前本机 DSH 端口' };
  } else {
    if (/\s/.test(input)) return { ok: false, error: 'token 不能包含空白字符' };
    url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set('token', input);
  }
  const tokens = url.searchParams.getAll('token');
  if (tokens.length !== 1 || !tokens[0] || /\s/.test(tokens[0])) return { ok: false, error: '认证 URL 必须包含唯一的有效 token' };
  return { ok: true, url: url.toString() };
}

function isManualWindowsDshCommand(commandLine) {
  const command = String(commandLine || '');
  return /@deepseek-ai[\\/]dsh(?:[\\/\s]|$)/i.test(command) && /(?:^|\s)web(?:\s|$)/i.test(command);
}

async function verifyWindowsAuthRequiredListener(ep) {
  const port = ep.port != null ? ep.port : (appState.cfg && appState.cfg.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  const owner = await findPortOwnerAsync(port);
  if (!owner || !Number.isInteger(owner.pid)) return null;
  const identity = await windowsProcessIdentityAsync(owner.pid);
  if (!identity || !isManualWindowsDshCommand(identity.commandLine)) return null;
  const status = await probeWithGrace(`http://127.0.0.1:${port}`);
  if (status !== 'auth_required') return null;
  return { pid: owner.pid, creationTime: identity.creationTime, port };
}

async function startFreshWindowsLocal(ep) {
  // A retry/connect click can still be in flight while force-start finishes.
  // Supersede that shared work before reconnecting so it cannot take over the
  // released port or make connectEndpoint dedupe to the old attempt.
  ep._pendingConnect = null;
  ep._connectSequence = (ep._connectSequence || 0) + 1;
  ep._skipWindowsRecoveryOnce = true;
  ep.child = null;
  ep.childAlive = false;
  ep.url = null;
  ep.authUrl = null;
  ep.tokenAuth = false;
  ep._windowsAuthRequired = false;
  ep.status = 'unknown';
  ep.detail = '';
  appState.url = null;
  appState.child = null;
  appState.childAlive = false;
  await connectEndpoint('local');
  return ep.status === 'online'
    ? { ok: true }
    : { ok: false, error: ep.detail || '新实例未能启动，请在 Windows 引导页重试' };
}

ipcMain.handle('router:windows-connect-auth', async (event, input) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return { ok: false, error: '当前页面不可执行认证连接' };
  const ep = getEndpoint('local');
  const port = ep && (ep.port != null ? ep.port : (appState.cfg && appState.cfg.port));
  if (!ep || ep._windowsAuthRequired !== true || !Number.isInteger(port)) return { ok: false, error: '当前未检测到需要认证的本机 DSH' };
  const parsed = windowsAuthUrl(input, port);
  if (!parsed.ok) return parsed;
  windowsAuthInFlight = true;
  const sequence = (ep._connectSequence || 0) + 1;
  ep._connectSequence = sequence;
  try {
    if ((await probeSpawnedTokenUrl(parsed.url)) !== 'harness') return { ok: false, error: '认证失败：请确认 token 来自当前 DSH 终端输出' };
    if (getEndpoint('local') !== ep || appState.currentPage !== 'local' || ep._connectSequence !== sequence) return { ok: false, error: '页面已切换，请重新操作' };
    ep.authUrl = parsed.url;
    ep.url = stripTokenUrl(parsed.url);
    ep.tokenAuth = true;
    ep.status = 'online';
    ep.wasOnline = true;
    ep.detail = '';
    ep._windowsAuthRequired = false;
    appState.url = parsed.url;
    appState.displayEndpoint = ep.id;
    appState.child = null;
    appState.childAlive = false;
    pushStartupProgress(ep, sequence, 'loading', '认证成功，正在加载 DSH 网页…');
    loadStartupPage(ep, sequence, parsed.url);
    pushPureInfo(); setStatus({}); refreshDshMenu();
    return { ok: true };
  } catch {
    return { ok: false, error: '认证连接失败，请检查当前 DSH 的完整 token URL' };
  } finally {
    windowsAuthInFlight = false;
    pushWindowsStatus(ep, 'auth');
  }
});

ipcMain.handle('router:windows-force-start', async (event) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return { ok: false, error: '当前页面不可执行强制启动' };
  const ep = getEndpoint('local');
  if (!ep || ep._windowsAuthRequired !== true) return { ok: false, error: '仅认证受阻的本机 DSH 可强制启动' };
  windowsAuthInFlight = true;
  const sequence = ep._connectSequence || 0;
  const expectedPort = ep.port;
  let shouldRecheck = false;
  try {
    const first = await verifyWindowsAuthRequiredListener(ep);
    if (!first) {
      // A prior force-stop may already have released the listener. This is a
      // safe no-kill path: clear the stale auth UI and start a fresh local DSH.
      if ((await endpointPortIsFree({ kind: 'local', port: expectedPort, url: null, authUrl: null })) &&
        isLocalRouterSender(event) && getEndpoint('local') === ep && appState.currentPage === 'local' &&
        ep.port === expectedPort && ep._connectSequence === sequence && ep._windowsAuthRequired === true) {
        return await startFreshWindowsLocal(ep);
      }
      return { ok: false, error: '无法确认当前监听者是需要认证的 DSH，未结束任何进程' };
    }
    const answer = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['取消', '停止并启动'], defaultId: 0, cancelId: 0,
      message: '强制停止已运行的 DSH、 中断当前连接并重新启动？',
      detail: '仅会停止已核验的本机 DSH 进程；取消不会更改任何进程。'
    });
    if (!answer || answer.response !== 1) return { ok: false, cancelled: true };
    if (!isLocalRouterSender(event) || getEndpoint('local') !== ep || appState.currentPage !== 'local' ||
      ep.port !== expectedPort || ep._connectSequence !== sequence || ep._windowsAuthRequired !== true) {
      return { ok: false, error: '页面或监听状态已变化，未结束任何进程' };
    }
    const again = await verifyWindowsAuthRequiredListener(ep);
    if (!again || again.pid !== first.pid || again.creationTime !== first.creationTime) {
      return { ok: false, error: '监听进程已变化，未结束任何进程' };
    }
    if (!isLocalRouterSender(event) || getEndpoint('local') !== ep || appState.currentPage !== 'local' ||
      ep.port !== expectedPort || ep._connectSequence !== sequence || ep._windowsAuthRequired !== true) {
      return { ok: false, error: '页面或监听状态已变化，未结束任何进程' };
    }
    const stoppedEndpoint = { kind: 'local', port: again.port, url: null, authUrl: null };
    if (!(await forceKillPidAsync(again.pid)) || !(await waitForEndpointPortFree(stoppedEndpoint, 8_000))) {
      return { ok: false, error: '未能确认 DSH 已停止，未启动新实例' };
    }
    if (!isLocalRouterSender(event) || getEndpoint('local') !== ep || appState.currentPage !== 'local' ||
      ep.port !== expectedPort || ep._connectSequence !== sequence || ep._windowsAuthRequired !== true) {
      return { ok: false, error: '页面或监听状态已变化，未启动新实例' };
    }
    return await startFreshWindowsLocal(ep);
  } catch {
    return { ok: false, error: '强制启动失败，未对未知进程执行操作' };
  } finally {
    shouldRecheck = ep && ep.status === 'error';
    windowsAuthInFlight = false;
    pushWindowsStatus(ep, 'force-start');
    if (shouldRecheck) detectWindowsEndpoint('force-start').catch(() => {});
  }
});
ipcMain.on('router:windows-install-node', async (event) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return;
  windowsInstallInFlight = true;
  const winget = await windowsWhere('winget.exe');
  if (!isLocalRouterSender(event) || !windowsInstallInFlight) { windowsInstallInFlight = false; return; }
  if (!winget) {
    windowsInstallInFlight = false;
    pushWindowsInstallProgress('install-node', { status: 'error', detail: '未找到 winget。请展开“手动安装”并从 nodejs.org 安装 LTS 版 Node.js。', fallback: true });
    return;
  }
  runWindowsInstall('install-node', winget, ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'], '正在通过 winget 安装官方 Node.js LTS…');
});
ipcMain.on('router:windows-install-dsh', async (event) => {
  if (!isLocalRouterSender(event) || isWindowsBusy()) return;
  windowsInstallInFlight = true;
  const npmPath = (getEndpoint('local').windows || {}).npmPath || await windowsWhere('npm.cmd');
  if (!isLocalRouterSender(event) || !windowsInstallInFlight) { windowsInstallInFlight = false; return; }
  if (!npmPath) {
    windowsInstallInFlight = false;
    pushWindowsInstallProgress('install-dsh', { status: 'error', detail: '未找到 npm。请先安装 Node.js，或展开“手动安装”。', fallback: true });
    return;
  }
  runWindowsInstall('install-dsh', npmPath, ['install', '--global', '@deepseek-ai/dsh', '--loglevel=verbose'], '正在使用 npm 全局安装 DSH…');
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
  let u = typeof raw === 'string' ? raw.trim() : '';
  if (u !== '' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'http://' + u;
  return u;
}

function customTokenStorageAvailable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || typeof safeStorage.getSelectedStorageBackend !== 'function' ||
      safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
}

function encryptCustomToken(token) {
  if (!customTokenStorageAvailable()) return null;
  try { return safeStorage.encryptString(token).toString('base64'); } catch { return null; }
}

function decryptCustomToken(value) {
  if (!customTokenStorageAvailable()) return null;
  try {
    const token = safeStorage.decryptString(Buffer.from(value, 'base64'));
    return validCustomToken(token) ? token : null;
  } catch { return null; }
}

function validCustomToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/\s/.test(token);
}

function parseCustomEndpoint(raw, explicitToken) {
  if (explicitToken !== undefined && explicitToken !== '' && !validCustomToken(explicitToken)) {
    return { ok: false, error: 'token 不能为空、不能含空白且最长 4096 个字符' };
  }
  let parsed;
  try { parsed = new URL(normalizeEndpointUrl(raw)); } catch { return { ok: false, error: '地址格式不正确（如：192.168.1.10:3080）' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: '仅支持 http / https 地址' };
  const tokens = parsed.searchParams.getAll('token');
  if (tokens.length > 1 || (tokens.length === 1 && !validCustomToken(tokens[0]))) {
    return { ok: false, error: 'URL 中 token 必须恰好为一个非空值' };
  }
  if (tokens.length && explicitToken !== undefined && explicitToken !== '') {
    return { ok: false, error: '请仅在 URL 或 token 输入框之一提供 token' };
  }
  const token = explicitToken === '' ? null : (explicitToken || tokens[0] || null);
  parsed.searchParams.delete('token');
  return { ok: true, url: parsed.toString(), token };
}

function customRuntimeUrl(ep) {
  if (!ep || !ep.token) return ep && ep.url;
  const parsed = new URL(ep.url);
  parsed.searchParams.set('token', ep.token);
  return parsed.toString();
}

function sameEndpointOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function editCustomEndpoint(ep, patch) {
  const next = Object.assign({}, ep);
  const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 40) : '';
  if (name) next.name = name;
  const tokenProvided = Object.prototype.hasOwnProperty.call(patch, 'token');
  const explicitToken = tokenProvided ? patch.token : undefined;
  if (tokenProvided && typeof explicitToken !== 'string') return { ok: false, error: '无效的 token' };
  const rawUrl = typeof patch.url === 'string' && patch.url.trim() !== '' ? patch.url : ep.url;
  const parsed = parseCustomEndpoint(rawUrl, explicitToken);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const originChanged = !sameEndpointOrigin(ep.url, parsed.url);
  if (originChanged && !tokenProvided && !parsed.token && (ep.token || ep.encryptedToken)) {
    return { ok: false, error: '地址 origin 已变化，请重新输入 token 或明确清除 token' };
  }
  if (parsed.token && !customTokenStorageAvailable()) return { ok: false, error: '当前系统无法安全保存认证 token' };
  next.url = parsed.url;
  if (tokenProvided || parsed.token) {
    next.token = parsed.token;
    next.encryptedToken = null;
    next.tokenError = false;
  } else if (!originChanged) {
    // Same-origin path/query edits preserve the existing in-memory credential.
    next.token = ep.token;
    next.encryptedToken = ep.encryptedToken;
    next.tokenError = ep.tokenError;
  }
  const index = appState.endpoints.indexOf(ep);
  if (appState.endpoints.some((other) => other !== ep && other.kind === 'custom' && other.url === next.url)) {
    return { ok: false, error: '该地址已存在' };
  }
  appState.endpoints[index] = next;
  if (!persistEndpoints()) {
    appState.endpoints[index] = ep;
    return { ok: false, error: '无法安全保存端点设置' };
  }
  // Make every continuation which captured the replaced record stale before
  // the new record can connect, so an old probe cannot navigate with an old
  // credential URL.
  ep._connectSequence = (ep._connectSequence || 0) + 1;
  next._connectSequence = ep._connectSequence;
  next._pendingConnect = null;
  next.tokenAuth = false;
  next.status = 'unknown';
  next.detail = '';
  next.wasOnline = false;
  next.child = null;
  next.childAlive = false;
  const view = appState.views[ep.id];
  if (view && !view.webContents.isDestroyed()) {
    try { view.webContents.stop(); } catch { /* best effort */ }
    // A same-origin token change must not take the online shortcut.  Blank
    // the parked document so the next visit loads the new runtime URL.
    try { view.webContents.loadURL('about:blank').catch(() => {}); } catch { /* best effort */ }
  }
  if (appState.displayEndpoint === ep.id) {
    appState.url = null;
    appState.displayEndpoint = null;
    enterPureView(`「${next.name}」设置已更新，点击「打开 DSH Web」重新连接`);
  }
  pushPureInfo();
  return { ok: true };
}

function stripTokenUrl(raw) {
  try { const parsed = new URL(raw); parsed.searchParams.delete('token'); return parsed.toString(); } catch { return raw || null; }
}

ipcMain.handle('pure:add-endpoint', (event, name, url, token) => {
  if (!isPureSender(event)) return { ok: false, error: 'unavailable' };
  const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  if (n === '') return { ok: false, error: '请填写名称' };
  const parsed = parseCustomEndpoint(url, token);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.token && !customTokenStorageAvailable()) return { ok: false, error: '当前系统无法安全保存认证 token' };
  if (appState.endpoints.some((e) => e.kind === 'custom' && e.url === parsed.url)) {
    return { ok: false, error: '该地址已存在' };
  }
  const endpoint = {
    id: 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    kind: 'custom',
    name: n,
    url: parsed.url,
    token: parsed.token,
    child: null,
    childAlive: false,
    wasOnline: false,
    status: 'unknown',
    detail: ''
  };
  // Serialize a candidate first: disk/encryption failure must not alter state.
  appState.endpoints.push(endpoint);
  if (!persistEndpoints()) {
    appState.endpoints.pop();
    return { ok: false, error: '无法安全保存端点设置' };
  }
  appState.activeEndpoint = endpoint.id;
  pushPureInfo();
  return { ok: true };
});

/**
 * Edit an endpoint: name (all kinds), port + dsh executable (local),
 * port + manual dsh path (wsl), url (custom). A config change detaches the
 * endpoint's running state — 「打开 DSH Web」 reconnects with the new values.
 */
ipcMain.handle('pure:edit-endpoint', (event, id, patch) => {
  if (!isPureSender(event)) return { ok: false, error: 'unavailable' };
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (!ep) return { ok: false, error: '端点不存在' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: '无效的参数' };
  if (ep.kind === 'custom') return editCustomEndpoint(ep, patch);
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
  if (ep.kind !== 'custom') { ep.url = null; ep.authUrl = null; }
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

ipcMain.handle('pure:open-endpoint-browser', (event, id) => {
  if (!isPureSender(event)) return { ok: false, error: 'unavailable' };
  const ep = getEndpoint(typeof id === 'string' ? id : '');
  if (!ep) return { ok: false, error: '端点不存在' };
  const target = ep.kind === 'custom' ? customRuntimeUrl(ep) : (pageEndpointRuntimeUrl(ep) || ep.urlOverride);
  if (!target) return { ok: false, error: '端点尚未连接' };
  openExternalSafely(target);
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
    ep.port = WSL_DEFAULT_PORT;
    ep.dshOverride = null;
    ep.urlOverride = null;
  }
  if (ep.child !== null) {
    killChild(ep.child);
    ep.child = null;
    ep.childAlive = false;
  }
  ep.url = null;
  ep.authUrl = null;
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
  if (ep.kind === 'wsl') {
    // Reset = back to defaults; immediately re-resolve + connect so the
    // endpoint comes back online without another manual 「打开 DSH Web」 click.
    detectWslEndpoint('manual')
      .then(() => connectEndpoint('wsl'))
      .catch(() => {});
  }
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
    target = customRuntimeUrl(ep);
  } else if (ep.urlOverride) {
    target = ep.urlOverride;
  } else if (ep.authUrl || ep.url) {
    target = ep.authUrl || ep.url;
  } else {
    target = `http://127.0.0.1:${ep.port}`;
  }
  if (!target) return;
  ep.status = 'starting';
  pushPureInfo();
  const st = await probeEndpointUrl(ep, target);
  if (st === 'harness') {
    ep.status = 'online';
    ep.wasOnline = true;
    ep.detail = '';
  } else {
    // 红（offline）仅用于"曾经连上过、现在没了"；从未连上过保持灰。
    ep.status = ep.wasOnline ? 'offline' : 'unknown';
    ep.detail =
      st === 'free'
        ? ep.kind === 'custom'
          ? '远端 dsh web 未运行'
          : 'dsh web 未运行（本端不会自动启动）'
        : ep.kind === 'custom'
          ? '地址可达，但不是 dsh web（远端需以 --trusted-host 声明本端主机）'
          : '该地址已被其他服务占用';
  }
  pushPureInfo();
  setStatus({});
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

function forceKillPidAsync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGTERM'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true
      });
    } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function stopVerifiedWindowsRecovery(ep) {
  const expected = ep.recoveryIdentity;
  if (!expected || process.platform !== 'win32') return false;
  const record = readWindowsRecovery();
  if (!record || record.pid !== expected.pid || record.port !== expected.port ||
    record.creationTime !== expected.creationTime) return false;
  const owner = await findPortOwnerAsync(record.port);
  if (!owner || owner.pid !== record.pid) return false;
  const identity = await windowsProcessIdentityAsync(record.pid);
  if (!identity || identity.creationTime !== record.creationTime ||
    !isExpectedWindowsDshCommand(identity.commandLine, record.port)) return false;
  return forceKillPidAsync(record.pid);
}

function clearWindowsRecoveryIfMatches(expected) {
  if (!expected || process.platform !== 'win32') return;
  const record = readWindowsRecovery();
  if (record && record.pid === expected.pid && record.port === expected.port &&
    record.creationTime === expected.creationTime) clearWindowsRecovery();
}

async function endpointPortIsFree(ep) {
  let target = pageEndpointRuntimeUrl(ep);
  if (target === null && ep.port != null) target = `http://127.0.0.1:${ep.port}`;
  if (target === null) return false;
  try {
    const parsed = new URL(target);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    // Do not call an authenticated URL (or follow its redirects) merely to
    // decide whether the listener disappeared. A known local listener wins.
    const localTarget = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    if (localTarget && Number.isInteger(port) && (await findPortOwnerAsync(port))) return false;
    return Number.isInteger(port) && await tcpPortRefused(parsed.hostname, port, 1_500);
  } catch { return false; }
}

/** A close is confirmed only by TCP ECONNREFUSED, never by an HTTP/network timeout. */
function tcpPortRefused(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    try {
      socket = net.connect({ host, port });
      socket.once('connect', () => finish(false));
      socket.once('error', (err) => finish(Boolean(err && err.code === 'ECONNREFUSED')));
      socket.setTimeout(timeoutMs, () => finish(false));
    } catch { finish(false); }
  });
}

async function waitForEndpointPortFree(ep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await endpointPortIsFree(ep)) return true;
    if (Date.now() < deadline) await sleep(250);
  } while (Date.now() < deadline);
  return false;
}

function isReusedWindowsAuthEndpoint(ep) {
  return Boolean(process.platform === 'win32' && ep && ep.kind === 'local' &&
    ep.childAlive !== true && (ep.recoveryIdentity || (ep.status === 'online' && (ep.authUrl || ep.url))));
}

async function verifyReusedWindowsAuthListener(ep) {
  if (!isReusedWindowsAuthEndpoint(ep)) return null;
  const runtimeUrl = ep.authUrl || ep.url;
  let auth;
  try { auth = new URL(runtimeUrl); } catch { return null; }
  const configuredPort = ep.port != null ? ep.port : 3080;
  const expectedRecovery = ep.recoveryIdentity;
  const port = expectedRecovery ? expectedRecovery.port : configuredPort;
  const loopback = auth.hostname === '127.0.0.1' || auth.hostname === 'localhost' || auth.hostname === '::1' || auth.hostname === '[::1]';
  if (auth.protocol !== 'http:' || !loopback || Number(auth.port || 80) !== port || auth.username || auth.password || auth.hash) return null;
  const owner = await findPortOwnerAsync(port);
  if (!owner || !Number.isInteger(owner.pid)) return null;
  const identity = await windowsProcessIdentityAsync(owner.pid);
  if (!identity || (expectedRecovery
    ? (owner.pid !== expectedRecovery.pid || identity.creationTime !== expectedRecovery.creationTime || !isExpectedWindowsDshCommand(identity.commandLine, port))
    : !isManualWindowsDshCommand(identity.commandLine))) return null;
  const bare = `http://127.0.0.1:${port}`;
  if (auth.searchParams.has('token')) {
    // Both proofs are required: bare URL must be DSH's exact auth gate and the
    // in-memory URL must pass its token handshake.
    if ((await probeWithGrace(bare)) !== 'auth_required' || (await probeSpawnedTokenUrl(runtimeUrl)) !== 'harness') return null;
  } else if ((await probeWithGrace(bare)) !== 'harness') {
    return null; // no-token reuse still needs the strict harness marker
  }
  return { pid: owner.pid, creationTime: identity.creationTime, port, configuredPort, runtimeUrl };
}

async function confirmStopReusedWindows(ep, sequence, expectedPage, action = 'stop') {
  const first = await verifyReusedWindowsAuthListener(ep);
  if (!first) return { ok: false, error: '无法确认当前监听者是认证中的 DSH，未结束任何进程' };
  const answer = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['取消', action === 'restart' ? '停止并重新启动' : '停止外部 DSH'], defaultId: 0, cancelId: 0,
    message: action === 'restart' ? '停止外部手动启动的 DSH 并重新启动？' : '停止外部手动启动的 DSH？',
    detail: '这会中断当前连接。仅会停止已核验的本机 DSH 进程；取消不会更改任何进程。'
  });
  if (!answer || answer.response !== 1) return { ok: false, cancelled: true };
  if (getEndpoint(ep.id) !== ep || appState.currentPage !== expectedPage || ep._connectSequence !== sequence || ep.port !== first.configuredPort || (ep.authUrl || ep.url) !== first.runtimeUrl || !isReusedWindowsAuthEndpoint(ep)) {
    return { ok: false, error: '页面或连接状态已变化，未结束任何进程' };
  }
  const again = await verifyReusedWindowsAuthListener(ep);
  if (!again || again.pid !== first.pid || again.creationTime !== first.creationTime || again.port !== first.port || again.runtimeUrl !== first.runtimeUrl) {
    return { ok: false, error: '监听进程已变化，未结束任何进程' };
  }
  if (getEndpoint(ep.id) !== ep || appState.currentPage !== expectedPage || ep._connectSequence !== sequence || ep.port !== first.configuredPort || (ep.authUrl || ep.url) !== first.runtimeUrl || !isReusedWindowsAuthEndpoint(ep)) {
    return { ok: false, error: '页面或连接状态已变化，未结束任何进程' };
  }
  return { ok: await forceKillPidAsync(again.pid), identity: again };
}

/** Close only a child the shell owns, or a Windows recovery PID re-verified now. */
async function stopCurrentPageServer() {
  const ep = currentPageEndpoint();
  if (!canSafelyOperatePageServer(ep)) return false;
  const generation = (ep._serverActionSequence || 0) + 1;
  ep._serverActionSequence = generation;
  ep._connectSequence = (ep._connectSequence || 0) + 1;
  const sequence = ep._connectSequence;
  ep._pendingConnect = null;
  ep._stopping = true; // child exit is not proof that a WSL-side listener stopped
  let requested = false;
  try {
    if (ep.child && ep.childAlive) {
      requested = await forceKillPidAsync(ep.child.pid);
    } else if (ep.kind === 'local') {
      if (isReusedWindowsAuthEndpoint(ep)) {
        const result = await confirmStopReusedWindows(ep, sequence, ep.id, 'stop');
        if (result.cancelled) { refreshDshMenu(); setStatus({}); return false; }
        requested = result.ok;
      } else {
        requested = await stopVerifiedWindowsRecovery(ep);
      }
    }
    if (requested) {
      ep.child = null;
      ep.childAlive = false;
    }
    if (!requested || !(await waitForEndpointPortFree(ep, 8_000))) {
      if (ep._serverActionSequence === generation && ep._connectSequence === sequence) {
        ep.status = 'error';
        ep.detail = '未能确认 DSH 服务已关闭；未标记为已断开。';
        ep._stopping = false;
        if (currentPageEndpoint() === ep) {
          appState.url = null;
          appState.child = null;
          appState.childAlive = false;
          appState.displayEndpoint = ep.id;
          appState.view = 'web';
          loadWeb(ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(ep.id, 'error', ep.name, ep.detail));
          layout();
        }
        pushPureInfo();
        setStatus({ reason: `未能确认「${ep.name}」已关闭` });
      }
      return false;
    }
    if (ep._serverActionSequence !== generation || ep._connectSequence !== sequence) return false;
    ep.child = null;
    ep.childAlive = false;
    clearWindowsRecoveryIfMatches(ep.recoveryIdentity);
    ep.recoveryIdentity = null;
    ep.url = null;
    ep.authUrl = null;
    ep.status = 'offline';
    ep.wasOnline = true;
    ep.detail = 'DSH 服务已关闭；可手动重新连接。';
    ep._stopping = false;
    if (currentPageEndpoint() === ep) {
      appState.url = null;
      appState.child = null;
      appState.childAlive = false;
      appState.displayEndpoint = ep.id;
      appState.view = 'web';
      loadWeb(ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(ep.id, 'offline', ep.name));
      layout();
    }
    pushPureInfo();
    setStatus({ reason: `「${ep.name}」的 DSH 服务已关闭` });
    refreshDshMenu();
    return true;
  } finally {
    if (ep._serverActionSequence === generation && ep._connectSequence === sequence && ep.status !== 'offline') ep._stopping = false;
  }
}

/** Shell menu/tray restart: only after the same ownership guard as stop. */
async function restartCurrentPageServer() {
  const ep = currentPageEndpoint();
  if (!canSafelyOperatePageServer(ep)) return false;
  if (isReusedWindowsAuthEndpoint(ep)) return restartReusedWindowsServer(ep);
  // The legacy explicit restart path may handle a reused server; menu/tray must
  // not. It is safe only while the tracked child/recovery target remains here.
  const stopped = await stopCurrentPageServer();
  if (!stopped || currentPageEndpoint() !== ep) return false;
  return restartServer(ep.id, { ownedOnly: true });
}

async function restartReusedWindowsServer(ep) {
  if (ep._stopping) return false;
  const expectedPage = appState.currentPage;
  const sequence = (ep._connectSequence || 0) + 1;
  const generation = (ep._reusedRestartGeneration || 0) + 1;
  ep._reusedRestartGeneration = generation;
  ep._connectSequence = sequence;
  ep._pendingConnect = null;
  ep._stopping = true;
  try {
    const result = await confirmStopReusedWindows(ep, sequence, expectedPage, 'restart');
    if (!result.ok) return false;
    const stoppedEndpoint = { kind: 'local', port: result.identity.port, url: null, authUrl: null };
    if (!(await waitForEndpointPortFree(stoppedEndpoint, 8_000))) return false;
    if (getEndpoint(ep.id) !== ep || appState.currentPage !== expectedPage || ep._connectSequence !== sequence) return false;
    ep.child = null; ep.childAlive = false; ep.url = null; ep.authUrl = null; ep.tokenAuth = false;
    ep.status = 'unknown'; ep.detail = ''; ep._stopping = false;
    await restartServer(ep.id, { ownedOnly: true, expectedPage });
    return ep.status === 'online';
  } finally {
    if (ep._reusedRestartGeneration === generation) {
      ep._stopping = false;
      refreshDshMenu();
      setStatus({});
    }
  }
}

/**
 * Restart a dsh web endpoint (local or WSL). Works whether the shell spawned
 * it (child) or reused an existing one: kill the child if we have one, wait
 * for the port to free, and if it's still occupied locally force-kill that
 * owner (safe — the port is serving the harness by definition) — then spawn a
 * fresh instance and reload. Remote (custom) endpoints are view-only.
 */
async function restartServer(epId, options = {}) {
  const cfg = appState.cfg;
  if (cfg === null || win === null || restarting) return;
  const ep =
    getEndpoint(typeof epId === 'string' ? epId : '') ||
    getEndpoint(appState.displayEndpoint) ||
    getEndpoint(appState.activeEndpoint);
  if (ep === null || ep.kind === 'custom') return; // view-only endpoints
  if (options.ownedOnly && currentPageEndpoint() !== ep && appState.currentPage !== options.expectedPage) return;
  if (!options.ownedOnly && isReusedWindowsAuthEndpoint(ep)) return restartReusedWindowsServer(ep);
  restarting = true;
  const port = ep.port != null ? ep.port : cfg.port;
  const portUrl = `http://127.0.0.1:${port}`;
  appState.currentPage = ep.id;
  // Show the router page's 加载中 component so the harness area doesn't flash a
  // Chromium "can't reach this page" error while the old server is killed.
  appState.view = 'web';
  appState.displayEndpoint = ep.id;
  loadWeb(routerUrl(ep.id, 'starting', ep.name));
  layout();
  ep.status = 'starting';
  ep.detail = '';
  pushPureInfo();
  setStatus({});
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
        if (options.ownedOnly) throw new Error('关闭后端口再次被占用，未结束未知进程');
        if (process.platform === 'win32') throw new Error('端口仍被占用，未结束未知 Windows 进程；请在认证引导页确认后重试');
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
        if (options.ownedOnly) throw new Error('WSL 服务未确认关闭，未结束复用进程');
        // The port is held by a dsh web inside the distro that isn't our child
        // (a reused / externally-started one — WSL processes are invisible to
        // Windows-side tooling). Kill it in the distro, then wait for free.
        await wslExec(
          wslDistroArgs(ep.wsl && ep.wsl.distro, ['-e', 'bash', '-ic', `pkill -f "dsh web --no-open --port ${port}" || true`]),
          10_000
        );
        const d3 = Date.now() + 5_000;
        while (Date.now() < d3 && (await probeWithGrace(portUrl)) !== 'free') {
          await sleep(300);
        }
        if ((await probeWithGrace(portUrl)) !== 'free') {
          throw new Error(`WSL 内端口 ${port} 仍被占用，请在 WSL 终端手动结束占用进程后重试`);
        }
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
    const restartedTokenUrl = ep.kind === 'local' && (() => {
      try { return new URL(url).searchParams.has('token'); } catch { return false; }
    })();
    ep.authUrl = restartedTokenUrl ? url : null;
    ep.url = restartedTokenUrl ? stripTokenUrl(url) : url;
    ep.child = child;
    ep.childAlive = child !== null;
    ep.status = 'online';
    ep.wasOnline = true;
    ep.detail = '';
    if (child !== null) bindChildExit(child, ep);
    appState.url = url;
    appState.child = child;
    appState.childAlive = child !== null;
    appState.displayEndpoint = ep.id;
    appState.view = 'web';
    appState.currentPage = ep.id;
    hideLoading();
    loadWeb(url);
    layout();
    setStatus({});
    refreshDshMenu();
  } catch (err) {
    // Degrade to the in-page error component for that endpoint (non-blocking):
    // the user retries from there — never quit the app, never leave the page.
    ep.status = 'error';
    ep.detail = err.message;
    appState.view = 'web';
    appState.displayEndpoint = ep.id;
    appState.currentPage = ep.id;
    appState.url = null;
    appState.child = null;
    appState.childAlive = false;
    hideLoading();
    loadWeb(ep.kind === 'wsl' ? wslRouterUrl(ep) : routerUrl(ep.id, 'error', ep.name, err.message));
    layout();
    setStatus({ reason: `重启「${ep.name}」失败：${err.message}` });
  } finally {
    restarting = false;
    hideLoading();
    pushPureInfo();
    setStatus({});
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const appState = {
  cfg: null,
  child: null, // the dsh web child process of the DISPLAYED endpoint (if we spawned it)
  url: null, // URL currently loaded in the active endpoint view
  displayEndpoint: null, // endpoint id currently displayed
  activeEndpoint: 'local', // endpoint selected in the Pure page's DSH Web tab bar
  currentPage: 'pure', // 'pure' (桌面端配置) or an endpoint id — the title bar
  view: 'web',
  layout: 'full',
  childAlive: false,
  endpoints: [], // [{id, kind, name, url, child, childAlive, status, detail, wsl?}]
  views: {} // epId → WebContentsView (each endpoint has its own view; session preserved)
};
let startupPagePreference = null;
let startupPromptActive = false;
let startupFlowStarted = false;
let startupFlowGeneration = 0;
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
    if (quitting || restarting || ep._stopping) return;
    if (process.platform === 'win32' && ep.kind === 'local') clearWindowsRecovery();
    const why = code !== null ? `code ${code}` : `signal ${signal}`;
    ep.child = null;
    ep.childAlive = false;
    if (ep.kind !== 'custom') { ep.url = null; ep.authUrl = null; }
    // The endpoint we are SHOWING died → stay ON this page with its 已断开
    // component (the user retries / restarts from there); only a background
    // endpoint dying updates its dot. A background endpoint dying only
    // updates its dot — the window stays where it is.
    if (appState.displayEndpoint === ep.id) {
      appState.child = null;
      appState.childAlive = false;
      appState.url = null;
      ep.status = 'offline';
      ep.detail = `dsh web 已退出（${why}）`;
      layout();
      const v = appState.views[ep.id];
      if (v && !v.webContents.isDestroyed()) {
        if (ep.kind === 'wsl') pushWslStatus(ep); // guide stays, status flips live
        else v.webContents.loadURL(routerUrl(ep.id, 'offline', ep.name));
      }
      setStatus({ reason: `「${ep.name}」的 dsh web 已退出（${why}）` });
    } else {
      pushPureInfo();
    }
  });
}

function main() {
  // Load the shell chrome/Pure page first. DSH discovery, spawning and token
  // verification begin only after those local documents have painted, and are
  // intentionally not awaited by the application startup path.
  createWindow();
  enterPureView('正在准备本机 DSH 连接…');
  const ready = [pureView, titlebarView, menuView].map((view) => new Promise((resolve) => {
    view.webContents.once('did-finish-load', resolve);
  }));
  Promise.all(ready).then(() => {
    if (win !== null && !win.isDestroyed()) {
      startAutomaticReleaseUpdate();
      runStartupPreference().catch(() => {});
    }
  });
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
    startupPagePreference = loadStartupPagePreference();
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
    main();
    setInterval(() => {
      tickEndpoints().catch(() => {});
    }, 5_000);
  });
}

app.on('before-quit', () => {
  quitting = true;
  // A normal exit stops only the listener still proven to match the encrypted
  // recovery record. Its credential is removed only after that succeeds.
  stopWindowsRecoveryOnQuit();
  // Kill every endpoint child we spawned (local and WSL alike).
  for (const ep of appState.endpoints) {
    if (ep.child !== null) killChild(ep.child);
  }
  // Destroy all endpoint views.
  for (const v of Object.values(appState.views)) {
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }
  appState.views = {};
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
    appState.currentPage = appState.displayEndpoint || 'local';
    showWebOnly();
  }
});
