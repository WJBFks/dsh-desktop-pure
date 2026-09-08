'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(name) {
  const asyncAt = source.indexOf('async function ' + name + '(');
  const plainAt = source.indexOf('function ' + name + '(');
  const start = asyncAt !== -1 ? asyncAt : plainAt;
  assert.notEqual(start, -1, 'missing ' + name);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}
function load(names, extra) {
  const context = vm.createContext(Object.assign({ URL, Number, String, Promise }, extra));
  vm.runInContext(names.map(extract).join('\n'), context);
  return context;
}

function extractHandle(channel) {
  const start = source.indexOf("ipcMain.handle('" + channel + "'");
  assert.notEqual(start, -1, 'missing handle ' + channel);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, source.indexOf(');', i) + 2);
  }
  throw new Error('unterminated handle ' + channel);
}

function registeredHandle(channel, extra) {
  let handler;
  const context = vm.createContext(Object.assign({
    ipcMain: { handle: (name, fn) => { if (name === channel) handler = fn; } },
    Promise, Number, String, URL
  }, extra));
  vm.runInContext(extractHandle(channel), context);
  assert.equal(typeof handler, 'function', 'handler registered');
  return { handler, context };
}

const urls = load(['windowsAuthUrl', 'isManualWindowsDshCommand'], {});
assert.equal(urls.windowsAuthUrl('secret-token', 3080).ok, true);
assert.equal(urls.windowsAuthUrl('http://127.0.0.1:3080/?token=secret-token', 3080).ok, true);
assert.equal(urls.windowsAuthUrl('http://localhost:3080/?token=secret-token', 3080).ok, true);
assert.equal(urls.windowsAuthUrl('http://[::1]:3080/?token=secret-token', 3080).ok, true);
assert.equal(urls.windowsAuthUrl('http://evil.test:3080/?token=secret-token', 3080).ok, false);
assert.equal(urls.windowsAuthUrl('http://user@127.0.0.1:3080/?token=secret-token', 3080).ok, false);
assert.equal(urls.windowsAuthUrl('http://127.0.0.1:3081/?token=secret-token', 3080).ok, false);
assert.equal(urls.isManualWindowsDshCommand('node C:\\npm\\node_modules\\@deepseek-ai\\dsh\\bin.js web'), true);
assert.equal(urls.isManualWindowsDshCommand('node.exe unrelated-web.js'), false);

async function verificationCases() {
  const portFree = load(['endpointPortIsFree'], {
    pageEndpointRuntimeUrl: (endpoint) => endpoint.url,
    findPortOwnerAsync: async () => null,
    tcpPortRefused: async () => true
  });
  assert.equal(await portFree.endpointPortIsFree({ url: 'http://127.0.0.1:3080/' }), true,
    'endpointPortIsFree proceeds to bounded TCP refusal when listener lookup finds no owner');

  const ep = { port: 3080 };
  const verified = load(['isManualWindowsDshCommand', 'verifyWindowsAuthRequiredListener'], {
    appState: { cfg: { port: 3080 } },
    findPortOwnerAsync: async () => ({ pid: 77 }),
    windowsProcessIdentityAsync: async () => ({ pid: 77, creationTime: 'time-a', commandLine: 'node @deepseek-ai/dsh web' }),
    probeWithGrace: async () => 'auth_required'
  });
  const identity = await verified.verifyWindowsAuthRequiredListener(ep);
  assert.equal(identity.pid, 77);
  assert.equal(identity.creationTime, 'time-a');
  assert.equal(identity.port, 3080);
  verified.probeWithGrace = async () => 'busy';
  assert.equal(await verified.verifyWindowsAuthRequiredListener(ep), null, 'foreign 401/busy is never force-start eligible');

  const reused = load(['isReusedWindowsAuthEndpoint', 'verifyReusedWindowsAuthListener'], {
    URL, process: { platform: 'win32' },
    findPortOwnerAsync: async () => ({ pid: 99 }),
    windowsProcessIdentityAsync: async () => ({ creationTime: 'recovery-time', commandLine: 'node @deepseek-ai/dsh web --port 45678' }),
    isExpectedWindowsDshCommand: () => true, isManualWindowsDshCommand: () => true,
    probeWithGrace: async () => 'auth_required', probeSpawnedTokenUrl: async () => 'harness'
  });
  const recovered = { id: 'local', kind: 'local', port: 0, status: 'online', childAlive: false,
    authUrl: 'http://127.0.0.1:45678/?token=secret', tokenAuth: true,
    recoveryIdentity: { pid: 99, port: 45678, creationTime: 'recovery-time' } };
  const recoveredIdentity = await reused.verifyReusedWindowsAuthListener(recovered);
  assert.equal(recoveredIdentity.port, 45678);
  assert.equal(recoveredIdentity.configuredPort, 0);
  reused.probeWithGrace = async () => 'harness';
  reused.probeSpawnedTokenUrl = async () => { throw new Error('no-token reuse must not use token handshake'); };
  const noToken = { id: 'local', kind: 'local', port: 3080, status: 'online', childAlive: false,
    url: 'http://127.0.0.1:3080/', authUrl: null, tokenAuth: false, recoveryIdentity: null };
  assert.equal((await reused.verifyReusedWindowsAuthListener(noToken)).port, 3080, 'strict harness marker permits no-token reuse');
}

