'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const CHANGELOG_URLS = Object.freeze({
  zh: 'https://raw.githubusercontent.com/WJBFks/dsh-desktop-pure/main/CHANGELOG.md',
  en: 'https://raw.githubusercontent.com/WJBFks/dsh-desktop-pure/main/CHANGELOG.en.md'
});
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = MAX_BYTES * 6 + 8192;
const CACHE_VERSION = 1;
const inFlight = new Map();

function normalizeLanguage(language) { return language === 'en' ? 'en' : 'zh'; }
function cachePath(cacheDir, language) { return path.join(cacheDir, `changelog-${normalizeLanguage(language)}.json`); }
function validValidator(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value) ? value : null;
}
function validCache(value, language) {
  const lang = normalizeLanguage(language);
  if (!value || value.version !== CACHE_VERSION || value.language !== lang || value.source !== CHANGELOG_URLS[lang] || typeof value.markdown !== 'string') return null;
  if (Buffer.byteLength(value.markdown, 'utf8') > MAX_BYTES) return null;
  return { markdown: value.markdown, etag: validValidator(value.etag), lastModified: validValidator(value.lastModified), cachedAt: Number.isFinite(value.cachedAt) ? value.cachedAt : null };
}

async function readCache(cacheDir, language) {
  if (typeof cacheDir !== 'string' || cacheDir === '') return null;
  try {
    const target = cachePath(cacheDir, language);
    const stats = await fs.stat(target);
    if (!stats.isFile() || stats.size > MAX_CACHE_BYTES) return null;
    return validCache(JSON.parse(await fs.readFile(target, 'utf8')), language);
  } catch { return null; }
}
async function writeCache(cacheDir, language, entry) {
  if (typeof cacheDir !== 'string' || cacheDir === '') return;
  const target = cachePath(cacheDir, language);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const lang = normalizeLanguage(language);
  const record = { version: CACHE_VERSION, language: lang, source: CHANGELOG_URLS[lang], markdown: entry.markdown, etag: validValidator(entry.etag), lastModified: validValidator(entry.lastModified), cachedAt: Date.now() };
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  } catch {
    try { await fs.unlink(temporary); } catch { /* best effort */ }
  }
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
    throw new Error('too_large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('too_large');
      chunks.push(next.value);
    }
    complete = true;
  } finally {
    if (!complete) try { await reader.cancel(); } catch { /* best effort */ }
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

async function refreshChangelog(language, options, cached) {
  const lang = normalizeLanguage(language);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return cached ? { ok: true, ...cached, source: 'cache', stale: true, error: 'unavailable' } : { ok: false, error: 'unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  const headers = { accept: 'text/markdown, text/plain;q=0.9', 'cache-control': 'no-cache' };
  if (cached && cached.etag) headers['if-none-match'] = cached.etag;
  if (cached && cached.lastModified) headers['if-modified-since'] = cached.lastModified;
  try {
    const response = await fetchImpl(CHANGELOG_URLS[lang], { signal: controller.signal, redirect: 'error', cache: 'no-cache', headers });
    if (response && response.status === 304 && cached) return { ok: true, ...cached, source: 'cache', verified: true };
    if (!response || !response.ok) throw new Error('unavailable');
    const fresh = {
      markdown: await readLimitedBody(response, options.maxBytes || MAX_BYTES),
      etag: validValidator(response.headers && response.headers.get('etag')),
      lastModified: validValidator(response.headers && response.headers.get('last-modified')),
      cachedAt: Date.now()
    };
    await writeCache(options.cacheDir, lang, fresh);
    return { ok: true, ...fresh, source: 'network', verified: true };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timeout' : 'unavailable';
    return cached ? { ok: true, ...cached, source: 'cache', stale: true, error: reason } : { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** `cacheDir` is a main-process-owned directory under app.getPath('userData'). */
async function fetchChangelog(language, options = {}) {
  const lang = normalizeLanguage(language);
  const cached = await readCache(options.cacheDir, lang);
  if (options.cachedOnly) return cached ? { ok: true, ...cached, source: 'cache', stale: true } : { ok: false, error: 'cache_miss' };
  const key = `${options.cacheDir || ''}\u0000${lang}`;
  if (!inFlight.has(key)) {
    const request = refreshChangelog(lang, options, cached).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
  }
  return inFlight.get(key);
}

module.exports = { CHANGELOG_URLS, TIMEOUT_MS, MAX_BYTES, MAX_CACHE_BYTES, CACHE_VERSION, fetchChangelog, readLimitedBody, readCache, writeCache };
