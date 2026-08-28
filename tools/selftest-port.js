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
const { probe, findPortOwner } = require('../port-probe.js');

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
  console.log(`info 3080 status: ${(await probe('http://127.0.0.1:3080')).toUpperCase()}`);
  if (failures > 0) process.exit(1);
  console.log('all selftest checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});