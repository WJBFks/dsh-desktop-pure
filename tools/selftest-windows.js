'use strict';

// Executes selected functions extracted from main.js in a VM with only mocked
// process APIs. This validates production code without invoking Electron,
// PowerShell, winget, npm, Node, or a real DSH installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(__dirname, '..', 'router.html'), 'utf8');

function extractFunction(name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const plainStart = source.indexOf('function ' + name + '(');
  const start = asyncStart !== -1 ? asyncStart : plainStart;
  assert.notEqual(start, -1, 'missing production function ' + name);
  const parameters = source.indexOf('(', start);
  let parameterDepth = 0;
  let body = -1;
  for (let i = parameters; i < source.length; i++) {
    if (source[i] === '(') parameterDepth++;
    if (source[i] === ')' && --parameterDepth === 0) {
      body = source.indexOf('{', i);
      break;
    }
  }
  assert.notEqual(body, -1, 'missing production function body ' + name);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated production function ' + name);
}

function load(names, extra) {
  const context = vm.createContext(Object.assign({ Buffer, console, setTimeout, clearTimeout }, extra));
  vm.runInContext(names.map(extractFunction).join('\n'), context, { filename: 'main.js (extracted)' });
  return context;
}

function extractIpcRegistration(channel) {
  const start = source.indexOf("ipcMain.on('" + channel + "'");
  assert.notEqual(start, -1, 'missing IPC handler ' + channel);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, source.indexOf(');', i) + 2);
  }
  throw new Error('unterminated IPC handler ' + channel);
}

const decision = load(['windowsStep', 'validWindowsVersion']);
assert.equal(decision.windowsStep({ windows: { node: 'v22.1.0', npm: '' } }), 'install-node');
assert.equal(decision.windowsStep({ windows: { node: 'v22.1.0', npm: '10.8.0', dshPath: '' } }), 'install-dsh');
assert.equal(decision.windowsStep({ windows: { node: 'v22.1.0', npm: '10.8.0', dshPath: 'C:\\npm bin\\dsh.cmd' } }), 'connect');
assert.equal(decision.validWindowsVersion('npm ERR! failed'), false);
assert.equal(decision.validWindowsVersion('v22.1.0'), true);

