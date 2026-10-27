import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { workspaceTools } from '../remote-session/workspace.mjs';
import { sessionOptions, runSession } from '../remote-session/agent.mjs';
import { openStore, invite, createShareServer } from '../remote-session/server.mjs';
import { validHubUrl } from '../remote-session/url.mjs';

test('remote URLs require TLS and do not accept embedded credentials', () => {
  assert.throws(() => validHubUrl('http://example.com'));
  assert.throws(() => validHubUrl('https://user:password@example.com'));
  assert.equal(validHubUrl('https://example.com/'), 'https://example.com');
});

test('workspace traversal, secrets and symlinks are blocked; mutation requires local consent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'hello.txt'), 'hello');
  await fs.writeFile(path.join(dir, '.env'), 'secret');
  await fs.symlink(os.tmpdir(), path.join(dir, 'escape'));
  const denied = workspaceTools(dir, async () => false);
  assert.equal(await denied('read', { path: 'hello.txt' }), 'hello');
  for (const p of ['../outside', '.env', 'escape/test', '/etc/passwd', '.git/config']) await assert.rejects(denied('read', { path: p }));
  assert.equal(await denied('list', {}), 'hello.txt');
  await assert.rejects(denied('write', { path: 'hello.txt', content: 'changed' }), /denied/);
  await assert.rejects(denied('shell', { command: 'echo should-not-run' }), /denied/);
  assert.equal(await fs.readFile(path.join(dir, 'hello.txt'), 'utf8'), 'hello');
  const allowed = workspaceTools(dir, async () => true);
  await allowed('write', { path: 'nested/new.txt', content: 'new' });
  assert.equal(await fs.readFile(path.join(dir, 'nested/new.txt'), 'utf8'), 'new');
  assert.match(await allowed('shell', { command: 'echo workspace-command' }), /Exit: 0\nworkspace-command/);
});

test('host session offers only remote tools and strips alternate billing and connector secrets', async () => {
  const options = sessionOptions('/tmp', new AbortController(), async () => 'ok', {
    PATH: '/bin', ANTHROPIC_API_KEY: 'do-not-forward', ANTHROPIC_BASE_URL: 'https://other', CLAUDE_CODE_OAUTH_TOKEN: 'do-not-copy', AVIATOR_CONNECTOR_TOKEN: 'private', CLAUDECODE: '1', SHARE_SECRET: 'private', HOME: '/home/example',
  });
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.env, { PATH: '/bin', HOME: '/home/example' });
  assert.equal((await options.canUseTool('Bash', { command: 'read-host-files' })).behavior, 'deny');
  assert.equal((await options.canUseTool('mcp__workspace__read', { path: 'README.md' })).behavior, 'allow');
});

test('no prompt is released unless account check confirms Pro/Max without API authentication', async () => {
  for (const account of [{ subscriptionType: 'pro', apiKeySource: 'none' }, { subscriptionType: 'max' }, { subscriptionType: 'pro', apiKeySource: 'env' }, {}]) {
    let promptSeen = false, closed = false;
    const queryImpl = ({ prompt }) => ({
      accountInfo: async () => account,
      close: () => { closed = true; },
      async *[Symbol.asyncIterator]() {
        for await (const item of prompt) { assert.equal(item.message.content, 'test'); promptSeen = true; }
        yield { type: 'result', result: 'done' };
      },
    });
    const call = runSession({ prompt: 'test', cwd: '/tmp', abortController: new AbortController(), callTool: async () => '', emit: () => {}, queryImpl });
    if (account.subscriptionType && (!account.apiKeySource || account.apiKeySource === 'none')) await call;
    else await assert.rejects(call, /saved Claude Pro or Max/);
    assert.equal(promptSeen, !!account.subscriptionType && (!account.apiKeySource || account.apiKeySource === 'none'));
    assert.equal(closed, true);
  }
});

test('portal separates users and connector tokens, routes workspace tools, and revokes access', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-integration-'));
  const db = openStore(dir);
  const alice = invite(db, 'Alice'), bob = invite(db, 'Bob');
  let executions = 0;
  const app = createShareServer({ db, origin: 'http://127.0.0.1:8081', run: async ({ callTool, emit }) => {
    executions++;
    const text = await callTool('read', { path: 'README.md' });
    emit({ type: 'text', text });
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let device;
  t.after(async () => { device?.terminate(); await app.close(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const get = (p, token) => fetch(base + p, { headers: headers(token) });
  assert.equal((await get('/api/status', alice.connector)).status, 401);
  assert.equal((await get('/api/status', alice.access)).status, 200);
  assert.equal((await fetch(base + '/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const login = await fetch(base + '/login', { method: 'POST', headers: { origin: 'http://127.0.0.1:8081' }, body: JSON.stringify({ token: alice.access }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  device = new WebSocket(base.replace('http', 'ws') + '/connect', { headers: headers(alice.connector) });
  await once(device, 'open');
  device.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'tool') {
      assert.equal(m.name, 'read');
      assert.equal(m.input.path, 'README.md');
      device.send(JSON.stringify({ type: 'result', id: m.id, text: 'Contents from the CLIENT device.' }));
    }
  });
  const submit = (token, text = 'Inspect project') => fetch(base + '/api/jobs', { method: 'POST', headers: headers(token), body: JSON.stringify({ text, key: 'integration-key-1234' }) });
  assert.equal((await submit(bob.access)).status, 503);
  const result = await submit(alice.access);
  assert.equal(result.status, 202);
  const job = await result.json();
  let state;
  for (let i = 0; i < 50; i++) {
    state = await (await get(`/api/jobs/${job.id}`, alice.access)).json();
    if (state.state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.state, 'completed');
  assert.ok(state.events.some(e => e.text === 'Contents from the CLIENT device.'));
  assert.equal((await get(`/api/jobs/${job.id}`, bob.access)).status, 404);
  assert.equal((await submit(alice.access)).status, 200);
  assert.equal(executions, 1);
  assert.equal((await submit(alice.access, 'different task')).status, 409);
  db.prepare('DELETE FROM users WHERE id = ?').run(alice.id);
  assert.equal((await get('/api/status', alice.access)).status, 401);
});

test('cancellation aborts the host session and reaches its connected device', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-cancel-'));
  const db = openStore(dir);
  const user = invite(db, 'Owner');
  let aborted = false;
  const app = createShareServer({ db, origin: 'http://127.0.0.1:8081', run: async ({ abortController }) => {
    await new Promise(resolve => abortController.signal.addEventListener('abort', resolve, { once: true }));
    aborted = true;
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ws = new WebSocket(base.replace('http', 'ws') + '/connect', { headers: { authorization: `Bearer ${user.connector}` } });
  t.after(async () => { ws.terminate(); await app.close(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await once(ws, 'open');
  const headers = { authorization: `Bearer ${user.access}`, 'content-type': 'application/json' };
  const result = await fetch(base + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ key: 'cancel-test-123456', text: 'Wait' }) });
  const job = await result.json();
  const cancellation = once(ws, 'message');
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/cancel`, { method: 'POST', headers })).status, 200);
  assert.equal(JSON.parse((await cancellation)[0]).type, 'cancel');
  assert.equal(aborted, true);
});
