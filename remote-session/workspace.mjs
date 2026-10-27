import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SECRET = /^(\.env(?!\.(example|sample|template)$).*|\.git|\.ssh|\.aws|\.claude|\.npmrc|credentials(?:\.json)?|id_rsa.*|id_ed25519.*|.*\.pem)$/i;
const LIMIT = 64 * 1024;

export function workspaceTools(root, approve) {
  async function resolve(relative = '.') {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Use a relative workspace path.');
    const parts = relative.split(/[\\/]+/);
    if (parts.some(p => p === '..' || SECRET.test(p))) throw new Error('Path outside the workspace or protected file.');
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path outside workspace.');
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat?.isSymbolicLink()) throw new Error('Symlinks are not exposed.');
    }
    return target;
  }
  return async function execute(name, input, signal) {
    if (signal?.aborted) throw new Error('Cancelled.');
    const target = await resolve(input.path ?? '.');
    if (name === 'list') {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.filter(e => !SECRET.test(e.name) && !e.isSymbolicLink()).slice(0, 500).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    if (name === 'read') {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > LIMIT) throw new Error('Read requires a text file of at most 64 KiB.');
      return fs.readFile(target, 'utf8');
    }
    if (name === 'write') {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > LIMIT) throw new Error('Write limit is 64 KiB.');
      if (!await approve(`Write ${input.path}\n${input.content.slice(0, 2000)}`, signal)) throw new Error('Device owner denied the write.');
      if (signal?.aborted) throw new Error('Cancelled.');
      await resolve(input.path); // Recheck after waiting for local approval.
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, { mode: 0o600 });
      return 'File written.';
    }
    if (name === 'shell') {
      if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 8000) throw new Error('Invalid command.');
      if (!await approve(`Run in ${target}:\n${input.command}\nThis command has your OS user permissions.`, signal)) throw new Error('Device owner denied the command.');
      if (signal?.aborted) throw new Error('Cancelled.');
      await resolve(input.path ?? '.');
      return new Promise((resolveResult, reject) => {
        // Do not pass the connector token or unrelated application credentials to commands.
        const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
        const child = spawn(input.command, { cwd: target, shell: true, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', stopped = false;
        const kill = () => {
          stopped = true;
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        };
        const timer = setTimeout(kill, 120_000);
        signal?.addEventListener('abort', kill, { once: true });
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
        const receive = b => { output += b.toString(); if (Buffer.byteLength(output) > LIMIT) { output = output.slice(0, LIMIT); kill(); } };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.on('error', e => { cleanup(); reject(e); });
        child.on('close', code => { cleanup(); resolveResult(`Exit: ${code}${stopped ? ' (cancelled or resource limit)' : ''}\n${output}`); });
      });
    }
    throw new Error('Unknown workspace tool.');
  };
}
