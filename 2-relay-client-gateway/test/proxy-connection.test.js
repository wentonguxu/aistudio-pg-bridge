'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

test('native environment proxy mode reuses connections between requests', { skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy') }, async () => {
  const sockets = new Set();
  let requests = 0;
  let connects = 0;
  const respond = (req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
  const origin = http.createServer(respond);
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer(respond);
  proxy.on('connection', socket => sockets.add(socket));
  proxy.on('connect', (req, socket, head) => {
    connects++;
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${proxy.address().port}`;
    const helper = path.resolve(__dirname, '../src/system-proxy.js');
    const code = `const {fetchWithSystemProxyFallback}=require(${JSON.stringify(helper)});
      (async()=>{for(let i=0;i<2;i++){const r=await fetchWithSystemProxyFallback('http://relay-test.invalid/probe');if(!(await r.json()).ok)throw Error('bad response');await new Promise(resolve=>setTimeout(resolve,20));}})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
    await promisify(execFile)(process.execPath, ['--use-env-proxy', '-e', code], {
      env: { ...process.env, NODE_OPTIONS: '', HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: '', no_proxy: '' },
      timeout: 15000,
      windowsHide: true,
    });
    assert.equal(requests, 2);
    assert.equal(connects, 1, 'native requests should share a CONNECT tunnel');
    assert.equal(sockets.size, 1, 'proxy socket should be reused rather than opened per request');
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections(); origin.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]);
  }
});
