'use strict';

/**
 * port-probe.js — pure helpers for the shell's port policy, shared by main.js
 * and the selftest. Classifies what answers on 127.0.0.1:<port> and, when a
 * foreign process holds it, identifies that process (name + PID). No Electron
 * imports here, so it runs under plain Node.
 */

const { spawn, spawnSync } = require('node:child_process');

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_BODY_LIMIT_BYTES = 256 * 1024;
const AUTH_BODY_LIMIT_BYTES = 256;
const GRACE_REPROBES = 3;
const GRACE_INTERVAL_MS = 1_000;
// This is deliberately an exact compatibility signature, not a generic 401.
// A different protected service must remain a port conflict.
const DSH_AUTH_REQUIRED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.';

/**
 * Structural markers of a DeepSeek Harness page. These are load-bearing parts
 * of the DSH client (the __DSH_BOOT__ payload and the client runtime/modules),
 * not display copy — so they are far more likely to survive a dsh release than
 * a visible title string. Any ONE match is enough to identify a harness.
 */
const HARNESS_MARKERS = [
  '__DSH_BOOT__',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-modules',
  'DeepSeek Harness'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBodyLimited(response, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('response body limit exceeded');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* response already complete */ }
  }
}

/**
 * Classify the listener at `url`:
 *   'harness' — a DeepSeek Harness index page is served
 *   'busy'    — something else answers (or a broken/foreign HTTP answer)
 *   'free'    — connection refused (no listener)
 *
 * `options.assumeHarness` (default false): when the caller just spawned this
 * exact server itself (waitForServer), any HTTP 200 answer is trusted as the
 * harness, so readiness never depends on DSH's page markup surviving. When the
 * caller is deciding whether to REUSE an existing port, the check stays strict
 * (needs a structural marker) so a foreign HTTP server is never mistaken for
 * the harness. If an HTML page matches no known marker, this is treated as a
 * possible version-drift: a console warning is emitted and the port is
 * classified 'busy' — never a crash.
 */