// Router status events must use the outer refresh hook. Progress is an
// in-place update: rebuilding the selected step would close manual panels.
assert.match(routerSource, /var doRefreshWindows = null;/);
assert.match(routerSource, /doRefreshWindows = refreshWindows;/);
assert.match(routerSource, /doRefreshWindows\(\);/);
assert.doesNotMatch(routerSource, /installState\[progressInfo\.step\][\s\S]{0,180}setStep\(active\)/);
assert.match(routerSource, /\? '已安装' : '自动安装官方 Node\.js LTS（推荐）'/);
assert.match(routerSource, /\? '已安装' : '一键安装 DSH（推荐）'/);
assert.match(routerSource, /function cmdBlock\(command\)/);
assert.match(routerSource, /dsh web --no-open --port ' \+ winLive\.port/);
assert.match(routerSource, /setTimeout\(function \(\) \{ button\.textContent = '复制'; \}, 1500\)/);
assert.match(routerSource, /function renderGuideStatusbar\(id, segments\)/);
assert.match(routerSource, /@media \(max-width: 375px\)/);
assert.match(routerSource, /if \(!panel\) return;/);

const busy = load(['isWindowsBusy'], {
  windowsProbeInFlight: null, windowsInstallInFlight: false, windowsStartInFlight: false, windowsAuthInFlight: false
});
assert.equal(busy.isWindowsBusy(), false);
busy.windowsProbeInFlight = Promise.resolve();
assert.equal(busy.isWindowsBusy(), true);
busy.windowsProbeInFlight = null; busy.windowsInstallInFlight = true;
assert.equal(busy.isWindowsBusy(), true);
busy.windowsInstallInFlight = false; busy.windowsStartInFlight = true;
assert.equal(busy.isWindowsBusy(), true);
busy.windowsStartInFlight = false; busy.windowsAuthInFlight = true;
assert.equal(busy.isWindowsBusy(), true);
assert.match(source, /windowsStartInFlight = false;[\s\S]{0,420}detectWindowsEndpoint\('retry'\)/);
assert.match(source, /windowsProbeInFlight = null;[\s\S]{0,260}pushWindowsStatus\(ep, kind\)/);
assert.match(source, /windowsProbeInFlight = Promise\.resolve\(\)[\s\S]{0,1100}pushWindowsStatus\(ep, kind\);/);

const versions = load(['validWindowsVersion', 'windowsVersion'], {
  windowsTool: async () => ({ ok: true, out: 'dsh version 0.4.0\n' })
});
let powershellCommand;
versions.windowsVersion('C:\\Program Files\\dsh.cmd').then((value) => {
  assert.equal(value, '0.4.0');
  versions.windowsTool = async () => ({ ok: true, out: 'npm ERR! code EACCES\n10.8.0\n' });
  return versions.windowsVersion('C:\\Program Files\\npm.cmd');
}).then((value) => {
  assert.equal(value, '');

  const prefix = load(['windowsNpmPrefix'], {
    path: path.win32,
    windowsTool: async () => ({ ok: true, out: 'C:\\Tools\\npm-global\n' })
  });
  return prefix.windowsNpmPrefix('C:\\Program Files\\nodejs\\npm.cmd');
}).then((prefixValue) => {
  assert.equal(prefixValue, 'C:\\Tools\\npm-global');

  const env = load(['expandWindowsVars', 'refreshedWindowsEnv'], {
    process: { env: { PATH: 'C:\\Old', Path: 'C:\\Stale', APPDATA: 'C:\\Users\\A\\AppData\\Roaming', SystemRoot: 'C:\\Windows' } },
    path: path.win32,
    spawnSync: (_file, args) => ({ stdout: args[1] === 'HKCU\\Environment' ? 'Path    REG_EXPAND_SZ    %SystemRoot%\\UserBin\r\n' : 'Path    REG_SZ    C:\\MachineBin\r\n' })
  });
  const refreshed = env.refreshedWindowsEnv();
  assert.equal(Object.keys(refreshed).filter((key) => key.toLowerCase() === 'path').length, 1);
  assert.match(refreshed.Path, /C:\\Windows\\UserBin/);
  assert.match(refreshed.Path, /C:\\Users\\A\\AppData\\Roaming\\npm/);

  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const tool = load(['windowsTool'], {
    spawn: (_file, args) => { powershellCommand = args; return child; },
    refreshedWindowsEnv: () => ({ Path: 'C:\\Safe' })
  });
  const pending = tool.windowsTool("C:\\O'Hara Dir\\npm.cmd", ['install', "it's-safe"]);
  child.emit('close', 0);
  return pending;
}).then(async (result) => {
  assert.equal(result.ok, true);
  assert.equal(powershellCommand[0], '-NoProfile');
  const script = Buffer.from(powershellCommand[powershellCommand.length - 1], 'base64').toString('utf16le');
  assert.match(script, /\$toolArgs=@\('install','it''s-safe'\)/);
  assert.doesNotMatch(script, /JSON\.stringify/);

  // stdout is deliberately split through the token name. The production
  // logger must wait for a complete line, redact it, and retain the real URL
  // for the webview/readiness path.
  const output = [];
  const outputChild = { stdout: new PassThrough(), stderr: new PassThrough() };
  const outputContext = load(['redactTokenUrls', 'pipeChildOutput'], {
    URL,
    process: { stdout: { write: (chunk) => output.push(String(chunk)) }, stderr: { write: () => {} } }
  });
  const outputSource = outputContext.pipeChildOutput(outputChild, true);
  const token = 'never-print-this-token';
  const expectedUrl = `http://127.0.0.1:45678/?token=${token}&keep=value`;
  outputChild.stdout.write('dsh web: http://127.0.0.1:45678/?to');
  outputChild.stdout.write(`ken=${token}&keep=value\n`);
  const outputEnded = once(outputChild.stdout, 'end');
  outputChild.stdout.end();
  await outputEnded;
  assert.equal(outputSource.discoveredUrl(), expectedUrl);
  assert.equal(output.join('').includes(token), false);
  assert.match(output.join(''), /token=REDACTED/);

  // WSL recovery logs a saved raw tail, so it must use the same redactor.
  assert.equal(outputContext.redactTokenUrls(`dsh web: ${expectedUrl}`).includes(token), false);
  assert.match(source, /initial dsh web output tail:[\s\S]{0,120}redactTokenUrls\(output\)\.slice\(-4000\)/);

  // A never-terminated verbose line is bounded and never emits a split token.
  const longOutput = [];
  const longChild = { stdout: new PassThrough(), stderr: new PassThrough() };
  const longContext = load(['redactTokenUrls', 'pipeChildOutput'], {
    URL,
    process: { stdout: { write: (chunk) => longOutput.push(String(chunk)) }, stderr: { write: () => {} } }
  });
  const longSource = longContext.pipeChildOutput(longChild, true);
  longChild.stdout.write('dsh web: http://127.0.0.1:45678/?token=' + token.slice(0, 8));
  longChild.stdout.write('x'.repeat(17 * 1024));
  longChild.stdout.write(token.slice(8));
  longChild.stdout.write('\nnext line\n');
  const longEnded = once(longChild.stdout, 'end');
  longChild.stdout.end();
  await longEnded;
  assert.ok(longOutput.join('').length < 1024, 'unterminated verbose output must remain bounded');
  assert.equal(longOutput.join('').includes(token), false);
  assert.match(longOutput.join(''), /verbose line omitted/);
  assert.equal(longSource.discoveredUrl(), null, 'discarded partial URL must not be treated as ready');

  // OS-assigned servers can announce more than once; use the last complete URL.
  const latestChild = { stdout: new PassThrough(), stderr: new PassThrough() };
  const latestContext = load(['redactTokenUrls', 'pipeChildOutput'], {
    URL,
    process: { stdout: { write: () => {} }, stderr: { write: () => {} } }
  });
  const latestSource = latestContext.pipeChildOutput(latestChild, false);
  latestChild.stdout.write('dsh web: http://127.0.0.1:40001/\n');
  latestChild.stdout.write('dsh web: http://127.0.0.1:40002/\n');
  const latestEnded = once(latestChild.stdout, 'end');
  latestChild.stdout.end();
  await latestEnded;
  assert.equal(latestSource.discoveredUrl(), 'http://127.0.0.1:40002/');

  let tokenProbeCalls = 0;
  const waiter = load(['waitForServer'], {
    URL,
    probe: async () => { throw new Error('fixed/no-token probe must not run'); },
    probeSpawnedTokenUrl: async (url) => { tokenProbeCalls++; return url === expectedUrl ? 'harness' : 'busy'; },
    sleep: async () => {}, POLL_INTERVAL_MS: 300
  });
  const started = Date.now();
  const ready = await waiter.waitForServer(null, () => expectedUrl, { exitCode: null, signalCode: null }, 2_000);
  assert.equal(ready, expectedUrl);
  assert.equal(tokenProbeCalls, 1);
  assert.ok(Date.now() - started < 1_000, 'token handshake must not wait for READY_TIMEOUT_MS');

  // The production connect success log must redact the token while preserving
  // the real URL for the webview and endpoint state.
  const connectLogs = [];
  const connectState = {
    cfg: { verbose: true }, activeEndpoint: null, currentPage: null,
    displayEndpoint: null, url: null, child: null, childAlive: false,
    view: 'web', endpoints: [], views: {}
  };
  const endpoint = { id: 'local', kind: 'local', name: 'Windows', port: 3080,
    url: null, urlOverride: null, childAlive: false, status: 'starting', wasOnline: false, detail: '' };
  const connectEndpoint = load(['connectEndpoint', 'connectEndpointAttempt', 'redactTokenUrls'], {
    URL,
    process: { platform: 'win32' },
    console: { log: (...args) => connectLogs.push(args.join(' ')), error: () => {} },
    appState: connectState,
    getEndpoint: () => endpoint,
    getEndpointView: () => {}, layout: () => {}, loadWeb: () => {},
    hideStartupOverlay: () => {}, showStartupOverlay: () => {}, pushStartupProgress: () => {}, loadStartupPage: () => {},
    pushPureInfo: () => {}, setStatus: () => {},
    refreshDshMenu: () => {},
    detectWindowsEndpoint: () => Promise.resolve(),
    routerUrl: () => 'router://starting', wslRouterUrl: () => 'router://wsl', windowsRouterUrl: () => 'router://windows',
    resolveServerFor: async () => ({ url: expectedUrl, child: null }),
    bindChildExit: () => {}, probeEndpointUrl: async () => 'harness', showWebOnly: () => {},
    stripTokenUrl: (raw) => new URL(raw).origin + '/',
    sameOrigin: () => false,
    isCurrentEndpointAttempt: () => true
  });
  await connectEndpoint.connectEndpoint('local');
  assert.equal(endpoint.url.includes('token'), false);
  assert.equal(endpoint.authUrl, expectedUrl);
  assert.equal(connectState.url, expectedUrl);
  assert.equal(connectLogs.some((line) => line.includes(token)), false);
  assert.match(connectLogs.join('\n'), /web view -> .*token=REDACTED/);

  // On Windows, an unauthenticated or otherwise busy listener must reach the
  // router error state, never block startup in the native port-conflict modal.
  let restoreResult = null;
  let windowsProbeStatus = 'auth_required';
  let conflictDialogs = 0;
  const windowsResolver = load(['resolveServerFor'], {
    process: { platform: 'win32' },
    tryRestoreWindowsDsh: async () => restoreResult,
    probeEndpointUrl: async () => windowsProbeStatus,
    spawnOnPort: async () => { throw new Error('must not spawn over busy port'); },
    showPortConflictDialog: () => { conflictDialogs++; return false; },
    app: { exit: () => { throw new Error('must not exit'); } }
  });
  const forcedFreshResolver = load(['resolveServerFor'], {
    process: { platform: 'win32' },
    tryRestoreWindowsDsh: async () => { throw new Error('force-start must skip retained recovery once'); },
    probeEndpointUrl: async () => 'free',
    spawnOnPort: async () => ({ url: 'http://127.0.0.1:45678/', child: null })
  });
  const forcedFresh = { id: 'local', port: 45678, dshBin: 'dsh', _skipWindowsRecoveryOnce: true };
  assert.equal((await forcedFreshResolver.resolveServerFor({ port: 45678, dshBin: 'dsh' }, forcedFresh)).url, 'http://127.0.0.1:45678/');
  assert.equal(forcedFresh._skipWindowsRecoveryOnce, undefined, 'one-shot recovery skip is consumed');
  const resolverCfg = { port: 3080, dshBin: 'dsh', verbose: false };
  const resolverEndpoint = { port: 3080, urlOverride: null };
  await assert.rejects(
    windowsResolver.resolveServerFor(resolverCfg, resolverEndpoint),
    /需要认证 URL/
  );
  windowsProbeStatus = 'busy';
  await assert.rejects(
    windowsResolver.resolveServerFor(resolverCfg, resolverEndpoint),
    /端口 3080 已被占用/
  );
  assert.equal(conflictDialogs, 0, 'Windows busy/auth-required must not open the native conflict dialog');
  restoreResult = { unavailable: true, retained: true, reason: 'token 握手暂时不可用' };
  await assert.rejects(windowsResolver.resolveServerFor(resolverCfg, resolverEndpoint), /凭据已保留/);
  restoreResult = { unavailable: true, retained: false, reason: 'DSH 已明确拒绝保存的认证' };
  await assert.rejects(windowsResolver.resolveServerFor(resolverCfg, resolverEndpoint), /凭据已清理/);

  let retryHandler;
  let retryDetections = 0;
  const retryContext = vm.createContext({
    ipcMain: { on: (_channel, handler) => { retryHandler = handler; } },
    isLocalRouterSender: () => true,
    isWindowsBusy: () => false,
    connectEndpoint: () => Promise.resolve(),
    getEndpoint: () => ({ status: 'error' }),
    detectWindowsEndpoint: () => { retryDetections++; return Promise.resolve(); },
    windowsStartInFlight: false
  });
  vm.runInContext(extractIpcRegistration('router:windows-retry'), retryContext, { filename: 'main.js (retry handler)' });
  retryHandler({});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(retryContext.windowsStartInFlight, false);
  assert.equal(retryDetections, 1);

  // Production ticker regression: a failed first Windows-local start has no
  // previous URL. Its null endpoint URL must never match the null router URL
  // and replace the Windows setup guide with the generic offline page.
  let offlineLoads = 0;
  const failedLocal = {
    id: 'local', kind: 'local', name: 'Windows', port: 3080,
    url: null, childAlive: false, wasOnline: false, status: 'error'
  };
  const ticker = load(['tickEndpoints'], {
    appState: {
      endpoints: [failedLocal], displayEndpoint: 'local', url: null,
      views: { local: { webContents: { isDestroyed: () => false, loadURL: () => { offlineLoads++; } } } }
    },
    ticking: false,
    probeEndpointUrl: async () => 'free', detectWslEndpoint: () => Promise.resolve(),
    pushPureInfo: () => {}, setStatus: () => {}, layout: () => {},
    pushWslStatus: () => {}, routerUrl: () => 'router://offline'
  });
  await ticker.tickEndpoints();
  assert.equal(offlineLoads, 0);
  assert.equal(failedLocal.status, 'unknown');

  // Token handshake is selected by the URL, not stale endpoint state. A bare
  // URL must preserve the exact DSH auth_required classification.
  let tokenHealthChecks = 0;
  let bareHealthChecks = 0;
  const tokenTicker = load(['probeEndpointUrl'], {
    URL,
    probeWithGrace: async () => { bareHealthChecks++; return 'auth_required'; },
    probeSpawnedTokenUrl: async () => { tokenHealthChecks++; return 'harness'; }
  });
  assert.equal(await tokenTicker.probeEndpointUrl({ tokenAuth: true }, 'http://127.0.0.1:45678/?token=test'), 'harness');
  assert.equal(tokenHealthChecks, 1);
  assert.equal(await tokenTicker.probeEndpointUrl({ tokenAuth: true }, 'http://127.0.0.1:45678/'), 'auth_required');
  assert.equal(bareHealthChecks, 1, 'stale tokenAuth must not force a token handshake on a bare URL');

  const foreign401 = load(['probeEndpointUrl'], {
    URL, probeWithGrace: async () => 'busy', probeSpawnedTokenUrl: async () => { throw new Error('foreign bare 401 must not use token handshake'); }
  });
  assert.equal(await foreign401.probeEndpointUrl({ tokenAuth: true }, 'http://127.0.0.1:45679/'), 'busy');

  // Recovery records are DPAPI/safeStorage ciphertext at rest. Reuse remains
  // conditional on every identity check and the token handshake.
  const recoveryFiles = new Map();
  const recoveryToken = 'confidential-token-value';
  const recoveryUrl = `http://127.0.0.1:45678/?token=${recoveryToken}`;
  let recoveryHandshake = 'harness';
  let recoveryKilled = false;
  let recoveryKillSucceeds = true;
  let recoveryOwner = { pid: 4242 };
  let recoveryIdentity = { pid: 4242, creationTime: '20260908120000.000000+480', commandLine: 'node C:\\npm\\node_modules\\@deepseek-ai\\dsh\\bin.js web --port 45678' };
  let recoveryOwnerFailures = 0;
  let recoveryIdentityFailures = 0;
  let recoveryHandshakeSequence = [];
  const recovery = load([
    'windowsRecoveryFile', 'clearWindowsRecovery', 'readWindowsRecovery',
    'writeWindowsRecovery', 'isExpectedWindowsDshCommand', 'tryRestoreWindowsDsh', 'stopWindowsRecoveryOnQuit'
  ], {
    URL, path: path.win32,
    process: { platform: 'win32' },
    app: { getPath: () => 'C:\\UserData' },
    fs: {
      readFileSync: (file) => { if (!recoveryFiles.has(file)) throw new Error('missing'); return recoveryFiles.get(file); },
      writeFileSync: (file, value) => recoveryFiles.set(file, value),
      unlinkSync: (file) => recoveryFiles.delete(file)
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from('dpapi:' + value.split('').reverse().join('')),
      decryptString: (value) => Buffer.from(value).toString('utf8').slice(6).split('').reverse().join('')
    },
    findPortOwner: () => recoveryKilled || recoveryOwnerFailures-- > 0 ? null : recoveryOwner,
    windowsProcessIdentity: () => recoveryIdentityFailures-- > 0 ? null : recoveryIdentity,
    findPortOwnerAsync: async () => recoveryKilled || recoveryOwnerFailures-- > 0 ? null : recoveryOwner,
    windowsProcessIdentityAsync: async () => recoveryIdentityFailures-- > 0 ? null : recoveryIdentity,
    forceKillPid: () => { if (recoveryKillSucceeds) recoveryKilled = true; return recoveryKillSucceeds; },
    probeSpawnedTokenUrl: async () => recoveryHandshakeSequence.length ? recoveryHandshakeSequence.shift() : recoveryHandshake,
    sleep: async () => {},
    WINDOWS_RECOVERY_MAX_AGE_MS: 24 * 60 * 60 * 1000
  });
  const recoveryRecord = { version: 1, savedAt: Date.now(), url: recoveryUrl, port: 45678, pid: 4242, creationTime: '20260908120000.000000+480' };
  assert.equal(recovery.writeWindowsRecovery(recoveryRecord), true);
  const recoveryDisk = recoveryFiles.get(recovery.windowsRecoveryFile());
  assert.equal(String(recoveryDisk).includes(recoveryToken), false, 'recovery file must not contain plaintext token');
  const restoredRecovery = await recovery.tryRestoreWindowsDsh(45678);
  assert.ok(restoredRecovery && restoredRecovery.child === null && restoredRecovery.url === recoveryUrl, 'valid recovery reused');
  recovery.writeWindowsRecovery(Object.assign({}, recoveryRecord, { pid: 9999 }));
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'wrong PID rejected into an actionable error');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), false, 'wrong PID removes unsafe credentials');
  recovery.writeWindowsRecovery(Object.assign({}, recoveryRecord, { savedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'expired record rejected into an actionable error');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), false, 'expired credentials are removed');
  recovery.writeWindowsRecovery(recoveryRecord);
  assert.equal(await recovery.tryRestoreWindowsDsh(45679), null, 'changed configured port skips recovery');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), true, 'changed configured port retains credentials');
  recoveryOwnerFailures = 1;
  assert.ok((await recovery.tryRestoreWindowsDsh(45678)).url === recoveryUrl, 'one owner lookup failure retries and restores');
  recoveryIdentityFailures = 1;
  assert.ok((await recovery.tryRestoreWindowsDsh(45678)).url === recoveryUrl, 'one CIM lookup failure retries and restores');
  recoveryHandshakeSequence = ['unavailable', 'harness'];
  assert.ok((await recovery.tryRestoreWindowsDsh(45678)).url === recoveryUrl, 'one token handshake failure retries and restores');
  recoveryOwner = null;
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'transient owner lookup does not restore blindly');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), true, 'transient owner lookup preserves credentials');
  recoveryOwner = { pid: 4242 }; recoveryIdentity = null;
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'transient CIM lookup does not restore blindly');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), true, 'transient CIM lookup preserves credentials');
  recoveryIdentity = { pid: 4242, creationTime: '20260908120000.000000+480', commandLine: 'node C:\\npm\\node_modules\\@deepseek-ai\\dsh\\bin.js web --port 45678' };
  recovery.writeWindowsRecovery(recoveryRecord);
  recoveryHandshake = 'busy';
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'transient token handshake is not reused');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), true, 'transient token handshake preserves credentials');
  recoveryHandshake = 'auth_required';
  assert.equal((await recovery.tryRestoreWindowsDsh(45678)).unavailable, true, 'invalid DSH authentication is rejected');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), false, 'invalid DSH authentication removes credentials');
  assert.equal(recovery.isExpectedWindowsDshCommand('node @deepseek-ai/dsh web --port 45678', 45678), true);
  assert.equal(recovery.isExpectedWindowsDshCommand('node @deepseek-ai/dsh web --port 45679', 45678), false);
  assert.equal(recovery.isExpectedWindowsDshCommand('node @deepseek-ai/dsh web --port 0', 45678), true, 'dynamic-port recovery accepts --port 0 only after listener identity checks');
  recoveryHandshake = 'harness'; recoveryKilled = false; recoveryKillSucceeds = false; recoveryOwner = { pid: 4242 };
  recovery.writeWindowsRecovery(recoveryRecord);
  assert.equal(recovery.stopWindowsRecoveryOnQuit(), false, 'failed verified shutdown preserves recovery credentials');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), true, 'credentials survive an unsuccessful shutdown');
  recoveryHandshake = 'harness'; recoveryKilled = false; recoveryKillSucceeds = true;
  recovery.writeWindowsRecovery(recoveryRecord);
  assert.equal(recovery.stopWindowsRecoveryOnQuit(), true, 'normal quit stops the verified recovered listener');
  assert.equal(recoveryFiles.has(recovery.windowsRecoveryFile()), false, 'credentials clear only after the verified listener stopped');
  console.log('selftest-windows: production main.js functions passed (mocked; no installation executed)');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
