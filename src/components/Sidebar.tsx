"use client";

import { ago, planUsageLine, STATUS_GLYPH, tokens, type RunSummary } from "@/lib/client";
import type { AppStatus, ChatSummary, Project } from "@/lib/types";

type Props = {
  status: AppStatus | null;
  projects: Project[];
  projectId: string | null;
  runs: RunSummary[];
  selectedRunId: string | null;
  onPickProject: (id: string) => void;
  onEditProject: () => void;
  onNewProject: () => void;
  onNewTask: () => void;
  onPickRun: (id: string) => void;
  onDeleteRun: (id: string) => void;
  onSignIn: () => void;
  onAgents: () => void;
  onConnections: () => void;
  chats: ChatSummary[];
  selectedChatId: string | null;
  /** Open the general chat page: one chat, or null for a new one. */
  onChat: (id: string | null) => void;
  onDeleteChat: (id: string) => void;
  page: "agents" | "connections" | "chat" | null;
};

export function Sidebar(p: Props) {
  const runs = p.runs.filter((r) => r.projectId === p.projectId);
  const chats = p.chats.filter((c) => c.projectId === p.projectId);
  const auth = p.status?.auth;
  const plan = planUsageLine(p.status?.planUsage);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="star">✻</span> aviator
        {p.status?.demo && <span className="tag badge warn">demo</span>}
      </div>

      <div className="section-label">project</div>
      <div className="project-picker">
        <select value={p.projectId ?? ""} onChange={(e) => p.onPickProject(e.target.value)} aria-label="Project">
          {p.projects.length === 0 && <option value="">No projects yet</option>}
          {p.projects.map((proj) => (
            <option key={proj.id} value={proj.id}>
              {proj.name}
            </option>
          ))}
        </select>
        <button className="btn icon" onClick={p.onEditProject} disabled={!p.projectId} title="Edit project">
          ✎
        </button>
        <button className="btn icon" onClick={p.onNewProject} title="New project">
          +
        </button>
      </div>

      <button className="btn primary new-task" onClick={p.onNewTask} disabled={!p.projectId}>
        + New task
      </button>
      <button className={`btn new-task ${p.page === "agents" ? "active-nav" : ""}`} onClick={p.onAgents} title="Model, effort, prompts and your own agents">
        ⚙ Agents
      </button>
      <button className={`btn new-task ${p.page === "connections" ? "active-nav" : ""}`} onClick={p.onConnections} title="MCP tool servers your agents can use">
        ⚡ Connections
      </button>
      <button
        className={`btn new-task ${p.page === "chat" ? "active-nav" : ""}`}
        onClick={() => p.onChat(null)}
        disabled={!p.projectId}
        title="Ask anything about this project's code: one Claude Code session with full access, outside the task pipeline"
      >
        ✦ General chat
      </button>

      {p.page === "chat" ? (
        <>
          <div className="section-label">chats</div>
          <div className="runs">
            {chats.length === 0 && <div className="faint" style={{ padding: "0 10px" }}>No chats yet</div>}
            {chats.map((c) => (
              <div className="run-row" key={c.id}>
                <button
                  className={`run-item ${c.id === p.selectedChatId ? "active" : ""}`}
                  onClick={() => p.onChat(c.id)}
                  title={c.title}
                >
                  <span className={`glyph ${c.busy ? "running" : "done"}`}>{c.busy ? "●" : "✦"}</span>
                  <span className="run-title">{c.title}</span>
                  <span className="run-meta">
                    {ago(c.updatedAt)}
                    {c.tokens ? ` · ${tokens(c.tokens)} tokens` : ""}
                  </span>
                </button>
                <button className="run-delete" onClick={() => p.onDeleteChat(c.id)} title="Delete this chat" aria-label={`Delete chat ${c.title}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="section-label">runs</div>
          <div className="runs">
            {runs.length === 0 && <div className="faint" style={{ padding: "0 10px" }}>No runs yet</div>}
            {runs.map((r) => {
              const g = STATUS_GLYPH[r.status];
              return (
                <div className="run-row" key={r.id}>
                  <button
                    className={`run-item ${r.id === p.selectedRunId ? "active" : ""}`}
                    onClick={() => p.onPickRun(r.id)}
                    title={`${r.title} · ${g.label}`}
                  >
                    <span className={`glyph ${g.cls}`}>{g.glyph}</span>
                    <span className="run-title">{r.title}</span>
                    <span className="run-meta">
                      {ago(r.createdAt)} · {g.label}
                      {r.tokens ? ` · ${tokens(r.tokens)} tokens` : ""}
                    </span>
                  </button>
                  <button className="run-delete" onClick={() => p.onDeleteRun(r.id)} title="Delete this run" aria-label={`Delete run ${r.title}`}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="env">
        {!auth ? (
          <span>Checking Claude sign-in…</span>
        ) : auth.ok ? (
          <span title={auth.email}>
            <span className="ok">●</span> {auth.mode === "claude-code" ? "Claude Code login" : "API key"}
            {auth.plan ? ` · ${auth.plan}` : ""}
          </span>
        ) : (
          <>
            <span className="bad" title={auth.error}>
              ● Not signed in to Claude
            </span>
            <button className="btn primary" style={{ margin: "4px 0" }} onClick={p.onSignIn}>
              Sign in with Claude
            </button>
          </>
        )}
        {auth?.ok && (
          <span title="Aviator only uses your plan's included usage and stops a run if Claude switches to paid extra usage.">
            <span className={plan?.cls ?? "ok"}>●</span> {plan ? plan.text : "Included plan usage only"}
          </span>
        )}
        <span>
          <span className={p.status?.hasClickUp ? "ok" : "faint"}>●</span> ClickUp{" "}
          {p.status?.hasClickUp ? "connected" : "not configured"}
        </span>
        {p.status?.viaHub && (
          <span>
            <span className="ok">●</span> Through your hub ·{" "}
            <a className="link-btn" href="/_hub/computers">
              computers &amp; sign out
            </a>
          </span>
        )}
      </div>
    </aside>
  );
}
