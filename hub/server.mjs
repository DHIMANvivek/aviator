#!/usr/bin/env node
// Aviator hub: one public address for everyone. People sign in here; each person's own computer
// runs Aviator plus the runner (runner/aviator-runner.mjs), which keeps an outbound WebSocket
// open to this hub. Every other request is checked against the signed-in user and passed down
// that user's connection, so their files, git and agents stay on their own machine. The hub
// stores accounts and which computers belong to whom; it never saves what passes through.
//
// Settings (environment variables, all optional):
//   PORT / HUB_PORT      port to listen on (default 8080)
//   HUB_PUBLIC_URL       public address, e.g. https://aviator.example.com (shown in the pairing command)
//   HUB_DATA_DIR         folder for hub.db (default ./.hub)
//   HUB_TRUST_PROXY=1    behind a TLS proxy (Fly, Railway, Render, nginx): trust its X-Forwarded-* headers
//   HUB_ALLOWED_EMAILS   comma-separated; when set, only these addresses can create an account
//   HUB_REPO_URL         where people get Aviator from (shown in the setup steps)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || process.env.HUB_PORT || 8080);
const DATA_DIR = path.resolve(process.env.HUB_DATA_DIR || ".hub");
const TRUST_PROXY = process.env.HUB_TRUST_PROXY === "1";
const PUBLIC_URL = (process.env.HUB_PUBLIC_URL || "").replace(/\/+$/, "");
const ALLOWED_EMAILS = (process.env.HUB_ALLOWED_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const REPO_URL = process.env.HUB_REPO_URL || "https://github.com/DHIMANvivek/aviator";

const SESSION_COOKIE = "hub_session";
const SESSION_MS = 30 * 24 * 60 * 60_000;
const PAIR_MS = 10 * 60_000;
const MAX_BODY = 64 * 1024 * 1024;
const PING_MS = 25_000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "hub.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, runner_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pair_codes (
    code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT,
    token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER);
`);

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  addUser: db.prepare("INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)"),
  session: db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?"),
  addSession: db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
  dropSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  chooseRunner: db.prepare("UPDATE sessions SET runner_id = ? WHERE id = ?"),
  forgetRunner: db.prepare("UPDATE sessions SET runner_id = NULL WHERE runner_id = ?"),
  addCode: db.prepare("INSERT INTO pair_codes (code, user_id, expires_at) VALUES (?, ?, ?)"),
  code: db.prepare("SELECT * FROM pair_codes WHERE code = ? AND expires_at > ?"),
  dropCode: db.prepare("DELETE FROM pair_codes WHERE code = ?"),
  addRunner: db.prepare(
    "INSERT INTO runners (id, user_id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ),
  runnersOf: db.prepare("SELECT * FROM runners WHERE user_id = ? ORDER BY created_at"),
  runnerByToken: db.prepare("SELECT * FROM runners WHERE token_hash = ?"),
  runner: db.prepare("SELECT * FROM runners WHERE id = ? AND user_id = ?"),
  dropRunner: db.prepare("DELETE FROM runners WHERE id = ? AND user_id = ?"),
  seen: db.prepare("UPDATE runners SET last_seen = ?, platform = COALESCE(?, platform) WHERE id = ?"),
  prune: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  pruneCodes: db.prepare("DELETE FROM pair_codes WHERE expires_at <= ?"),
};

setInterval(() => {
  const now = Date.now();
  q.prune.run(now);
  q.pruneCodes.run(now);
}, 60 * 60_000).unref();

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function checkPassword(password, stored) {
  const [, salt, hash] = String(stored).split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

/** Pairing codes avoid look-alike characters (0/O, 1/I/L), e.g. K7Q-4XM. */
function pairCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
}

// Wrong passwords or pairing codes: 10 from one address in 15 minutes pause that address.
const LOCKOUT_MS = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map();
function recentFails(address) {
  const now = Date.now();
  const list = (fails.get(address) ?? []).filter((t) => now - t < LOCKOUT_MS);
  if (list.length) fails.set(address, list);
  else fails.delete(address);
  return list;
}
const lockedOut = (address) => recentFails(address).length >= MAX_FAILS;
const recordFail = (address) => fails.set(address, [...recentFails(address), Date.now()]);

// ---------- request helpers ----------

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers["fly-client-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return String(forwarded).replace(/^::ffff:/, "");
  }
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

// Tunnels and TLS proxies (ngrok, Fly) serve https:// but reach the hub over plain http, adding
// X-Forwarded-Proto. Trusting it without HUB_TRUST_PROXY is fine: it only picks the cookie's
// Secure flag and the address shown in the pairing command.
function isHttps(req) {
  if (PUBLIC_URL) return PUBLIC_URL.startsWith("https:");
  if (req.headers["x-forwarded-proto"]) return String(req.headers["x-forwarded-proto"]).split(",")[0].trim() === "https";
  return !!req.socket.encrypted;
}

/** The hub's own address as the browser sees it, e.g. https://aviator.example.com */
function ownOrigin(req) {
  if (PUBLIC_URL) return new URL(PUBLIC_URL).origin;
  const host = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host || `localhost:${PORT}`;
  return `${isHttps(req) ? "https" : "http"}://${host}`;
}

