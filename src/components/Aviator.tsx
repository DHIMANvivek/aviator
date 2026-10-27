"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  actorColor,
  api,
  derive,
  duration,
  FINAL,
  STATUS_GLYPH,
  storage,
  tokens,
  VERBS,
  type RunSummary,
} from "@/lib/client";
import { AGENTS, type AppStatus, type AviatorEvent, type ChatSummary, type ImageInput, type Project, type Run } from "@/lib/types";
import { Composer, COMMANDS, type Activity, type ComposerHandle } from "./Composer";
import { ProjectDialog } from "./ProjectDialog";
import { Sidebar } from "./Sidebar";
import { AgentsPage } from "./AgentsPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { ChatPage } from "./ChatPage";

type Page = "agents" | "connections" | "chat";
import { matchingPreset, PRESETS, type AgentSettings } from "@/lib/agentPresets";
import { SignInDialog } from "./SignInDialog";
import { SidePanel } from "./SidePanel";
import { Transcript, type Filter } from "./Transcript";

type Notice = { kind: "error" | "info"; text: string } | null;

function runFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.location.hash.slice(1);
  return id.startsWith("run_") ? id : null;
}

function chatFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.location.hash.slice(1);
  return id.startsWith("chat_") ? id : null;
}

export function Aviator() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AviatorEvent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<{ project: Project | null } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Continue the stopped run by itself once the plan limit resets (while this page is open). */
  const [autoContinue, setAutoContinue] = useState<string | null>(null);
  /** What to tell the agents when continuing, e.g. changes you made yourself meanwhile. */
  const [continueNote, setContinueNote] = useState("");
  /** The run a Continue was just sent for, so its card hides right away. */
  const [continuing, setContinuing] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const derived = useMemo(() => derive(events), [events]);
  /** Your custom agents (and on-demand helpers) that appeared in this run, for the filter chips. */
  const customActors = useMemo(
    () => [...new Set(events.map((e) => e.actor))].filter((a) => !(AGENTS as readonly string[]).includes(a) && a !== "orchestrator" && a !== "user"),
    [events],
  );
  const runStatus = derived.status ?? run?.status;
  const active = !!runId && !!runStatus && !FINAL.includes(runStatus);
  // Runs saved before error codes existed are recognized by their message.
  const dirtyRepo =
    run && runStatus === "failed" && (run.errorCode === "dirty_repo" || /has uncommitted changes/.test(run.error ?? ""))
      ? (run.errorRepo ?? (run.error ?? "").split(" has uncommitted")[0])
      : null;

  // A stopped run that has a branch can pick up where it stopped.
  const canContinue =
    !!run && !!runStatus && (runStatus === "failed" || runStatus === "cancelled") && run.repos.length > 0 && !dirtyRepo && continuing !== runId;
  const usage = derived.planUsage ?? status?.planUsage;
  const resetMs = usage?.resetsAt ? (usage.resetsAt < 1e12 ? usage.resetsAt * 1000 : usage.resetsAt) : undefined;
  const limitUntil = usage && (usage.status === "rejected" || usage.usingExtraUsage) && resetMs && resetMs > now ? resetMs : undefined;

  // ---------- loading ----------

  const loadRuns = useCallback(() => api<RunSummary[]>("/api/runs").then(setRuns).catch(() => {}), []);
  const loadChats = useCallback(() => api<ChatSummary[]>("/api/chats").then(setChats).catch(() => {}), []);
  const refreshStatus = useCallback(
    () =>
      api<AppStatus>("/api/status?refresh=1")
        .then((s) => {
          setStatus(s);
          return s;
        })
        .catch(() => null),
    [],
  );

  useEffect(() => {
    api<AppStatus>("/api/status").then(setStatus).catch(() => {});
    api<Project[]>("/api/projects")
      .then((list) => {
        setProjects(list);
        const stored = storage("aviator.project");
        setProjectId(list.find((p) => p.id === stored)?.id ?? list[0]?.id ?? null);
      })
      .catch(() => {});
    void loadRuns();
    void loadChats();
    api<{ settings: AgentSettings }>("/api/agents")
      .then((r) => setAgentSettings(r.settings))
      .catch(() => {});
    const onHash = () => {
      const h = window.location.hash.slice(1);
      setPage(h === "agents" || h === "connections" || h === "chat" ? h : chatFromHash() ? "chat" : null);
      setRunId(runFromHash());
      setChatId(chatFromHash());
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    const poll = setInterval(() => {
      void loadRuns();
      void loadChats();
    }, 5000);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(poll);
    };
  }, [loadRuns, loadChats]);

  useEffect(() => {
    if (projectId) storage("aviator.project", projectId);
  }, [projectId]);

  const selectRun = useCallback((id: string | null) => {
    setRunId(id);
    setFilter("all");
    setShowHelp(false);
    setPage(null);
    setChatId(null);
    const hash = id ? `#${id}` : "";
    if (window.location.hash !== hash) history.replaceState(null, "", hash || window.location.pathname);
  }, []);

  const openPage = useCallback((which: Page) => {
    setPage(which);
    setShowHelp(false);
    setRunId(null);
    setChatId(null);
    if (window.location.hash !== `#${which}`) history.replaceState(null, "", `#${which}`);
  }, []);

  /** The general chat page, on one chat or a new one. */
  const openChat = useCallback((id: string | null) => {
    setPage("chat");
    setShowHelp(false);
    setRunId(null);
    setChatId(id);
    const hash = `#${id ?? "chat"}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
  }, []);

  // Live event stream for the selected run (replays history, then streams).
  useEffect(() => {
    setEvents([]);
    setRun(null);
    if (!runId) return;
    stickToBottom.current = true;
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AviatorEvent;
      setEvents((prev) => (prev.length && prev[prev.length - 1].seq >= e.seq ? prev : [...prev, e]));
    };
    return () => es.close();
  }, [runId]);

  // Full run record (repos, diff, project) refreshes whenever the stage or status moves.
  useEffect(() => {
    if (!runId) return;
    api<Run>(`/api/runs/${runId}`)
      .then((r) => {
        setRun(r);
        if (r.projectId !== projectId && projects.some((p) => p.id === r.projectId)) setProjectId(r.projectId);
      })
      .catch(() => setRun(null));
    void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, derived.status, derived.stage, loadRuns]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, filter]);

  // ---------- actions ----------

  const fail = (err: unknown) => {
    setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    return false;
  };

  async function startRun(text: string, source?: "clickup" | "prompt", images: ImageInput[] = []): Promise<boolean> {
    if (!projectId) {
      setNotice({ kind: "error", text: "Connect a project first: /new-project" });
      return false;
    }
    try {
      const r = await api<Run>("/api/runs", { method: "POST", json: { projectId, text, source, images } });
      void loadRuns();
      selectRun(r.id);
      return true;
    } catch (err) {
      return fail(err);
    }
  }

  async function approve() {
    if (!runId) return;
    stickToBottom.current = true;
    try {
      await api(`/api/runs/${runId}/approve`, { method: "POST", json: { approved: true } });
    } catch (err) {
      fail(err);
    }
  }

  /** Retry the selected run's task, after stashing changes or switching to a worktree. */
  async function retry(fix: "stash" | "worktree"): Promise<boolean> {
    if (!runId) return false;
    if (
      fix === "stash" &&
      !window.confirm(
        `Stash the uncommitted changes in ${dirtyRepo}?\n\nThey're kept in git's stash; run "git stash pop" in that folder to get them back.`,
      )
    ) {
      return false;
    }
    try {
      const next = await api<Run>(`/api/runs/${runId}/retry`, { method: "POST", json: { fix } });
      void loadRuns();
      if (fix === "worktree") void api<Project[]>("/api/projects").then(setProjects);
      selectRun(next.id);
      return true;
    } catch (err) {
      return fail(err);
    }
  }

  /** Delete a run's record (log, plan, report); its branch and changes stay in your repo. */
  async function deleteRun(id: string): Promise<boolean> {
    const r = runs.find((x) => x.id === id);
    const live = r && !FINAL.includes(r.status);
    if (
      !window.confirm(
        `Delete "${r?.title ?? "this run"}"?${live ? "\n\nIt's still running and will be stopped." : ""}\n\nIts log, plan and report are removed. The branch and any changes the agents made stay in your repo.`,
      )
    ) {
      return false;
    }
    try {
      await api(`/api/runs/${id}`, { method: "DELETE" });
      setRuns((prev) => prev.filter((x) => x.id !== id));
      if (id === runId) selectRun(null);
      return true;
    } catch (err) {
      return fail(err);
    }
  }

  async function deleteChat(id: string) {
    const c = chats.find((x) => x.id === id);
    if (!window.confirm(`Delete the chat "${c?.title ?? "this chat"}"?${c?.busy ? "\n\nClaude is still working and will be stopped." : ""}\n\nIts history is removed; changes Claude made to your files stay.`)) {
      return;
    }
    try {
      await api(`/api/chats/${id}`, { method: "DELETE" });
      setChats((prev) => prev.filter((x) => x.id !== id));
      if (id === chatId) openChat(null);
    } catch (err) {
      fail(err);
    }
  }

  async function continueRun(id = runId, note = continueNote): Promise<boolean> {
    if (!id) return false;
    stickToBottom.current = true;
    setAutoContinue(null);
    setContinuing(id);
    try {
      await api(`/api/runs/${id}/continue`, { method: "POST", json: { note } });
      setContinueNote("");
      void loadRuns();
      void refreshStatus();
      return true;
    } catch (err) {
      setContinuing(null);
      return fail(err);
    } finally {
      // Once the run's own status events arrive they decide whether the card shows again.
      setTimeout(() => setContinuing((cur) => (cur === id ? null : cur)), 5000);
    }
  }

  // Re-render when the limit resets so the Continue button turns on.
  useEffect(() => {
    if (!limitUntil) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, limitUntil - Date.now()) + 1000);
    return () => clearTimeout(t);
  }, [limitUntil]);

  // Auto-continue fires a minute after the reset time, if the run is still the one waiting.
  useEffect(() => {
    if (!autoContinue || !resetMs) return;
    const t = setTimeout(() => {
      if (autoContinue === runId) void continueRun(autoContinue);
    }, Math.max(0, resetMs - Date.now()) + 60_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoContinue, resetMs, runId, continueNote]);

  async function openFolder(path: string, how: "folder" | "editor") {
    try {
      await api("/api/open", { method: "POST", json: { path, how } });
    } catch (err) {
      fail(err);
    }
  }

  async function cancel() {
    if (!runId) return;
    try {
      await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    } catch (err) {
      fail(err);
    }
  }

  async function command(text: string): Promise<boolean> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/clickup":
        if (!arg) return fail(new Error("Usage: /clickup <task link or id>"));
        return startRun(arg, "clickup");
      case "/new":
        selectRun(null);
        return true;
      case "/approve":
        await approve();
        return true;
      case "/cancel":
        if (!active) return fail(new Error("No run is in progress."));
        await cancel();
        return true;
      case "/project":
        setDialog({ project });
        return true;
      case "/new-project":
        setDialog({ project: null });
        return true;
      case "/login":
        setSigningIn(true);
        return true;
      case "/status": {
        const s = await refreshStatus();
        setNotice(
          s?.auth.ok
            ? { kind: "info", text: `Signed in via ${s.auth.mode === "claude-code" ? "Claude Code login" : "API key"}${s.auth.plan ? ` (${s.auth.plan})` : ""}${s.auth.email ? ` as ${s.auth.email}` : ""}.` }
            : { kind: "error", text: s?.auth.error ?? "Couldn't check sign-in." },
        );
        return true;
      }
      case "/agents":
        openPage("agents");
        return true;
      case "/connections":
        openPage("connections");
        return true;
      case "/chat":
        openChat(null);
        return true;
      case "/continue":
        if (!canContinue) return fail(new Error("Open a stopped run that has a branch to continue it."));
        return continueRun();
      case "/delete":
        if (!runId) return fail(new Error("Open a run first, or use the × next to it in the sidebar."));
        return deleteRun(runId);
      case "/help":
        setShowHelp(true);
        return true;
      default:
        return fail(new Error(`Unknown command ${cmd}. Type / to see commands.`));
    }
  }

  async function submit(text: string, images: ImageInput[] = []): Promise<boolean> {
    setNotice(null);
    stickToBottom.current = true;
    if (text.startsWith("/") && !images.length) return command(text);
    // After an uncommitted-changes failure, "stash" or "worktree" picks that fix.
    if (dirtyRepo && /\bstash\b/i.test(text)) return retry("stash");
    if (dirtyRepo && /\bwork ?tree\b/i.test(text)) return retry("worktree");
    // "continue", optionally followed by a note for the agents: "continue, I fixed the import myself".
    const cont = canContinue && text.match(/^\s*(continue|resume|go on|carry on)\b[\s.,:;!-]*([\s\S]*)$/i);
    if (cont) return continueRun(runId, [continueNote, cont[2]].filter((t) => t.trim()).join("\n\n"));
    if (active && runId) {
      try {
        await api(`/api/runs/${runId}/message`, { method: "POST", json: { text, images } });
        return true;
      } catch (err) {
        return fail(err);
      }
    }
    return startRun(text, undefined, images);
  }

  // ---------- composer state ----------

  let activity: Activity = { kind: "none" };
  let placeholder = status?.hasClickUp
    ? "Describe a task, or paste a ClickUp link"
    : "Describe a task (ClickUp links work once CLICKUP_API_TOKEN is set)";
  if (!project) placeholder = "Connect your repos first: /new-project";
  if (active && run) {
    if (runStatus === "waiting_input" && derived.lastBranchSeq > derived.lastQuestionSeq) {
      activity = { kind: "waiting", text: "Name the branch for this run" };
      placeholder = "Type a branch name, or ok for the suggested one…";
    } else if (runStatus === "waiting_input") {
      activity = { kind: "waiting", text: "The researcher is waiting for your answer" };
      placeholder = "Type your answer…";
    } else if (runStatus === "waiting_approval") {
      activity = { kind: "waiting", text: "Approve the plan, or type the changes you want" };
      placeholder = "Type the changes you want in the plan, or /approve";
    } else {
      const working = AGENTS.filter((a) => derived.agents[a]?.status === "running");
      activity = {
        kind: "working",
        verb: VERBS[derived.stage ?? run.stage] ?? "Working",
        meta: [duration(now - run.createdAt), `${tokens(derived.tokens)} tokens`, working.join(" + ")].filter(Boolean).join(" · "),
      };
      placeholder = "Steer the agents… (start with @backend or @frontend to target one)";
    }
  }

  const authLine = !status ? (
    <span className="muted">Checking Claude sign-in…</span>
  ) : status.auth.ok ? (
    <span>
      <span className="ok">✓</span> Signed in with {status.auth.mode === "claude-code" ? "your Claude Code login" : "an API key"}
      {status.auth.plan ? ` · ${status.auth.plan}` : ""}
      {status.auth.email ? <span className="muted"> · {status.auth.email}</span> : null}
    </span>
  ) : (
    <div>
      <span className="bad">✗ {status.auth.error}</span>
      <div style={{ marginTop: 8 }}>
        <button className="btn solid" onClick={() => setSigningIn(true)}>
          Sign in with Claude
        </button>
      </div>
    </div>
  );

  return (
    <div className={`app ${page === "chat" ? "no-side" : ""}`}>
      <Sidebar
        status={status}
        projects={projects}
        projectId={projectId}
        runs={runs}
        selectedRunId={runId}
        onPickProject={(id) => {
          setProjectId(id);
          if (page === "chat") openChat(null);
          else selectRun(null);
        }}
        onEditProject={() => setDialog({ project })}
        onNewProject={() => setDialog({ project: null })}
        onNewTask={() => {
          selectRun(null);
          composer.current?.focus();
        }}
        onPickRun={selectRun}
        onDeleteRun={(id) => void deleteRun(id)}
        onDeleteChat={(id) => void deleteChat(id)}
        onSignIn={() => setSigningIn(true)}
        onAgents={() => openPage("agents")}
        onConnections={() => openPage("connections")}
        chats={chats}
        selectedChatId={chatId}
        onChat={openChat}
        page={page}
      />

      {page === "chat" ? (
        <ChatPage
          project={project}
          chatId={chatId}
          onOpen={openChat}
          onChanged={() => void loadChats()}
        />
      ) : (
        <main className="main">
          {status?.demo && (
            <div className="demo-banner" role="status">
              DEMO MODE: runs here are a scripted example that ignores your task and never touches your repos. For real runs
              use Aviator started with <code>npm run dev</code> (port 3210).
            </div>
          )}
          <header className="topbar">
            <span className="title">{page === "agents" ? "Agents" : page === "connections" ? "Connections" : runId ? (run?.title ?? "…") : "New task"}</span>
            {runId && runStatus && <span className={`pill ${runStatus}`}>{STATUS_GLYPH[runStatus].label}</span>}
            {runId && !page && (
              <div className="filters" role="group" aria-label="Filter by agent">
                {(["all", ...AGENTS, ...customActors, "orchestrator"] as Filter[]).map((a) => (
                  <button
                    key={a}
                    className={`chip ${filter === a ? "on" : ""}`}
                    style={a !== "all" ? { color: filter === a ? actorColor(a) : undefined } : filter === a ? { color: "var(--text)" } : undefined}
                    onClick={() => setFilter(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}
          </header>

          <div
            className="transcript"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {showHelp && (
              <div className="card accent" style={{ marginLeft: 0 }}>
                <h3>Commands</h3>
                <table className="help-table">
                  <tbody>
                    {COMMANDS.map((c) => (
                      <tr key={c.cmd}>
                        <td>
                          {c.cmd} <span className="faint">{c.args}</span>
                        </td>
                        <td>{c.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>While a run is going</h3>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  <li>Type to steer every running agent; start with <code>@backend</code> or <code>@frontend</code> to talk to one.</li>
                  <li>When the researcher asks a question, your next message is the answer.</li>
                  <li>When a plan is waiting, your next message is feedback and the planner revises it.</li>
                  <li>Press Esc twice to cancel. Nothing is ever committed or pushed.</li>
                </ul>
                <div className="actions">
                  <button className="btn" onClick={() => setShowHelp(false)}>
                    Close
                  </button>
                </div>
              </div>
            )}

            {page === "connections" ? (
              <ConnectionsPage />
            ) : page === "agents" ? (
              <AgentsPage onSaved={setAgentSettings} />
            ) : !runId ? (
              <>
                <div className="welcome">
                  <h1>
                    <span className="star">✻</span>Welcome to Aviator!
                  </h1>
                  <div className="muted">/help for help · multi-agent coding on top of Claude Code</div>
                  <div style={{ marginTop: 10 }}>{authLine}</div>
                  {project && (
                    <div className="muted">
                      project: <span style={{ color: "var(--text)" }}>{project.name}</span> ·{" "}
                      {project.layout === "monorepo" ? `monorepo ${project.root}` : [project.backendPath, project.frontendPath].filter(Boolean).join(" + ")}
                    </div>
                  )}
                </div>
                <div className="tips">
                  Tips for getting started:
                  <ol>
                    <li>
                      {project ? (
                        <>Repos connected ✓ (edit with <code>/project</code>)</>
                      ) : (
                        <>
                          Connect your repos:{" "}
                          <button className="btn primary" onClick={() => setDialog({ project: null })}>
                            /new-project
                          </button>
                        </>
                      )}
                    </li>
                    <li>
                      Describe a task below, or paste a ClickUp link (<code>/clickup &lt;id&gt;</code>)
                    </li>
                    <li>Watch the researcher, planner, builders and QA think and work. Answer questions and approve the plan.</li>
                    <li>Review the before/after report and the diff, then commit and push yourself.</li>
                  </ol>
                  {status?.demo && (
                    <div className="warn">
                      Demo mode: runs are scripted and never call Claude or touch git. Unset AVIATOR_DEMO for real runs.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Transcript
                events={events}
                filter={filter}
                status={runStatus}
                derived={derived}
                handlers={{
                  onApprove: approve,
                  onBranch: (name) => void submit(name),
                  onRequestChanges: () => {
                    setNotice({ kind: "info", text: "Type the changes you want in the plan and press Enter." });
                    composer.current?.focus();
                  },
                }}
              />
            )}

            {!page && canContinue && run && (
            <div className="card accent">
              <h3>Continue this run</h3>
              <div className="muted">
                Picks up on branch <code>{run.repos[0].branch}</code> where it stopped: finished research and the approved plan are
                reused, builders continue their own sessions, then testing and the report run again.
              </div>
              {limitUntil && (
                <div className="warn" style={{ marginTop: 8 }}>
                  Your plan&apos;s usage limit resets{" "}
                  {new Date(limitUntil).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. Continue
                  works after that.
                </div>
              )}
              <textarea
                className="continue-note"
                value={continueNote}
                onChange={(e) => setContinueNote(e.target.value)}
                rows={3}
                placeholder="Optional: tell the agents what changed since it stopped, e.g. “I fixed the DevPanel import myself, don't redo it” or “also handle empty uploads”."
                aria-label="Note for the agents"
              />
              <div className="actions">
                <button className="btn solid" onClick={() => void continueRun()} disabled={!!limitUntil}>
                  Continue
                </button>
                {limitUntil && (
                  <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={autoContinue === runId}
                      onChange={(e) => setAutoContinue(e.target.checked ? runId : null)}
                    />
                    Continue automatically when it resets (keep this page open)
                  </label>
                )}
              </div>
              <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                You can also type <code>continue</code> below, optionally followed by your note.
              </div>
            </div>
          )}

          {!page && dirtyRepo && (
              <div className="card amber">
                <h3 className="warn">Your repo has uncommitted changes</h3>
                <div className="muted">
                  Aviator gives each run its own branch and won&apos;t mix your unsaved work into it. Pick how to continue;
                  the same task then runs again.
                </div>
                <div className="actions">
                  <button className="btn solid" onClick={() => retry("stash")}>
                    Stash my changes &amp; retry
                  </button>
                  <button className="btn" onClick={() => retry("worktree")}>
                    Use a separate worktree &amp; retry
                  </button>
                  {!status?.remoteDevice && (
                    <>
                      <button className="btn" onClick={() => openFolder(dirtyRepo, "folder")}>
                        Open folder
                      </button>
                      <button className="btn" onClick={() => openFolder(dirtyRepo, "editor")}>
                        Open in VS Code
                      </button>
                    </>
                  )}
                </div>
                <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                  Stash keeps your changes safe in git; <code>git stash pop</code> in that folder brings them back. A worktree
                  leaves your checkout untouched, but the agents may need to install dependencies there. You can also type
                  &quot;stash&quot; or &quot;worktree&quot; below.
                </div>
              </div>
            )}
          </div>

          {notice && (
            <div style={{ padding: "0 24px" }}>
              <div className={notice.kind === "error" ? "errors" : "card"} style={{ margin: "0 0 6px", padding: "6px 12px" }}>
                {notice.text}
                <button className="btn icon" style={{ float: "right", border: 0 }} onClick={() => setNotice(null)} aria-label="Dismiss">
                  ×
                </button>
              </div>
            </div>
          )}

          <Composer
            ref={composer}
            placeholder={placeholder}
            activity={activity}
            cancellable={active}
            disabled={!project && !runId}
            hintRight={[project?.name, agentSettings && `agents: ${PRESETS.find((p) => p.id === matchingPreset(agentSettings.agents))?.name ?? "Custom"}`]
              .filter(Boolean)
              .join(" · ")}
            onSubmit={submit}
            onCancel={cancel}
          />
        </main>
      )}

      {page !== "chat" && (
        <SidePanel
          run={run}
          project={project}
          derived={derived}
          filter={filter}
          onFilter={setFilter}
          onOpen={status?.remoteDevice ? undefined : openFolder}
        />
      )}

      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} onSignedIn={() => void refreshStatus()} />}

      {dialog && (
        <ProjectDialog
          project={dialog.project}
          demo={!!status?.demo}
          browseInPage={!!status?.remoteDevice}
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            setProjects((prev) => [...prev.filter((x) => x.id !== p.id), p]);
            setProjectId(p.id);
            setDialog(null);
          }}
          onDeleted={(id) => {
            setProjects((prev) => prev.filter((x) => x.id !== id));
            setProjectId((cur) => (cur === id ? null : cur));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
