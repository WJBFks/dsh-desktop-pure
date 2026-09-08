'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractFunction(name) {
  const plain = source.indexOf('function ' + name + '(');
  const async = source.indexOf('async function ' + name + '(');
  const start = async !== -1 ? async : plain;
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

function load(names, extra) {
  const context = vm.createContext(Object.assign({ Promise, Set }, extra));
  vm.runInContext(names.map(extractFunction).join('\n'), context);
  return context;
}

function extractHandle(channel) {
  const start = source.indexOf("ipcMain.handle('" + channel + "'");
  assert.notEqual(start, -1, 'missing IPC handler ' + channel);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, source.indexOf(');', i) + 2);
  }
  throw new Error('unterminated IPC handler ' + channel);
}

function set(context, expression) { vm.runInContext(expression, context); }

// Invalid/corrupt settings never become an implicit preference; write failure
// is returned to the caller rather than pretending to save.
const files = new Map();
const storage = load(['startupFile', 'loadStartupPagePreference', 'saveStartupPagePreference'], {
  path: path.win32, app: { getPath: () => 'C:\\UserData' },
  fs: {
    readFileSync: (file) => { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    writeFileSync: (file, value) => files.set(file, value)
  },
  STARTUP_PAGES: new Set(['pure', 'local', 'wsl']), startupPagePreference: null
});
files.set(storage.startupFile(), '{bad');
assert.equal(storage.loadStartupPagePreference(), null);
assert.equal(storage.saveStartupPagePreference('remote').ok, false);
assert.equal(storage.saveStartupPagePreference('local').ok, true);
assert.match(files.get(storage.startupFile()), /"local"/);

// Startup decision: saved local is immediate; first-run Windows waits for a
// confirmed WSL probe, prompts only when available, and never treats unknown
// as absent. A missing WSL falls back locally without persisting a default.
async function flowCase({ page, platform, info, available }) {
  const calls = [];
  const ep = { id: 'wsl', wsl: available ? { installed: true } : null };
  const flow = load(['wslStartupAvailable', 'runStartupPreference'], {
    process: { platform }, startupPagePreference: page, startupFlowStarted: false, startupFlowGeneration: 0,
    startupPromptActive: false,
    getEndpoint: (id) => id === 'wsl' && platform === 'win32' ? ep : null,
    pushPureInfo: () => calls.push('push'), detectWslEndpoint: async () => info,
    connectEndpoint: (id) => { calls.push('connect:' + id); return Promise.resolve(); },
    enterPureView: (reason) => calls.push('pure:' + reason)
  });
  await flow.runStartupPreference();
  return { calls, prompt: vm.runInContext('startupPromptActive', flow) };
}

(async () => {
  assert.deepEqual((await flowCase({ page: 'local', platform: 'win32' })).calls, ['connect:local']);
  const chooser = await flowCase({ page: null, platform: 'win32', info: { installed: true }, available: true });
  assert.equal(chooser.prompt, true);
  assert.equal(chooser.calls.includes('connect:local'), false);
  const unknown = await flowCase({ page: null, platform: 'win32', info: { installed: null, error: 'timeout' }, available: false });
  assert.equal(unknown.calls.includes('connect:local'), true, 'unknown WSL falls back locally without persisting');
  assert.equal((await flowCase({ page: null, platform: 'win32', info: null, available: false })).calls.includes('connect:local'), true, 'superseded WSL probe also falls back locally');
  assert.deepEqual((await flowCase({ page: null, platform: 'linux' })).calls, ['connect:local']);

  // A late probe must not reopen the chooser after the user saved a setting.
  let settleProbe;
  let stalePrompt = false;
  const stale = load(['wslStartupAvailable', 'runStartupPreference'], {
    process: { platform: 'win32' }, startupPagePreference: null, startupFlowStarted: false, startupFlowGeneration: 0,
    startupPromptActive: false, getEndpoint: () => ({ wsl: { installed: true } }),
    pushPureInfo: () => {}, detectWslEndpoint: () => new Promise((resolve) => { settleProbe = resolve; }),
    connectEndpoint: () => Promise.resolve(), enterPureView: () => {}
  });
  const staleRun = stale.runStartupPreference();
  set(stale, "startupPagePreference = 'local'; startupFlowGeneration += 1;");
  settleProbe({ installed: true });
  await staleRun;
  stalePrompt = vm.runInContext('startupPromptActive', stale);
  assert.equal(stalePrompt, false, 'stale WSL result cannot override a saved choice');

  // IPC handlers are sender-gated. Null chooses local for this run without
  // persistence; a failed save never starts a page as though it succeeded.
  const handlers = {};
  let saved = 0;
  const ipc = vm.createContext({
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    isPureSender: (event) => event && event.trusted === true,
    STARTUP_PAGES: new Set(['pure', 'local', 'wsl']), wslStartupAvailable: () => false,
    saveStartupPagePreference: () => { saved += 1; return { ok: false, error: 'disk' }; },
    startupPromptActive: true, pushPureInfo: () => {}, enterPureView: () => {},
    connectEndpoint: () => { throw new Error('must not connect after failed save'); }
  });
  vm.runInContext(extractHandle('pure:set-startup-page'), ipc);
  vm.runInContext(extractHandle('pure:choose-startup-page'), ipc);
  assert.equal(handlers['pure:set-startup-page']({}, 'local').ok, false, 'untrusted sender rejected');
  assert.equal(handlers['pure:set-startup-page']({ trusted: true }, 'wsl').ok, false, 'unavailable WSL rejected');
  assert.equal(handlers['pure:set-startup-page']({ trusted: true }, 'local').ok, false, 'save failure returned');
  assert.equal(saved, 1);
  let chosen = '';
  ipc.connectEndpoint = (id) => { chosen = id; return Promise.resolve(); };
  assert.equal(handlers['pure:choose-startup-page']({ trusted: true }, null).ok, true);
  assert.equal(chosen, 'local');
  console.log('selftest-startup-preferences: persistence, decision and IPC guards passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
