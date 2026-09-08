'use strict';

// Network-only release metadata.  Download URLs are intentionally retained as
// non-enumerable in-memory data so they cannot cross the Pure IPC boundary.
const REPOSITORY = 'WJBFks/dsh-desktop-pure';
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 256 * 1024;

function parseSemver(value) {
  const match = typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (![match[1], match[2], match[3], ...prerelease].every((part) => !/^\d+$/.test(part) || Number.isSafeInteger(Number(part)))) return null;
  if (prerelease.some((part) => part === '' || (/^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareSemver(a, b) {
  const left = parseSemver(a); const right = parseSemver(b);
  if (!left || !right) return null;
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] > right[part] ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index]; const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

async function readLimitedJson(response, maxBytes) {
  const declared = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('too_large');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('too_large');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0; let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('too_large');
      chunks.push(next.value);
    }
    complete = true;
    return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)));
  } finally {
    if (!complete) try { await reader.cancel(); } catch { /* best effort */ }
    reader.releaseLock();
  }
}

function githubReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && (url.port === '' || url.port === '443') && !url.username && !url.password && !url.hash && !url.search &&
      url.pathname.startsWith(`/${REPOSITORY}/releases/`) ? url.toString() : null;
  } catch { return null; }
}

function githubDownloadUrl(value, tag) {
  try {
    const url = new URL(value);
    const prefix = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/`;
    return typeof tag === 'string' && url.protocol === 'https:' && url.hostname === 'github.com' && (url.port === '' || url.port === '443') && !url.username && !url.password && !url.hash && !url.search &&
      url.pathname.startsWith(prefix) ? url.toString() : null;
  } catch { return null; }
}

// Release metadata (latest.yml, blockmaps, signatures) is not an installer
// choice. Keep the list cross-platform and explicit, but expose only common
// distributable package/archive formats for the user to choose from.
function isReleasePackageName(name) {
  return typeof name === 'string' && /\.(?:exe|msi|dmg|pkg|appimage|deb|rpm|zip|tgz|tar\.gz)$/i.test(name);
}

function baseResult(currentVersion, error) {
  return { ok: false, currentVersion, latestVersion: null, updateAvailable: false, status: 'none', releaseUrl: RELEASES_URL, assets: [], ...(error ? { error } : {}) };
}

function attachAssetUrls(result, assets) {
  Object.defineProperty(result, 'assetUrls', { value: assets, enumerable: false });
  return result;
}

async function checkLatestRelease(currentVersion, options = {}) {
  const current = typeof currentVersion === 'string' ? currentVersion : '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return baseResult(current, 'unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const response = await fetchImpl(API_URL, {
      signal: controller.signal, redirect: 'error', cache: 'no-cache',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    });
    if (!response) return baseResult(current, 'offline');
    if (response.status === 404) return attachAssetUrls({ ...baseResult(current), ok: true }, new Map());
    if (response.status === 403 || response.status === 429) return baseResult(current, 'GitHub 请求限流，请稍后再试；可打开 Release 页面手动查看。');
    if (!response.ok) return baseResult(current, 'unavailable');
    const release = await readLimitedJson(response, options.maxBytes || MAX_BYTES);
    const releaseVersion = release && parseSemver(release.tag_name);
    if (!release || typeof release.tag_name !== 'string' || !releaseVersion) return baseResult(current, 'invalid_response');
    if (release.draft === true || release.prerelease === true || releaseVersion.prerelease.length > 0) {
      return attachAssetUrls({ ...baseResult(current), ok: true }, new Map());
    }
    const compared = compareSemver(current, release.tag_name);
    if (compared === null) return baseResult(current, 'invalid_version');
    const downloads = new Map();
    const assets = [];
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
      const id = Number(asset && asset.id);
      const name = typeof (asset && asset.name) === 'string' ? asset.name : '';
      const size = Number(asset && asset.size);
      const url = githubDownloadUrl(asset && asset.browser_download_url, release.tag_name);
      if (!Number.isSafeInteger(id) || id < 1 || !name || name.length > 255 || !isReleasePackageName(name) || !Number.isSafeInteger(size) || size < 0 || !url || downloads.has(id)) continue;
      downloads.set(id, url); assets.push({ id, name, size });
    }
    const status = compared < 0 ? 'update' : compared > 0 ? 'ahead' : 'current';
    const updateAvailable = status === 'update';
    return attachAssetUrls({ ok: true, currentVersion: current, latestVersion: release.tag_name.replace(/^v/, ''), updateAvailable, status, releaseUrl: githubReleaseUrl(release.html_url) || RELEASES_URL, assets: updateAvailable ? assets : [] }, updateAvailable ? downloads : new Map());
  } catch (error) {
    return baseResult(current, error && error.name === 'AbortError' ? 'timeout' : error && error.message === 'too_large' ? 'response_too_large' : 'offline');
  } finally {
    clearTimeout(timer); controller.abort();
  }
}

module.exports = { REPOSITORY, API_URL, RELEASES_URL, TIMEOUT_MS, MAX_BYTES, parseSemver, compareSemver, githubDownloadUrl, isReleasePackageName, checkLatestRelease };
