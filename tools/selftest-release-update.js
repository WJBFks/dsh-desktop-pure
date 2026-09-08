'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { API_URL, RELEASES_URL, compareSemver, checkLatestRelease } = require('../release-update.js');

function response(body, status = 200) { return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function release(tag, assets = []) { return { tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/WJBFks/dsh-desktop-pure/releases/tag/${tag}`, assets }; }

function extractHandle(source, channel) {
  const start = source.indexOf("ipcMain.handle('" + channel + "'"); assert.notEqual(start, -1, 'missing ' + channel);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}' && --depth === 0) return source.slice(start, source.indexOf(');', i) + 2); }
  throw new Error('unterminated ' + channel);
}
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(') >= 0 ? source.indexOf('function ' + name + '(') : source.indexOf('async function ' + name + '(');
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', source.indexOf(')', start)); let depth = 0;
  for (let i = body; i < source.length; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
  throw new Error('unterminated ' + name);
}
function extractOn(source, channel) {
  const start = source.indexOf("ipcMain.on('" + channel + "'"); assert.notEqual(start, -1, 'missing ' + channel);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}' && --depth === 0) return source.slice(start, source.indexOf(');', i) + 2); }
  throw new Error('unterminated ' + channel);
}

async function main() {
  assert.equal(compareSemver('0.4.0', 'v0.4.1'), -1);
  assert.equal(compareSemver('0.4.0', 'v0.4.0-beta.2'), 1);
  assert.equal(compareSemver('0.4.0-rc.2', '0.4.0-rc.10'), -1);
  assert.equal(compareSemver('0.5.0', '0.4.9'), 1);
  let requested = '';
  const result = await checkLatestRelease('0.4.0', { fetchImpl: async (url, init) => {
    requested = url; assert.equal(init.redirect, 'error'); return response(release('v0.4.1', [
      { id: 1, name: 'safe.exe', size: 42, browser_download_url: 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v0.4.1/safe.exe' },
      { id: 2, name: 'evil.exe', size: 42, browser_download_url: 'https://evil.test/file.exe' },
      { id: 3, name: 'latest.yml', size: 42, browser_download_url: 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v0.4.1/latest.yml' },
      { id: 4, name: 'portable.zip', size: 42, browser_download_url: 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v0.4.1/portable.zip' },
      { id: 5, name: 'wrong-tag.exe', size: 42, browser_download_url: 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v0.3.0/wrong-tag.exe' }
    ]));
  } });
  assert.equal(requested, API_URL); assert.equal(result.status, 'update'); assert.equal(result.latestVersion, '0.4.1');
  assert.deepEqual(result.assets, [{ id: 1, name: 'safe.exe', size: 42 }, { id: 4, name: 'portable.zip', size: 42 }]);
  assert.equal(Object.keys(result).includes('assetUrls'), false, 'download URL map is not serializable');
  assert.equal(result.assetUrls.get(1).includes('safe.exe'), true);
  const ahead = await checkLatestRelease('0.5.0', { fetchImpl: async () => response(release('v0.4.1', [{ id: 8, name: 'old.exe', size: 1, browser_download_url: 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v0.4.1/old.exe' }])) });
  assert.equal(ahead.status, 'ahead'); assert.deepEqual(ahead.assets, [], 'ahead never exposes downgrade assets'); assert.equal(ahead.assetUrls.size, 0);
  assert.equal((await checkLatestRelease('0.4.0', { fetchImpl: async () => response(null, 404) })).status, 'none');
  assert.match((await checkLatestRelease('0.4.0', { fetchImpl: async () => response(null, 403) })).error, /GitHub 请求限流/);
  assert.match((await checkLatestRelease('0.4.0', { fetchImpl: async () => response(null, 429) })).error, /GitHub 请求限流/);
  assert.equal((await checkLatestRelease('0.4.0', { maxBytes: 32, fetchImpl: async () => response(release('v0.4.1')) })).error, 'response_too_large');
  assert.equal((await checkLatestRelease('0.4.0', { fetchImpl: async () => response({ tag_name: 'not-semver' }) })).error, 'invalid_response');
  assert.equal((await checkLatestRelease('0.4.0', { fetchImpl: async () => { throw new Error('offline'); } })).error, 'offline');
  assert.equal((await checkLatestRelease('0.4.0', { fetchImpl: async () => response({ ...release('v9.9.9'), prerelease: true }) })).status, 'none');

  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'); let handlers = {};
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, Number, Map, Promise,
    isPureSender: (event) => event && event.trusted === true,
    refreshReleaseUpdate: async () => ({ ok: true, assets: [] }),
    verifiedReleaseAssets: new Map([[7, 'https://github.com/WJBFks/dsh-desktop-pure/releases/download/v/safe.exe']]),
    shell: { openExternal: async (url) => { context.opened = url; } }
  });
  vm.runInContext(extractHandle(source, 'pure:check-update') + '\n' + extractHandle(source, 'pure:download-update'), context);
  assert.equal((await handlers['pure:check-update']({ trusted: false })).ok, false);
  assert.equal((await handlers['pure:download-update']({ trusted: true }, 8)).ok, false);
  assert.equal((await handlers['pure:download-update']({ trusted: true }, 7)).ok, true);
  assert.match(context.opened, /^https:\/\/github\.com\/WJBFks\/dsh-desktop-pure\/releases\/download\//);
  context.shell.openExternal = async () => { throw new Error('no launcher'); };
  const launchFailure = await handlers['pure:download-update']({ trusted: true }, 7);
  assert.equal(launchFailure.ok, false); assert.match(launchFailure.error, /无法打开下载器/);
  assert.equal(RELEASES_URL, 'https://github.com/WJBFks/dsh-desktop-pure/releases');

  let autoCalls = 0;
  const autoContext = vm.createContext({ Promise, releaseAutoRefreshStarted: false, refreshReleaseUpdate: () => { autoCalls += 1; return Promise.resolve(); } });
  vm.runInContext(extractFunction(source, 'startAutomaticReleaseUpdate'), autoContext);
  autoContext.startAutomaticReleaseUpdate(); assert.equal(autoCalls, 0, 'automatic refresh never blocks the shell-ready turn');
  await Promise.resolve(); assert.equal(autoCalls, 1);
  autoContext.startAutomaticReleaseUpdate(); await Promise.resolve(); assert.equal(autoCalls, 1, 'automatic refresh runs once per process');

  const state = { checking: false, result: { ok: true, updateAvailable: true, status: 'update', assets: [], releaseUrl: RELEASES_URL } };
  const refreshContext = vm.createContext({
    Map, Promise, app: { getVersion: () => '0.4.0' }, releaseCheckInFlight: null, verifiedReleaseAssets: new Map([[1, 'old']]),
    releaseUpdateState: state, checkLatestRelease: async () => ({ ok: false, updateAvailable: false, status: 'none', assets: [], releaseUrl: RELEASES_URL, error: 'offline' }),
    releaseUpdatePublicResult: (value) => value, publishReleaseUpdate: () => { refreshContext.publishes = (refreshContext.publishes || 0) + 1; }
  });
  vm.runInContext(extractFunction(source, 'refreshReleaseUpdate'), refreshContext);
  const refreshing = refreshContext.refreshReleaseUpdate();
  assert.equal(state.checking, true); assert.equal(state.result, null); assert.equal(refreshContext.verifiedReleaseAssets.size, 0, 'refresh immediately clears old update authorization/highlight');
  await refreshing; assert.equal(state.checking, false); assert.equal(state.result.updateAvailable, false); assert.equal(refreshContext.publishes, 2, 'checking and terminal state are broadcast');

  let aboutHandler; let entered = 0; let flushed = 0;
  const titleContext = vm.createContext({
    ipcMain: { on: (_name, handler) => { aboutHandler = handler; } },
    isTitlebarSender: (event) => event && event.trusted === true,
    releaseUpdateState: { result: { ok: true, updateAvailable: true } }, pendingPureSection: null,
    enterPureView: () => { entered += 1; }, flushPendingPureSection: () => { flushed += 1; }
  });
  vm.runInContext(extractOn(source, 'titlebar:open-update-about'), titleContext);
  aboutHandler({ trusted: false }); assert.equal(entered, 0, 'untrusted titlebar sender cannot navigate');
  aboutHandler({ trusted: true }); assert.equal(entered, 1); assert.equal(titleContext.pendingPureSection, 'about'); assert.equal(flushed, 1);
  assert.match(source, /isLoadingMainFrame/, 'about selection remains pending while Pure is loading');
  assert.match(source, /titlebar:release-update/, 'late titlebar loads receive the current snapshot');
  assert.match(source, /releaseUpdate: releaseUpdateSnapshot\(\)/, 'get-info includes the current snapshot');
  console.log('selftest-release-update: version, errors, asset boundary and trusted IPC passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
