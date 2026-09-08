'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(name) {
  const asyncAt = source.indexOf('async function ' + name + '(');
  const plainAt = source.indexOf('function ' + name + '(');
  const start = asyncAt !== -1 ? asyncAt : plainAt;
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
  const c = vm.createContext(Object.assign({ URL, Buffer, Set, Object }, extra));
  vm.runInContext(names.map(extract).join('\n'), c);
  return c;
}

const crypto = load(['normalizeEndpointUrl', 'customTokenStorageAvailable', 'encryptCustomToken', 'decryptCustomToken', 'validCustomToken', 'parseCustomEndpoint', 'customRuntimeUrl', 'stripTokenUrl'], {
  process: { platform: 'win32' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('x' + value),
    decryptString: (value) => Buffer.from(value).toString('utf8').slice(1)
  }
});
const pasted = crypto.parseCustomEndpoint('https://host/path/?x=1&token=abc/', undefined);
assert.equal(pasted.ok, true);
assert.equal(pasted.url, 'https://host/path/?x=1');
assert.equal(pasted.token, 'abc/', 'trailing slash in token is preserved');
assert.equal(crypto.parseCustomEndpoint('https://host/?token=a&token=b').ok, false);
assert.equal(crypto.parseCustomEndpoint('https://host/?token=a', 'b').ok, false);
assert.equal(crypto.customRuntimeUrl({ url: pasted.url, token: pasted.token }), 'https://host/path/?x=1&token=abc%2F');
assert.equal(crypto.stripTokenUrl('https://host/?token=secret&x=1'), 'https://host/?x=1');
assert.equal(crypto.decryptCustomToken(crypto.encryptCustomToken('secret')), 'secret');

// Same-origin edits may retain token; cross-origin edits must explicitly
// replace/clear it so no credential is sent to a different server.
const ep = { id: 'one', kind: 'custom', name: 'One', url: 'https://a.test/path', token: 'old', encryptedToken: null, tokenError: false };
const state = { endpoints: [ep], displayEndpoint: null, views: {} };
const edits = load(['normalizeEndpointUrl', 'validCustomToken', 'parseCustomEndpoint', 'sameEndpointOrigin', 'editCustomEndpoint'], {
  URL, appState: state, customTokenStorageAvailable: () => true,
  persistEndpoints: () => true, pushPureInfo: () => {}, enterPureView: () => {}
});
assert.equal(edits.editCustomEndpoint(ep, { url: 'https://a.test/new' }).ok, true);
assert.equal(state.endpoints[0].token, 'old');
assert.equal(edits.editCustomEndpoint(state.endpoints[0], { url: 'https://b.test/new' }).ok, false);
assert.equal(edits.editCustomEndpoint(state.endpoints[0], { url: 'https://b.test/new', token: 'new' }).ok, true);
assert.equal(state.endpoints[0].token, 'new');
assert.equal(edits.editCustomEndpoint(state.endpoints[0], { token: '' }).ok, true);
assert.equal(state.endpoints[0].token, null);

// A pending probe captures the old endpoint object. Replacing that record
// invalidates it, so it cannot later navigate using its old token URL.
const stale = { id: 'stale', _connectSequence: 7, _pendingConnect: Promise.resolve(), status: 'online' };
const staleState = { endpoints: [stale] };
const staleCheck = load(['isCurrentEndpointAttempt'], {
  appState: staleState,
  getEndpoint: (id) => staleState.endpoints.find((item) => item.id === id) || null
});
const replacement = Object.assign({}, stale, {
  _connectSequence: stale._connectSequence + 1,
  _pendingConnect: null,
  status: 'unknown'
});
stale._connectSequence += 1;
staleState.endpoints[0] = replacement;
assert.equal(staleCheck.isCurrentEndpointAttempt(stale, 7), false, 'old pending probe is stale after edit');
assert.equal(staleCheck.isCurrentEndpointAttempt(replacement, replacement._connectSequence), true, 'replacement can connect');

