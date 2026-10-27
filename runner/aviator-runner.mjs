#!/usr/bin/env node
// aviator-runner: links this computer's Aviator to an Aviator hub, so you can open it from the
// hub's address on any device after signing in. The connection goes out from this computer, so
// no open ports or tunnel are needed. Each request the hub sends is replayed against Aviator on
// localhost and the answer streamed back; your files, git and agents never leave this machine.
//
//   npm run runner -- pair <CODE> --hub <URL> [--name <name>]   link this computer, then start
//   npm run runner [-- --no-app]                                 connect (and start Aviator unless it's running)
//   npm run runner -- install-service | uninstall-service        start at login (Linux, macOS, Windows)
//   npm run runner -- status | unpair

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const SCRIPT = fileURLToPath(import.meta.url);
const APP_DIR = path.resolve(path.dirname(SCRIPT), "..");
const CONFIG = process.env.AVIATOR_RUNNER_CONFIG || path.join(os.homedir(), ".aviator", "runner.json");
const PORT = Number(process.env.AVIATOR_PORT || 3210);
const LOCAL = "127.0.0.1";
const SERVICE = "aviator-runner";
const PLATFORM = `${process.platform}-${process.arch}`;

const log = (...args) => console.log("[runner]", ...args);
function die(message) {
  console.error(`[runner] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positional.push(a);
    else if (a.includes("=")) flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}

// ---------- config (~/.aviator/runner.json) ----------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  // The token lets whoever holds it act as this computer on the hub, so only you may read it.
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ---------- pairing ----------

async function pair(code, hub, name) {
  if (!code) die("Usage: npm run runner -- pair <CODE> --hub <URL>  (both are shown on the hub's “Add my computer” page)");
  if (!hub || hub === true) die("Add --hub <URL>, the address of your Aviator hub (shown next to the code).");
  hub = String(hub).replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${hub}/_hub/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: typeof name === "string" ? name : os.hostname(), platform: PLATFORM }),
    });
  } catch (err) {
    die(`Couldn't reach the hub at ${hub}: ${err.cause?.message ?? err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `The hub refused pairing (${res.status}).`);
  saveConfig({ hub, runnerId: data.runnerId, name: data.name, token: data.token });
  log(`This computer is linked as “${data.name}”. Settings saved in ${CONFIG}.`);
}

// ---------- the local Aviator ----------

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOCAL);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

