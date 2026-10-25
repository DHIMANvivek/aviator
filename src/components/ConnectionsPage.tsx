"use client";

import { useEffect, useState } from "react";
import type { AgentSettings } from "@/lib/agentPresets";
import { actorColor, api } from "@/lib/client";
import { CONNECTION_EXAMPLES, connectionSlug, MASK, type Connection, type ToolRule } from "@/lib/connectionTypes";
import { AGENTS } from "@/lib/types";

const BLANK: Connection = {
  id: "",
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  agents: [],
  tools: [],
  enabled: true,
};

const toLines = (m: Record<string, string>, sep: string) =>
  Object.entries(m)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");

function fromLines(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

type Draft = { conn: Connection; isNew: boolean; args: string; env: string; headers: string };

function AgentChips({ all, value, onChange }: { all: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="checks-row" style={{ marginTop: 0 }}>
      {all.map((a) => (
        <label key={a.id} className="check">
          <input
            type="checkbox"
            checked={value.includes(a.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((x) => x !== a.id))}
          />
          <span style={{ color: actorColor(a.id) }}>{a.name}</span>
        </label>
      ))}
    </div>
  );
}

export function ConnectionsPage() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>(AGENTS.map((a) => ({ id: a, name: a })));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"" | "saving" | "testing">("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ connections: Connection[] }>("/api/connections").then((r) => setList(r.connections));
    api<{ settings: AgentSettings }>("/api/agents")
      .then((r) => setAgents([...AGENTS.map((a) => ({ id: a, name: a })), ...r.settings.custom.map((c) => ({ id: c.id, name: c.name }))]))
      .catch(() => {});
  }, []);

  if (!list) return <div className="muted">Loading connections…</div>;

  const open = (conn: Connection, isNew: boolean) => {
    setMessage(null);
    setDraft({ conn, isNew, args: conn.args.join("\n"), env: toLines(conn.env, "="), headers: toLines(conn.headers, ": ") });
  };
  const current = (d: Draft): Connection => ({
    ...d.conn,
    id: d.conn.id || connectionSlug(d.conn.name),
    args: d.args.split("\n").map((s) => s.trim()).filter(Boolean),
    env: fromLines(d.env, "="),
    headers: fromLines(d.headers, ":"),
  });

  async function saveAll(next: Connection[], note: string) {
    setBusy("saving");
    try {
      const res = await api<{ connections: Connection[] }>("/api/connections", { method: "PUT", json: { connections: next } });
      setList(res.connections);
      setMessage({ ok: true, text: note });
      return res.connections;
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function saveDraft() {
    if (!draft) return;
    const conn = current(draft);
    if (!conn.name.trim()) return setMessage({ ok: false, text: "Give the connection a name." });
    if (conn.transport === "stdio" ? !conn.command : !conn.url) {
      return setMessage({ ok: false, text: conn.transport === "stdio" ? "Enter the command that starts the server." : "Enter the server URL." });
    }
    const next = draft.isNew ? [...list!, conn] : list!.map((c) => (c.id === draft.conn.id ? conn : c));
    const saved = await saveAll(next, `Saved ${conn.name}. Test it to list its tools.`);
    if (saved) open(saved.find((c) => c.name === conn.name) ?? conn, false);
  }

  async function test() {
    if (!draft) return;
    setBusy("testing");
    setMessage(null);
    try {
      const conn = current(draft);
      const res = await api<{ status: string; error?: string; tools: ToolRule[] }>("/api/connections/test", {
        method: "POST",
        json: { connection: conn },
      });
      setDraft({ ...draft, conn: { ...draft.conn, tools: res.tools, lastStatus: res.status, lastError: res.error } });
      if (!draft.isNew) {
        setList((l) => l && l.map((c) => (c.id === draft.conn.id ? { ...c, tools: res.tools, lastStatus: res.status, lastError: res.error } : c)));
      }
      setMessage(
        res.status === "connected"
          ? { ok: true, text: `Connected. Found ${res.tools.length} tools. Choose what each is for and who may use it, then Save.` }
          : { ok: false, text: `Status: ${res.status}${res.error ? `. ${res.error}` : ""}` },
      );
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const setTool = (name: string, patch: Partial<ToolRule>) =>
    draft &&
    setDraft({ ...draft, conn: { ...draft.conn, tools: draft.conn.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)) } });

  return (
    <div className="agents-page">
      <h2 className="page-title">Connections</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Connect MCP tool servers (screenshots, Figma, Sentry, GitHub, your own APIs…) and decide which agents may use each tool and what
        for. Keys and tokens stay on this computer, are masked here, and are never logged or pushed.
      </p>

      {list.length === 0 && !draft && <div className="faint" style={{ margin: "8px 0" }}>No connections yet.</div>}
      {list.map((c) => (
        <div key={c.id} className="conn-row">
          <label className="check" title="Turn this connection on or off">
            <input
              type="checkbox"
              checked={c.enabled}
              onChange={() => saveAll(list.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)), `${c.name} ${c.enabled ? "turned off" : "turned on"}.`)}
            />
          </label>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              <b>{c.name}</b> <span className="faint">mcp__{c.id}__…</span>{" "}
              <span className={`badge ${c.lastStatus === "connected" ? "ok" : c.lastStatus ? "bad" : "muted"}`}>{c.lastStatus ?? "not tested"}</span>
            </div>
            <div className="faint" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {c.transport === "stdio" ? `${c.command} ${c.args.join(" ")}` : c.url} · {c.tools.length} tools · used by{" "}
              {[...new Set([...c.agents, ...c.tools.flatMap((t) => t.agents)])].join(", ") || "no agents yet"}
            </div>
          </div>
          <button className="btn" onClick={() => open(c, false)}>
            Edit
          </button>
        </div>
      ))}

      {!draft && (
        <div className="actions" style={{ marginTop: 12, alignItems: "center" }}>
          <button className="btn primary" onClick={() => open(BLANK, true)}>
            + Add connection
          </button>
          <span className="faint" style={{ fontSize: 12 }}>
            or start from:
          </span>
          {CONNECTION_EXAMPLES.map((ex) => (
            <button key={ex.name} className="chip" title={ex.note} onClick={() => open({ ...BLANK, ...ex.conn } as Connection, true)}>
              {ex.name}
            </button>
          ))}
        </div>
      )}

      {message && <div className={message.ok ? "ok" : "bad"} style={{ margin: "10px 0", fontSize: 12.5 }}>{message.text}</div>}

      {draft && (
        <div className="card prompt-editor custom-editor">
          <div className="prompt-head">
            <h3 style={{ margin: 0 }}>{draft.isNew ? "New connection" : `Edit ${draft.conn.name}`}</h3>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="cn-name">Name</label>
              <input
                id="cn-name"
                type="text"
                value={draft.conn.name}
                onChange={(e) => setDraft({ ...draft, conn: { ...draft.conn, name: e.target.value } })}
                placeholder="Playwright"
              />
              <span className="help">Agents see its tools as mcp__{draft.conn.id || connectionSlug(draft.conn.name || "name")}__toolname.</span>
            </div>
            <div className="field">
              <label>Type</label>
              <div className="segmented">
                <button className={draft.conn.transport === "stdio" ? "on" : ""} onClick={() => setDraft({ ...draft, conn: { ...draft.conn, transport: "stdio" } })}>
                  Local command
                </button>
                <button className={draft.conn.transport !== "stdio" ? "on" : ""} onClick={() => setDraft({ ...draft, conn: { ...draft.conn, transport: "http" } })}>
                  URL
                </button>
              </div>
            </div>
          </div>

          {draft.conn.transport === "stdio" ? (
            <div className="grid2">
              <div className="field">
                <label htmlFor="cn-cmd">Command</label>
                <input id="cn-cmd" type="text" value={draft.conn.command} onChange={(e) => setDraft({ ...draft, conn: { ...draft.conn, command: e.target.value } })} placeholder="npx" />
                <label htmlFor="cn-args" style={{ marginTop: 6 }}>
                  Arguments (one per line)
                </label>
                <textarea id="cn-args" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} placeholder={"@playwright/mcp@latest"} />
              </div>
              <div className="field">
                <label htmlFor="cn-env">Environment variables (KEY=value, one per line)</label>
                <textarea id="cn-env" value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} placeholder="API_TOKEN=..." />
                <span className="help">Saved values show as {MASK}; leave them as they are to keep them.</span>
              </div>
            </div>
          ) : (
            <div className="grid2">
              <div className="field">
                <label htmlFor="cn-url">Server URL</label>
                <input id="cn-url" type="text" value={draft.conn.url} onChange={(e) => setDraft({ ...draft, conn: { ...draft.conn, url: e.target.value } })} placeholder="https://example.com/mcp" />
                <label className="check" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={draft.conn.transport === "sse"}
                    onChange={(e) => setDraft({ ...draft, conn: { ...draft.conn, transport: e.target.checked ? "sse" : "http" } })}
                  />
                  Older SSE server
                </label>
              </div>
              <div className="field">
                <label htmlFor="cn-headers">Headers (Name: value, one per line)</label>
                <textarea id="cn-headers" value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} placeholder="Authorization: Bearer ..." />
                <span className="help">Saved values show as {MASK}; leave them as they are to keep them.</span>
              </div>
            </div>
          )}

          <div className="field">
            <label>Agents that may use its tools</label>
            <AgentChips all={agents} value={draft.conn.agents} onChange={(v) => setDraft({ ...draft, conn: { ...draft.conn, agents: v } })} />
            <span className="help">Per-tool choices below override this. Tools that look destructive stay off until you allow them.</span>
          </div>

          {draft.conn.lastError && <div className="errors">{draft.conn.lastError}</div>}

          {draft.conn.tools.length > 0 && (
            <>
              <div className="section-label" style={{ padding: "8px 0 6px" }}>
                tools · what each is for, and who may use it
              </div>
              <table className="table agents-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Use it for</th>
                    <th>Allowed</th>
                    <th>Only these agents (empty = the ones above)</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.conn.tools.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <div style={{ fontWeight: 500 }}>
                          {t.name} {t.destructive && <span className="badge warn">changes things</span>}
                          {t.readOnly && <span className="badge muted">read-only</span>}
                        </div>
                        <div className="faint" style={{ fontSize: 11 }}>
                          {(t.description ?? "").slice(0, 140)}
                        </div>
                      </td>
                      <td>
                        <input type="text" value={t.purpose} onChange={(e) => setTool(t.name, { purpose: e.target.value })} placeholder="e.g. screenshots of changed pages" style={{ width: "100%" }} />
                      </td>
                      <td>
                        <input type="checkbox" checked={t.allowed} onChange={(e) => setTool(t.name, { allowed: e.target.checked })} aria-label={`${t.name} allowed`} />
                      </td>
                      <td>
                        <AgentChips all={agents} value={t.agents} onChange={(v) => setTool(t.name, { agents: v })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="actions">
            <button className="btn solid" onClick={saveDraft} disabled={!!busy}>
              {busy === "saving" ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={test} disabled={!!busy}>
              {busy === "testing" ? "Starting the server…" : "Test & list tools"}
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              Close
            </button>
            {!draft.isNew && (
              <button
                className="btn"
                style={{ marginLeft: "auto", color: "var(--red)" }}
                onClick={async () => {
                  if (!window.confirm(`Remove the connection "${draft.conn.name}"? Its saved keys are deleted too.`)) return;
                  if (await saveAll(list.filter((c) => c.id !== draft.conn.id), `Removed ${draft.conn.name}.`)) setDraft(null);
                }}
              >
                Remove
              </button>
            )}
          </div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
            Testing starts the server on this computer for a few seconds to read its tool list. It sends no prompt and uses none of your
            Claude plan. Local commands run as you, so only add servers you trust.
          </div>
        </div>
      )}
    </div>
  );
}
