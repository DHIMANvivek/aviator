"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";
import type { ProjectSuggestion } from "@/lib/agents/configure";
import type { RepoCandidate, RepoInspection } from "@/lib/inspectRepo";
import type { Project } from "@/lib/types";
import { FolderBrowser } from "./FolderBrowser";

type FolderKey = "root" | "frontendPath" | "backendPath" | "frontendDirs" | "backendDirs";

const splitDirs = (s: string) =>
  s
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

/** Whether a check command refers to a folder, e.g. `node --test "web/*.test.js"` mentions web. */
const mentions = (line: string, dir: string) =>
  new RegExp(`(^|[\\s"'=/])${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\s|"|'|$)`).test(line);

type Form = {
  name: string;
  layout: "monorepo" | "separate";
  root: string;
  frontendDirs: string;
  backendDirs: string;
  frontendPath: string;
  backendPath: string;
  frontendTests: string;
  backendTests: string;
  isolation: "branch" | "worktree";
  requirePlanApproval: boolean;
};

function toForm(p?: Project | null): Form {
  return {
    name: p?.name ?? "",
    layout: p?.layout ?? "separate",
    root: p?.root ?? "",
    frontendDirs: (p?.frontendDirs ?? []).join(", "),
    backendDirs: (p?.backendDirs ?? []).join(", "),
    frontendPath: p?.frontendPath ?? "",
    backendPath: p?.backendPath ?? "",
    frontendTests: (p?.testCommands.frontend ?? []).join("\n"),
    backendTests: (p?.testCommands.backend ?? []).join("\n"),
    isolation: p?.isolation ?? "branch",
    requirePlanApproval: p?.requirePlanApproval ?? true,
  };
}

