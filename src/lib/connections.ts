import fs from "node:fs";
import path from "node:path";
import { query, type McpServerConfig, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./auth";
import { connectionSlug, MASK, RISKY_TOOL, type Connection, type ToolRule } from "./connectionTypes";
import { dataDir } from "./store";
import type { GuardDecision } from "./agents/guard";

// Connections live in .aviator/connections.json on your machine. Secret values (env vars,
// headers) are never sent back to the browser, logged, or written anywhere else.

const file = () => path.join(dataDir, "connections.json");

function sanitize(value: unknown, taken: Set<string>): Connection | null {
  const v = (value ?? {}) as Partial<Connection>;
  const name = String(v.name ?? "").trim().slice(0, 60);
  if (!name) return null;
  let id = connectionSlug(String(v.id || name));
  let unique = id;
  for (let i = 2; taken.has(unique); i++) unique = `${id}_${i}`;
  id = unique;
  taken.add(id);
  const strMap = (m: unknown) =>
    Object.fromEntries(
      Object.entries((m ?? {}) as Record<string, unknown>)
        .map(([k, val]) => [k.trim(), String(val ?? "")])
        .filter(([k]) => k),
    );
  const transport = v.transport === "http" || v.transport === "sse" ? v.transport : "stdio";
  return {
    id,
    name,
    transport,
    command: String(v.command ?? "").trim(),
    args: Array.isArray(v.args) ? v.args.map(String).filter((a) => a.length > 0) : [],
    env: strMap(v.env),
    url: String(v.url ?? "").trim(),
    headers: strMap(v.headers),
    agents: Array.isArray(v.agents) ? [...new Set(v.agents.map(String))] : [],
    tools: Array.isArray(v.tools)
      ? v.tools.map((t: Partial<ToolRule>) => ({
          name: String(t.name ?? ""),
          description: t.description ? String(t.description) : undefined,
          purpose: String(t.purpose ?? "").slice(0, 300),
          agents: Array.isArray(t.agents) ? [...new Set(t.agents.map(String))] : [],
          allowed: t.allowed !== false,
          destructive: !!t.destructive,
          readOnly: !!t.readOnly,
        }))
      : [],
    enabled: v.enabled !== false,
    lastStatus: v.lastStatus,
    lastError: v.lastError,
    testedAt: v.testedAt,
  };
}

export function loadConnections(): Connection[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as { connections?: unknown[] };
    const taken = new Set<string>();
    return (raw.connections ?? []).map((c) => sanitize(c, taken)).filter((c): c is Connection => !!c);
  } catch {
    return [];
  }
}

function write(connections: Connection[]) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ connections }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** What the browser sees: secret values replaced by MASK. */
export function masked(connections: Connection[]): Connection[] {
  const hide = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).map((k) => [k, m[k] ? MASK : ""]));
  return connections.map((c) => ({ ...c, env: hide(c.env), headers: hide(c.headers) }));
}

/** Save the list from the browser; MASK values keep what was saved before. */
export function saveConnections(list: unknown[]): Connection[] {
  const current = loadConnections();
  const taken = new Set<string>();
  const next = list.map((c) => sanitize(c, taken)).filter((c): c is Connection => !!c);
  for (const c of next) {
    const before = current.find((o) => o.id === c.id);
    for (const key of ["env", "headers"] as const) {
      for (const [k, val] of Object.entries(c[key])) {
        if (val === MASK) c[key][k] = before?.[key][k] ?? "";
      }
    }
  }
  write(next);
  return next;
}

export function sdkConfig(c: Connection): McpServerConfig {
  if (c.transport === "stdio") return { type: "stdio", command: c.command, args: c.args, env: c.env };
  return { type: c.transport, url: c.url, headers: c.headers };
}

/** Which connections and tools one agent (built-in or custom id) may use. */
export function accessFor(agentId: string, connections = loadConnections()) {
  const usable = connections.filter(
    (c) => c.enabled && (c.agents.includes(agentId) || c.tools.some((t) => t.allowed && t.agents.includes(agentId))),
  );
  const ruleAllows = (c: Connection, t: ToolRule) => t.allowed && (t.agents.length ? t.agents.includes(agentId) : c.agents.includes(agentId));

  const servers: Record<string, McpServerConfig> = Object.fromEntries(usable.map((c) => [c.id, sdkConfig(c)]));

  const check = (toolName: string): GuardDecision => {
    const m = toolName.match(/^mcp__(.+?)__(.+)$/);
    const conn = m && usable.find((c) => c.id === m[1]);
    if (!m || !conn) return { allow: false, reason: `${toolName} isn't connected for ${agentId}.` };
    const rule = conn.tools.find((t) => t.name === m[2]);
    if (rule) {
      return ruleAllows(conn, rule)
        ? { allow: true }
        : { allow: false, reason: `${conn.name} › ${m[2]} isn't allowed for ${agentId}. Change it on the Connections page.` };
    }
    if (conn.agents.includes(agentId) && !RISKY_TOOL.test(m[2])) return { allow: true };
    return { allow: false, reason: `${conn.name} › ${m[2]} needs to be allowed on the Connections page first (Test the connection to list its tools).` };
  };

  const lines: string[] = [];
  for (const c of usable) {
    const tools = c.tools.filter((t) => ruleAllows(c, t));
    if (!tools.length && c.agents.includes(agentId)) lines.push(`- ${c.name}: tools named mcp__${c.id}__*`);
    for (const t of tools) lines.push(`- mcp__${c.id}__${t.name}${t.purpose ? `: use it for ${t.purpose}` : ""}`);
  }
  const note = lines.length ? `## Connected tools you can use\n${lines.join("\n")}` : "";

  return { servers, check, note };
}

/** Start the server briefly and list its tools. Uses none of your plan (no prompt is sent). */
export async function testConnection(c: Connection): Promise<{ status: string; error?: string; tools: ToolRule[] }> {
  let close: (() => void) | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => (close = () => resolve({ done: true, value: undefined }))),
    }),
  };
  const q = query({
    prompt: idle,
    options: { env: agentEnv(), settingSources: [], persistSession: false, mcpServers: { [c.id]: sdkConfig(c) }, strictMcpConfig: true },
  });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = (await q.mcpServerStatus()).find((s) => s.name === c.id);
      if (status && status.status !== "pending") {
        const tools: ToolRule[] = (status.tools ?? []).map((t) => {
          const old = c.tools.find((o) => o.name === t.name);
          const destructive = !!t.annotations?.destructive || RISKY_TOOL.test(t.name);
          return (
            old ?? {
              name: t.name,
              description: t.description,
              purpose: (t.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 160),
              agents: [],
              allowed: !destructive,
              destructive,
              readOnly: !!t.annotations?.readOnly,
            }
          );
        });
        return { status: status.status, error: status.error, tools };
      }
      if (Date.now() > deadline) return { status: "failed", error: "Timed out waiting for the server to start.", tools: c.tools };
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    close?.();
    q.close();
  }
}
