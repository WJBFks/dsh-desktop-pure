'use strict';

// Synthetic tests for the native-drag status hover path. They extract the
// production helpers without starting Electron or opening a real window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const titlebar = fs.readFileSync(path.join(root, 'titlebar.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing production function ' + name);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated production function ' + name);
}

const sent = [];
const context = vm.createContext({
  titlebarStatusHover: false,
  titlebarView: { webContents: { isDestroyed: () => false, send: (channel, value) => sent.push([channel, value]) } }
});
vm.runInContext([
  extractFunction(main, 'isScreenPointInContentRect'),
  extractFunction(main, 'shouldRevealTitlebarStatus'),
  extractFunction(main, 'setTitlebarStatusHover')
].join('\n'), context, { filename: 'main.js (titlebar helpers)' });

const content = { x: 100, y: 200 };
const status = { x: 400, y: 0, width: 160, height: 40 };
// Hover in / out and exact edges use synthetic screen coordinates.
assert.equal(context.shouldRevealTitlebarStatus({ x: 500, y: 220 }, content, status, true, true), true);
assert.equal(context.shouldRevealTitlebarStatus({ x: 660, y: 220 }, content, status, true, true), false);
assert.equal(context.shouldRevealTitlebarStatus({ x: 500, y: 240 }, content, status, true, true), false);
// Blur and hide must override a still-in-range pointer.
assert.equal(context.shouldRevealTitlebarStatus({ x: 500, y: 220 }, content, status, false, true), false);
assert.equal(context.shouldRevealTitlebarStatus({ x: 500, y: 220 }, content, status, true, false), false);
assert.equal(context.setTitlebarStatusHover(true), true);
assert.equal(context.setTitlebarStatusHover(true), false, 'unchanged hover must not cause extra renderer updates');
assert.equal(context.setTitlebarStatusHover(false), true);
assert.deepEqual(sent, [['titlebar:status-hover', true], ['titlebar:status-hover', false]]);

const redactorContext = vm.createContext({});
vm.runInContext(extractFunction(titlebar, 'redactTokenUrl'), redactorContext, { filename: 'titlebar.html (redactor)' });
assert.equal(redactorContext.redactTokenUrl('http://127.0.0.1/?token=secret&keep=yes'), 'http://127.0.0.1/?token=***&keep=yes');
// A status update is retained and rerendered when the main-process hover state
// changes; no title attribute remains as a second, stale reveal channel.
assert.match(titlebar, /currentStatus = status;/);
assert.match(titlebar, /if \(currentStatus\) apply\(currentStatus\);/);
assert.doesNotMatch(titlebar, /label\.title\s*=/);
assert.match(titlebar, /<div id="status">/);
assert.match(titlebar, /<span id="label">/);
assert.match(main, /screen\.getCursorScreenPoint\(\)/);
assert.match(main, /function isTitlebarSender\(event\)/);

console.log('titlebar hover self-test passed');