export function ProjectDialog({
  project,
  demo,
  browseInPage,
  onClose,
  onSaved,
  onDeleted,
}: {
  project: Project | null;
  demo: boolean;
  /** Pick folders in the page rather than the native dialog, which opens on the computer running Aviator. */
  browseInPage: boolean;
  onClose: () => void;
  onSaved: (p: Project) => void;
  onDeleted: (id: string) => void;
}) {
  const [f, setF] = useState<Form>(() =>
    project || !demo
      ? toForm(project)
      : { ...toForm(null), name: "Demo shop", backendPath: "/demo/shop-api", frontendPath: "/demo/shop-web" },
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const [picking, setPicking] = useState<string | null>(null);
  type Browsing = { key: FolderKey; prompt: string; inside?: string; start?: string };
  const [browsing, setBrowsing] = useState<Browsing | null>(null);
  const [info, setInfo] = useState<RepoInspection | null>(null);
  const [note, setNote] = useState("");
  const inspected = useRef("");
  /** True while a checks box holds Aviator's suggestion rather than something you typed. */
  const autoChecks = useRef({ frontend: false, backend: false });

  type AiState = { state: "idle" | "running" | "done" | "failed"; notes?: string; error?: string; pending?: ProjectSuggestion };
  const [ai, setAi] = useState<AiState>({ state: "idle" });
  const aiRun = useRef<AbortController | null>(null);
  /** Set when you change the folders yourself while Claude works, so its answer won't overwrite yours. */
  const userEdited = useRef(false);
  useEffect(() => () => aiRun.current?.abort(), []);

  function applySuggestion(s: ProjectSuggestion) {
    autoChecks.current = { frontend: false, backend: false };
    setF((prev) => ({
      ...prev,
      frontendDirs: s.frontendDirs.join(", "),
      backendDirs: s.backendDirs.join(", "),
      frontendTests: s.frontendChecks.join("\n"),
      backendTests: s.backendChecks.join("\n"),
    }));
    setNote("");
    setAi({ state: "done", notes: s.notes });
  }

  /** Claude reads the repo (read-only) and picks each agent's folders and checks. */
  async function askClaude(root: string) {
    if (!root.trim()) return;
    aiRun.current?.abort();
    const ctrl = new AbortController();
    aiRun.current = ctrl;
    userEdited.current = false;
    setAi({ state: "running" });
    try {
      const s = await api<ProjectSuggestion>("/api/configure-project", { method: "POST", json: { root: root.trim() }, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (userEdited.current) setAi({ state: "done", notes: s.notes, pending: s });
      else applySuggestion(s);
    } catch (err) {
      if (!ctrl.signal.aborted) setAi({ state: "failed", error: (err as Error).message });
    }
  }

  /**
   * Looks inside the chosen monorepo: suggests its app folders, and drops folders and checks
   * left over from a different repo (e.g. after switching the repo folder).
   */
  const inspect = useCallback(async (root: string, dirs: string[]) => {
    if (!root.trim() || inspected.current === root) return;
    inspected.current = root;
    const res = await api<RepoInspection>("/api/inspect-repo", { method: "POST", json: { root, dirs } }).catch(() => null);
    setInfo(res);
    if (!res?.missing.length) return;
    const gone = res.missing;
    setF((prev) => {
      const keep = (s: string) => splitDirs(s).filter((d) => !gone.includes(d)).join(", ");
      const drop = (s: string) =>
        s
          .split("\n")
          .filter((line) => !gone.some((d) => mentions(line, d)))
          .join("\n");
      return {
        ...prev,
        frontendDirs: keep(prev.frontendDirs),
        backendDirs: keep(prev.backendDirs),
        frontendTests: drop(prev.frontendTests),
        backendTests: drop(prev.backendTests),
      };
    });
    setNote(`Removed ${gone.map((d) => `"${d}"`).join(", ")} and its checks: not in this repo. Pick this repo's folders below.`);
  }, []);

  /** Scan the repo; with `ask`, also have Claude set up the folders when the repo is new to this dialog. */
  const inspectRoot = (root = f.root, ask = false) => {
    const r = root.trim();
    if (f.layout !== "monorepo" || !r) return;
    // Name the project after its folder if you haven't named it yet.
    setF((prev) => (prev.name.trim() ? prev : { ...prev, name: r.split(/[\\/]/).filter(Boolean).pop() ?? "" }));
    const changed = inspected.current !== r;
    void inspect(r, [...splitDirs(f.frontendDirs), ...splitDirs(f.backendDirs)]);
    if (ask && changed) void askClaude(r);
  };

  // On open just scan; switching to monorepo later, picking a repo or typing one asks Claude too.
  const opened = useRef(false);
  useEffect(() => {
    inspectRoot(f.root, opened.current);
    opened.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.layout]);

  // Fill each side's checks from the chosen folders' own scripts, unless you typed your own.
  useEffect(() => {
    if (f.layout !== "monorepo" || !info) return;
    const suggest = (dirs: string) => {
      const chosen = splitDirs(dirs);
      return [...new Set(info.candidates.filter((c) => chosen.includes(c.path)).flatMap((c) => c.checks))].join("\n");
    };
    setF((prev) => {
      const next = { ...prev };
      for (const side of ["frontend", "backend"] as const) {
        const key = side === "frontend" ? "frontendTests" : "backendTests";
        const suggested = suggest(side === "frontend" ? prev.frontendDirs : prev.backendDirs);
        if ((autoChecks.current[side] || !prev[key].trim()) && suggested !== prev[key]) {
          next[key] = suggested;
          autoChecks.current[side] = !!suggested;
        }
      }
      return next;
    });
  }, [f.layout, f.frontendDirs, f.backendDirs, info]);

  function addDir(key: "frontendDirs" | "backendDirs", dir: string) {
    userEdited.current = true;
    setF((prev) => {
      const list = splitDirs(prev[key]);
      return list.includes(dir) ? prev : { ...prev, [key]: [...list, dir].join(", ") };
    });
  }

  function suggestions(side: "frontend" | "backend"): RepoCandidate[] {
    if (!info) return [];
    const taken = new Set([...splitDirs(f.frontendDirs), ...splitDirs(f.backendDirs)]);
    const rank = (c: RepoCandidate) => (c.kind === side ? 0 : c.kind === "shared" ? 1 : 2);
    return info.candidates
      .filter((c) => !taken.has(c.path) && rank(c) < 2)
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }

  /** With `inside`, `chosen` is relative to that repo and joins a comma-separated list. */
  function applyFolder(key: FolderKey, chosen: string, inside?: string) {
    if (key === "root") inspectRoot(chosen, true);
    if (inside) userEdited.current = true;
    setF((prev) => {
      if (inside) {
        const list = prev[key].split(",").map((s) => s.trim()).filter(Boolean);
        return { ...prev, [key]: list.includes(chosen) ? prev[key] : [...list, chosen].join(", ") };
      }
      const folderName = chosen.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return { ...prev, [key]: chosen, name: prev.name.trim() ? prev.name : folderName };
    });
  }

  /**
   * Opens the system folder picker (on the machine running Aviator), or the in-page browser when
   * you're on another device or that machine has no picker. With `inside`, the folder must be
   * within that repo and is added to a comma-separated list as a relative path.
   */
  async function pick(key: FolderKey, prompt: string, inside?: string) {
    setErrors([]);
    const current = inside ? undefined : f[key].trim() || undefined;
    if (browseInPage) {
      setBrowsing({ key, prompt, inside, start: inside ?? current });
      return;
    }
    setPicking(key);
    try {
      const res = await api<{ path?: string; cancelled?: boolean }>("/api/pick-folder", {
        method: "POST",
        json: { prompt, inside, startIn: current },
      });
      if (res.path) applyFolder(key, res.path, inside);
    } catch (err) {
      if (/^Pick a folder inside/.test((err as Error).message)) setErrors([(err as Error).message]);
      else setBrowsing({ key, prompt, inside, start: inside ?? current });
    } finally {
      setPicking(null);
    }
  }

  function browsed(chosen: string) {
    if (!browsing) return;
    const { key, inside } = browsing;
    setBrowsing(null);
    if (!inside) return applyFolder(key, chosen);
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const root = norm(inside);
    const picked = norm(chosen);
    if (picked !== root && !picked.startsWith(`${root}/`)) return setErrors([`Pick a folder inside ${inside}.`]);
    applyFolder(key, picked.slice(root.length + 1) || ".", inside);
  }

  async function save() {
    setSaving(true);
    setErrors([]);
    const body = {
      name: f.name,
      layout: f.layout,
      root: f.root,
      frontendDirs: f.frontendDirs,
      backendDirs: f.backendDirs,
      frontendPath: f.frontendPath,
      backendPath: f.backendPath,
      testCommands: { frontend: f.frontendTests, backend: f.backendTests },
      isolation: f.isolation,
      requirePlanApproval: f.requirePlanApproval,
    };
    try {
      const saved = project
        ? await api<Project>(`/api/projects/${project.id}`, { method: "PUT", json: body })
        : await api<Project>("/api/projects", { method: "POST", json: body });
      onSaved(saved);
    } catch (err) {
      setErrors(err instanceof ApiError && err.errors.length ? err.errors : [String((err as Error).message)]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!project || !confirm(`Remove project "${project.name}" from Aviator? Your repos are not touched.`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    onDeleted(project.id);
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Project settings">
        <h2>{project ? "Edit project" : "Connect a project"}</h2>
        <p className="sub">Point Aviator at your code. Agents only write inside the folders you give each of them.</p>

        {errors.length > 0 && (
          <div className="errors">
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input id="p-name" type="text" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="My Shop" autoFocus />
        </div>

        <div className="field">
          <label>Is this a monorepo?</label>
          <div className="segmented">
            <button className={f.layout === "separate" ? "on" : ""} onClick={() => set("layout", "separate")}>
              No, separate repos
            </button>
            <button className={f.layout === "monorepo" ? "on" : ""} onClick={() => set("layout", "monorepo")}>
              Yes, one monorepo
            </button>
          </div>
          <span className="help">
            {f.layout === "monorepo"
              ? "One repo; the frontend and backend agents are each limited to their folders."
              : "Each builder works only in its own repo; the researcher can read both."}
          </span>
        </div>

        {note && (
          <div className="card" style={{ margin: "0 0 12px", borderColor: "var(--amber)", color: "var(--amber)" }}>
            {note}
          </div>
        )}

        {f.layout === "monorepo" ? (
          <>
            <div className="field">
              <label htmlFor="p-root">Repo folder</label>
              <div className="path-row">
                <input
                  id="p-root"
                  type="text"
                  value={f.root}
                  onChange={(e) => set("root", e.target.value)}
                  onBlur={() => inspectRoot(f.root, true)}
                  placeholder="Choose the monorepo's folder"
                />
                <button className="btn primary" disabled={!!picking} onClick={() => pick("root", "Choose your monorepo folder")}>
                  {picking === "root" ? "Pick in the dialog…" : "Choose folder…"}
                </button>
              </div>
            </div>
            {f.root.trim() && (
              <div className={`ai-box ${ai.state}`} aria-live="polite">
                {ai.state === "running" ? (
                  <>
                    <span className="spin">✻</span> Claude is reading this repo to choose each agent&apos;s folders and checks…{" "}
                    <span className="faint">(read-only, uses a little of your plan)</span>
                  </>
                ) : ai.state === "done" ? (
                  <>
                    <div>
                      <span className="accent-text">✻ Set up by Claude.</span> {ai.notes}
                    </div>
                    <div className="ai-actions">
                      {ai.pending && (
                        <button className="btn solid" onClick={() => applySuggestion(ai.pending!)}>
                          Apply Claude&apos;s setup (you changed folders meanwhile)
                        </button>
                      )}
                      <button className="btn" onClick={() => askClaude(f.root)}>
                        Ask Claude again
                      </button>
                    </div>
                  </>
                ) : ai.state === "failed" ? (
                  <>
                    <span className="bad">Claude couldn&apos;t set this up: {ai.error}</span>{" "}
                    <button className="btn" onClick={() => askClaude(f.root)}>
                      Try again
                    </button>
                  </>
                ) : (
                  <button className="btn primary" onClick={() => askClaude(f.root)}>
                    ✻ Set up folders and checks with Claude
                  </button>
                )}
              </div>
            )}
            <div className="grid2">
              {(
                [
                  ["frontendDirs", "Frontend folders", "apps/web, packages/ui"],
                  ["backendDirs", "Backend folders", "apps/api"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <div className="field" key={key}>
                  <label htmlFor={`p-${key}`}>{label}</label>
                  <input
                    id={`p-${key}`}
                    type="text"
                    value={f[key]}
                    onChange={(e) => {
                      userEdited.current = true;
                      set(key, e.target.value);
                    }}
                    placeholder={placeholder}
                  />
                  {suggestions(key === "frontendDirs" ? "frontend" : "backend").length > 0 && (
                    <div className="suggest">
                      <span className="faint">In this repo:</span>
                      {suggestions(key === "frontendDirs" ? "frontend" : "backend").map((c) => (
                        <button key={c.path} className="chip" onClick={() => addDir(key, c.path)} title={`Add ${c.path}`}>
                          + {c.path}
                          {c.framework && <span className="faint"> · {c.framework}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <div>
                    <button
                      className="btn"
                      disabled={!!picking || !f.root.trim()}
                      title={f.root.trim() ? undefined : "Choose the repo folder first"}
                      onClick={() => pick(key, `Choose a ${label.toLowerCase().replace(" folders", "")} folder inside the repo`, f.root.trim())}
                    >
                      {picking === key ? "Pick in the dialog…" : "+ Other folder…"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="grid2">
            {(
              [
                ["frontendPath", "Frontend repo", "Choose your frontend repo folder"],
                ["backendPath", "Backend repo", "Choose your backend repo folder"],
              ] as const
            ).map(([key, label, prompt]) => (
              <div className="field" key={key}>
                <label htmlFor={`p-${key}`}>{label}</label>
                <input id={`p-${key}`} type="text" value={f[key]} onChange={(e) => set(key, e.target.value)} placeholder="Not set" />
                <div>
                  <button className="btn primary" disabled={!!picking} onClick={() => pick(key, prompt)}>
                    {picking === key ? "Pick in the dialog…" : "Choose folder…"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid2">
          <div className="field">
            <label htmlFor="p-ftests">Frontend checks (one per line)</label>
            <textarea id="p-ftests" value={f.frontendTests} onChange={(e) => {
                autoChecks.current.frontend = false;
                set("frontendTests", e.target.value);
              }} placeholder={"npm test\nnpm run typecheck"} />
          </div>
          <div className="field">
            <label htmlFor="p-btests">Backend checks (one per line)</label>
            <textarea id="p-btests" value={f.backendTests} onChange={(e) => {
                autoChecks.current.backend = false;
                set("backendTests", e.target.value);
              }} placeholder={"npm test\nnpm run lint"} />
          </div>
        </div>
        <span className="help faint" style={{ display: "block", marginTop: -6, marginBottom: 12, fontSize: 11.5 }}>
          Filled in from each chosen folder&apos;s own scripts. Edit freely, or leave empty and QA will find the commands itself.
        </span>

        <div className="field">
          <label>Where agents work</label>
          <div className="segmented">
            <button className={f.isolation === "branch" ? "on" : ""} onClick={() => set("isolation", "branch")}>
              New branch in my checkout
            </button>
            <button className={f.isolation === "worktree" ? "on" : ""} onClick={() => set("isolation", "worktree")}>
              Separate worktree
            </button>
          </div>
          <span className="help">
            {f.isolation === "branch"
              ? "Switches your repo to a new branch (needs no uncommitted changes). Installed dependencies are reused."
              : "Leaves your checkout untouched and allows parallel runs; agents may need to install dependencies."}
          </span>
        </div>

        <div className="field">
          <span className="help">
            Model, effort and prompts are set per agent on the <b>Agents</b> page (sidebar, or type <code>/agents</code>).
          </span>
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={f.requirePlanApproval} onChange={(e) => set("requirePlanApproval", e.target.checked)} />
            Ask me to approve the plan before building
          </label>
          <span className="help">
            Runs use only your Claude plan&apos;s included usage. If Claude switches to paid extra usage, Aviator stops the run.
          </span>
        </div>

        <div className="dialog-actions">
          {project && (
            <button className="btn" style={{ marginRight: "auto", color: "var(--red)" }} onClick={remove}>
              Remove
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" onClick={save} disabled={saving}>
            {saving ? "Checking…" : project ? "Save" : "Connect project"}
          </button>
        </div>
      </div>
      {browsing && (
        <FolderBrowser title={browsing.prompt} start={browsing.start} onPick={browsed} onClose={() => setBrowsing(null)} />
      )}
    </div>
  );
}
