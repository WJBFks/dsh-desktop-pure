'use strict';

// Default mode exercises the production parser/probe with deterministic WSL
// responses. `--live` calls only the production wslProbe: it never installs
// packages or starts dsh web, and is intended for an explicit local check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const plainStart = source.indexOf('function ' + name + '(');
  const start = asyncStart !== -1 ? asyncStart : plainStart;
  assert.notEqual(start, -1, 'missing production function ' + name);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

function load(names, extra = {}) {
  const context = vm.createContext(Object.assign({ Buffer, console, process, path, execFile, setTimeout, clearTimeout }, extra));
  vm.runInContext(names.map(extract).join('\n'), context, { filename: 'main.js (WSL selftest)' });
  return context;
}

const functions = ['decodeWslList', 'wslDistroArgs', 'parseWslList', 'markedWslDistro', 'parseOsRelease', 'wslProbeFailure', 'isWslExecutableMissing', 'wslProbeWithExec'];

async function mockProbe() {
  const calls = [];
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const context = load(functions);
  const result = await context.wslProbeWithExec(async (args) => {
    calls.push(args);
    const joined = args.join(' ');
    if (joined === '-l -q') return { err: null, stdout: utf16('Ubuntu-26.04\r\ndocker-desktop\r\n') };
    if (joined === '-l -v') return { err: null, stdout: utf16('名称 状态 版本\r\n* Ubuntu-26.04 Running 2\r\n  docker-desktop Stopped 2\r\n') };
    if (joined.includes('hostname -I')) return { err: null, stdout: '172.30.10.4\n' };
    if (joined.includes('command -v dsh')) return { err: null, stdout: '/home/test/.npm-global/bin/dsh\n' };
    if (joined.includes('command -v node')) return { err: null, stdout: 'NODE=v22.2.0\nNPM=10.8.0\n' };
    if (joined.includes('--version')) return { err: null, stdout: '0.4.0\n' };
    if (joined.includes('/etc/os-release')) return { err: null, stdout: 'PRETTY_NAME="Ubuntu 26.04 LTS"\nVERSION_ID="26.04"\n' };
    throw new Error('unexpected WSL call: ' + joined);
  });
  assert.equal(result.installed, true);
  assert.equal(result.distro, 'Ubuntu-26.04');
  assert.equal(result.distroLabel, 'Ubuntu 26.04 LTS');
  assert.equal(result.node, 'v22.2.0');
  assert.ok(calls.filter((args) => args.includes('-e')).every((args) => args[0] === '-d' && args[1] === 'Ubuntu-26.04'));
}

async function failureAndCompatibility() {
  const context = load(functions);
  assert.deepEqual(Array.from(context.parseWslList(Buffer.from('Ubuntu\n', 'utf8'), true)), ['Ubuntu']);
  assert.equal(context.parseOsRelease('NAME=Ubuntu\nVERSION_ID=24.04\n'), 'Ubuntu 24.04');
  assert.equal(context.parseOsRelease('VERSION_ID=24.04\n'), '');
  const utf16Error = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Wsl/EnumerateDistros/Service/E_ACCESSDENIED', 'utf16le')]);
  assert.match(context.wslProbeFailure(new Error('exit 1'), Buffer.alloc(0), utf16Error), /E_ACCESSDENIED/);
  const inaccessible = await context.wslProbeWithExec(async () => ({
    err: Object.assign(new Error('exit 1'), { code: 1 }), stdout: Buffer.alloc(0),
    stderr: Buffer.from('Wsl/EnumerateDistros/Service/E_ACCESSDENIED', 'utf8')
  }));
  assert.equal(inaccessible.installed, null);
  assert.match(inaccessible.error, /E_ACCESSDENIED/);
  const noWslExecutable = await context.wslProbeWithExec(async () => ({
    err: Object.assign(new Error('not found'), { code: 'ENOENT' }), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)
  }));
  assert.equal(noWslExecutable.installed, false);
  assert.equal(noWslExecutable.error, null);
  const noDistros = await context.wslProbeWithExec(async () => ({ err: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  assert.equal(noDistros.installed, false);
  assert.equal(noDistros.error, null);
  const legacy = await context.wslProbeWithExec(async (args) => {
    if (args.join(' ') === '-l -q') return { err: new Error('unknown option'), stdout: Buffer.alloc(0) };
    if (args.join(' ') === '-l') return { err: null, stdout: Buffer.from('本地安装的发行版:\r\n* Ubuntu-24.04 (默认)\r\n', 'utf8') };
    if (args.join(' ') === '-l -v') return { err: new Error('unsupported'), stdout: Buffer.alloc(0) };
    if (args.includes('hostname')) return { err: null, stdout: '' };
    if (args.includes('bash')) return { err: new Error('bash unavailable'), stdout: '' };
    if (args.includes('sh')) return { err: new Error('sh unavailable'), stdout: '' };
    throw new Error('unexpected legacy call');
  });
  assert.equal(legacy.installed, true);
  assert.equal(legacy.distro, null, 'without a verbose default marker, commands must use WSL default');
  assert.equal(legacy.distroLabel, null);
  assert.match(legacy.error, /无法启动或响应/);

  const steps = load(['wslStep']);
  assert.equal(steps.wslStep({ wsl: { installed: true, node: '', error: 'bash unavailable' } }), 'install-wsl');
}

async function main() {
  if (process.argv.includes('--live')) {
    const live = load(['wslExecutable', 'wslExec'].concat(functions, ['wslProbe']));
    const started = Date.now();
    const result = await live.wslProbe();
    console.log(JSON.stringify({ elapsedMs: Date.now() - started, result }, null, 2));
    return;
  }
  await mockProbe();
  await failureAndCompatibility();
  const router = fs.readFileSync(path.join(__dirname, '..', 'router.html'), 'utf8');
  assert.match(router, /return wslLive\.wslError \|\| !wslLive\.wslInstalled/);
  assert.match(router, /if \(wslLive\.wslError\) \{\s*doSetStep\('install-wsl'\)/);
  assert.match(router, /nodeOk \|\| wslLive\.wslError \? ' disabled'/);
  assert.match(router, /wslLive\.dshPath \|\| wslLive\.wslError \? ' disabled'/);
  assert.match(router, /distroLabel \|\| wslLive\.distro/);
  console.log('WSL selftest passed');
}

main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
