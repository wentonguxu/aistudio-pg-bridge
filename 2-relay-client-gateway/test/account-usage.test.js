'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { RelayAccountStore, renderDashboardHtml } = require('../src/dashboard');
const { WaaRelayClient } = require('../src/relay-server');
const COOKIES = 'SID=fake; SAPISID=fake; HSID=fake; SSID=fake; __Secure-1PSID=fake';
const STREAM_BODY = JSON.stringify([[[[[null, 1]]]]]);

test('daily outcomes persist, keep model-specific failures and never invent quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-'));
  try {
    let store = new RelayAccountStore({ storageDir: dir });
    const account = store.addAccount(COOKIES);
    store.recordOutcome(account.accountId, 'models/gemini-3.8-flash', { ok: true });
    store.recordOutcome(account.accountId, 'models/gemini-4-argon', { ok: false, kind: 'proof', status: 500 });
    store = new RelayAccountStore({ storageDir: dir });
    const view = store.listPublic()[0];
    assert.equal(view.usage.success, 1);
    assert.equal(view.usage.failed, 1);
    assert.equal(view.modelUsage['gemini-4-argon'].state, 'proof_error');
    assert.equal(view.modelUsage['gemini-3.8-flash'].state, 'available');
    assert.equal(view.remainingQuota, null);
    assert.equal('cookies' in view, false);
    store.addAccount(COOKIES);
    assert.equal(store.listPublic()[0].usage.failed, 1);
    store.accounts.get(view.accountId).dailyBucket = 'old';
    store.addAccount(COOKIES);
    const rolled = store.listPublic()[0];
    assert.equal(rolled.usage.success, 0);
    assert.equal(rolled.usage.failed, 0);
    assert.equal(rolled.modelUsage['gemini-4-argon'].state, 'proof_error');
    assert.equal(rolled.modelUsage['gemini-4-argon'].failed, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('429 denotes observed limiting rather than a confirmed daily quota balance', () => {
  const store = new RelayAccountStore();
  const account = store.addAccount(COOKIES);
  store.recordOutcome(account.accountId, 'gemini-3.8-flash', { ok: false, kind: 'upstream', status: 429 });
  assert.equal(store.listPublic()[0].modelUsage['gemini-3.8-flash'].state, 'limited');
  assert.equal(store.listPublic()[0].remainingQuota, null);
});

test('proof 500 retries once and returns a typed 502 when the signer remains unavailable', async () => {
  let calls = 0;
  let fail = false;
  const server = http.createServer((req, res) => {
    req.resume(); calls++;
    const ok = !fail && calls % 2 === 0;
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true, proof: '!fake' } : { ok: false, error: 'Rpc failed due to xhr error' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WaaRelayClient({ accountStore: new RelayAccountStore(), proofServerUrl: `http://127.0.0.1:${server.address().port}` });
    const params = { cookies: 'SID=fake; SAPISID=fake' };
    assert.equal((await client.requestProof(params)).proof, '!fake');
    assert.equal(calls, 2);
    fail = true;
    await assert.rejects(client.requestProof(params), e => e.httpStatus === 502 && e.failureKind === 'proof');
    assert.equal(calls, 4);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('dashboard explains observed usage and unknown quota', () => {
  const html = renderDashboardHtml({ apiKey: 'test', defaultModel: 'gemini-3.8-flash' });
  assert.ok(/剩余额度.*未知/.test(html), 'remaining quota must be explicitly unknown');
  assert.ok(html.includes('modelUsage'), 'model usage details must be rendered');
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('non-JSON proof responses identify the service and retry only transient failures', async () => {
  for (const [status, body, format, attempts] of [
    [502, '<html><h1>Bad gateway</h1></html>', 'HTML', 2],
    [200, '<html><h1>Temporary error</h1></html>', 'HTML', 2],
    [403, '<html><h1>Forbidden</h1></html>', 'HTML', 1],
    [200, 'invalid JSON', 'invalid JSON', 2],
  ]) {
    let calls = 0;
    const server = http.createServer((req, res) => {
      req.resume(); calls++;
      res.writeHead(status, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new WaaRelayClient({ accountStore: new RelayAccountStore(), proofServerUrl: `http://127.0.0.1:${server.address().port}` });
      await assert.rejects(client.requestProof({ cookies: COOKIES }), error => {
        assert.equal(error.failureKind, 'proof');
        assert.equal(error.httpStatus, 502);
        assert.equal(error.proofStatus, status);
        assert.equal(error.responseFormat, format);
        assert.ok(error.message.includes('Proof Server'));
        assert.ok(!error.message.includes('<html>'));
        return true;
      });
      assert.equal(calls, attempts);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('failover attributes failures and completed responses to the actual accounts', async () => {
  const store = new RelayAccountStore();
  store.backfillIdentities = async () => ({ filled: 0, failed: 0 });
  const first = store.addAccount(COOKIES);
  const second = store.addAccount(COOKIES.replaceAll('fake', 'other'));
  let upstreamCalls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/proof/mint') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, proof: '!fake' }));
    }
    upstreamCalls++;
    res.writeHead(upstreamCalls === 1 ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const client = new WaaRelayClient({ accountStore: store, proofServerUrl: url, generateContentUrl: url + '/generate' });
    await client.callGenerateContent({ accountId: first.accountId, cookies: COOKIES, fromStore: true, model: 'gemini-3.8-flash', payload: { messages: [{ role: 'user', content: 'Hi' }] } });
    assert.equal(upstreamCalls, 2);
    const views = store.listPublic();
    assert.equal(views.find(a => a.accountId === first.accountId).usage.failed, 1);
    assert.equal(views.find(a => a.accountId === first.accountId).usage.success, 0);
    assert.equal(views.find(a => a.accountId === second.accountId).usage.success, 1);
    assert.equal(views.find(a => a.accountId === second.accountId).usage.failed, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('malformed completed response is a failure, not a successful model observation', async () => {
  const store = new RelayAccountStore();
  store.backfillIdentities = async () => ({ filled: 0, failed: 0 });
  const account = store.addAccount(COOKIES);
  const client = new WaaRelayClient({ accountStore: store });
  client._openGenerateStream = async () => ({ res: new Response('invalid JSON'), proofPkg: {}, targetModel: 'models/gemini-3.8-flash', tRpc0: Date.now() });
  await assert.rejects(client.callGenerateContent({ accountId: account.accountId, model: 'gemini-3.8-flash' }));
  assert.equal(store.listPublic()[0].usage.failed, 1);
  assert.equal(store.listPublic()[0].usage.success, 0);
});

test('stream completion and broken streams are recorded once', async () => {
  const store = new RelayAccountStore();
  store.backfillIdentities = async () => ({ filled: 0, failed: 0 });
  const account = store.addAccount(COOKIES);
  const client = new WaaRelayClient({ accountStore: store });
  const params = { accountId: account.accountId, model: 'gemini-3.8-flash' };
  client._openGenerateStream = async () => ({ res: new Response(STREAM_BODY), proofPkg: {}, targetModel: 'models/gemini-3.8-flash', tRpc0: Date.now() });
  await client.streamGenerateContent(params, () => {});
  client._openGenerateStream = async () => ({ res: new Response(new ReadableStream({ pull(controller) { controller.error(new Error('broken stream')); } })), proofPkg: {}, targetModel: 'models/gemini-3.8-flash', tRpc0: Date.now() });
  await assert.rejects(client.streamGenerateContent(params, () => {}), /broken stream/);
  assert.equal(store.listPublic()[0].usage.success, 1);
  assert.equal(store.listPublic()[0].usage.failed, 1);
});

test('malformed or truncated streams are not marked as complete successes', async () => {
  const store = new RelayAccountStore();
  store.backfillIdentities = async () => ({ filled: 0, failed: 0 });
  const account = store.addAccount(COOKIES);
  const client = new WaaRelayClient({ accountStore: store });
  for (const body of ['invalid JSON', STREAM_BODY.slice(0, -1)]) {
    client._openGenerateStream = async () => ({ res: new Response(body), proofPkg: {}, targetModel: 'models/gemini-3.8-flash', tRpc0: Date.now() });
    await assert.rejects(client.streamGenerateContent({ accountId: account.accountId, model: 'gemini-3.8-flash' }, () => {}));
  }
  assert.equal(store.listPublic()[0].usage.success, 0);
  assert.equal(store.listPublic()[0].usage.failed, 2);
});
