'use strict';

// Selftest for the port policy helpers (plain Node, no Electron):
//   1. free test port      -> 'free'
//   2. foreign listener    -> 'busy'
//   3. owner lookup        -> { pid: this process, name: non-empty }
//   4. after close         -> 'free'
//   5. 3080 status         -> informational only (the real harness may be up)
//
// Usage: node tools/selftest-port.js [testPort]   (default 3987, never 3080)
const http = require('node:http');
const {
  probe, probeSpawnedTokenUrl, probeWithGrace, findPortOwner,
  parseWindowsTcpListeningPid, DSH_AUTH_REQUIRED_BODY
} = require('../port-probe.js');

const PORT = Number(process.argv[2] || 3987);
if (PORT === 3080) {
  console.error('refusing to selftest on 3080 — that is the harness port');
  process.exit(1);
}
const URL = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

async function main() {
  selftestWindowsNetstatParsing();
  check(`no listener on ${PORT}`, await probe(URL), 'free');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>definitely not dsh</body></html>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  try {
    check('foreign listener', await probe(URL), 'busy');
    const owner = findPortOwner(PORT);
    console.log('OK   owner lookup: ' + JSON.stringify(owner));
    check('owner.pid === self', owner && owner.pid === process.pid, true);
    check(
      'owner.name non-empty',
      owner ? typeof owner.name === 'string' && owner.name.length > 0 : false,
      true
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((r) => setTimeout(r, 300));
  }

  check('after close', await probe(URL), 'free');
  await selftestSpawnedTokenHandshake();
  console.log(`info 3080 status: ${(await probe('http://127.0.0.1:3080')).toUpperCase()}`);
  if (failures > 0) process.exit(1);
  console.log('all selftest checks passed');
}

function selftestWindowsNetstatParsing() {
  // Captured netstat column shape: only a positive-PID local LISTENING row
  // owns the requested port.  The other rows model the PID 0 TIME_WAIT output
  // that previously prevented Windows force-start from seeing a free port.
  const fixture = [
    '  TCP    127.0.0.1:51742      127.0.0.1:3080       TIME_WAIT       0',
    '  TCP    127.0.0.1:51743      127.0.0.1:3080       ESTABLISHED     4420',
    '  TCP    127.0.0.1:3080       0.0.0.0:0            LISTENING       57740',
    '  TCP    [::1]:51744          [::1]:3080           TIME_WAIT       0'
  ].join('\r\n');
  check('Windows netstat finds only local positive-PID listener', parseWindowsTcpListeningPid(fixture, 3080), 57740);
  const noListener = fixture.replace('LISTENING       57740', 'ESTABLISHED     57740');
  check('Windows netstat excludes TIME_WAIT, ESTABLISHED, remote port and PID 0', parseWindowsTcpListeningPid(noListener, 3080), null);
  check('Windows localized listening state remains supported', parseWindowsTcpListeningPid(' TCP    0.0.0.0:3080  0.0.0.0:0  侦听  1234', 3080), 1234);
}

async function selftestSpawnedTokenHandshake() {
  const token = 'never-print-this-token';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/token-ok')) {
      res.writeHead(303, { 'set-cookie': 'dsh_session=fixture; HttpOnly', location: '/' });
    } else if (req.url.startsWith('/token-200')) {
      res.writeHead(200, { 'content-type': 'text/html' });
    } else if (req.url.startsWith('/nested/token-relative')) {
      res.writeHead(303, { 'set-cookie': 'dsh_session=fixture', location: '../' });
    } else if (req.url.startsWith('/token-no-cookie')) {
      res.writeHead(303, { location: '/' });
    } else if (req.url.startsWith('/token-external')) {
      res.writeHead(303, { 'set-cookie': 'dsh_session=fixture', location: 'http://localhost/' });
    } else if (req.url.startsWith('/token-non-root')) {
      res.writeHead(303, { 'set-cookie': 'dsh_session=fixture', location: '/login' });
    } else if (req.url === '/auth-required') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(DSH_AUTH_REQUIRED_BODY + '\n');
      return;
    } else if (req.url === '/foreign-401') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      // A trailing space must not be accepted by the CR/LF-only tolerance.
      res.end(DSH_AUTH_REQUIRED_BODY + ' \n');
      return;
    } else if (req.url.startsWith('/token-auth-required')) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(DSH_AUTH_REQUIRED_BODY + '\n');
      return;
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
    }
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const fixturePort = server.address().port;
  const fixture = (path) => `http://127.0.0.1:${fixturePort}${path}?token=${token}&keep=value`;
  try {
    const goodUrl = fixture('/token-ok');
    check('token URL HTTP 200', await probeSpawnedTokenUrl(fixture('/token-200')), 'harness');
    check('token 303 + cookie + same-origin root', await probeSpawnedTokenUrl(goodUrl), 'harness');
    check('token 303 relative root redirect', await probeSpawnedTokenUrl(fixture('/nested/token-relative')), 'harness');
    check('token 303 without cookie rejected', await probeSpawnedTokenUrl(fixture('/token-no-cookie')), 'busy');
    check('token 303 external redirect rejected', await probeSpawnedTokenUrl(fixture('/token-external')), 'busy');
    check('token 303 non-root redirect rejected', await probeSpawnedTokenUrl(fixture('/token-non-root')), 'busy');
    check('token URL exact DSH 401 identifies invalid authentication', await probeSpawnedTokenUrl(fixture('/token-auth-required')), 'auth_required');
    const immediate = Date.now();
    check('exact DSH 401 classified', await probe(fixture('/auth-required').replace(/\?.*$/, '')), 'auth_required');
    check('exact DSH 401 has no grace delay', await probeWithGrace(fixture('/auth-required').replace(/\?.*$/, '')), 'auth_required');
    if (Date.now() - immediate > 900) throw new Error('exact DSH 401 unexpectedly retried');
    check('foreign 401 stays busy', await probe(fixture('/foreign-401').replace(/\?.*$/, '')), 'busy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
