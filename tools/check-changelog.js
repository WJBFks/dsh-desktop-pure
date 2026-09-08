'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseChangelog } = require('../changelog-format.js');

const root = path.join(__dirname, '..');
const supplied = process.argv.slice(2);
if (supplied.length !== 0 && supplied.length !== 2) {
  console.error('usage: node tools/check-changelog.js [CHANGELOG.md CHANGELOG.en.md]');
  process.exit(2);
}
const files = supplied.length ? supplied : [path.join(root, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.en.md')];
const parsed = [];
let failed = false;
for (const file of files) {
  try {
    parsed.push({ file, result: parseChangelog(fs.readFileSync(file, 'utf8')) });
  } catch (error) {
    failed = true;
    console.error(`${path.basename(file)}:1: cannot read file (${error.code || 'unknown error'})`);
  }
}
for (const { file, result } of parsed) {
  for (const problem of result.errors) {
    failed = true;
    console.error(`${path.basename(file)}:${problem.line}: ${problem.message}`);
  }
}
if (!failed && parsed.every(({ result }) => result.errors.length === 0)) {
  const [zh, en] = parsed.map(({ result }) => result.versions);
  const length = Math.max(zh.length, en.length);
  for (let index = 0; index < length; index++) {
    const left = zh[index]; const right = en[index];
    if (!left || !right || left.version !== right.version || left.date !== right.date) {
      failed = true;
      const line = left ? left.line : 1;
      console.error(`${path.basename(parsed[0].file)}:${line}: Chinese/English version and date sequences must match`);
      break;
    }
  }
}
if (failed) process.exit(1);
console.log(`changelog format OK (${parsed[0].result.versions.length} versions)`);
