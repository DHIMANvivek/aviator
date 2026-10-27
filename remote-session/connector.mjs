import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';
import { validHubUrl } from './url.mjs';
import { workspaceTools } from './workspace.mjs';

const [hubArg, workspaceArg] = process.argv.slice(2);
if (!hubArg || !workspaceArg || !process.env.AVIATOR_CONNECTOR_TOKEN) throw new Error('Usage: AVIATOR_CONNECTOR_TOKEN=<device-token> npm run share:connect -- https://your-host <workspace-folder>');
const hub = validHubUrl(hubArg);
const root = await fs.realpath(workspaceArg);
if (!(await fs.stat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
if (!process.stdin.isTTY) throw new Error('Run this connector in a terminal; writes and shell commands require your approval.');
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const execute = workspaceTools(root, async (description, signal) => {
  console.log(`\n${description.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')}`);
  try { return /^y(es)?$/i.test((await terminal.question('Allow? [y/N] ', { signal })).trim()); }
  catch { return false; }
});
const active = new Map();
let stopping = false;
function connect() {
  const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/connect`, { headers: { authorization: `Bearer ${process.env.AVIATOR_CONNECTOR_TOKEN}` }, maxPayload: 256 * 1024 });
  let watchdog;
  const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ws.terminate(), 65000); };
  ws.on('open', () => { alive(); console.log(`Connected. Only this workspace is exposed by file tools: ${root}`); });
  ws.on('ping', alive);
  ws.on('message', async raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'cancel') { for (const controller of active.values()) controller.abort(); return; }
    if (m.type !== 'tool' || typeof m.id !== 'string' || active.has(m.id)) return;
    const send = data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: m.id, ...data })); };
    if (active.size) return send({ error: 'Another tool is awaiting completion or local approval.' });
    const controller = new AbortController();
    active.set(m.id, controller);
    try { send({ text: await execute(m.name, m.input || {}, controller.signal) }); }
    catch (e) { send({ error: e.message }); }
    finally { active.delete(m.id); }
  });
  ws.on('unexpected-response', (_req, res) => { console.error(`Connection rejected (${res.statusCode}). Check the connector token.`); stopping = true; ws.terminate(); });
  ws.on('error', e => console.error(e.message));
  ws.on('close', () => {
    clearTimeout(watchdog);
    for (const controller of active.values()) controller.abort();
    if (!stopping) setTimeout(connect, 3000);
    else terminal.close();
  });
  const stop = () => { stopping = true; ws.close(); terminal.close(); };
  process.once('SIGINT', stop);
  ws.once('close', () => process.removeListener('SIGINT', stop));
}
connect();
