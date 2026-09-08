'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', start); let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}
function button(page) {
  return {
    disabled: false, textContent: '', attributes: { 'data-startup-page': page },
    classList: { selected: false, toggle(_name, value) { this.selected = value; } },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; }
  };
}

const html = fs.readFileSync(path.join(__dirname, '..', 'pure.html'), 'utf8');
const local = button('local'); const wsl = button('wsl'); const pure = button('pure');
const dialog = { open: false, showCount: 0, closeCount: 0, showModal() { this.open = true; this.showCount++; }, close() { this.open = false; this.closeCount++; } };
const calls = [];
let promptFailure = true;
const context = vm.createContext({
  startupChoices: { querySelectorAll: () => [pure, local, wsl] }, startupLocal: local, startupWsl: wsl,
  startupSave: { disabled: false }, startupStatus: { textContent: '' }, startupDialog: dialog,
  startupPromptLocal: { focusCount: 0, focus() { this.focusCount++; } }, startupState: null,
  startupPromptWsl: { disabled: false }, startupPromptLater: { disabled: false }, startupPromptStatus: { textContent: '' },
  startupCandidate: 'local', startupSaving: false, startupFeedback: '', startupPromptClosed: false, startupPromptPending: false, startupPageSeen: null,
  api: { chooseStartupPage: (page) => { calls.push(page); return Promise.resolve(promptFailure ? { ok: false, error: 'write failed' } : { ok: true }); } }, Promise
});
vm.runInContext([
  extractFunction(html, 'applyStartup'), extractFunction(html, 'chooseStartupPrompt'), extractFunction(html, 'maybeShowStartupPrompt')
].join('\n'), context, { filename: 'pure.html (startup settings)' });

async function run() {
context.applyStartup({ page: null, wslAvailable: true, detecting: false }, 'win32');
assert.equal(local.textContent, 'Windows');
assert.equal(wsl.disabled, false);
assert.equal(local.classList.selected, true, 'an unset startup preference defaults to Windows');
assert.match(context.startupStatus.textContent, /默认 Windows/);
context.startupCandidate = 'wsl'; context.applyStartup({ page: null, wslAvailable: true, detecting: false }, 'win32');
assert.equal(wsl.classList.selected, true, 'pending selection survives ordinary state updates');
assert.equal(context.startupSave.disabled, false, 'the Windows default may be explicitly saved');
context.applyStartup({ page: null, wslAvailable: false, detecting: true }, 'linux');
assert.equal(local.textContent, '本机');
assert.equal(wsl.disabled, true, 'unavailable/detecting WSL cannot be selected');
assert.equal(context.startupStatus.textContent, '正在检测 WSL…');
context.applyStartup({ page: null, wslAvailable: false, detecting: false }, 'linux');
assert.match(context.startupStatus.textContent, /默认 本机/, 'detection completion replaces transient progress text');

context.maybeShowStartupPrompt({ prompt: true });
assert.equal(dialog.open, true); assert.equal(dialog.showCount, 1);
await context.chooseStartupPrompt(null);
assert.equal(dialog.open, true, 'failed prompt choice remains open for retry');
assert.equal(context.startupPromptStatus.textContent, 'write failed');
assert.equal(context.startupPromptLater.disabled, false, 'failed prompt choice re-enables controls');
promptFailure = false;
await context.chooseStartupPrompt(null);
assert.equal(dialog.open, false); assert.equal(dialog.closeCount, 1); assert.deepEqual(calls, [null, null]);
context.maybeShowStartupPrompt({ prompt: true });
assert.equal(dialog.showCount, 1, 'ordinary updates cannot reopen a closed prompt');
console.log('startup settings UI self-test passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