/**
 * Browsers send simple cross-site POSTs without asking first, so changes must come from our own
 * page. Compares host names only (like src/proxy.ts): behind a tunnel the scheme the hub sees
 * isn't the one the browser used, and another site can't put our host name in its Origin.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] !== "cross-site";
  try {
    const host = new URL(origin).host.toLowerCase();
    const own = [PUBLIC_URL && new URL(PUBLIC_URL).host, req.headers["x-forwarded-host"], req.headers.host];
    return own.some((h) => h && String(h).toLowerCase() === host);
  } catch {
    return false;
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readForm(req) {
  const raw = (await readBody(req, 64 * 1024)).toString("utf8");
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

/** Only paths on this site, so ?next= can't send people elsewhere. */
const safeNext = (next) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function sessionCookie(req, token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isHttps(req) ? "; Secure" : ""}`;
}

function currentSession(req) {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = q.session.get(sha256(token), Date.now());
  if (!session) return null;
  const user = q.userById.get(session.user_id);
  return user ? { session, user } : null;
}

async function startSession(req, res, user, next) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  q.addSession.run(sha256(token), user.id, now, now + SESSION_MS);
  redirect(res, next, { "Set-Cookie": sessionCookie(req, token, SESSION_MS / 1000) });
}

// ---------- pages ----------

const STYLE = `
:root{--bg:#151514;--raised:#1d1d1b;--input:#191918;--line:#2e2e2b;--line-strong:#4a4a46;--text:#ecebe4;--dim:#85837a;
--faint:#5c5b55;--accent:#d77757;--green:#4eba65;--red:#ff6b80;--amber:#ffc107;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:680px;margin:0 auto;padding:48px 16px}
h1{font-size:18px;color:var(--accent);margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
p{margin:6px 0}.dim{color:var(--dim)}.faint{color:var(--faint)}.bad{color:var(--red)}.ok{color:var(--green)}
a{color:#b1b9f9}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:20px}
form.inline{display:inline}
label{display:grid;gap:4px;margin:12px 0;color:#b9b7ad;font-size:12.5px}
input{background:var(--input);border:1px solid var(--line-strong);border-radius:6px;padding:8px 10px;color:var(--text);font:inherit;width:100%}
button,.btn{background:transparent;border:1px solid var(--line-strong);border-radius:6px;color:var(--text);font:inherit;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{background:#242422}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#1a1a19}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}
.card{border:1px solid var(--line);background:var(--raised);border-radius:10px;padding:14px 16px;margin:10px 0}
.computer{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.computer .name{font-weight:600}.selected{border-color:var(--accent)}
.error{border:1px solid var(--red);color:var(--red);border-radius:6px;padding:8px 12px;margin:12px 0}
pre{background:var(--input);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;margin:6px 0;white-space:pre-wrap;word-break:break-all}
.code{font-size:28px;letter-spacing:4px;color:var(--accent);font-weight:700}
ol{padding-left:20px}li{margin:10px 0}
`;

function page(res, status, title, body, script = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function loginPage(res, { error = "", email = "", next = "/", status = 200 } = {}) {
  page(
    res,
    status,
    "Aviator · Sign in",
    `<h1>✻ Aviator</h1>
<p class="dim">Sign in to open Aviator on your own computer, from any device.</p>
${error ? `<div class="error">${esc(error)}</div>` : ""}
<form method="post" action="/_hub/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label>Email<input type="email" name="email" value="${esc(email)}" required autofocus autocomplete="email"></label>
  <label>Password<input type="password" name="password" required minlength="8" autocomplete="current-password"></label>
  <div class="row">
    <button class="primary" type="submit">Sign in</button>
    <button type="submit" formaction="/_hub/signup">Create account</button>
  </div>
</form>
<p class="faint" style="margin-top:28px">Your code never comes here: Aviator runs on your computer, and this site only connects your browser to it.</p>`,
  );
}

function header(user) {
  return `<header><h1>✻ Aviator</h1><span class="dim">${esc(user.email)} ·
<form class="inline" method="post" action="/_hub/logout"><button type="submit" style="border:0;padding:0;color:#b1b9f9;text-decoration:underline">Sign out</button></form></span></header>`;
}

function runnerView(r, selectedId) {
  const online = connections.has(r.id);
  return {
    id: r.id,
    name: r.name,
    platform: r.platform || "",
    online,
    selected: r.id === selectedId,
    lastSeen: online ? Date.now() : r.last_seen,
  };
}

function computersPage(req, res, auth) {
  const runners = q.runnersOf.all(auth.user.id).map((r) => runnerView(r, auth.session.runner_id));
  const origin = ownOrigin(req);
  const list = runners.length
    ? runners
        .map(
          (r) => `<div class="card computer${r.selected ? " selected" : ""}" data-id="${esc(r.id)}">
  <div><div class="name">${esc(r.name)}</div>
  <div class="faint"><span class="state ${r.online ? "ok" : "faint"}">● ${r.online ? "online" : "offline"}</span>${r.platform ? ` · ${esc(r.platform)}` : ""}${r.selected ? " · in use on this device" : ""}</div></div>
  <div class="row" style="margin:0">
    <form class="inline" method="post" action="/_hub/computers/use"><input type="hidden" name="runnerId" value="${esc(r.id)}"><button class="${r.selected ? "" : "primary"}" type="submit">Open</button></form>
    <form class="inline" method="post" action="/_hub/computers/remove" onsubmit="return confirm('Remove ${esc(r.name.replace(/['"\\]/g, ""))}? It stops being reachable from here; nothing on it is deleted.')"><input type="hidden" name="runnerId" value="${esc(r.id)}"><button type="submit">Remove</button></form>
  </div>
</div>`,
        )
        .join("")
    : `<p class="dim">No computers yet. Add the computer your code is on, and Aviator on it opens here.</p>`;

  page(
    res,
    200,
    "Aviator · Your computers",
    `${header(auth.user)}
<h2>Your computers</h2>
${list}
<div class="row"><button class="primary" id="add">Add my computer</button></div>
<div id="pairing" hidden>
  <h2>Add a computer</h2>
  <p class="dim">On the computer you want to use (it needs <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js 22.5+</a> and git):</p>
  <ol>
    <li>Get Aviator, once:<pre>git clone ${esc(REPO_URL)} aviator
cd aviator
npm install</pre></li>
    <li>Link it to your account (the code works once, for 10 minutes):<pre id="cmd"></pre>
      <div class="row" style="margin-top:4px"><button id="copy">Copy</button><span class="code" id="code"></span></div></li>
    <li>Optional: start it automatically when you log in:<pre>npm run runner -- install-service</pre></li>
  </ol>
  <p id="waiting" class="dim">Waiting for your computer…</p>
</div>`,
    `
const origin = ${JSON.stringify(origin)};
const known = new Set(${JSON.stringify(runners.map((r) => r.id))});
const $ = (id) => document.getElementById(id);
let pairing = false;
$("add").onclick = async () => {
  $("add").disabled = true;
  const res = await fetch("/_hub/pair/start", { method: "POST" });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Couldn't start pairing."); $("add").disabled = false; return; }
  $("code").textContent = data.code;
  $("cmd").textContent = data.command;
  $("pairing").hidden = false;
  pairing = true;
  $("pairing").scrollIntoView({ behavior: "smooth" });
};
$("copy").onclick = () => navigator.clipboard?.writeText($("cmd").textContent).then(() => ($("copy").textContent = "Copied"));
async function poll() {
  try {
    const state = await (await fetch("/_hub/state")).json();
    for (const r of state.runners) {
      const card = document.querySelector('[data-id="' + r.id + '"] .state');
      if (card) { card.className = "state " + (r.online ? "ok" : "faint"); card.textContent = "● " + (r.online ? "online" : "offline"); }
      if (pairing && r.online && !known.has(r.id)) {
        $("waiting").textContent = r.name + " is connected. Opening Aviator…";
        const form = document.createElement("form");
        form.method = "post"; form.action = "/_hub/computers/use";
        form.innerHTML = '<input type="hidden" name="runnerId">';
        form.firstChild.value = r.id;
        document.body.append(form); form.submit();
        return;
      }
      if (!known.has(r.id) && !pairing) location.reload();
    }
  } catch {}
  setTimeout(poll, pairing ? 2000 : 5000);
}
poll();`,
  );
}

function offlinePage(res, auth, runner) {
  page(
    res,
    503,
    "Aviator · Computer offline",
    `${header(auth.user)}
<h2>${esc(runner.name)} is offline</h2>
<p>Aviator opens here once that computer is on and connected. On it, in the aviator folder, run:</p>
<pre>npm run runner</pre>
<p class="dim">To have it start by itself at login: <code>npm run runner -- install-service</code></p>
<p id="waiting" class="faint">Waiting for ${esc(runner.name)}…</p>
<div class="row"><a class="btn" href="/_hub/computers">Use another computer</a></div>`,
    `
const id = ${JSON.stringify(runner.id)};
(async function poll() {
  try {
    const state = await (await fetch("/_hub/state")).json();
    if (state.runners.some((r) => r.id === id && r.online)) return location.reload();
  } catch {}
  setTimeout(poll, 3000);
})();`,
  );
}

function errorPage(res, status, title, message) {
  page(res, status, `Aviator · ${title}`, `<h1>✻ Aviator</h1><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="row"><a class="btn" href="/_hub/computers">Your computers</a></div>`);
}

// ---------- runner connections ----------

/** runnerId -> { ws, runnerId, userId, ip, alive, pending: Map<requestId, ServerResponse> } */
const connections = new Map();
let nextRequestId = 0;

function attach(runner, ws, ip) {
  connections.get(runner.id)?.ws.close(4000, "Another runner connected with this computer's token.");
  const conn = { ws, runnerId: runner.id, userId: runner.user_id, ip, alive: true, pending: new Map() };
  connections.set(runner.id, conn);
  q.seen.run(Date.now(), null, runner.id);
  console.log(`[hub] ${runner.name} (${runner.id}) connected from ${ip}`);

  ws.on("pong", () => {
    conn.alive = true;
    q.seen.run(Date.now(), null, runner.id);
  });
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) onRunnerMessage(conn, raw);
  });
  ws.on("close", () => {
    if (connections.get(runner.id) === conn) connections.delete(runner.id);
    for (const res of conn.pending.values()) {
      // Streams already under way (live run updates) are cut so the browser reconnects.
      if (res.headersSent) res.destroy();
      else errorPage(res, 502, "Your computer disconnected", "The connection to your computer dropped mid-request. Try again in a moment.");
    }
    conn.pending.clear();
    console.log(`[hub] ${runner.name} (${runner.id}) disconnected`);
  });
  ws.on("error", () => {});
}

setInterval(() => {
  for (const conn of connections.values()) {
    if (!conn.alive) {
      conn.ws.terminate();
      continue;
    }
    conn.alive = false;
    conn.ws.ping();
  }
}, PING_MS).unref();

function onRunnerMessage(conn, raw) {
  let m;
  try {
    m = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (m.t === "hello") {
    q.seen.run(Date.now(), typeof m.platform === "string" ? m.platform.slice(0, 60) : null, conn.runnerId);
    return;
  }
  const res = conn.pending.get(m.id);
  if (!res) return;
  if (m.t === "res") {
    const headers = {};
    for (const [k, v] of Object.entries(m.headers ?? {})) {
      // The hub's own cookie lives on this address; computers don't get to set cookies on it.
      if (HOP_BY_HOP.has(k) || k === "set-cookie") continue;
      headers[k] = v;
    }
    headers["x-accel-buffering"] = "no";
    res.writeHead(Number(m.status) || 502, headers);
    res.flushHeaders();
  } else if (m.t === "data") {
    res.write(Buffer.from(m.data, "base64"));
  } else if (m.t === "end") {
    conn.pending.delete(m.id);
    res.end();
  } else if (m.t === "error") {
    conn.pending.delete(m.id);
    if (res.headersSent) res.destroy();
    else errorPage(res, 502, "Your computer couldn't answer", String(m.message || "Aviator on your computer didn't respond."));
  }
}

async function forward(req, res, conn) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || k === "host" || k === "cookie" || k === "forwarded" || k === "x-real-ip") continue;
    if (k.startsWith("x-forwarded-") || k.startsWith("x-aviator-") || k.startsWith("fly-")) continue;
    headers[k] = v;
  }
  headers["x-aviator-hub"] = "1";
  // A guess at whether the browser sits on the same computer (same public address), so Aviator
  // can hide buttons that open windows on that computer's screen.
  headers["x-aviator-remote-device"] = clientIp(req) === conn.ip ? "0" : "1";

  const id = String(++nextRequestId);
  conn.pending.set(id, res);
  res.on("close", () => {
    // The browser left before the answer finished (e.g. closed a live stream): stop it there too.
    if (conn.pending.delete(id) && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify({ t: "cancel", id }));
  });
  conn.ws.send(JSON.stringify({ t: "req", id, method: req.method, path: req.url, headers, body: body?.toString("base64") }));
}

/** The computer this browser should talk to: the one it picked, else the only one online. */
function targetRunner(auth) {
  const runners = q.runnersOf.all(auth.user.id);
  const chosen = runners.find((r) => r.id === auth.session.runner_id);
  if (chosen) return { runner: chosen, conn: connections.get(chosen.id) };
  const online = runners.filter((r) => connections.has(r.id));
  if (online.length === 1) {
    q.chooseRunner.run(online[0].id, auth.session.id);
    return { runner: online[0], conn: connections.get(online[0].id) };
  }
  return { runners };
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://hub");
  const route = `${req.method} ${url.pathname}`;
  const address = clientIp(req);
  const changes = req.method !== "GET" && req.method !== "HEAD";

  if (route === "GET /_hub/health") return json(res, 200, { ok: true, computers: connections.size });

  // Runners call this from the command line, so there's no Origin; the one-time code is the proof.
  if (route === "POST /_hub/pair/claim") {
    if (lockedOut(address)) return json(res, 429, { error: "Too many wrong codes. Try again in 15 minutes." });
    const body = await readForm(req);
    const code = String(body.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const row = code.length === 6 && q.code.get(`${code.slice(0, 3)}-${code.slice(3)}`, Date.now());
    if (!row) {
      recordFail(address);
      return json(res, 400, { error: "That pairing code isn't valid (they work once, for 10 minutes). Get a new one from the hub page." });
    }
    q.dropCode.run(row.code);
    const token = crypto.randomBytes(32).toString("base64url");
    const runnerId = randomId("pc");
    const name = String(body.name ?? "").trim().slice(0, 60) || "My computer";
    const platform = typeof body.platform === "string" ? body.platform.slice(0, 60) : null;
    q.addRunner.run(runnerId, row.user_id, name, platform, sha256(token), Date.now());
    console.log(`[hub] paired ${name} (${runnerId})`);
    return json(res, 200, { runnerId, token, name });
  }

  if (changes && !sameOrigin(req)) {
    return url.pathname.startsWith("/_hub/") || url.pathname.startsWith("/api/")
      ? json(res, 403, { error: "Only Aviator's own page can make changes." })
      : errorPage(res, 403, "Not allowed", "Only Aviator's own page can make changes.");
  }

  if (route === "GET /_hub/login") return loginPage(res, { next: safeNext(url.searchParams.get("next")) });

  if (route === "POST /_hub/login" || route === "POST /_hub/signup") {
    const form = await readForm(req);
    const email = String(form.email ?? "").trim().toLowerCase();
    const password = String(form.password ?? "");
    const next = safeNext(form.next);
    if (lockedOut(address)) return loginPage(res, { error: "Too many wrong attempts. Try again in 15 minutes.", email, next, status: 429 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return loginPage(res, { error: "Enter a valid email address.", email, next, status: 400 });
    if (password.length < 8) return loginPage(res, { error: "Passwords are at least 8 characters.", email, next, status: 400 });

    if (route === "POST /_hub/signup") {
      if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
        return loginPage(res, { error: "This hub only accepts invited email addresses.", email, next, status: 403 });
      }
      if (q.userByEmail.get(email)) return loginPage(res, { error: "That email already has an account. Sign in instead.", email, next, status: 409 });
      const user = { id: randomId("user"), email };
      q.addUser.run(user.id, email, await hashPassword(password), Date.now());
      console.log(`[hub] new account ${email}`);
      return startSession(req, res, user, "/_hub/computers");
    }
    const user = q.userByEmail.get(email);
    if (!user || !(await checkPassword(password, user.password))) {
      recordFail(address);
      return loginPage(res, { error: "Wrong email or password.", email, next, status: 401 });
    }
    return startSession(req, res, user, next);
  }

  const auth = currentSession(req);

  if (route === "POST /_hub/logout") {
    const token = cookies(req)[SESSION_COOKIE];
    if (token) q.dropSession.run(sha256(token));
    return redirect(res, "/_hub/login", { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (!auth) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_hub/")) return json(res, 401, { error: "Sign in first." });
    return redirect(res, `/_hub/login${url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`}`);
  }

  if (route === "GET /_hub/computers") return computersPage(req, res, auth);

  if (route === "GET /_hub/state") {
    return json(res, 200, {
      email: auth.user.email,
      selected: auth.session.runner_id,
      runners: q.runnersOf.all(auth.user.id).map((r) => runnerView(r, auth.session.runner_id)),
    });
  }

  if (route === "POST /_hub/pair/start") {
    const code = pairCode();
    q.addCode.run(code, auth.user.id, Date.now() + PAIR_MS);
    return json(res, 200, { code, expiresAt: Date.now() + PAIR_MS, command: `npm run runner -- pair ${code} --hub ${ownOrigin(req)}` });
  }

  if (route === "POST /_hub/computers/use") {
    const { runnerId } = await readForm(req);
    if (!q.runner.get(String(runnerId), auth.user.id)) return errorPage(res, 404, "Not found", "That computer isn't on your account.");
    q.chooseRunner.run(String(runnerId), auth.session.id);
    return redirect(res, "/");
  }

  if (route === "POST /_hub/computers/remove") {
    const { runnerId } = await readForm(req);
    const id = String(runnerId);
    if (q.dropRunner.run(id, auth.user.id).changes) {
      q.forgetRunner.run(id);
      connections.get(id)?.ws.close(4001, "This computer was removed from its account.");
    }
    return redirect(res, "/_hub/computers");
  }

  if (url.pathname.startsWith("/_hub/")) return json(res, 404, { error: "Not found." });

  // Everything else belongs to Aviator on the user's own computer.
  const target = targetRunner(auth);
  if (target.conn) return forward(req, res, target.conn);
  if (url.pathname.startsWith("/api/")) {
    return json(res, 503, { error: target.runner ? `${target.runner.name} is offline. Start Aviator on it (npm run runner).` : "No computer connected." });
  }
  if (target.runner) return offlinePage(res, auth, target.runner);
  return redirect(res, "/_hub/computers");
}

// ---------- admin commands (run on the hub's machine instead of starting it) ----------
//   npm run hub -- users                      list accounts and their computers
//   npm run hub -- reset-password <email>     set a new random password and sign that account out everywhere
//   npm run hub -- sign-out <email>           sign that account out on every device (password unchanged)
//   npm run hub -- delete-user <email>        remove an account, its sessions and its computers

const [command, commandArg] = process.argv.slice(2);
if (command === "users") {
  for (const user of db.prepare("SELECT * FROM users ORDER BY created_at").all()) {
    const computers = q.runnersOf.all(user.id).map((r) => r.name);
    console.log(`${user.email}  (since ${new Date(user.created_at).toLocaleString()})${computers.length ? `  computers: ${computers.join(", ")}` : ""}`);
  }
  process.exit(0);
}
if (command === "reset-password") {
  const user = q.userByEmail.get(String(commandArg ?? "").trim().toLowerCase());
  if (!user) {
    console.error(`[hub] No account for “${commandArg ?? ""}”. See them all with: npm run hub -- users`);
    process.exit(1);
  }
  const password = crypto.randomBytes(9).toString("base64url");
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(await hashPassword(password), user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  console.log(`[hub] New password for ${user.email}: ${password}\n[hub] Every device it was signed in on is signed out. Its computers stay linked.`);
  process.exit(0);
}
// Both work while the hub runs: every request checks the session in the database, so the person
// loses access at once (and, when deleted, their computer's next reconnect is refused).
if (command === "sign-out") {
  const user = q.userByEmail.get(String(commandArg ?? "").trim().toLowerCase());
  if (!user) {
    console.error(`[hub] No account for “${commandArg ?? ""}”. See them all with: npm run hub -- users`);
    process.exit(1);
  }
  const { changes } = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  console.log(`[hub] Signed ${user.email} out of ${changes} device${changes === 1 ? "" : "s"}. They can sign in again with their password.`);
  process.exit(0);
}
if (command === "delete-user") {
  const user = q.userByEmail.get(String(commandArg ?? "").trim().toLowerCase());
  if (!user) {
    console.error(`[hub] No account for “${commandArg ?? ""}”. See them all with: npm run hub -- users`);
    process.exit(1);
  }
  for (const table of ["sessions", "pair_codes", "runners"]) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  console.log(`[hub] Deleted ${user.email}: signed out everywhere, and its computers are unlinked. Nothing on those computers is touched.`);
  process.exit(0);
}
if (command) {
  console.error(`[hub] Unknown command “${command}”. Commands: users, sign-out <email>, reset-password <email>, delete-user <email>. With none, the hub starts.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[hub]", err);
    if (res.headersSent) return res.destroy();
    if (err.status === 413) return json(res, 413, { error: err.message });
    json(res, 500, { error: "Something went wrong on the hub." });
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://hub");
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const runner = url.pathname === "/_hub/connect" && token ? q.runnerByToken.get(sha256(token)) : undefined;
  if (!runner) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(runner, ws, clientIp(req)));
});

server.listen(PORT, () => {
  console.log(`[hub] Aviator hub on http://localhost:${PORT}${PUBLIC_URL ? ` (public: ${PUBLIC_URL})` : ""}, data in ${DATA_DIR}`);
});
