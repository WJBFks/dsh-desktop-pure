'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extract(source, name) {
  const start = source.indexOf('function ' + name + '('); assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i++) { if (source[i] === '{') depth++; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
  throw new Error('unterminated ' + name);
}
const html = fs.readFileSync(path.join(__dirname, '..', 'pure.html'), 'utf8');
const url = { value: '', type: 'text', placeholder: '' }; const token = { value: '', type: 'text', placeholder: '' };
const clear = { checked: true }; const visibility = { textContent: '隐藏' }; const error = { textContent: '', hidden: true };
const context = vm.createContext({ epFormUrl: url, epFormToken: token, clearToken: clear, tokenVisibility: visibility, epFormErr: error, URL });
vm.runInContext([extract(html, 'clearTokenForm'), extract(html, 'splitTokenUrl'), extract(html, 'absorbUrlToken')].join('\n'), context, { filename: 'pure.html (remote token)' });
const split = context.splitTokenUrl('https://example.test/dsh?a=1&token=secret&b=2');
assert.equal(split.url, 'https://example.test/dsh?a=1&b=2'); assert.equal(split.token, 'secret');
assert.ok(context.splitTokenUrl('https://example.test/?token=a&token=b').error, 'duplicate URL tokens are rejected');
url.value = 'https://example.test/dsh?a=1&token=secret&b=2'; token.value = '';
assert.equal(context.absorbUrlToken(), true); assert.equal(url.value, 'https://example.test/dsh?a=1&b=2'); assert.equal(token.value, 'secret');
url.value = 'https://example.test/dsh?token=from-url'; token.value = 'from-field'; error.hidden = true;
assert.equal(context.absorbUrlToken(), false); assert.match(error.textContent, /冲突/); assert.equal(token.value, 'from-field');
context.clearTokenForm(); assert.equal(token.value, ''); assert.equal(token.type, 'password'); assert.equal(clear.checked, false); assert.equal(visibility.textContent, '显示');
assert.match(html, /openEndpointBrowser\(ep\.id\)/, 'custom browser opens by endpoint id');
assert.match(html, /Promise\.resolve\(api\.openEndpointBrowser\(ep\.id\)\)/, 'endpoint browser result is handled');
const preload = fs.readFileSync(path.join(__dirname, '..', 'purepreload.js'), 'utf8');
assert.match(preload, /ipcRenderer\.invoke\('pure:open-endpoint-browser'/, 'endpoint browser IPC must match main handle()');
assert.match(html, /patch\.token = ''/, 'explicit clear token patch is supported');
assert.match(html, /hasToken/, 'editor only receives token presence metadata');
assert.match(html, /clearToken\.checked = false/, 'new token and clear are not silently combined');
console.log('remote token UI self-test passed');
