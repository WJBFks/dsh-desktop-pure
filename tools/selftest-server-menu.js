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
  const context = vm.createContext(Object.assign({ Object, Boolean, URL, Promise, Date }, extra));
  vm.runInContext(names.map(extract).join('\n'), context);
  return context;
}

const local = { id: 'local', kind: 'local', name: 'Windows', url: 'http://127.0.0.1:3080/', child: { pid: 42 }, childAlive: true, status: 'online' };
const wsl = { id: 'wsl', kind: 'wsl', name: 'WSL', url: 'http://127.0.0.1:13080/', child: null, childAlive: false, status: 'online' };
const custom = { id: 'custom', kind: 'custom', name: '远程', url: 'https://remote.test/', child: null, childAlive: false, status: 'online' };
const state = { currentPage: 'pure', endpoints: [local, wsl, custom], url: local.url };
const labels = load(['currentPageEndpoint', 'pageEndpointRuntimeUrl', 'canSafelyOperatePageServer', 'menuItems'], {
  appState: state,
  getEndpoint: (id) => state.endpoints.find((ep) => ep.id === id) || null,
  customRuntimeUrl: (ep) => ep.url,
  isReusedWindowsAuthEndpoint: () => false,
  nativeTheme: { themeSource: 'system' },
  restarting: false,
  accText: (x) => x
});
let menus = labels.menuItems();
assert.equal(menus.file[3].label, '在系统浏览器中打开');
assert.equal(menus.file[3].enabled, false);
assert.equal(menus.server[0].label, '重启 dsh 服务器');
assert.equal(menus.server[0].enabled, false);
state.currentPage = 'local';
menus = labels.menuItems();
assert.equal(menus.file[3].label, '在系统浏览器中打开 (Windows)');
assert.equal(menus.file[3].enabled, true);
assert.equal(menus.server[0].label, '重启 dsh 服务器 (Windows)');
assert.equal(menus.server[1].label, '关闭 dsh 服务器 (Windows)');
assert.equal(menus.server[1].enabled, true);
state.currentPage = 'wsl';
assert.equal(labels.menuItems().server[1].enabled, false, 'reused WSL has no owned child');
state.currentPage = 'custom';
assert.equal(labels.menuItems().server[0].enabled, false, 'remote is view-only');
state.currentPage = 'pure';
menus = labels.menuItems();
assert.equal(menus.server[0].label, '重启 dsh 服务器', 'returning to Pure removes stale page name');
assert.equal(menus.server[0].enabled, false, 'returning to Pure disables server actions');

async function stopCases() {
  const calls = [];
  const ep = { id: 'local', kind: 'local', name: 'Windows', url: 'http://127.0.0.1:3080/', child: { pid: 77 }, childAlive: true, status: 'online', _connectSequence: 0 };
  const appState = { url: ep.url, child: ep.child, childAlive: true, displayEndpoint: 'local', view: 'web' };
  const ctx = load(['stopCurrentPageServer'], {
    appState,
    currentPageEndpoint: () => ep,
    canSafelyOperatePageServer: () => true,
    forceKillPidAsync: async (pid) => { calls.push(['kill', pid]); return true; },
    stopVerifiedWindowsRecovery: async () => false,
    waitForEndpointPortFree: async () => true,
    clearWindowsRecoveryIfMatches: () => {},
    pushPureInfo: () => {}, setStatus: () => {}, refreshDshMenu: () => {}, layout: () => {},
    loadWeb: (url) => calls.push(['load', url]), routerUrl: () => 'router:offline', wslRouterUrl: () => 'router:wsl'
  });
  assert.equal(await ctx.stopCurrentPageServer(), true);
  assert.deepEqual(calls[0], ['kill', 77]);
  assert.equal(ep.status, 'offline');
  assert.equal(ep.childAlive, false);
  assert.equal(ep.url, null);

  const failed = { id: 'wsl', kind: 'wsl', name: 'WSL', url: 'http://127.0.0.1:13080/', child: { pid: 88 }, childAlive: true, status: 'online', _connectSequence: 0 };
  const failedState = { url: failed.url, child: failed.child, childAlive: true, displayEndpoint: 'wsl', view: 'web' };
  const failure = load(['stopCurrentPageServer'], {
    appState: failedState, currentPageEndpoint: () => failed, canSafelyOperatePageServer: () => true,
    forceKillPidAsync: async () => true, stopVerifiedWindowsRecovery: async () => false,
    waitForEndpointPortFree: async () => false, clearWindowsRecoveryIfMatches: () => {},
    pushPureInfo: () => {}, setStatus: () => {}, refreshDshMenu: () => {}, layout: () => {},
    loadWeb: (url) => calls.push(['failure', url]), routerUrl: () => 'router:error', wslRouterUrl: () => 'router:wsl'
  });
  assert.equal(await failure.stopCurrentPageServer(), false);
  assert.equal(failed.status, 'error', 'no confirmed stop must remain visible as an error');
  assert.equal(failed.childAlive, false);

  let killed = false;
  const notOwned = load(['stopCurrentPageServer'], {
    currentPageEndpoint: () => custom, canSafelyOperatePageServer: () => false,
    forceKillPidAsync: async () => { killed = true; return true; }
  });
  assert.equal(await notOwned.stopCurrentPageServer(), false);
  assert.equal(killed, false, 'remote/unowned endpoint is never killed');
}

async function tcpCloseConfirmation() {
  function fakeNet(event, payload) {
    return {
      connect: () => {
        const listeners = {};
        const socket = {
          once: (name, callback) => { listeners[name] = callback; return socket; },
          setTimeout: (_ms, callback) => { listeners.timeout = callback; },
          destroy: () => {}
        };
        queueMicrotask(() => listeners[event](payload));
        return socket;
      }
    };
  }
  for (const [event, payload, expected] of [
    ['error', { code: 'ECONNREFUSED' }, true],
    ['error', { code: 'ETIMEDOUT' }, false],
    ['connect', undefined, false],
    ['timeout', undefined, false]
  ]) {
    const tcp = load(['tcpPortRefused'], { net: fakeNet(event, payload) });
    assert.equal(await tcp.tcpPortRefused('192.0.2.1', 3080, 1), expected, event + ' close classification');
  }
}

Promise.all([stopCases(), tcpCloseConfirmation()]).then(() => {
  assert.match(source, /function isMenuSender[\s\S]{0,500}menu\.html/);
  assert.match(source, /ipcMain\.on\('menu:action', \(event, id\) => \{\s*if \(!isMenuSender\(event\)\) return;/);
  assert.match(source, /localTarget && Number\.isInteger\(port\) && \(await findPortOwnerAsync\(port\)\)/);
  assert.match(source, /err\.code === 'ECONNREFUSED'/);
  assert.match(source, /if \(options\.ownedOnly\) throw new Error/);
  console.log('selftest-server-menu: labels, guards, owned stop and failure handling passed');
}, (error) => {
  console.error(error);
  process.exitCode = 1;
});
