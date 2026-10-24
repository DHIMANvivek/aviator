"use client";

import { actorColor, AGENT_GLYPH, duration, planUsageLine, stageIndex, STAGES, tokens, type Derived } from "@/lib/client";
import { AGENTS, type AgentName, type Project, type Run } from "@/lib/types";
import { fileAnchor } from "./Report";
import type { Filter } from "./Transcript";

const ROLE: Record<AgentName, string> = {
  researcher: "reads the code, asks questions",
  planner: "plan + contract",
  backend: "builds the API side",
  frontend: "builds the UI side",
  qa: "tests and reviews",
  reporter: "before/after report",
};

function OpenButtons({ path, onOpen }: { path: string; onOpen: (path: string, how: "folder" | "editor") => void }) {
  return (
    <span className="open-btns">
      <button className="link-btn" onClick={() => onOpen(path, "folder")} title={`Open ${path}`}>
        open folder
      </button>
      <button className="link-btn" onClick={() => onOpen(path, "editor")} title={`Open ${path} in VS Code`}>
        VS Code
      </button>
    </span>
  );
}

export function SidePanel({
  run,
  project,
  derived,
  filter,
  onFilter,
  onOpen,
}: {
  run: Run | null;
  project: Project | null;
  derived: Derived;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onOpen: (path: string, how: "folder" | "editor") => void;
}) {
  const projectRepos: [string, string][] = project
    ? project.layout === "monorepo"
      ? project.root
        ? [["repo", project.root]]
        : []
      : ([
          ["frontend", project.frontendPath],
          ["backend", project.backendPath],
        ].filter(([, p]) => !!p) as [string, string][])
    : [];
  const current = stageIndex(derived.stage ?? run?.stage);
  const finished = derived.status === "done" || derived.status === "partial";
  const diff = run?.diff ?? [];

  return (
    <aside className="side">
      <div className="side-scroll">
        {projectRepos.length > 0 && (
          <>
            <div className="section-label">project · {project!.name}</div>
            {projectRepos.map(([label, p]) => (
              <div className="kv" key={label} style={{ marginBottom: 6 }}>
                <div>
                  <span className="k">{label}</span> <span className="faint">{p}</span>
                </div>
                <OpenButtons path={p} onOpen={onOpen} />
              </div>
            ))}
          </>
        )}
        <div className="section-label">pipeline</div>
        <ul className="stages">
          {STAGES.map((s, i) => {
            const state = finished || i < current ? "done" : i === current ? "current" : "";
            return (
              <li key={s.stage} className={state}>
                <span className={`glyph ${state === "current" ? "running" : ""}`}>
                  {state === "done" ? "✓" : state === "current" ? "●" : "○"}
                </span>
                <span>{s.label}</span>
              </li>
            );
          })}
        </ul>

        <div className="section-label">agents · click to filter</div>
        {AGENTS.map((a) => {
          const st = derived.agents[a] ?? run?.agents[a];
          const status = st?.status ?? "idle";
          const time = st?.startedAt ? duration((st.endedAt ?? Date.now()) - st.startedAt) : "";
          return (
            <button
              key={a}
              className="agent-row"
              onClick={() => onFilter(filter === a ? "all" : a)}
              style={filter === a ? { background: "var(--bg-hover)" } : undefined}
            >
              <span className={`glyph ${status}`}>{AGENT_GLYPH[status]}</span>
              <span style={{ color: actorColor(a) }}>{a}</span>
              <span className="cost">{st && st.tokens > 0 ? `${tokens(st.tokens)} tok` : ""}</span>
              <span className="sub">
                {status === "skipped" ? "not needed for this task" : ROLE[a]}
                {st && st.turns > 0 ? ` · ${st.turns} turns` : ""}
                {time ? ` · ${time}` : ""}
              </span>
            </button>
          );
        })}

        {run && run.repos.length > 0 && (
          <>
            <div className="section-label">branch</div>
            {run.repos.map((r) => (
              <div className="kv" key={r.role} style={{ marginBottom: 6 }}>
                <div>
                  <span className="k">{r.role}</span> <code>{r.branch}</code>
                </div>
                <div className="faint">{r.workPath}</div>
                <OpenButtons path={r.workPath} onOpen={onOpen} />
              </div>
            ))}
            <div className="kv faint">Nothing is committed or pushed.</div>
          </>
        )}

        {diff.length > 0 && (
          <>
            <div className="section-label">changes</div>
            {diff.flatMap((repo) =>
              repo.files.map((f) => (
                <button
                  key={repo.role + f.path}
                  className="file-row"
                  style={{ padding: "2px 16px" }}
                  onClick={() => document.getElementById(fileAnchor(repo.role, f.path))?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  <span className="path" style={{ fontSize: 12 }}>
                    {f.path}
                  </span>
                  <span className="adds" style={{ fontSize: 11.5 }}>
                    +{f.additions}
                  </span>
                  <span className="dels" style={{ fontSize: 11.5 }}>
                    −{f.deletions}
                  </span>
                </button>
              )),
            )}
          </>
        )}

        <div className="section-label">plan usage</div>
        <div className="kv">
          {(() => {
            const line = planUsageLine(derived.planUsage ?? run?.planUsage);
            return line ? <div className={line.cls}>{line.text}</div> : <div className="muted">Shown once Claude reports it</div>;
          })()}
          <div>
            <span className="k">this run</span> {tokens(derived.tokens || run?.tokens || 0)} tokens
          </div>
          <div className="faint">
            Only your plan&apos;s included usage is used. If Claude switches to paid extra usage, Aviator stops the run.
          </div>
        </div>
      </div>
    </aside>
  );
}
