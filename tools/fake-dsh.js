'use strict';

// A stand-in `dsh` for offline testing of the spawn/ready/load chain:
// parses `web --no-open --port N`, serves a harness-lookalike index on
// 127.0.0.1:N, and prints the exact `dsh web: http://…` URL line real dsh
// prints. Never touches real dsh data.
const http = require('node:http');

const argv = process.argv.slice(2);
if (argv[0] !== 'web') {
  console.error('fake-dsh: only the `web` subcommand is supported');
  process.exit(2);
}

function flag(name, fallback) {
  const eq = argv.indexOf(`--${name}=`);
  if (eq !== -1) return argv[eq].slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const port = Number(flag('port', '3080'));
const host = '127.0.0.1';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title></head>
<body style="background:#111827;color:#e5e7eb;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <h1>DeepSeek Harness（测试桩）</h1>
    <p>这是 fake-dsh 页面，仅用于验证 DSH Desktop Pure 的拉起/冲突逻辑，不是真实界面。</p>
    <p>端口：${port}　PID：${process.pid}</p>
  </div>
</body></html>`);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, host, () => {
  console.log(`dsh web: http://${host}:${port}`);
});