/** Builds Aviator when there's no production build yet or the source changed, then runs `next start`. */
async function startApp(rebuild) {
  const require = createRequire(path.join(APP_DIR, "package.json"));
  let next;
  try {
    next = require.resolve("next/dist/bin/next");
  } catch {
    die(`Aviator's packages aren't installed. Run \`npm install\` in ${APP_DIR} first.`);
  }
  const distDir = path.join(APP_DIR, process.env.AVIATOR_DIST_DIR || ".next");
  const buildId = path.join(distDir, "BUILD_ID");
  const stale = !fs.existsSync(buildId) || newestMtime(path.join(APP_DIR, "src")) > fs.statSync(buildId).mtimeMs;
  if (rebuild || stale) {
    log("Building Aviator (only when it changed; takes a minute)…");
    const built = spawnSync(process.execPath, [next, "build"], { cwd: APP_DIR, stdio: "inherit" });
    if (built.status !== 0) die("The build failed; see the output above.");
  }
  log(`Starting Aviator on http://localhost:${PORT}…`);
  const child = spawn(process.execPath, [next, "start", "-p", String(PORT), "-H", LOCAL], { cwd: APP_DIR, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    log(`Aviator stopped (${signal ?? `exit code ${code}`}).`);
    process.exit(code ?? 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  // The runner also stops on its own (e.g. this computer was removed from the hub); Aviator stops with it.
  process.on("exit", () => child.exitCode === null && child.kill());
  for (let i = 0; i < 120 && !(await listening(PORT)); i++) await new Promise((r) => setTimeout(r, 500));
}

// ---------- the connection to the hub ----------

/** Replays one request from the hub against the local Aviator and streams the answer back. */
function serve(ws, active, m) {
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const body = m.body ? Buffer.from(m.body, "base64") : undefined;
  // To Aviator this is a request from its own page on localhost; the hub already checked who
  // is signed in and that the change came from the hub's own page.
  const headers = { ...m.headers, host: `localhost:${PORT}` };
  if (headers.origin) headers.origin = `http://localhost:${PORT}`;
  if (headers.referer) headers.referer = `http://localhost:${PORT}${m.path}`;
  for (const k of Object.keys(headers)) {
    if (k.startsWith("x-forwarded-") || k === "forwarded" || k === "x-real-ip") delete headers[k];
  }
  if (body) headers["content-length"] = String(body.length);
  else delete headers["content-length"];

  const req = http.request({ host: LOCAL, port: PORT, method: m.method, path: m.path, headers }, (res) => {
    send({ t: "res", id: m.id, status: res.statusCode, headers: res.headers });
    res.on("data", (chunk) => {
      send({ t: "data", id: m.id, data: chunk.toString("base64") });
      // A slow connection to the hub: wait for it rather than buffering everything in memory.
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        res.pause();
        const wait = setInterval(() => {
          if (ws.bufferedAmount < 1024 * 1024 || ws.readyState !== WebSocket.OPEN) {
            clearInterval(wait);
            res.resume();
          }
        }, 50);
      }
    });
    res.on("end", () => {
      if (active.delete(m.id)) send({ t: "end", id: m.id });
    });
    res.on("close", () => {
      if (active.delete(m.id)) send({ t: "error", id: m.id, message: "Aviator stopped answering." });
    });
    res.on("error", () => {});
  });
  req.on("error", (err) => {
    if (active.delete(m.id)) {
      send({
        t: "error",
        id: m.id,
        message: err.code === "ECONNREFUSED" ? "Aviator isn't running on this computer. Start it with `npm run runner`." : err.message,
      });
    }
  });
  active.set(m.id, req);
  req.end(body);
}

function connect(cfg) {
  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(`${cfg.hub.replace(/^http/, "ws")}/_hub/connect`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      maxPayload: 100 * 1024 * 1024,
    });
    /** requestId -> the request to the local Aviator, so the hub can cancel it. */
    const active = new Map();
    // The hub pings every 25 s; silence for longer means the connection is dead.
    let watchdog;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), 70_000);
    };

    ws.on("open", () => {
      delay = 1000;
      alive();
      log(`Connected to ${cfg.hub} as “${cfg.name}”. Open that address on any device and sign in.`);
      ws.send(JSON.stringify({ t: "hello", platform: PLATFORM, hostname: os.hostname() }));
    });
    ws.on("ping", alive);
    ws.on("unexpected-response", (req, res) => {
      if (res.statusCode === 401) {
        die(`The hub doesn't know this computer any more (it was removed). Pair it again with a new code from ${cfg.hub}/_hub/computers.`);
      }
      log(`The hub answered ${res.statusCode}; retrying.`);
      req.destroy();
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let m;
      try {
        m = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (m.t === "req") serve(ws, active, m);
      else if (m.t === "cancel") {
        const req = active.get(m.id);
        active.delete(m.id);
        req?.destroy();
      }
    });
    ws.on("error", (err) => log(`Connection problem: ${err.message}`));
    ws.on("close", (code, reason) => {
      clearTimeout(watchdog);
      for (const req of active.values()) req.destroy();
      active.clear();
      if (code === 4001) die(`${reason || "This computer was removed from its account."} Pair it again to use it.`);
      if (code === 4000) die("Another copy of the runner connected with this computer's settings, so this one stops.");
      log(`Disconnected; reconnecting in ${Math.round(delay / 1000)} s…`);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  open();
}

async function start(flags) {
  const cfg = loadConfig();
  if (!cfg?.token) die("This computer isn't linked to a hub yet. On the hub, click “Add my computer” and run the command it shows.");
  if (!flags["no-app"]) {
    if (await listening(PORT)) log(`Aviator is already running on port ${PORT}; using it.`);
    else await startApp(!!flags.rebuild);
  }
  connect(cfg);
}

// ---------- start at login ----------

function installService() {
  const env = `PATH=${process.env.PATH ?? ""}`;
  if (process.platform === "linux") {
    const file = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE}.service`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `[Unit]
Description=Aviator runner (connects this computer's Aviator to your hub)
After=network-online.target

[Service]
WorkingDirectory=${APP_DIR}
Environment="${env}"
ExecStart="${process.execPath}" "${SCRIPT}" start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    );
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", `${SERVICE}.service`], { stdio: "inherit" });
    log(`Installed ${file}. Logs: journalctl --user -u ${SERVICE} -f`);
    log(`To keep it running while you're logged out: loginctl enable-linger ${os.userInfo().username}`);
  } else if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", "com.aviator.runner.plist");
    const logFile = path.join(os.homedir(), ".aviator", "runner.log");
    const x = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aviator.runner</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(SCRIPT)}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${x(APP_DIR)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(process.env.PATH ?? "")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${x(logFile)}</string>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
</dict></plist>
`,
    );
    spawnSync("launchctl", ["unload", file]);
    execFileSync("launchctl", ["load", "-w", file], { stdio: "inherit" });
    log(`Installed ${file}. Logs: ${logFile}`);
  } else if (process.platform === "win32") {
    execFileSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", "AviatorRunner", "/TR", `"${process.execPath}" "${SCRIPT}" start`], {
      stdio: "inherit",
    });
    execFileSync("schtasks", ["/Run", "/TN", "AviatorRunner"], { stdio: "inherit" });
    log("Installed the AviatorRunner task; it starts when you log in.");
  } else die(`Starting at login isn't supported on ${process.platform}.`);
}

function uninstallService() {
  if (process.platform === "linux") {
    const file = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE}.service`);
    spawnSync("systemctl", ["--user", "disable", "--now", `${SERVICE}.service`], { stdio: "inherit" });
    fs.rmSync(file, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  } else if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", "com.aviator.runner.plist");
    spawnSync("launchctl", ["unload", "-w", file], { stdio: "inherit" });
    fs.rmSync(file, { force: true });
  } else if (process.platform === "win32") {
    spawnSync("schtasks", ["/End", "/TN", "AviatorRunner"], { stdio: "inherit" });
    spawnSync("schtasks", ["/Delete", "/F", "/TN", "AviatorRunner"], { stdio: "inherit" });
  }
  log("Removed the start-at-login entry.");
}

// ---------- main ----------

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? "start";

if (command === "pair") {
  await pair(positional[1], flags.hub, flags.name);
  if (!flags["no-start"]) await start(flags);
} else if (command === "start") {
  await start(flags);
} else if (command === "install-service") {
  if (!loadConfig()?.token) die("Pair this computer first: npm run runner -- pair <CODE> --hub <URL>");
  installService();
} else if (command === "uninstall-service") {
  uninstallService();
} else if (command === "status") {
  const cfg = loadConfig();
  console.log(cfg ? `Linked to ${cfg.hub} as “${cfg.name}” (${cfg.runnerId}).` : "Not linked to a hub.");
  console.log((await listening(PORT)) ? `Aviator is running on port ${PORT}.` : `Aviator isn't running on port ${PORT}.`);
} else if (command === "unpair") {
  fs.rmSync(CONFIG, { force: true });
  log("Forgot the hub link on this computer. Remove it from the hub's “Your computers” page too.");
} else {
  die(`Unknown command “${command}”. Commands: pair, start, install-service, uninstall-service, status, unpair.`);
}
