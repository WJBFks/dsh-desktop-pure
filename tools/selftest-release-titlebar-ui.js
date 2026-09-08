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

const html = fs.readFileSync(path.join(__dirname, '..', 'titlebar.html'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'titlepreload.js'), 'utf8');
assert.match(html, /id="btnReleaseUpdate"[^>]*hidden[^>]*aria-label="发现新版本"/);
assert.match(html, /#wincontrols button\.update-available\[hidden\]\s*\{\s*display:\s*none/);
assert.match(preload, /ipcRenderer\.on\('titlebar:release-update'/);
assert.match(preload, /ipcRenderer\.send\('titlebar:open-update-about'\)/);

let hitboxes = 0; let openAbout = 0;
const button = { hidden: true, listener: null, addEventListener(_name, callback) { this.listener = callback; } };
const context = vm.createContext({
  Object, Boolean, String, Number,
  btnReleaseUpdate: button, releaseUpdateRevision: -1, releaseUpdatePayloadSignature: '',
  reportStatusHitbox() { hitboxes++; }, api: { openUpdateAbout() { openAbout++; } }
});
vm.runInContext([extract(html, 'applyReleaseUpdate'), extract(html, 'bindReleaseUpdateButton')].join('\n'), context, { filename: 'titlebar.html (release update)' });

context.applyReleaseUpdate({ revision: 4, checking: false, result: { ok: true, status: 'update', updateAvailable: true, latestVersion: '0.5.0' } });
assert.equal(button.hidden, false, 'available update reveals the icon');
assert.equal(hitboxes, 1, 'showing the icon recalculates the native status hitbox');
context.applyReleaseUpdate({ revision: 5, checking: false, result: { ok: true, status: 'current', updateAvailable: false } });
assert.equal(button.hidden, true, 'current release hides the icon without a placeholder');
context.applyReleaseUpdate({ revision: 4, checking: false, result: { ok: true, status: 'update', updateAvailable: true } });
assert.equal(button.hidden, true, 'older revision cannot restore a dismissed badge');
context.bindReleaseUpdateButton();
let stopped = false; button.listener({ stopPropagation() { stopped = true; } });
assert.equal(stopped, true); assert.equal(openAbout, 1, 'badge click asks main to navigate to About');
console.log('release titlebar UI self-test passed');
