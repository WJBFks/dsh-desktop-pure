'use strict';

/**
 * port-probe.js — pure helpers for the shell's port policy, shared by main.js
 * and the selftest. Classifies what answers on 127.0.0.1:<port> and, when a
 * foreign process holds it, identifies that process (name + PID). No Electron
 * imports here, so it runs under plain Node.
 */

const { spawnSync } = require('node:child_process');

const PROBE_TIMEOUT_MS = 2_000;
const GRACE_REPROBES = 3;
const GRACE_INTERVAL_MS = 1_000;

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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!response.ok) return 'busy';
    const body = await response.text();
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
  }
}

/**
 * A just-starting harness may briefly answer non-200; re-probe a few times
 * before declaring the port 'busy'. 'harness'/'free' settle immediately.
 * Passes `options` through to probe() unchanged.
 */
async function probeWithGrace(url, options) {
  for (let i = 0; i <= GRACE_REPROBES; i += 1) {
    const status = await probe(url, options);
    if (status === 'harness' || status === 'free') return status;
    await sleep(GRACE_INTERVAL_MS);
  }
  return 'busy';
}

/**
 * Identify the process listening on `port`. Returns { pid, name } or null.
 * Windows: netstat -ano (the state word is localized on zh-CN systems, so it
 * is matched loosely) + tasklist. POSIX: lsof + ps.
 */
function findPortOwner(port) {
  const pid = findPidForPort(port);
  if (pid === null) return null;
  return { pid, name: processNameFromPid(pid) };
}

function findPidForPort(port) {
  if (process.platform === 'win32') {
    const out =
      spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    // local:port  remote:port  <any state word>  PID
    const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+:\\d+\\s+\\S+\\s+(\\d+)\\s*$`, 'i');
    for (const line of out.split(/\r?\n/)) {
      const m = re.exec(line);
      if (m) return Number(m[1]);
    }
    return null;
  }
  const out =
    spawnSync('lsof', ['-i', `:${port}`, '-s', 'TCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '';
  const first = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^\d+$/.test(s));
  return first ? Number(first) : null;
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
  GRACE_REPROBES,
  GRACE_INTERVAL_MS,
  HARNESS_MARKERS,
  probe,
  probeWithGrace,
  findPortOwner
};