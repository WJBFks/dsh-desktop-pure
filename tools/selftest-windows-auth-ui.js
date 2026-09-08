'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '('); assert.notEqual(start, -1);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i++) { if (source[i] === '{') depth++; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
  throw new Error('unterminated ' + name);
}

const router = fs.readFileSync(path.join(__dirname, '..', 'router.html'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
assert.match(preload, /windowsConnectAuth\(input\)[\s\S]*ipcRenderer\.invoke\('router:windows-connect-auth'/);
assert.match(preload, /windowsForceStart\(\)[\s\S]*ipcRenderer\.invoke\('router:windows-force-start'/);
assert.match(router, /p\.get\('authRequired'\) === 'true' \|\| p\.get\('authRequired'\) === '1'/, 'initial query accepts main\'s 1/0 encoding');
assert.match(router, /完整认证 URL 或 Token/);
assert.match(router, /type="password" autocomplete="off"/);
assert.match(router, /data-action="forcestart"/);
assert.match(router, /shell\.windowsConnectAuth\(input\.value\)/);
assert.match(router, /authChanged/);
assert.doesNotMatch(router, /localStorage|sessionStorage/);
const context = vm.createContext({});
vm.runInContext(extractFunction(router, 'authFailureMessage'), context);
assert.equal(context.authFailureMessage({ cancelled: true }), '', 'native confirmation cancellation is not an error');
assert.equal(context.authFailureMessage({ error: 'denied' }), 'denied');
assert.equal(context.authFailureMessage(null), '操作失败，请重试。');
const input = { disabled: false }; const first = { disabled: false }; const second = { disabled: false };
const dom = { getElementById: (id) => id === 'winAuthInput' ? input : null, querySelectorAll: () => [first, second] };
vm.runInContext(extractFunction(router, 'applyWindowsAuthControlState'), vm.createContext({}));
const controlContext = vm.createContext({});
vm.runInContext([extractFunction(router, 'authFailureMessage'), extractFunction(router, 'applyWindowsAuthControlState'), extractFunction(router, 'submitWindowsAuth')].join('\n'), controlContext);
controlContext.applyWindowsAuthControlState(dom, true, false);
assert.equal(input.disabled, true); assert.equal(first.disabled, true); assert.equal(second.disabled, true, 'pending survives a busy=false refresh');
controlContext.applyWindowsAuthControlState(dom, false, false);
assert.equal(input.disabled, false); assert.equal(first.disabled, false);
first.disabled = false; second.disabled = false; // Simulates the generic footer retry/recheck loop.
controlContext.applyWindowsAuthControlState(dom, true, false);
assert.equal(first.disabled, true); assert.equal(second.disabled, true, 'final auth pass re-disables footer controls');
async function authActionChecks() {
  var pending = false; var calls = 0; var field = { value: 'token-value' }; var error = { textContent: '', hidden: true };
  var shell = { windowsConnectAuth: function () { calls++; return Promise.resolve({ ok: false, error: 'bad token' }); }, windowsForceStart: function () { calls++; return Promise.resolve({ cancelled: true }); } };
  await controlContext.submitWindowsAuth('connectauth', shell, field, error, function () { return pending; }, function (value) { pending = value; });
  assert.equal(calls, 1); assert.equal(field.value, 'token-value', 'failed connect retains input'); assert.equal(error.textContent, 'bad token'); assert.equal(pending, false);
  error.textContent = ''; error.hidden = true;
  await controlContext.submitWindowsAuth('forcestart', shell, field, error, function () { return pending; }, function (value) { pending = value; });
  assert.equal(error.textContent, '', 'cancelled native confirmation is silent');
  shell.windowsConnectAuth = function () { calls++; return Promise.resolve({ ok: true }); };
  await controlContext.submitWindowsAuth('connectauth', shell, field, error, function () { return pending; }, function (value) { pending = value; });
  assert.equal(field.value, '', 'successful connect clears input');
}
assert.match(router, /var authPending = false;/, 'pending is scoped to the whole Windows guide');
assert.match(router, /applyWindowsAuthControlState\(document, authPending, winLive\.busy\)/, 'refresh uses pending plus busy');
assert.ok(router.lastIndexOf('applyWindowsAuthControlState(document, authPending, winLive.busy)') > router.lastIndexOf('data-action="recheck"], [data-action="retry"'), 'auth control pass follows generic footer refresh');
assert.match(router, /手动启动[\s\S]*我已启动，重新检测/, 'auth branch retains manual/recheck recovery');
authActionChecks().then(function () { console.log('windows auth UI self-test passed'); }).catch(function (error) { console.error(error); process.exit(1); });
