'use strict';

// Focused startup-path regression checks. Uses extracted production functions
// and mocks only; it never starts Electron or a DSH process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

function load(names, extra) {
  const context = vm.createContext(Object.assign({ Promise, setTimeout, clearTimeout }, extra));
  vm.runInContext(names.map(extract).join('\n'), context, { filename: 'main.js (startup extract)' });
  return context;
}

// Same-endpoint clicks share one pending attempt; no second spawn/handshake is
// allowed to start while the first is unresolved.
let attempts = 0;
let finishAttempt;
const endpoint = { id: 'local' };
const dedupe = load(['connectEndpoint'], {
  getEndpoint: () => endpoint,
  appState: {}, getEndpointView: () => {}, layout: () => {}, setStatus: () => {}, refreshDshMenu: () => {},
  connectEndpointAttempt: () => {
    attempts += 1;
    return new Promise((resolve) => { finishAttempt = resolve; });
  }
});
const first = dedupe.connectEndpoint('local');
const second = dedupe.connectEndpoint('local');
assert.strictEqual(first, second);
assert.equal(attempts, 1);
assert.equal(dedupe.appState.currentPage, 'local', 'a shared pending connection returns to its endpoint');
finishAttempt();

// Progress is routed only to the active endpoint/connection generation, so a
// switch cannot leave an old overlay above the new page.
let layouts = 0;
const sends = [];
const overlay = load(['pushStartupProgress', 'hideStartupOverlay'], {
  startupState: { endpointId: 'local', sequence: 4, phase: 'checking', detail: '' },
  startupView: { webContents: { isDestroyed: () => false, send: (_c, payload) => sends.push(payload) } },
  layout: () => { layouts += 1; }
});
overlay.pushStartupProgress({ id: 'local' }, 4, 'loading', 'loading page');
assert.equal(sends.length, 1);
overlay.pushStartupProgress({ id: 'wsl' }, 4, 'loading', 'stale');
assert.equal(sends.length, 1);
overlay.hideStartupOverlay('wsl', 4);
assert.equal(layouts, 0);
overlay.hideStartupOverlay('local', 4);
assert.equal(layouts, 1);

// A page-load timeout becomes the existing router error state, which exposes
// retry; it does not leave a permanent progress surface.
let timedOut = '';
const timeout = load(['failStartupPageLoad'], {
  process: { platform: 'linux' },
  appState: { currentPage: 'local', url: 'http://127.0.0.1:3080' },
  hideStartupOverlay: () => {}, loadWeb: (url) => { timedOut = url; },
  routerUrl: (_id, status) => 'router://' + status,
  wslRouterUrl: () => 'router://wsl', setStatus: () => {}, pushPureInfo: () => {}
});
const timeoutEndpoint = { id: 'local', name: 'Windows', kind: 'local', _connectSequence: 7, status: 'online', detail: '' };
timeout.failStartupPageLoad(timeoutEndpoint, 7, 'timeout');
assert.equal(timeoutEndpoint.status, 'error');
assert.equal(timedOut, 'router://error');

// Exercise the production timer itself: a navigation that never finishes
// reaches the router error path, while a completed navigation clears it.
function mockContents() {
  const listeners = new Map();
  return {
    _startupNavigationSequence: 7,
    isDestroyed: () => false,
    on: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    loadURL: () => Promise.resolve(),
    finish: () => listeners.get('did-finish-load') && listeners.get('did-finish-load')()
  };
}
let timeoutCallback;
let timeoutFailure = '';
const timedContents = mockContents();
const pageTimer = load(['loadStartupPage'], {
  PAGE_LOAD_TIMEOUT_MS: 1,
  webView: { webContents: timedContents },
  startupState: { endpointId: 'local', sequence: 7 },
  setTimeout: (fn) => { timeoutCallback = fn; return 1; }, clearTimeout: () => {},
  failStartupPageLoad: (_ep, _seq, detail) => { timeoutFailure = detail; }
});
pageTimer.loadStartupPage({ id: 'local' }, 7, 'http://127.0.0.1:3080');
timeoutCallback();
assert.match(timeoutFailure, /加载超时/);

let cleared = 0;
const completeContents = mockContents();
const pageComplete = load(['loadStartupPage'], {
  PAGE_LOAD_TIMEOUT_MS: 1,
  webView: { webContents: completeContents },
  startupState: { endpointId: 'local', sequence: 7 },
  setTimeout: () => 1, clearTimeout: () => { cleared += 1; }, failStartupPageLoad: () => { throw new Error('must not time out'); }
});
pageComplete.loadStartupPage({ id: 'local' }, 7, 'http://127.0.0.1:3080');
completeContents.finish();
assert.equal(cleared, 1, 'finished backend navigation clears its page-load timer');

// First-paint/replay, real-document completion, and explicit retry remain
// guarded in production source (the latter is sender-validated in main.js).
assert.match(source, /Promise\.all\(ready\)\.then\([\s\S]{0,180}runStartupPreference\(\)/);
assert.match(source, /startupView\.webContents\.on\('did-finish-load'[\s\S]{0,300}router:startup-progress/);
assert.match(source, /v\.webContents\._startupNavigationSequence === startupState\.sequence/);
assert.match(source, /PAGE_LOAD_TIMEOUT_MS/);
assert.match(source, /ipcMain\.on\('router:retry'/);

console.log('selftest-startup: startup shell, dedupe, overlay and timeout checks passed');