async function probe(url, options) {
  const assumeHarness = Boolean(options && options.assumeHarness);
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      // DSH 0.1.2-rc.1 terminates this text line with LF. Remove only terminal
      // CR/LF bytes: spaces or any other body difference must still be busy.
      const errorBody = response.status === 401 ? await readBodyLimited(response, AUTH_BODY_LIMIT_BYTES) : '';
      if (response.status === 401 && errorBody.replace(/[\r\n]+$/, '') === DSH_AUTH_REQUIRED_BODY) {
        return 'auth_required';
      }
      return 'busy';
    }
    const body = await readBodyLimited(response, PROBE_BODY_LIMIT_BYTES);
    if (HARNESS_MARKERS.some((m) => body.includes(m))) return 'harness';
    if (assumeHarness) return 'harness';
    const ctype = (response.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html') || /<!doctype html>/i.test(body)) {
      // A real harness is expected here but no known marker matched — most
      // likely a dsh release changed the page structure. Warn, don't crash.
      try {
        console.warn(
          `[port-probe] ${url} 返回 HTML，但未匹配任何已知 harness 标记 ` +
            `（可能是 DSH 版本升级改变了页面结构）。本次按“非 harness”处理；` +
            `如属误判，请更新 port-probe.js 的 HARNESS_MARKERS。`
        );
      } catch {
        /* warning is best-effort */
      }
    }
    return 'busy';
  } catch (err) {
    const code = err && err.cause ? err.cause.code : undefined;
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'free';
    // A listener answered but broke the HTTP exchange (e.g. TLS on a plain-HTTP port).
    return 'busy';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Verify the authenticated URL printed by a harness child we just spawned.
 * dsh 0.1.2-rc.1 answers that URL with a 303 which installs a session cookie
 * before redirecting to its own root.  Fetch has no cookie jar, so following
 * that redirect reaches a 401 even though the server is ready.  This probe
 * intentionally accepts only that exact handshake shape.  It is never used
 * for discovering/reusing an existing listener.
 */
async function probeSpawnedTokenUrl(url) {
  let tokenUrl;
  try {
    tokenUrl = new URL(url);
  } catch {
    return 'busy';
  }
  if (!tokenUrl.searchParams.has('token')) return 'busy';
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(tokenUrl, { signal: controller.signal, redirect: 'manual' });
    if (response.status === 200) return 'harness';
    if (response.status === 401) {
      const errorBody = await readBodyLimited(response, AUTH_BODY_LIMIT_BYTES);
      if (errorBody.replace(/[\r\n]+$/, '') === DSH_AUTH_REQUIRED_BODY) return 'auth_required';
    }
    // 303 is the documented/observed POST-to-GET-style session handoff.  Do
    // not also accept 302/307/308: doing so broadens a security-sensitive
    // readiness signal without a DSH compatibility need.
    if (response.status !== 303 || !response.headers.get('set-cookie')) return 'busy';
    const location = response.headers.get('location');
    if (!location) return 'busy';
    const destination = new URL(location, tokenUrl);
    return destination.origin === tokenUrl.origin && destination.pathname === '/' && !destination.search
      ? 'harness'
      : 'busy';
  } catch {
    return 'unavailable';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A just-starting harness may briefly answer non-200; re-probe a few times
 * before declaring the port 'busy'. 'harness', 'free', and DSH's exact
 * token-required response settle immediately.
 * Passes `options` through to probe() unchanged.
 */
async function probeWithGrace(url, options) {
  for (let i = 0; i <= GRACE_REPROBES; i += 1) {
    const status = await probe(url, options);
    if (status === 'harness' || status === 'free' || status === 'auth_required') return status;
    await sleep(GRACE_INTERVAL_MS);
  }
  return 'busy';
}

/**
 * Identify the process listening on `port`. Returns { pid, name } or null.
 * Windows: netstat -ano (only a positive-PID TCP listener is accepted) +
 * tasklist. POSIX: lsof + ps.
 */
function findPortOwner(port) {
  const pid = findPidForPort(port);
  if (pid === null) return null;
  return { pid, name: processNameFromPid(pid) };
}

/**
 * Asynchronous listener lookup for the startup/recovery path. Keep the
 * synchronous helpers above for quit-time verification and conflict dialogs,
 * but never make the first window paint wait on netstat/tasklist.
 */
function commandOutput(file, args, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (data) => { out += data.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

async function findPortOwnerAsync(port) {
  if (process.platform === 'win32') {
    const out = await commandOutput('netstat', ['-ano', '-p', 'TCP']);
    if (out === null) return null;
    const pid = parseWindowsTcpListeningPid(out, port);
    return pid === null ? null : { pid, name: '未知进程' };
  }
  const out = await commandOutput('lsof', ['-i', `:${port}`, '-s', 'TCP:LISTEN', '-t']);
  const first = (out || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /^\d+$/.test(s));
  return first ? { pid: Number(first), name: 'unknown' } : null;
}

function findPidForPort(port) {
  if (process.platform === 'win32') {
    const out =
      spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    return parseWindowsTcpListeningPid(out, port);
  }
  const out =
    spawnSync('lsof', ['-i', `:${port}`, '-s', 'TCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '';
  const first = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^\d+$/.test(s));
  return first ? Number(first) : null;
}

// `netstat -ano -p TCP` has stable column order even when its headers are
// localized.  States normally remain English; accept the specific zh-CN state
// as well, rather than treating every state word as a listener.  In
// particular, PID 0 TIME_WAIT rows must never make a free port look occupied.
const WINDOWS_LISTENING_STATES = new Set(['LISTENING', '侦听']);

function windowsTcpEndpointPort(endpoint) {
  const separator = endpoint.lastIndexOf(':');
  if (separator < 1) return null;
  const text = endpoint.slice(separator + 1);
  return /^\d+$/.test(text) ? Number(text) : null;
}

function parseWindowsTcpListeningPid(output, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // Protocol, local endpoint, remote endpoint, state, PID.  Inspect the
    // local endpoint only: the requested port may appear as a remote peer on
    // an unrelated ESTABLISHED/TIME_WAIT connection.
    if (fields.length < 5 || !/^TCP(?:v6)?$/i.test(fields[0])) continue;
    if (windowsTcpEndpointPort(fields[1]) !== port) continue;
    if (!WINDOWS_LISTENING_STATES.has(fields[3].toUpperCase()) && fields[3] !== '侦听') continue;
    if (!/^[1-9]\d*$/.test(fields[4])) continue;
    return Number(fields[4]);
  }
  return null;
}

function processNameFromPid(pid) {
  if (process.platform === 'win32') {
    try {
      const out =
        spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
          encoding: 'utf8',
          windowsHide: true
        }).stdout || '';
      const line = out.split(/\r?\n/).find((l) => l.startsWith('"'));
      const m = line ? /^"([^"]+)"/.exec(line) : null;
      return m ? m[1] : '未知进程';
    } catch {
      return '未知进程';
    }
  }
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout || '';
    const name = out.trim().split(/\s+/).pop();
    return name || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  PROBE_TIMEOUT_MS,
  PROBE_BODY_LIMIT_BYTES,
  AUTH_BODY_LIMIT_BYTES,
  GRACE_REPROBES,
  GRACE_INTERVAL_MS,
  DSH_AUTH_REQUIRED_BODY,
  HARNESS_MARKERS,
  probe,
  probeSpawnedTokenUrl,
  probeWithGrace,
  parseWindowsTcpListeningPid,
  findPortOwner,
  findPortOwnerAsync
};
