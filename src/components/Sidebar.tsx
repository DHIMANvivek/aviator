"use client";

import { ago, planUsageLine, STATUS_GLYPH, tokens, type RunSummary } from "@/lib/client";
import type { AppStatus, Project } from "@/lib/types";

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
  onSignIn: () => void;
  onAgents: () => void;
  onConnections: () => void;
  page: "agents" | "connections" | null;
};

export function Sidebar(p: Props) {
  const runs = p.runs.filter((r) => r.projectId === p.projectId);
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

      <div className="section-label">runs</div>
      <div className="runs">
        {runs.length === 0 && <div className="faint" style={{ padding: "0 10px" }}>No runs yet</div>}
        {runs.map((r) => {
          const g = STATUS_GLYPH[r.status];
          return (
            <button
              key={r.id}
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
          );
        })}
      </div>

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
      </div>
    </aside>
  );
}
