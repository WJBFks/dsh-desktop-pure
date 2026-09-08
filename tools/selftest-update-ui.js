'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extract(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

function element(tag) {
  return {
    tagName: tag, children: [], childNodes: [], hidden: false, disabled: false,
    textContent: '', className: '', type: '', listeners: Object.create(null),
    appendChild(child) { this.children.push(child); this.childNodes.push(child); return child; },
    replaceChildren() { this.children = []; this.childNodes = []; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelectorAll(selector) {
      const found = [];
      function visit(node) {
        if (node && node.tagName === 'button' && selector === 'button') found.push(node);
        if (node && node.children) node.children.forEach(visit);
      }
      this.children.forEach(visit); return found;
    }
  };
}

const html = fs.readFileSync(path.join(__dirname, '..', 'pure.html'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'purepreload.js'), 'utf8');
assert.match(preload, /checkUpdate\(\)\s*\{\s*return ipcRenderer\.invoke\('pure:check-update'\)/);
assert.match(preload, /downloadUpdate\(assetId\)[\s\S]*?ipcRenderer\.invoke\('pure:download-update', assetId\)/);

const status = element('p'); const assets = element('div'); const check = element('button'); const releases = element('button'); const appVersion = element('span');
const panel = { classList: { active: false, toggle(_name, value) { this.active = value; } } };
let checkCalls = 0; let downloadCalls = 0; let resolveCheck;
const shownSections = [];
const context = vm.createContext({
  Number, isFinite, Array, Object, String, Promise,
  document: { createElement: element, createTextNode: (text) => ({ textContent: String(text) }) },
  updateStatus: status, updateAssets: assets, updatePanel: panel, btnCheckUpdate: check, btnOpenReleases: releases, valAppVersion: appVersion,
  updateBusy: false, updateChecking: false, updateDownloading: false, updateResult: null, updateRequest: 0,
  releaseUpdateRevision: -1, releaseUpdatePayloadSignature: '', releaseUpdateSignature: '',
  showPane(section) { shownSections.push(section); },
  api: {
    checkUpdate() { checkCalls++; return new Promise((resolve) => { resolveCheck = resolve; }); },
    downloadUpdate(id) { downloadCalls++; assert.equal(id, 7); return Promise.resolve({ ok: true }); },
    openExternal(url) { assert.equal(url, 'https://github.com/WJBFks/dsh-desktop-pure/releases'); }
  }
});
vm.runInContext([
  extract(html, 'formatAssetSize'), extract(html, 'applyUpdateBusy'), extract(html, 'clearUpdateAssets'),
  extract(html, 'applyUpdateAttention'), extract(html, 'applyUpdateBusy'), extract(html, 'syncUpdateBusy'), extract(html, 'releaseResultSignature'), extract(html, 'updateErrorMessage'), extract(html, 'renderUpdateResult'), extract(html, 'checkForUpdate'), extract(html, 'applyReleaseUpdate'), extract(html, 'downloadUpdate'), extract(html, 'bindUpdateControls'), extract(html, 'handleRequestedSection')
].join('\n'), context, { filename: 'pure.html (update UI)' });

async function run() {
  context.bindUpdateControls();
  context.handleRequestedSection('about'); context.handleRequestedSection('appearance');
  assert.deepEqual(shownSections, ['about'], 'titlebar navigation opens only the About section');
  const pending = check.listeners.click();
  assert.equal(check.disabled, true, 'checking disables repeat click');
  await Promise.resolve(); assert.equal(checkCalls, 1);
  await check.listeners.click(); assert.equal(checkCalls, 1, 'busy click is deduplicated');
  resolveCheck({ ok: true, currentVersion: '0.4.0', latestVersion: '0.5.0', status: 'update', assets: [{ id: 7, name: '<unsafe>.exe', size: 2048 }] });
  await pending;
  assert.equal(appVersion.textContent, 'v0.4.0'); assert.equal(assets.hidden, false);
  assert.equal(panel.classList.active, true, 'new version highlights the complete update panel');
  assert.equal(assets.children[0].children[0].textContent, '<unsafe>.exe', 'asset is plain text, not HTML');
  const download = assets.children[0].children[1];
  const downloading = download.listeners.click(); assert.equal(download.disabled, true, 'download shares busy lock');
  await downloading; assert.equal(downloadCalls, 1); assert.match(status.textContent, /系统浏览器/);
  context.renderUpdateResult({ ok: false, error: 'GitHub 500' });
  assert.equal(assets.hidden, true); assert.equal(assets.childNodes.length, 0, 'failure never retains old downloadable assets');
  assert.equal(status.textContent, 'GitHub 500');
  assert.equal(panel.classList.active, false, 'a non-update result clears the attention highlight');
  context.renderUpdateResult({ ok: true, status: 'current', currentVersion: '0.4.0' });
  assert.match(status.textContent, /最新/);
  context.renderUpdateResult({ ok: true, status: 'ahead', currentVersion: '0.5.0' });
  assert.match(status.textContent, /高于/);
  context.renderUpdateResult({ ok: true, status: 'none' });
  assert.match(status.textContent, /Release/);
  context.applyReleaseUpdate({ revision: 10, checking: false, result: { ok: true, currentVersion: '0.4.0', latestVersion: '0.5.0', status: 'update', updateAvailable: true, assets: [] } });
  assert.equal(panel.classList.active, true, 'pushed automatic result reuses the update renderer');
  context.applyReleaseUpdate({ revision: 11, checking: false, result: { ok: true, status: 'current', updateAvailable: false } });
  assert.equal(panel.classList.active, false, 'automatic current result clears the highlight');
  context.applyReleaseUpdate({ revision: 20, checking: true, result: null });
  assert.equal(check.disabled, true, 'backend checking state disables repeat manual checks');
  assert.equal(context.updateBusy, true);
  context.applyReleaseUpdate({ revision: 21, checking: false, result: { ok: true, status: 'current', updateAvailable: false } });
  assert.equal(check.disabled, false, 'terminal pushed state restores controls');
  context.updateDownloading = true; context.syncUpdateBusy();
  context.applyReleaseUpdate({ revision: 21, checking: false, result: { ok: true, status: 'current', updateAvailable: false } });
  assert.equal(context.updateBusy, true, 'duplicate revision cannot interrupt an in-progress download');
  context.updateDownloading = false; context.syncUpdateBusy();
  context.api.checkUpdate = () => Promise.resolve({ ok: false, error: 'rate_limited' });
  await context.checkForUpdate();
  assert.match(status.textContent, /请求过于频繁/); assert.equal(context.updateBusy, false);
  assert.equal(assets.childNodes.length, 0, 'a failed recheck clears the previous assets');
  context.api.checkUpdate = () => Promise.resolve({ ok: false, error: 'invalid_response' });
  await context.checkForUpdate();
  assert.equal(status.textContent, 'GitHub返回的版本信息格式异常，请稍后重试。');
  context.api.checkUpdate = () => Promise.reject(new Error('network failure'));
  await context.checkForUpdate();
  assert.match(status.textContent, /无法检查更新/); assert.equal(check.disabled, false, 'rejection restores controls');
  context.api.checkUpdate = () => { throw new Error('synchronous failure'); };
  await context.checkForUpdate();
  assert.equal(context.updateBusy, false, 'synchronous IPC throw restores busy state');
  context.renderUpdateResult({ ok: true, currentVersion: '0.4.0', latestVersion: '0.5.0', status: 'update', assets: [{ id: 7, name: 'installer.exe', size: 1 }] });
  context.api.downloadUpdate = () => { throw new Error('synchronous download failure'); };
  const failedDownload = assets.children[0].children[1].listeners.click();
  assert.equal(assets.children[0].children[1].disabled, true);
  await failedDownload;
  assert.equal(context.updateBusy, false, 'synchronous download throw restores busy state');
  assert.match(status.textContent, /无法打开下载/);
  let resolveLate;
  context.api.checkUpdate = () => new Promise((resolve) => { resolveLate = resolve; });
  const lateCheck = context.checkForUpdate(); await Promise.resolve();
  context.applyReleaseUpdate({ revision: 22, checking: false, result: { ok: true, status: 'current', updateAvailable: false } });
  resolveLate({ ok: true, status: 'update', updateAvailable: true, latestVersion: '9.9.9', assets: [] });
  await lateCheck;
  assert.match(status.textContent, /最新/, 'an older manual response cannot overwrite a pushed result');
  console.log('update UI self-test passed');
}
run().catch((error) => { console.error(error); process.exit(1); });
