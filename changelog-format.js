'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DshChangelogFormat = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const NUMBER = '(?:0|[1-9]\\d*)';
  const PRERELEASE_ID = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
  const VERSION_RE = new RegExp(`^## \\[(${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(?:${PRERELEASE_ID})(?:\\.${PRERELEASE_ID})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)\\] — (\\d{4}-\\d{2}-\\d{2})\\s*$`);
  const CATEGORY_RE = /^###\s+(.+?)\s*$/;
  const BULLET_RE = /^-\s+(.+?)\s*$/;
  const CATEGORY_TITLES = new Set(['新增', '变更', '修复', '弃用', '移除', '安全', 'Added', 'Changed', 'Fixed', 'Deprecated', 'Removed', 'Security']);

  function isValidDate(text) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!parts) return false;
    const year = Number(parts[1]); const month = Number(parts[2]); const day = Number(parts[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function semverParts(version) {
    const match = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-((?:${PRERELEASE_ID})(?:\\.${PRERELEASE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).exec(version);
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || null } : null;
  }

  // Returns > 0 when a is newer than b. Pre-release ordering is sufficient for
  // release-log ordering: stable releases sort after their prereleases.
  function compareSemver(a, b) {
    const left = semverParts(a); const right = semverParts(b);
    if (!left || !right) return 0;
    for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
    if (left.prerelease === right.prerelease) return 0;
    if (left.prerelease === null) return 1;
    if (right.prerelease === null) return -1;
    const leftIds = left.prerelease.split('.'); const rightIds = right.prerelease.split('.');
    for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i++) {
      if (leftIds[i] === undefined) return -1;
      if (rightIds[i] === undefined) return 1;
      if (leftIds[i] === rightIds[i]) continue;
      const leftNumber = /^\d+$/.test(leftIds[i]); const rightNumber = /^\d+$/.test(rightIds[i]);
      if (leftNumber && rightNumber) return Number(leftIds[i]) > Number(rightIds[i]) ? 1 : -1;
      if (leftNumber) return -1;
      if (rightNumber) return 1;
      return leftIds[i] > rightIds[i] ? 1 : -1;
    }
    return 0;
  }

  function parseChangelog(markdown) {
    const versions = [];
    const errors = [];
    const lines = String(markdown == null ? '' : markdown).replace(/^\uFEFF/, '').split(/\r?\n/);
    let current = null;
    let category = null;
    let item = null;
    let started = false;
    const error = (line, message) => errors.push({ line, message });
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const version = VERSION_RE.exec(line);
      if (version) {
        if (!isValidDate(version[2])) error(lineNumber, `invalid date: ${version[2]}`);
        current = { version: version[1], date: version[2], line: lineNumber, categories: [], categoryNames: new Set() };
        versions.push(current); category = null; item = null; started = true;
        return;
      }
      if (/^##\s/.test(line)) { error(lineNumber, 'version heading must be ## [strict-semver] — YYYY-MM-DD'); current = null; category = null; item = null; return; }
      if (!started) return; // Preamble is deliberately retained in files but not rendered.
      if (!current || line === '' || /^---\s*$/.test(line)) return;
      const categoryMatch = CATEGORY_RE.exec(line);
      if (categoryMatch) {
        if (!CATEGORY_TITLES.has(categoryMatch[1])) { error(lineNumber, `unknown category: ${categoryMatch[1]}`); category = null; item = null; return; }
        if (current.categoryNames.has(categoryMatch[1])) { error(lineNumber, `duplicate category: ${categoryMatch[1]}`); category = null; item = null; return; }
        category = { title: categoryMatch[1], line: lineNumber, items: [] };
        current.categories.push(category); current.categoryNames.add(categoryMatch[1]); item = null;
        return;
      }
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        if (!category) { error(lineNumber, 'bullet must follow a ### category'); return; }
        item = { text: bullet[1], line: lineNumber, continuations: [] };
        category.items.push(item);
        return;
      }
      if (/^ {2}\S/.test(line)) {
        if (!item) error(lineNumber, 'continuation must follow a bullet');
        else item.continuations.push(line.trim());
        return;
      }
      error(lineNumber, 'expected a ### category, - bullet, exactly two-space continuation, blank line, or ---');
    });
    if (versions.length === 0) error(1, 'no version headings found');
    const seen = new Set();
    versions.forEach((entry, index) => {
      if (seen.has(entry.version)) error(entry.line, `duplicate version: ${entry.version}`);
      seen.add(entry.version);
      if (entry.categories.length === 0) error(entry.line, 'version must contain at least one ### category');
      entry.categories.forEach((section) => { if (section.items.length === 0) error(section.line, 'category must contain at least one - bullet'); });
      if (index > 0 && compareSemver(versions[index - 1].version, entry.version) <= 0) error(entry.line, 'versions must be in descending semver order');
    });
    return { versions, errors };
  }

  return { VERSION_RE, CATEGORY_TITLES, parseChangelog, compareSemver, isValidDate };
});