// Persisted and Pure-facing forms are deliberately separate.
assert.match(source, /encryptedToken/);
assert.match(source, /url: stripTokenUrl\(appState\.url\)/);
assert.match(source, /hasToken: e\.kind === 'custom' \? Boolean\(e\.token \|\| e\.encryptedToken\) : false/);
assert.match(source, /status: Object\.assign\({}, currentStatus, \{ url: stripTokenUrl\(currentStatus && currentStatus\.url\) \}\)/);
assert.match(source, /next\._pendingConnect = null/);
assert.match(source, /loadURL\('about:blank'\)/);
assert.match(source, /tokenError[\s\S]{0,120}无法读取/);
assert.match(source, /ipcMain\.handle\('pure:add-endpoint', \(event[\s\S]{0,140}isPureSender/);
assert.match(source, /ipcMain\.handle\('pure:edit-endpoint', \(event[\s\S]{0,120}isPureSender/);
assert.match(source, /ipcMain\.handle\('pure:open-endpoint-browser'/);

async function staleProbeCannotNavigate() {
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  const navigations = [];
  const old = {
    id: 'custom', kind: 'custom', name: 'Remote', url: 'https://a.test/app',
    token: 'old', encryptedToken: null, tokenError: false, status: 'unknown',
    detail: '', wasOnline: false, _connectSequence: 0, _pendingConnect: null,
    childAlive: false
  };
  const state = {
    cfg: { verbose: false }, endpoints: [old], views: {}, url: null,
    displayEndpoint: null, currentPage: null, activeEndpoint: null, view: 'pure'
  };
  const view = { webContents: {
    isDestroyed: () => false,
    stop: () => {},
    loadURL: (url) => { navigations.push(url); return Promise.resolve(); }
  } };
  state.views.custom = view;
  const ctx = load([
    'normalizeEndpointUrl', 'validCustomToken', 'parseCustomEndpoint',
    'sameEndpointOrigin', 'customRuntimeUrl', 'stripTokenUrl',
    'editCustomEndpoint', 'isCurrentEndpointAttempt', 'connectEndpointAttempt'
  ], {
    URL,
    appState: state,
    process: { platform: 'win32' },
    getEndpoint: (id) => state.endpoints.find((item) => item.id === id) || null,
    customTokenStorageAvailable: () => true,
    persistEndpoints: () => true,
    pushPureInfo: () => {}, enterPureView: () => {},
    hideStartupOverlay: () => {}, showStartupOverlay: () => {},
    pushStartupProgress: () => {}, getEndpointView: () => view,
    layout: () => {}, loadWeb: (url) => navigations.push(url),
    routerUrl: () => 'router:starting', wslRouterUrl: () => 'router:wsl',
    windowsRouterUrl: () => 'router:windows', setStatus: () => {},
    showWebOnly: () => {}, refreshDshMenu: () => {}, bindChildExit: () => {},
    loadStartupPage: (_ep, _sequence, url) => navigations.push(url),
    hideStartupOverlay: () => {},
    probeEndpointUrl: async () => probe,
    resolveWslServer: async () => ({}), resolveServerFor: async () => ({})
  });
  const pending = ctx.connectEndpointAttempt('custom');
  await Promise.resolve();
  assert.equal(ctx.editCustomEndpoint(old, { token: 'new' }).ok, true);
  releaseProbe('harness');
  await pending;
  assert.ok(!navigations.some((url) => String(url).includes('token=old')), 'old probe must not navigate old token URL');
  assert.equal(state.endpoints[0].status, 'unknown');
  await ctx.connectEndpointAttempt('custom');
  assert.ok(navigations.some((url) => String(url).includes('token=new')), 'replacement can start a new authenticated connection');
}

staleProbeCannotNavigate().then(() => {
  console.log('selftest-remote-token: parse, encryption, origin boundary, stale probe and redaction passed');
}, (error) => {
  console.error(error);
  process.exitCode = 1;
});
