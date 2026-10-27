import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { runSession } from './agent.mjs';
import { validHubUrl } from './url.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const here = path.dirname(fileURLToPath(import.meta.url));

export function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'share.db'));
  fs.chmodSync(path.join(directory, 'share.db'), 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, access_hash TEXT NOT NULL UNIQUE, connector_hash TEXT NOT NULL UNIQUE)');
  return db;
}

export function invite(db, name) {
  if (!name || name.length > 100) throw new Error('Supply a name of 1–100 characters.');
  const user = { id: crypto.randomUUID(), name, access: random(), connector: random() };
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(user.id, name, hash(user.access), hash(user.connector));
  return user;
}

export function createShareServer({ db, origin, run = runSession }) {
  origin = validHubUrl(origin);
  const sessions = new Map(), devices = new Map(), jobs = new Map();
  let running;
  const byId = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  function userFor(req) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) return db.prepare('SELECT * FROM users WHERE access_hash = ?').get(hash(bearer));
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)share_session=([A-Za-z0-9_-]+)/)?.[1];
    const session = cookie && sessions.get(hash(cookie));
    return session && session.expires > Date.now() ? byId(session.id) : undefined;
  }
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 40000) throw new Error('Body too large.'); }
    return JSON.parse(text || '{}');
  }
  function stop(job) {
    job.abort.abort();
    const device = devices.get(job.userId);
    if (device?.ws.readyState === WebSocket.OPEN) device.ws.send(JSON.stringify({ type: 'cancel' }));
    for (const pending of device?.pending.values() || []) pending.reject(new Error('Job cancelled.'));
    device?.pending.clear();
  }
  const attempts = new Map();
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    handle(req, res).catch(() => { if (!res.headersSent) json(res, 400, { error: 'Invalid request.' }); else res.destroy(); });
  });
  async function handle(req, res) {
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(here, url.pathname === '/' ? 'index.html' : 'app.js')));
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method !== 'GET' && !req.headers.authorization && req.headers.origin !== origin) return json(res, 403, { error: 'Origin rejected.' });
    if (req.method === 'POST' && url.pathname === '/login') {
      // Limit by the direct peer; tunnel deployments therefore share the limit.
      const address = req.socket.remoteAddress;
      const recent = (attempts.get(address) || []).filter(t => t > Date.now() - 60000);
      if (recent.length >= 20) return json(res, 429, { error: 'Too many login attempts. Wait one minute.' });
      attempts.set(address, [...recent, Date.now()]);
      const input = await body(req);
      const user = typeof input.token === 'string' && db.prepare('SELECT * FROM users WHERE access_hash = ?').get(hash(input.token));
      if (!user) return json(res, 401, { error: 'Invalid access code.' });
      const token = random();
      sessions.set(hash(token), { id: user.id, expires: Date.now() + 8 * 3600000 });
      res.setHeader('Set-Cookie', `share_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    const user = userFor(req);
    if (!user) return json(res, 401, { error: 'Sign in with your access code.' });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { name: user.name, connected: devices.has(user.id), busy: !!running, job: [...jobs.values()].filter(j => j.userId === user.id).at(-1)?.id });
    if (req.method === 'POST' && url.pathname === '/logout') {
      const token = String(req.headers.cookie || '').match(/(?:^|;\s*)share_session=([A-Za-z0-9_-]+)/)?.[1];
      if (token) sessions.delete(hash(token));
      res.setHeader('Set-Cookie', 'share_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const input = await body(req);
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000 || !/^[A-Za-z0-9_-]{16,128}$/.test(input.key || '')) return json(res, 400, { error: 'Supply text and a unique request key.' });
      const prior = [...jobs.values()].find(j => j.userId === user.id && j.key === input.key);
      if (prior) return json(res, prior.digest === hash(input.text) ? 200 : 409, prior.digest === hash(input.text) ? { id: prior.id } : { error: 'Request key already used.' });
      if (running) return json(res, 409, { error: 'Another task is running. Try after it finishes.' });
      const device = devices.get(user.id);
      if (!device) return json(res, 503, { error: 'Start your workspace connector first.' });
      const job = { id: crypto.randomUUID(), userId: user.id, key: input.key, digest: hash(input.text), abort: new AbortController(), state: 'running', events: [] };
      // Keep bounded, in-memory history. Never evict an active task.
      const ownJobs = [...jobs.values()].filter(j => j.userId === user.id);
      while (ownJobs.length >= 10) jobs.delete(ownJobs.shift().id);
      jobs.set(job.id, job);
      running = job;
      const emit = event => { if (job.events.length < 500) job.events.push({ ...event, text: String(event.text || '').slice(0, 16000) }); };
      const callTool = (name, input) => new Promise((resolve, reject) => {
        if (job.abort.signal.aborted || devices.get(user.id) !== device || !byId(user.id)) return reject(new Error('Device disconnected or access revoked.'));
        const id = crypto.randomUUID();
        emit({ type: 'tool', text: `${name}: ${input.path || '.'}${name === 'shell' ? `\n${input.command}` : ''}` });
        const timer = setTimeout(() => { stop(job); reject(new Error('Tool timed out waiting for device or approval.')); }, 5 * 60000);
        device.pending.set(id, { resolve: text => { clearTimeout(timer); resolve(text); }, reject: e => { clearTimeout(timer); reject(e); } });
        device.ws.send(JSON.stringify({ type: 'tool', id, name, input }));
      });
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aviator-session-'));
      const timer = setTimeout(() => stop(job), 20 * 60000);
      void Promise.resolve().then(() => run({ prompt: input.text, cwd, abortController: job.abort, callTool, emit })).then(() => { job.state = job.abort.signal.aborted ? 'cancelled' : 'completed'; }).catch(e => {
        job.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
        // SDK errors can include environment or protocol details; keep them off the shared portal.
        emit({ type: 'error', text: job.abort.signal.aborted ? 'Task cancelled.' : 'Claude session failed. Ask the host operator to check login and usage limits.' });
        console.error('[share] session failed:', e.name || 'Error');
      }).finally(() => { clearTimeout(timer); stop(job); running = undefined; fs.rmSync(cwd, { recursive: true, force: true }); });
      return json(res, 202, { id: job.id });
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(\/cancel)?$/);
    const job = match && jobs.get(match[1]);
    if (!job || job.userId !== user.id) return json(res, 404, { error: 'Not found.' });
    if (req.method === 'GET' && !match[2]) return json(res, 200, { id: job.id, state: job.state, events: job.events });
    if (req.method === 'POST' && match[2]) { stop(job); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'Not found.' });
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const token = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const user = token && db.prepare('SELECT * FROM users WHERE connector_hash = ?').get(hash(token));
    if (!user || req.url !== '/connect' || req.headers.origin) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (devices.has(user.id)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const device = { ws, pending: new Map(), alive: true };
      devices.set(user.id, device);
      ws.on('pong', () => { device.alive = true; });
      ws.on('error', () => {});
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type !== 'result' || !device.pending.has(m.id)) return;
        const pending = device.pending.get(m.id);
        device.pending.delete(m.id);
        if (typeof m.error === 'string') pending.reject(new Error(m.error.slice(0, 1000)));
        else if (typeof m.text === 'string') pending.resolve(m.text.slice(0, 65536));
        else pending.reject(new Error('Invalid tool response.'));
      });
      ws.on('close', () => {
        if (running?.userId === user.id) stop(running);
        for (const pending of device.pending.values()) pending.reject(new Error('Device disconnected.'));
        devices.delete(user.id);
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const [id, device] of devices) {
      if (!byId(id) || !device.alive) { device.ws.terminate(); continue; }
      device.alive = false;
      device.ws.ping();
    }
    for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
    for (const [key, times] of attempts) if (times.at(-1) < Date.now() - 60000) attempts.delete(key);
  }, 25000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return { server, close: () => { if (running) stop(running); for (const d of devices.values()) d.ws.terminate(); clearInterval(heartbeat); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openStore(path.resolve(process.env.SHARE_DATA_DIR || '.aviator-share'));
  const [command, value] = process.argv.slice(2);
  if (command === 'invite') {
    const user = invite(db, value);
    console.log(`User ID: ${user.id}\nBrowser access code: ${user.access}\nConnector token: ${user.connector}\nKeep these private. They are shown only once.`);
    db.close();
  } else if (command === 'revoke') {
    db.prepare('DELETE FROM users WHERE id = ?').run(value || '');
    console.log('Access revoked. The device disconnects within 25 seconds.');
    db.close();
  } else if (!command) {
    const port = Number(process.env.SHARE_PORT || 8081);
    const origin = process.env.SHARE_PUBLIC_URL || `http://127.0.0.1:${port}`;
    const app = createShareServer({ db, origin });
    app.server.listen(port, '127.0.0.1', () => console.log(`Shared session portal: ${origin}\nHost login stays here; workspace commands run on the connected device.`));
  } else throw new Error('Commands: invite <name>, revoke <user-id>, or no command to start.');
}