verificationCases().then(() => {
  // Handler contracts: no persistence call in the auth handler, strict
  // handshake, cancellation result, and pre-kill page/identity revalidation.
  const authStart = source.indexOf("ipcMain.handle('router:windows-connect-auth'");
  const forceStart = source.indexOf("ipcMain.handle('router:windows-force-start'");
  assert.ok(authStart >= 0 && forceStart > authStart);
  const authBody = source.slice(authStart, forceStart);
  assert.match(authBody, /probeSpawnedTokenUrl\(parsed\.url\)/);
  assert.match(authBody, /ep\.authUrl = parsed\.url/);
  assert.doesNotMatch(authBody, /persistEndpoints|writeFile|console\.(?:log|warn)/);
  const forceBody = source.slice(forceStart, source.indexOf("ipcMain.on('router:windows-install-node'", forceStart));
  assert.match(forceBody, /cancelled: true/);
  assert.match(forceBody, /again\.pid !== first\.pid/);
  assert.match(forceBody, /isLocalRouterSender\(event\)/);
  return handlerCases();
}).then(() => {
  console.log('selftest-windows-auth: URL boundary, identity and IPC safeguards passed');
}, (error) => { console.error(error); process.exitCode = 1; });

async function handlerCases() {
  function forceCase(options = {}) {
    const ep = { id: 'local', port: 3080, _windowsAuthRequired: true, _connectSequence: 4, status: 'error', detail: '' };
    const state = { cfg: { port: 3080 }, currentPage: 'local' };
    let verifyIndex = 0; let kills = 0; let starts = 0;
    const registered = registeredHandle('router:windows-force-start', {
      appState: state, windowsAuthInFlight: false,
      win: {},
      isLocalRouterSender: () => true, isWindowsBusy: () => false,
      getEndpoint: () => ep,
      verifyWindowsAuthRequiredListener: async () => (options.verify || [{ pid: 41, creationTime: 'a', port: 3080 }, { pid: 41, creationTime: 'a', port: 3080 }])[verifyIndex++] || null,
      dialog: { showMessageBox: async () => {
        if (options.changePage) state.currentPage = 'pure';
        return { response: options.response == null ? 1 : options.response };
      } },
      forceKillPidAsync: async (pid) => { kills += 1; assert.equal(pid, 41); return options.kill !== false; },
      waitForEndpointPortFree: async () => {
        if (options.changeSequenceDuringWait) ep._connectSequence += 1;
        return options.free !== false;
      },
      startFreshWindowsLocal: async () => { starts += 1; ep.status = options.startFails ? 'error' : 'online'; return { ok: !options.startFails, error: 'spawn failed' }; },
      endpointPortIsFree: async () => options.listenerFree === true,
      detectWindowsEndpoint: () => Promise.resolve(), pushWindowsStatus: () => {}
    });
    return { ep, state, handler: registered.handler, kills: () => kills, starts: () => starts };
  }
  let test = forceCase({ response: 0 });
  assert.equal((await test.handler({})).cancelled, true);
  assert.equal(test.kills(), 0);
  test = forceCase({ verify: [{ pid: 41, creationTime: 'a', port: 3080 }, { pid: 42, creationTime: 'b', port: 3080 }] });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 0, 'PID/creation change blocks kill');
  test = forceCase({ changePage: true });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 0, 'page change blocks kill');
  test = forceCase({ verify: [null] });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 0, 'foreign listener blocks kill');
  test = forceCase({ verify: [null], listenerFree: true });
  assert.equal((await test.handler({})).ok, true); assert.equal(test.kills(), 0); assert.equal(test.starts(), 1, 'already-free stale auth state starts once without kill');
  test = forceCase({ kill: false });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 1); assert.equal(test.starts(), 0);
  test = forceCase({ free: false });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 1); assert.equal(test.starts(), 0);
  test = forceCase({ changeSequenceDuringWait: true });
  assert.equal((await test.handler({})).ok, false); assert.equal(test.kills(), 1); assert.equal(test.starts(), 0, 'post-stop sequence change cannot launch a new instance');
  test = forceCase({});
  assert.equal((await test.handler({})).ok, true); assert.equal(test.kills(), 1); assert.equal(test.starts(), 1);

  // Execute the production force handler, fresh-start helper, connection
  // dedupe/attempt, and resolver together. The old in-flight promise must be
  // discarded and the mocked spawn boundary reached exactly once.
  const inFlightPending = new Promise(() => {});
  const freshEp = { id: 'local', kind: 'local', port: 3080, _windowsAuthRequired: true, _connectSequence: 7,
    _pendingConnect: inFlightPending, status: 'error', detail: 'old auth error', authUrl: 'http://127.0.0.1:3080/?token=old', child: { pid: 1 }, childAlive: true };
  const freshState = { cfg: { port: 3080, dshBin: 'dsh', verbose: false }, currentPage: 'local', activeEndpoint: 'local', view: 'web', displayEndpoint: 'local', url: 'http://127.0.0.1:3080/?token=old', child: null, childAlive: false };
  let freshHandler;
  let freshSpawns = 0;
  const freshContext = vm.createContext({
    Promise, Number, String, URL, appState: freshState, windowsAuthInFlight: false, win: {},
    ipcMain: { handle: (_name, fn) => { freshHandler = fn; } },
    isLocalRouterSender: () => true, isWindowsBusy: () => false, getEndpoint: () => freshEp,
    verifyWindowsAuthRequiredListener: async () => null, endpointPortIsFree: async () => true,
    process: { platform: 'win32' }, tryRestoreWindowsDsh: async () => { throw new Error('fresh path skips retained recovery'); },
    probeEndpointUrl: async () => 'free', spawnOnPort: async () => { freshSpawns += 1; return { url: 'http://127.0.0.1:3080/', child: null }; },
    getEndpointView: () => {}, hideStartupOverlay: () => {}, showStartupOverlay: () => {}, pushStartupProgress: () => {},
    loadStartupPage: () => {}, loadWeb: () => {}, layout: () => {}, routerUrl: () => 'router:starting', wslRouterUrl: () => 'router:wsl', windowsRouterUrl: () => 'router:windows',
    pushPureInfo: () => {}, setStatus: () => {}, refreshDshMenu: () => {}, bindChildExit: () => {}, showWebOnly: () => {}, sameOrigin: () => false,
    isCurrentEndpointAttempt: undefined,
    forceKillPidAsync: async () => { throw new Error('free path must not kill'); }, waitForEndpointPortFree: async () => true,
    dialog: { showMessageBox: async () => ({ response: 0 }) }, pushWindowsStatus: () => {}, detectWindowsEndpoint: () => Promise.resolve()
  });
  vm.runInContext([
    extract('resolveServerFor'), extract('connectEndpoint'), extract('isCurrentEndpointAttempt'), extract('connectEndpointAttempt'),
    extract('startFreshWindowsLocal'), extractHandle('router:windows-force-start')
  ].join('\n'), freshContext);
  assert.equal((await freshHandler({})).ok, true);
  assert.equal(freshSpawns, 1);
  assert.equal(freshEp.authUrl, null);
  assert.equal(freshEp._windowsAuthRequired, false);
  let failedRouter = '';
  let failedDetects = 0;
  freshContext.spawnOnPort = async () => { throw new Error('mock spawn failure'); };
  freshContext.loadWeb = (url) => { failedRouter = url; };
  freshContext.detectWindowsEndpoint = () => { failedDetects += 1; return Promise.resolve(); };
  freshEp.status = 'online'; freshEp.detail = ''; freshEp._pendingConnect = null;
  const failedFresh = await freshContext.startFreshWindowsLocal(freshEp);
  assert.equal(failedFresh.ok, false);
  assert.equal(freshEp.status, 'error', 'spawn failure remains visible on the router');
  assert.equal(failedDetects, 1, 'failure schedules the existing retryable Windows guide refresh');
  assert.match(failedRouter, /^router:/);

  const ep = { id: 'local', port: 3080, _windowsAuthRequired: true, _connectSequence: 1, status: 'error', detail: '' };
  const state = { cfg: { port: 3080 }, currentPage: 'local', url: null, displayEndpoint: null };
  let loaded = '';
  const auth = registeredHandle('router:windows-connect-auth', {
    appState: state, windowsAuthInFlight: false,
    isLocalRouterSender: () => true, isWindowsBusy: () => false, getEndpoint: () => ep,
    windowsAuthUrl: (input, port) => input === 'bad' ? { ok: false, error: '认证 URL 格式无效' } : { ok: true, url: `http://127.0.0.1:${port}/?token=secret` },
    probeSpawnedTokenUrl: async () => 'harness', stripTokenUrl: () => 'http://127.0.0.1:3080/',
    pushStartupProgress: () => {}, loadStartupPage: (_ep, _seq, url) => { loaded = url; },
    pushPureInfo: () => {}, setStatus: () => {}, refreshDshMenu: () => {}, pushWindowsStatus: () => {}
  });
  assert.equal((await auth.handler({}, 'good')).ok, true);
  assert.equal(ep.authUrl.includes('secret'), true);
  assert.equal(ep.url.includes('secret'), false, 'snapshot-facing endpoint URL is token-free');
  assert.equal(loaded.includes('secret'), true, 'only the in-memory navigation receives token');
  ep._windowsAuthRequired = true; ep.status = 'error'; ep.url = null; ep.authUrl = null;
  auth.context.probeSpawnedTokenUrl = async () => 'auth_required';
  assert.equal((await auth.handler({}, 'good')).ok, false);
  assert.equal(ep.authUrl, null, 'failed handshake retains no input credential');

  let opened = '';
  const browser = registeredHandle('pure:open-endpoint-browser', {
    isPureSender: () => true,
    getEndpoint: () => ({ id: 'local', kind: 'local', url: 'http://127.0.0.1:3080/', authUrl: 'http://127.0.0.1:3080/?token=secret' }),
    pageEndpointRuntimeUrl: (endpoint) => endpoint.authUrl,
    customRuntimeUrl: () => null,
    openExternalSafely: (url) => { opened = url; }
  });
  assert.equal((await browser.handler({}, 'local')).ok, true);
  assert.equal(opened.includes('token=secret'), true, 'explicit browser action uses the in-memory authenticated URL');

  const titleEp = { id: 'local', name: 'Windows', kind: 'local', status: 'online', childAlive: false,
    url: 'http://127.0.0.1:3080/', authUrl: 'http://127.0.0.1:3080/?token=secret' };
  const title = load(['pageStatus'], {
    appState: { currentPage: 'local', url: null }, getEndpoint: () => titleEp,
    pageEndpointRuntimeUrl: (endpoint) => endpoint.authUrl || endpoint.url
  });
  assert.equal(title.pageStatus().url.includes('token=secret'), true, 'titlebar status receives runtime URL for hover');
  assert.match(source, /status: Object\.assign\({}, currentStatus, \{ url: stripTokenUrl\(currentStatus && currentStatus\.url\) \}\)/, 'Pure status snapshot is redacted');

  async function reuseConfirmCase(change) {
    const reused = { id: 'local', kind: 'local', port: 3080, tokenAuth: true, authUrl: 'http://127.0.0.1:3080/?token=secret', childAlive: false, recoveryIdentity: null, _connectSequence: 5 };
    const state = { currentPage: 'local' }; let kills = 0;
    const confirmed = load(['confirmStopReusedWindows'], {
      appState: state, process: { platform: 'win32' },
      getEndpoint: () => reused, isReusedWindowsAuthEndpoint: () => true,
      verifyReusedWindowsAuthListener: async () => ({ pid: 51, creationTime: 'same', port: 3080, configuredPort: 3080, runtimeUrl: reused.authUrl }),
      dialog: { showMessageBox: async () => { if (change === 'page') state.currentPage = 'pure'; if (change === 'seq') reused._connectSequence += 1; return { response: change === 'cancel' ? 0 : 1 }; } },
      win: {}, forceKillPidAsync: async (pid) => { kills += 1; assert.equal(pid, 51); return true; }
    });
    const result = await confirmed.confirmStopReusedWindows(reused, 5, 'local');
    return { result, kills };
  }
  let reuse = await reuseConfirmCase('cancel');
  assert.equal(reuse.result.cancelled, true); assert.equal(reuse.kills, 0);
  reuse = await reuseConfirmCase('page');
  assert.equal(reuse.result.ok, false); assert.equal(reuse.kills, 0);
  reuse = await reuseConfirmCase('seq');
  assert.equal(reuse.result.ok, false); assert.equal(reuse.kills, 0);
  reuse = await reuseConfirmCase();
  assert.equal(reuse.result.ok, true); assert.equal(reuse.kills, 1, 'verified reused Windows DSH is the only external PID killed');

  function reusedRestartCase(options = {}) {
    const endpoint = { id: 'local', kind: 'local', port: 3080, status: 'online', detail: '', authUrl: 'http://127.0.0.1:3080/?token=secret', tokenAuth: true, _connectSequence: 3, _stopping: Boolean(options.stopping) };
    const state = { currentPage: options.page || 'local' }; let starts = 0; let confirms = 0;
    const restart = load(['restartReusedWindowsServer'], {
      appState: state, getEndpoint: () => endpoint,
      confirmStopReusedWindows: async () => { confirms += 1; return options.cancel ? { ok: false, cancelled: true } : { ok: true, identity: { port: 3080 } }; },
      waitForEndpointPortFree: async () => true,
      restartServer: async (_id, opts) => { starts += 1; assert.equal(opts.ownedOnly, true); assert.equal(opts.expectedPage, state.currentPage); endpoint.status = 'online'; },
      refreshDshMenu: () => {}, setStatus: () => {}
    });
    return { endpoint, state, restart, starts: () => starts, confirms: () => confirms };
  }
  let orchestration = reusedRestartCase({ cancel: true });
  assert.equal(await orchestration.restart.restartReusedWindowsServer(orchestration.endpoint), false);
  assert.equal(orchestration.starts(), 0); assert.equal(orchestration.endpoint._stopping, false);
  orchestration = reusedRestartCase({ page: 'pure' });
  assert.equal(await orchestration.restart.restartReusedWindowsServer(orchestration.endpoint), true);
  assert.equal(orchestration.starts(), 1, 'verified reused restart starts exactly once');
  orchestration = reusedRestartCase({ stopping: true });
  assert.equal(await orchestration.restart.restartReusedWindowsServer(orchestration.endpoint), false);
  assert.equal(orchestration.confirms(), 0, 'duplicate IPC is locked out');

  let finishConfirm;
  const oldEndpoint = { id: 'local', kind: 'local', port: 3080, status: 'online', detail: '', authUrl: 'http://127.0.0.1:3080/?token=secret', tokenAuth: true, _connectSequence: 1 };
  const oldState = { currentPage: 'local' };
  const old = load(['restartReusedWindowsServer'], {
    appState: oldState, getEndpoint: () => oldEndpoint,
    confirmStopReusedWindows: () => new Promise((resolve) => { finishConfirm = resolve; }),
    waitForEndpointPortFree: async () => true, restartServer: async () => {}, refreshDshMenu: () => {}, setStatus: () => {}
  });
  const oldPending = old.restartReusedWindowsServer(oldEndpoint);
  oldEndpoint._reusedRestartGeneration = 2; oldEndpoint._stopping = true;
  finishConfirm({ ok: false }); await oldPending;
  assert.equal(oldEndpoint._stopping, true, 'old finally cannot unlock a newer request');

  let forced = 0;
  let clock = 0;
  const offline = { id: 'local', kind: 'local', port: 3080, status: 'offline', detail: '', child: null, childAlive: false, recoveryIdentity: null };
  const legacy = load(['restartServer'], {
    appState: { cfg: { port: 3080, dshBin: 'dsh' }, currentPage: 'local', view: 'web', displayEndpoint: 'local' },
    win: {}, restarting: false, process: { platform: 'win32' },
    getEndpoint: () => offline, currentPageEndpoint: () => offline, isReusedWindowsAuthEndpoint: () => false,
    loadWeb: () => {}, layout: () => {}, pushPureInfo: () => {}, setStatus: () => {}, hideLoading: () => {}, refreshDshMenu: () => {},
    routerUrl: () => 'router:error', wslRouterUrl: () => 'router:wsl', probeWithGrace: async () => 'busy',
    Date: { now: () => { clock += 11_000; return clock; } }, sleep: async () => {}, forceKillPid: () => { forced += 1; },
    resolveWslServer: async () => ({}), spawnOnPort: async () => ({})
  });
  await legacy.restartServer('local');
  assert.equal(forced, 0, 'offline Windows endpoint without ownership never reaches legacy force-kill');
}
