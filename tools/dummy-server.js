'use strict';

// Temporary dev tool: a foreign (non-harness) HTTP listener used to exercise
// the port-conflict dialog. Usage: node tools/dummy-server.js [port]
const http = require('node:http');
const port = Number(process.argv[2] || 3987);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>definitely not dsh</body></html>');
});
server.listen(port, '127.0.0.1', () => {
  console.log(`dummy listening on ${port} pid ${process.pid}`);
});
