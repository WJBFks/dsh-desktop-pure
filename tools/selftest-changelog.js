'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { CHANGELOG_URLS, MAX_BYTES, MAX_CACHE_BYTES, fetchChangelog } = require('../changelog.js');
const format = require('../changelog-format.js');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.open = false; this.className = ''; this.textContent = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener(name, listener) { (this.listeners[name] || (this.listeners[name] = [])).push(listener); }
  querySelectorAll(selector) {
    const found = []; const walk = (node) => {
      if (node && node.tagName === 'details' && selector === 'details[data-version]' && node.attributes['data-version']) found.push(node);
      if (node && node.children) node.children.forEach(walk);
    };
    this.children.forEach(walk); return found;
  }
}
function fakeDocument() {
  return { createElement: (tag) => new FakeElement(tag), createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }) };
}

async function main() {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-changelog-'));
  try {
  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response('# Changelog\n\n## [1.0.0]\n- safe', { status: 200, headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' } });
  };
  const zh = await fetchChangelog('zh', { cacheDir, fetchImpl: mockFetch });
  const en = await fetchChangelog('en', { cacheDir, fetchImpl: mockFetch });
  assert.equal(zh.ok, true);
  assert.equal(en.ok, true);
  assert.equal(requests[0].url, CHANGELOG_URLS.zh);
  assert.equal(requests[1].url, CHANGELOG_URLS.en);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-cache');
  assert.equal(requests[0].init.headers['cache-control'], 'no-cache');
  assert.match(requests[0].url, /^https:\/\/raw\.githubusercontent\.com\/WJBFks\/dsh-desktop-pure\/main\/CHANGELOG/);
  const cached = await fetchChangelog('zh', { cacheDir, cachedOnly: true });
  assert.equal(cached.ok, true);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.markdown, zh.markdown);
  const verified = await fetchChangelog('zh', { cacheDir, fetchImpl: async (_url, init) => {
    assert.equal(init.headers['if-none-match'], '"v1"');
    assert.equal(init.headers['if-modified-since'], 'Mon, 01 Jan 2026 00:00:00 GMT');
    return new Response(null, { status: 304 });
  } });
  assert.equal(verified.verified, true);
  assert.equal(verified.source, 'cache');
  const offline = await fetchChangelog('zh', { cacheDir, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.ok, true);
  assert.equal(offline.stale, true);
  assert.equal(offline.markdown, zh.markdown);
  const zhCachePath = path.join(cacheDir, 'changelog-zh.json');
  const wrongLanguage = JSON.parse(await fsp.readFile(zhCachePath, 'utf8'));
  wrongLanguage.language = 'en';
  await fsp.writeFile(zhCachePath, JSON.stringify(wrongLanguage), 'utf8');
  assert.deepEqual(await fetchChangelog('zh', { cacheDir, cachedOnly: true }), { ok: false, error: 'cache_miss' },
    'cache language/source binding must reject a mismatched record');
  assert.equal((await fetchChangelog('zh', { cacheDir, fetchImpl: mockFetch })).ok, true, 'mismatched cache must recover');

  const concurrentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-changelog-concurrent-'));
  let fetches = 0;
  const delayedFetch = async () => {
    fetches++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response('# English', { status: 200 });
  };
  const both = await Promise.all([
    fetchChangelog('en', { cacheDir: concurrentDir, fetchImpl: delayedFetch }),
    fetchChangelog('en', { cacheDir: concurrentDir, fetchImpl: delayedFetch })
  ]);
  assert.equal(fetches, 1, 'same-language refreshes must share one request');
  assert.equal(both[0].markdown, both[1].markdown);
  await fsp.rm(concurrentDir, { recursive: true, force: true });

  await fsp.writeFile(path.join(cacheDir, 'changelog-en.json'), '{not-json', 'utf8');
  const repaired = await fetchChangelog('en', { cacheDir, fetchImpl: mockFetch });
  assert.equal(repaired.ok, true, 'malformed cache must recover from the network');
  await fsp.writeFile(path.join(cacheDir, 'changelog-en.json'), 'x'.repeat(MAX_CACHE_BYTES + 1), 'utf8');
  const oversizedCache = await fetchChangelog('en', { cacheDir, cachedOnly: true });
  assert.deepEqual(oversizedCache, { ok: false, error: 'cache_miss' }, 'oversized cache must not be read');

  let cancelled = false;
  const oversized = await fetchChangelog('zh', {
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(MAX_BYTES + 1) },
      body: { cancel: async () => { cancelled = true; } }
    })
  });
  assert.deepEqual(oversized, { ok: false, error: 'unavailable' });
  assert.equal(cancelled, true, 'oversized responses must be cancelled');

  const valid = 'Preamble\n\n## [1.0.0-rc.10] — 2026-02-01\n\n### Added\n\n- item\n  continuation\n\n---\n\n## [0.9.0] — 2026-01-01\n\n### Fixed\n\n- older';
  assert.equal(format.parseChangelog(valid).errors.length, 0);
  assert.equal(format.compareSemver('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.ok(format.parseChangelog('## [01.0.0] — 2026-01-01').errors.length > 0, 'leading-zero semver must fail');
  assert.ok(format.parseChangelog('## [1.0.0] — 2026-01-01\n### Added\n- a\n### Added\n- b').errors.length > 0, 'duplicate categories must fail');
  assert.ok(format.parseChangelog('## [1.0.0] — 2026-01-01\n### Added\n- a\n   bad').errors.length > 0, 'continuations require exactly two spaces');

  const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-changelog-cli-'));
  const fixtureZh = path.join(fixtureDir, 'zh.md'); const fixtureEn = path.join(fixtureDir, 'en.md');
  await fsp.writeFile(fixtureZh, valid, 'utf8'); await fsp.writeFile(fixtureEn, valid, 'utf8');
  const checker = path.join(__dirname, 'check-changelog.js');
  assert.equal(spawnSync(process.execPath, [checker, fixtureZh, fixtureEn], { encoding: 'utf8' }).status, 0, 'valid CLI fixture must pass');
  await fsp.writeFile(fixtureEn, valid.replace('2026-02-01', '2026-02-02'), 'utf8');
  const mismatch = spawnSync(process.execPath, [checker, fixtureZh, fixtureEn], { encoding: 'utf8' });
  assert.equal(mismatch.status, 1, 'bilingual date mismatch must fail');
  assert.match(mismatch.stderr, /zh\.md:\d+:/);
  await fsp.writeFile(fixtureEn, '## [bad] — 2026-01-01\n', 'utf8');
  const invalid = spawnSync(process.execPath, [checker, fixtureZh, fixtureEn], { encoding: 'utf8' });
  assert.equal(invalid.status, 1, 'invalid CLI fixture must fail');
  assert.match(invalid.stderr, /en\.md:1:/);
  await fsp.rm(fixtureDir, { recursive: true, force: true });

  const html = fs.readFileSync(path.join(__dirname, '..', 'pure.html'), 'utf8');
  assert.match(html, /loadChangelog\('zh'\)/, 'Chinese must be the default');
  assert.match(html, /request !== changelogRequest/, 'stale language responses must be ignored');
  assert.match(html, /url\.protocol !== 'http:' && url\.protocol !== 'https:'/,
    'Markdown links must reject non-http(s) schemes');
  assert.match(html, /document\.createElement\('strong'\)/, 'Markdown bold is rendered with DOM nodes');
  assert.match(html, /document\.createElement\('details'\)/, 'versions use native details elements');
  const renderer = html.slice(html.indexOf('function renderChangelog('), html.indexOf('function changelogMessage('));
  assert.doesNotMatch(renderer, /innerHTML/, 'remote Markdown renderer must not inject HTML');
  assert.match(html, /getChangelog\(changelogLanguage, \{ cachedOnly: true \}\)/, 'cache must render before refresh');
  assert.match(html, /无法验证最新内容，正在显示缓存。/, 'stale cache message must not claim every failure is offline');
  assert.match(html, /name === 'changelog' && api\) loadChangelog\(changelogLanguage\)/, 'opening the pane must verify the cache');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'purepreload.js'), 'utf8');
  assert.match(preload, /cachedOnly: Boolean\(options && options\.cachedOnly\)/, 'preload only forwards cachedOnly');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /actual\.protocol === 'file:' && actual\.pathname === expected\.pathname/);
  assert.match(main, /new URL\(event\.sender\.getURL\(\)\)/, 'sender validation must parse the actual URL');
  const start = main.indexOf('function isPureSender(event)');
  const body = main.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = body; i < main.length; i++) {
    if (main[i] === '{') depth++;
    if (main[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, 'isPureSender must be complete');
  const purePath = path.join(__dirname, '..', 'pure.html');
  const sender = { getURL: () => pathToFileURL(purePath).href + '?v=12345', mainFrame: {} };
  const context = vm.createContext({ pureView: { webContents: Object.assign(sender, { isDestroyed: () => false }) }, path, pathToFileURL, __dirname: path.join(__dirname, '..'), URL });
  vm.runInContext(main.slice(start, end), context, { filename: 'main.js (pure sender)' });
  assert.equal(context.isPureSender({ sender, senderFrame: sender.mainFrame }), true, 'actual pure.html query URL is trusted');
  sender.getURL = () => pathToFileURL(path.join(__dirname, '..', 'router.html')).href + '?v=12345';
  assert.equal(context.isPureSender({ sender, senderFrame: sender.mainFrame }), false, 'other local pages are rejected');

  const box = new FakeElement('div');
  const renderContext = vm.createContext({
    window: { DshChangelogFormat: format }, document: fakeDocument(), changelogBox: box,
    changelogLanguage: 'zh', changelogExpanded: { zh: Object.create(null), en: Object.create(null) }, api: null
  });
  vm.runInContext([
    extractFunction(html, 'appendMarkdownInline'), extractFunction(html, 'rememberExpanded'), extractFunction(html, 'renderChangelog')
  ].join('\n'), renderContext, { filename: 'pure.html (changelog renderer)' });
  assert.equal(renderContext.renderChangelog(valid), true, 'valid parsed changelog renders dynamically');
  assert.equal(box.children[0].tagName, 'details');
  assert.equal(box.children[0].getAttribute('data-version'), '1.0.0-rc.10');
  assert.equal(box.children[0].children[0].children[0].textContent, '[1.0.0-rc.10] — 2026-02-01');
  assert.equal(box.children[0].open, true, 'latest semver is open by default');
  assert.equal(box.children[1].open, false, 'older versions are collapsed by default');
  box.children[1].open = true; box.children[1].listeners.toggle[0]();
  assert.equal(renderContext.renderChangelog(valid), true);
  assert.equal(box.children[1].open, true, 'same-content refresh preserves user expansion');
  const retained = box.children[0];
  assert.equal(renderContext.renderChangelog('## [broken] — 2026-01-01'), false);
  assert.equal(box.children[0], retained, 'invalid remote content cannot blank an existing changelog');
  console.log('changelog self-test passed');
  } finally {
    await fsp.rm(cacheDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
