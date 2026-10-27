import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanHostEnv } from "../auth";
import { fetchClickUpTask, parseClickUpRef } from "../clickup";
import { branchProblem, currentBranch, diffRepo, DirtyRepoError, isDirty, prepareRepo, suggestBranch } from "../git";
import {
  emit as emitEvent,
  getPlanUsage,
  history,
  registerLive,
  resetTime,
  setPlanUsage,
  settleRun,
  takePending,
  unregisterLive,
  type ApprovalDecision,
  type LiveRun,
} from "../runtime";
import { dataDir, emptyAgents, getProject, getRun, loadRunImages, newId, readRunFile, saveRun, saveRunImages, writeRunFile } from "../store";
import type {
  Actor,
  AgentName,
  AgentState,
  BaselineCheck,
  BuilderName,
  EventBody,
  PlanOutput,
  PlanUsage,
  Project,
  QaOutput,
  RepoDiff,
  ReportOutput,
  ResearchOutput,
  Run,
  RunRepo,
  RunStatus,
  Stage,
  TaskBrief,
} from "../types";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { STEPS, type AgentSettings, type StepId, type WriteAccess } from "../agentPresets";
import { loadAgentSettings } from "../agentSettings";
import { accessFor, loadConnections } from "../connections";
import type { Connection } from "../connectionTypes";
import { AGENTS, type ImageInput, type StepFinding, type StepOutput } from "../types";
import { AGENT_TOOLS, briefMarkdown, SCHEMAS } from "./definitions";
import { buildCustomSystemPrompt, buildSystemPrompt } from "./prompts";
import { demoBrief, demoDiff, runDemoAgent } from "./demo";
import { runAgent, type AgentHost, type AgentRequest, type AgentResult, type Helper, type PreparedRequest } from "./runAgent";

export type StartRunInput = {
  projectId: string;
  source: "prompt" | "clickup";
  text: string;
  /** Shown at the start of the run, e.g. "Stashed your changes in …". */
  notice?: string;
  /** Screenshots attached in the chat box; the researcher, planner and builders see them. */
  images?: ImageInput[];
  /** Continuing: what you told the agents when you pressed Continue. */
  note?: string;
};

const MAX_QA_ATTEMPTS = 3;
const BASELINE_TIMEOUT_MS = 10 * 60_000;
const MAX_RELAY_ROUNDS = 3;
/**
 * Diffs up to this size go into the reporter's prompt: it can then write the report in a single
 * step, which is cheaper than reading the changed files over several steps.
 */
const MAX_REPORT_PATCH_CHARS = 200_000;
/** Task messages longer than this are shortened in the run log (the agent still gets all of it). */
const MAX_LOGGED_PROMPT = 60_000;

class RunContext implements AgentHost {
  constructor(
    public run: Run,
    public project: Project,
    public live: LiveRun,
  ) {}

  get runId() {
    return this.run.id;
  }
  get abort() {
    return this.live.abort;
  }

  save() {
    saveRun(this.run);
  }
  emit(actor: Actor, body: EventBody) {
    emitEvent(this.run.id, actor, body);
  }
  say(text: string) {
    this.emit("orchestrator", { kind: "text", text });
  }
  stage(stage: Stage, label: string) {
    this.run.stage = stage;
    const furthest = this.run.furthestStage ?? stage;
    if (STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(furthest)) this.run.furthestStage = stage;
    this.save();
    this.emit("orchestrator", { kind: "stage", stage, label });
  }
  status(status: RunStatus, message?: string) {
    this.run.status = status;
    this.save();
    this.emit("orchestrator", { kind: "status", status, message });
  }
  /** Custom agents get an entry the first time they run. */
  private agentState(agent: string): AgentState {
    return (this.run.agents[agent] ??= { status: "idle", tokens: 0, turns: 0 });
  }
  setAgent(agent: string, patch: Partial<AgentState>) {
    Object.assign(this.agentState(agent), patch);
    this.save();
    this.emit("orchestrator", { kind: "agent", agent, state: { ...this.run.agents[agent] } });
  }
  addUsage(agent: string, tokens: number, turns: number, cached = 0) {
    const state = this.agentState(agent);
    state.tokens += tokens;
    state.cachedTokens = (state.cachedTokens ?? 0) + cached;
    state.turns += turns;
    this.run.tokens += tokens;
    this.run.cachedTokens = (this.run.cachedTokens ?? 0) + cached;
    this.save();
    this.emit("orchestrator", { kind: "usage", tokens: this.run.tokens, cached: this.run.cachedTokens });
    this.emit("orchestrator", { kind: "agent", agent, state: { ...this.run.agents[agent] } });
  }
  planUsage(usage: PlanUsage) {
    this.run.planUsage = usage;
    setPlanUsage(usage);
    this.save();
    this.emit("orchestrator", { kind: "plan_usage", usage });
  }
  stop(reason: string) {
    if (this.live.abort.signal.aborted) return;
    this.live.stopReason = reason;
    this.live.abort.abort();
  }
  /** Set once the run has its branch/worktree; custom agents' folders come from it. */
  ws?: Workspace;

  /** The folders a custom agent may change, from its write access setting. */
  ownedFor(access: WriteAccess): string[] {
    const ws = this.ws;
    if (!ws || access === "none") return [];
    const fe = ws.scopes.frontend?.owned ?? [];
    const be = ws.scopes.backend?.owned ?? [];
    if (access === "frontend") return fe;
    if (access === "backend") return be;
    return [...new Set([...fe, ...be, ws.primary, ...ws.others])];
  }

  /** On-demand custom agents a built-in agent can call, each with its own limits and tools. */
  helpersFor(builtin: AgentName, settings: AgentSettings, connections: Connection[], cwd: string): Record<string, Helper> {
    const out: Record<string, Helper> = {};
    for (const c of settings.custom) {
      if (!c.enabled || c.placement.mode !== "on-demand" || !c.placement.helps.includes(builtin)) continue;
      const owned = this.ownedFor(c.writeAccess);
      const access = accessFor(c.id, connections);
      const mcpTools = connections
        .filter((conn) => access.servers[conn.id])
        .flatMap((conn) => {
          const allowed = conn.tools.map((t) => `mcp__${conn.id}__${t.name}`).filter((name) => access.check(name).allow);
          return allowed.length ? allowed : conn.agents.includes(c.id) ? [`mcp__${conn.id}`] : [];
        });
      out[c.id] = {
        definition: {
          description: c.description || c.name,
          prompt: [buildCustomSystemPrompt(c.prompt, c.id, { ownedPaths: owned }, settings.prompts), access.note]
            .filter(Boolean)
            .join("\n\n"),
          tools: [...c.tools, ...mcpTools],
          model: c.config.model || undefined,
          effort: c.config.effort,
          maxTurns: c.config.maxTurns,
          mcpServers: Object.keys(access.servers).length
            ? ([access.servers] as unknown as AgentDefinition["mcpServers"])
            : undefined,
        },
        scope: { cwd, writableRoots: owned },
        check: access.check,
      };
    }
    return out;
  }

  /**
   * Start an agent (built-in or custom) with its current settings, connections and helpers,
   * recording exactly what it was told.
   */
  agent(req: AgentRequest): Promise<AgentResult> {
    const settings = loadAgentSettings();
    const connections = loadConnections();
    const custom = settings.custom.find((c) => c.id === req.agent);
    const builtin = (AGENTS as readonly string[]).includes(req.agent) ? (req.agent as AgentName) : null;
    if (!custom && !builtin) return Promise.reject(new Error(`There's no agent called ${req.agent}.`));

    const config = custom ? custom.config : settings.agents[builtin!];
    const ownedPaths = custom ? this.ownedFor(custom.writeAccess) : req.ownedPaths;
    const access = accessFor(req.agent, connections);
    const helpers = builtin ? this.helpersFor(builtin, settings, connections, req.cwd) : {};
    const helperNote = Object.keys(helpers).length
      ? `## Helper agents you can call with the Agent tool\n${Object.entries(helpers)
          .map(([id, h]) => `- ${id}: ${h.definition.description}`)
          .join("\n")}\nCall one when its description fits the work; it reports back to you.`
      : "";
    const base = custom
      ? buildCustomSystemPrompt(custom.prompt, custom.id, { ownedPaths }, settings.prompts)
      : buildSystemPrompt(builtin!, { ownedPaths, peer: req.peer }, settings.prompts);
    const system = [base, helperNote, access.note].filter(Boolean).join("\n\n");

    let message =
      req.prompt.length > MAX_LOGGED_PROMPT
        ? `${req.prompt.slice(0, MAX_LOGGED_PROMPT)}\n… (${req.prompt.length - MAX_LOGGED_PROMPT} more characters not shown here; the agent received all of it)`
        : req.prompt;
    if (req.images?.length) message += `\n\n[${req.images.length} screenshot(s) attached]`;
    this.emit(req.agent, {
      kind: "prompt",
      agent: req.agent,
      model: config.model,
      effort: config.effort,
      maxTurns: config.maxTurns,
      system,
      message,
      followUp: !!req.resume,
    });

    const prepared: PreparedRequest = {
      ...req,
      ownedPaths,
      config,
      system,
      tools: custom ? custom.tools : AGENT_TOOLS[builtin!],
      connections: { servers: access.servers, check: access.check },
      helpers,
    };
    return this.run.demo ? runDemoAgent(this, prepared) : runAgent(this, prepared);
  }
  async structured<T>(req: AgentRequest): Promise<{ value: T; sessionId?: string }> {
    const result = await this.agent(req);
    if (result.structured === undefined) {
      const why = result.errors.filter(Boolean).join("; ") || "it returned no structured result";
      throw new Error(`The ${req.agent} agent failed: ${why}`);
    }
    return { value: result.structured as T, sessionId: result.sessionId };
  }
}

type BuilderScope = { cwd: string; owned: string[]; additional: string[] };

type Workspace = {
  primary: string;
  others: string[];
  scopes: Partial<Record<BuilderName, BuilderScope>>;
  checks: { label: string; cwd: string; commands: string[] }[];
  description: string;
};

function promptBrief(text: string): TaskBrief {
  const firstLine = text.trim().split("\n")[0].replace(/^#+\s*/, "");
  return {
    source: "prompt",
    title: firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine,
    description: text.trim(),
    acceptanceCriteria: [],
    comments: [],
    attachments: [],
    clarifications: [],
  };
}

/** Only included plan usage is used: don't start anything while the plan limit is reached. */
export function assertPlanUsage(now = Date.now()) {
  const usage = getPlanUsage();
  const resets = resetTime(usage);
  if (usage && (usage.status === "rejected" || usage.usingExtraUsage) && (!resets || resets > now)) {
    throw new Error(
      `Your Claude plan's included usage is used up${resets ? ` until ${new Date(resets).toLocaleString()}` : ""}. Aviator doesn't use paid extra usage, so start this after the limit resets.`,
    );
  }
}

export function startRun(input: StartRunInput): Run {
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project not found. Set one up with /project first.");
  const now = Date.now();
  assertPlanUsage(now);
  const run: Run = {
    id: newId("run"),
    projectId: project.id,
    title: input.source === "clickup" ? `ClickUp ${input.text.trim()}` : promptBrief(input.text).title,
    brief: promptBrief(input.text),
    status: "running",
    stage: "intake",
    createdAt: now,
    updatedAt: now,
    repos: [],
    tokens: 0,
    agents: emptyAgents(),
    input: { source: input.source, text: input.text },
    demo: process.env.AVIATOR_DEMO === "1",
  };
  saveRun(run);
  emitEvent(run.id, "user", {
    kind: "user",
    text: input.source === "clickup" ? `/clickup ${input.text}` : input.text,
    images: input.images?.length ? saveRunImages(run.id, input.images) : undefined,
  });
  const live = registerLive(run.id);
  void execute(new RunContext(run, project, live), input).finally(() => unregisterLive(run.id));
  return run;
}

/** Pipeline stages in order, to tell how far a stopped run got. */
const STAGE_ORDER: Stage[] = ["intake", "prepare", "research", "clarify", "plan", "approval", "build", "qa", "report", "done"];

/**
 * Pick a stopped run back up (e.g. after your plan's usage limit resets) on the same branch:
 * finished research and an approved plan are reused, builders resume their own sessions,
 * and testing and the report run again.
 */
/** Marks a note you add when continuing, inside the task's clarifications. */
export const CONTINUE_NOTE = "Note from the developer when continuing the run";

export function continueRun(runId: string, note?: string): Run {
  const found = getRun(runId);
  if (!found) throw new Error("Run not found.");
  // A run cut off by a restart is stopped too.
  const run = settleRun(found);
  if (!["failed", "cancelled"].includes(run.status)) throw new Error("Only a stopped run can be continued.");
  if (!run.repos.length) throw new Error("This run stopped before it had a branch. Start the task again instead.");
  const project = getProject(run.projectId);
  if (!project) throw new Error("This run's project no longer exists.");
  assertPlanUsage();

  const reached = run.furthestStage ?? run.stage;
  run.error = undefined;
  run.errorCode = undefined;
  run.errorRepo = undefined;
  run.status = "running";
  saveRun(run);
  const trimmed = note?.trim();
  // Your note (e.g. changes you made yourself meanwhile) becomes part of the task, so every
  // agent that runs from here on sees it.
  if (trimmed) run.brief.clarifications.push({ questions: [CONTINUE_NOTE], answer: trimmed });
  saveRun(run);
  emitEvent(run.id, "user", { kind: "user", text: trimmed ? `/continue\n${trimmed}` : "/continue" });
  // Tells open pages the run is live again (they go by the latest status event).
  emitEvent(run.id, "orchestrator", { kind: "status", status: "running" });
  // The first message's screenshots, for agents that start fresh.
  const first = history(run.id).find((e) => e.kind === "user");
  const images = first?.kind === "user" && first.images?.length ? loadRunImages(run.id, first.images) : undefined;
  const live = registerLive(run.id);
  const input: StartRunInput = { projectId: project.id, source: run.input?.source ?? "prompt", text: run.input?.text ?? run.brief.description, images };
  void execute(new RunContext(run, project, live), { ...input, note: trimmed }, reached).finally(() => unregisterLive(run.id));
  return run;
}

function waitFor<T>(live: LiveRun, key: "answer" | "decide"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    live.abort.signal.addEventListener("abort", onAbort, { once: true });
    const done = (value: T) => {
      live.abort.signal.removeEventListener("abort", onAbort);
      live.answer = undefined;
      live.decide = undefined;
      resolve(value);
    };
    if (key === "answer") live.answer = done as (text: string) => void;
    else live.decide = done as (decision: ApprovalDecision) => void;
  });
}

/** The repos a run's branch is created in. */
function projectRepos(project: Project): string[] {
  return project.layout === "monorepo"
    ? [project.root].filter((p): p is string => !!p)
    : [project.backendPath, project.frontendPath].filter((p): p is string => !!p);
}

/** Ask the developer what to call the branch, suggesting a short name, until git accepts it. */
async function chooseBranch(ctx: RunContext): Promise<string> {
  const { run, project, live } = ctx;
  const suggested = suggestBranch(run.brief.title, run.brief.clickupId);
  if (run.demo) return suggested;
  const repos = projectRepos(project);
  // Fail before asking when the checkout can't be switched anyway.
  if (project.isolation === "branch") {
    for (const repo of repos) if (await isDirty(repo).catch(() => false)) throw new DirtyRepoError(repo);
  }
  let problem: string | undefined;
  for (;;) {
    ctx.emit("orchestrator", { kind: "branch", suggested, problem });
    ctx.status("waiting_input");
    const answer = (await waitFor<string>(live, "answer")).trim();
    ctx.status("running");
    // "ok", "yes" or an empty answer takes the suggestion.
    const name = !answer || /^(ok|okay|yes|y|use it|default)$/i.test(answer) ? suggested : answer.replace(/^`|`$/g, "");
    problem = (await branchProblem(name, repos)) ?? undefined;
    if (!problem) return name;
  }
}

async function prepareWorkspace(ctx: RunContext, branch: string): Promise<Workspace> {
  const { project, run } = ctx;
  const worktree = (role: string) => path.join(dataDir, "worktrees", run.id, role);
  const prepare = async (role: "monorepo" | BuilderName, repoPath: string) =>
    run.demo
      ? { role, originalPath: repoPath, workPath: repoPath, branch, baseCommit: "demo" }
      : prepareRepo({ role, repoPath, branch, isolation: project.isolation, worktreeDir: worktree(role) });

  if (project.layout === "monorepo") {
    if (!project.root) throw new Error("This monorepo project has no repo root set.");
    run.repos = [await prepare("monorepo", project.root)];
  } else {
    const backend = project.backendPath ? await prepare("backend", project.backendPath) : undefined;
    const frontend = project.frontendPath ? await prepare("frontend", project.frontendPath) : undefined;
    if (!backend && !frontend) throw new Error("This project has no repo paths set.");
    run.repos = [backend, frontend].filter((r) => !!r);
  }
  ctx.save();
  return workspaceFrom(project, run.repos);
}

/** A continued run works on the branch it already has: check each repo is still on it. */
async function reopenWorkspace(ctx: RunContext): Promise<Workspace> {
  const { project, run } = ctx;
  if (!run.repos.length) throw new Error("This run never got a branch, so there's nothing to continue. Start the task again.");
  for (const repo of run.repos) {
    if (run.demo) continue;
    if (!fs.existsSync(repo.workPath)) throw new Error(`${repo.workPath} no longer exists, so this run can't continue.`);
    const current = await currentBranch(repo.workPath);
    if (current !== repo.branch) {
      throw new Error(
        `${repo.workPath} is on branch "${current}", not this run's branch "${repo.branch}". Switch back with \`git -C "${repo.workPath}" switch ${repo.branch}\`, then continue.`,
      );
    }
  }
  return workspaceFrom(project, run.repos);
}

function workspaceFrom(project: Project, repos: RunRepo[]): Workspace {
  const branch = repos[0].branch;
  if (project.layout === "monorepo") {
    const repo = repos.find((r) => r.role === "monorepo") ?? repos[0];
    const owned = (dirs?: string[]) =>
      dirs && dirs.length ? dirs.map((d) => path.resolve(repo.workPath, d)) : [repo.workPath];
    return {
      primary: repo.workPath,
      others: [],
      scopes: {
        backend: { cwd: repo.workPath, owned: owned(project.backendDirs), additional: [] },
        frontend: { cwd: repo.workPath, owned: owned(project.frontendDirs), additional: [] },
      },
      checks: [
        { label: "backend", cwd: repo.workPath, commands: project.testCommands.backend },
        { label: "frontend", cwd: repo.workPath, commands: project.testCommands.frontend },
      ].filter((c) => c.commands.length),
      description: [
        `Monorepo at ${repo.workPath} (branch ${branch}).`,
        `Backend folders: ${(project.backendDirs ?? []).join(", ") || "(whole repo)"}`,
        `Frontend folders: ${(project.frontendDirs ?? []).join(", ") || "(whole repo)"}`,
      ].join("\n"),
    };
  }

  const backend = repos.find((r) => r.role === "backend");
  const frontend = repos.find((r) => r.role === "frontend");
  const scopes: Workspace["scopes"] = {};
  if (backend) {
    scopes.backend = { cwd: backend.workPath, owned: [backend.workPath], additional: frontend ? [frontend.workPath] : [] };
  }
  if (frontend) {
    scopes.frontend = { cwd: frontend.workPath, owned: [frontend.workPath], additional: backend ? [backend.workPath] : [] };
  }
  const primary = (backend ?? frontend)!.workPath;
  return {
    primary,
    others: [frontend?.workPath, backend?.workPath].filter((p): p is string => !!p && p !== primary),
    scopes,
    checks: [
      backend && { label: "backend", cwd: backend.workPath, commands: project.testCommands.backend },
      frontend && { label: "frontend", cwd: frontend.workPath, commands: project.testCommands.frontend },
    ].filter((c): c is { label: string; cwd: string; commands: string[] } => !!c && c.commands.length > 0),
    description: [
      backend && `Backend repo: ${backend.workPath} (branch ${branch})`,
      frontend && `Frontend repo: ${frontend.workPath} (branch ${branch})`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Research a run already did; runs from before it was saved get it back from research.md. */
function savedResearch(run: Run): ResearchOutput | undefined {
  if (run.research) return { ...run.research };
  const summary = readRunFile(run.id, "research.md");
  if (!summary) return undefined;
  const areas = (["backend", "frontend"] as BuilderName[]).filter((b) =>
    (b === "backend" ? run.plan?.backendTask : run.plan?.frontendTask)?.trim(),
  );
  return { clear: true, questions: [], taskType: "feature", areas, relevantFiles: [], summary };
}

/** Notes you added when continuing the run, for prompts that don't include the whole task. */
function developerNotes(run: Run): string {
  const notes = run.brief.clarifications.filter((c) => c.questions[0] === CONTINUE_NOTE).map((c) => `- ${c.answer}`);
  return notes.length ? `## Notes from the developer (added when continuing)\n${notes.join("\n")}` : "";
}

function checksMarkdown(ws: Workspace): string {
  if (!ws.checks.length) return "No check commands are configured; discover the project's test, typecheck and lint commands.";
  return ws.checks.map((c) => `- ${c.label} (run in ${c.cwd}):\n${c.commands.map((cmd) => `  - \`${cmd}\``).join("\n")}`).join("\n");
}

function researchPrompt(run: Run, ws: Workspace): string {
  return `${briefMarkdown(run.brief)}\n\n## Workspace\n${ws.description}\n\nInvestigate the codebase for this task and return your findings.`;
}

function plannerPrompt(run: Run, research: ResearchOutput, ws: Workspace, feedback?: string, previous?: PlanOutput): string {
  const parts = [
    briefMarkdown(run.brief),
    `## Research findings (task type: ${research.taskType}; areas: ${research.areas.join(", ") || "unknown"})\n${research.summary}`,
    research.relevantFiles.length ? `Relevant files:\n${research.relevantFiles.map((f) => `- ${f}`).join("\n")}` : "",
    `## Workspace\n${ws.description}`,
    `## Configured checks\n${checksMarkdown(ws)}`,
    `Builders available: ${Object.keys(ws.scopes).join(", ")}.`,
  ];
  if (feedback && previous) {
    parts.push(`## Your previous plan\n${previous.planMd}`, `## Developer feedback: revise the plan accordingly\n${feedback}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Run your configured check commands. Aviator runs them itself, so it costs no Claude usage:
 * once on the untouched code (so agents know which failures were already there) and before
 * each QA pass (so QA reviews results instead of running and reading whole test suites).
 */
async function runChecks(ws: Workspace, signal: AbortSignal): Promise<BaselineCheck[]> {
  const results: BaselineCheck[] = [];
  for (const check of ws.checks) {
    for (const command of check.commands) {
      if (signal.aborted) return results;
      const passed = await new Promise<{ ok: boolean; output: string }>((resolve) =>
        exec(
          command,
          // The same environment the agents' own commands get, so results match what they'd see.
          { cwd: check.cwd, timeout: BASELINE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, signal, env: cleanHostEnv() },
          (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }),
        ),
      );
      results.push({ label: check.label, command, passed: passed.ok, output: passed.output.slice(-3000) });
    }
  }
  return results;
}

function baselineMarkdown(run: Run): string {
  const failing = (run.baseline ?? []).filter((c) => !c.passed);
  if (!failing.length) return "";
  return [
    "## Checks that already fail before any change",
    "Aviator ran these on the base commit and they failed there too. Those existing failures aren't yours to fix unless your task asks for it, but any failure in them that isn't in the output below is new, and counts.",
    ...failing.map((c) => `- \`${c.command}\` (${c.label}). Output on the base commit (end):\n\`\`\`\n${c.output.slice(-1500)}\n\`\`\``),
  ].join("\n");
}

function builderPrompt(agent: BuilderName, run: Run, plan: PlanOutput, ws: Workspace): string {
  const task = agent === "backend" ? plan.backendTask : plan.frontendTask;
  return [
    `# Your task (${agent})\n${task}`,
    `## Contract shared with the other builder\n${plan.contractMd}`,
    `## Overall plan, for context\n${plan.planMd}`,
    plan.acceptanceCriteria.length ? `## Acceptance criteria\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}` : "",
    `## Checks\n${checksMarkdown(ws)}\n\nWhile you work, run the ones for your own area (${agent}). Aviator runs all of them itself before QA, so you don't need to run the other builder's.`,
    baselineMarkdown(run),
    `## Original task\n${briefMarkdown(run.brief)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function changesHint(run: Run): string {
  return run.repos.map((r) => `- \`git -C ${r.workPath} diff ${r.baseCommit}\` and \`git -C ${r.workPath} status\``).join("\n");
}

/** Check results Aviator got just now, for QA; failures keep the end of their output. */
function checkResultsMarkdown(run: Run, results: BaselineCheck[]): string {
  const before = new Map((run.baseline ?? []).map((c) => [c.command, c.passed]));
  return [
    "## Check results (Aviator ran these just now; don't run them again)",
    "Re-run a failing one only if you need more of its output to assign or explain the failure.",
    ...results.map((c) =>
      c.passed
        ? `- ✓ \`${c.command}\` (${c.label})`
        : `- ✗ \`${c.command}\` (${c.label})${before.get(c.command) === false ? ", also failed before any change: compare with its base-commit output, only new failures count" : ""}\n\`\`\`\n${c.output}\n\`\`\``,
    ),
  ].join("\n");
}

function qaPrompt(run: Run, plan: PlanOutput, ws: Workspace, attempt: number, reviewNotes = "", results?: BaselineCheck[]): string {
  return [
    `# QA pass ${attempt} for: ${run.brief.title}`,
    `## Acceptance criteria\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "- (none listed; use the plan)"}`,
    results?.length ? checkResultsMarkdown(run, results) : `## Checks to run\n${checksMarkdown(ws)}`,
    `## See the changes\n${changesHint(run)}`,
    `## Plan\n${plan.planMd}`,
    `## Contract\n${plan.contractMd}`,
    reviewNotes ? `## Reviews by custom agents\n${reviewNotes}` : "",
    developerNotes(run),
    baselineMarkdown(run),
    `Builders: ${Object.keys(ws.scopes).join(", ")}. Assign every failure to one of them.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const STEP_LABEL = Object.fromEntries(STEPS.map((s) => [s.id, s.label.toLowerCase()])) as Record<StepId, string>;

/**
 * Run your custom agents placed at one pipeline step, in order. Their notes and findings feed
 * the next stage; a custom agent that fails is reported and skipped, never failing the run.
 */
async function runStepAgents(
  ctx: RunContext,
  step: StepId,
  context: string,
): Promise<{ notes: string; findings: (StepFinding & { from: string })[] }> {
  const ws = ctx.ws!;
  const agents = loadAgentSettings().custom.filter((c) => c.enabled && c.placement.mode === "step" && c.placement.step === step);
  const notes: string[] = [];
  const findings: (StepFinding & { from: string })[] = [];
  for (const c of agents) {
    ctx.say(`Running your custom agent **${c.name}** (${STEP_LABEL[step]}).`);
    try {
      const { value } = await ctx.structured<StepOutput>({
        agent: c.id,
        prompt: `${context}\n\n## Your job at this step (${STEP_LABEL[step]})\n${c.description || c.name}\n\nReturn a short summary and your findings. Use severity "blocker" only for problems that must be fixed before this ships, and owner "backend" or "frontend" for who should fix it ("none" if neither).`,
        cwd: ws.primary,
        additionalDirectories: ws.others,
        schema: SCHEMAS.step,
      });
      const lines = value.findings.map((f) => `- **${f.severity}** (${f.owner}) ${f.summary}${f.details ? `: ${f.details}` : ""}`);
      const note = `### Notes from ${c.name}\n${value.summary}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
      notes.push(note);
      ctx.emit(c.id, { kind: "text", text: note });
      findings.push(...value.findings.map((f) => ({ ...f, from: c.id })));
    } catch (err) {
      if (ctx.abort.signal.aborted) throw err;
      ctx.emit("orchestrator", {
        kind: "error",
        message: `Your custom agent ${c.name} failed (${err instanceof Error ? err.message : String(err)}). Continuing without it.`,
      });
    }
  }
  return { notes: notes.join("\n\n"), findings };
}

function reportPrompt(
  run: Run,
  plan: PlanOutput,
  research: ResearchOutput,
  qa: QaOutput | undefined,
  diff: RepoDiff[],
  reviewNotes = "",
): string {
  const stat = diff
    .map(
      (r) =>
        `### ${r.role} (${r.path}, branch ${r.branch})\n${r.files.map((f) => `- ${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join("\n") || "- no changes"}`,
    )
    .join("\n\n");
  const patches = diff.flatMap((r) => r.files.map((f) => f.patch)).join("\n");
  const patchSection =
    patches.length > MAX_REPORT_PATCH_CHARS
      ? `The full diff is ${patches.length} characters, too large to include. Read the changed files directly.`
      : `## Full diff\n\`\`\`diff\n${patches}\n\`\`\``;
  return [
    briefMarkdown(run.brief),
    `## Research summary\n${research.summary}`,
    `## Plan\n${plan.planMd}`,
    `## Contract\n${plan.contractMd}`,
    `## QA result\n${qa ? JSON.stringify(qa, null, 2) : "QA did not run."}`,
    reviewNotes ? `## Reviews by custom agents (mention what they found)\n${reviewNotes}` : "",
    `## Changed files\n${stat}`,
    patchSection,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Relays that arrived after their receiver finished: resume that builder with them. */
async function drainRelays(
  ctx: RunContext,
  sessions: Partial<Record<BuilderName, string>>,
  makeRequest: (b: BuilderName) => AgentRequest,
) {
  for (let round = 0; round < MAX_RELAY_ROUNDS; round++) {
    const work = (Object.keys(sessions) as BuilderName[])
      .map((b) => ({ b, messages: takePending(ctx.runId, b) }))
      .filter((w) => w.messages.length > 0);
    if (!work.length) return;
    await Promise.all(
      work.map(async ({ b, messages }) => {
        ctx.say(`Delivering ${messages.length} message(s) to the ${b} builder.`);
        const images = messages.flatMap((m) => m.images ?? []);
        const result = await ctx.agent({
          ...makeRequest(b),
          prompt: `${messages.map((m) => m.text).join("\n\n")}\n\nHandle these, re-run the relevant checks, then summarize what changed.`,
          images: images.length ? images : undefined,
          resume: sessions[b],
        });
        sessions[b] = result.sessionId ?? sessions[b];
      }),
    );
  }
}

/** `resumeFrom` is the stage a continued run had reached when it stopped. */
async function execute(ctx: RunContext, input: StartRunInput, resumeFrom?: Stage) {
  const { run, project, live } = ctx;
  const reached = resumeFrom ? STAGE_ORDER.indexOf(resumeFrom) : -1;
  /** True when a continued run already got past this stage. */
  const past = (stage: Stage) => reached > STAGE_ORDER.indexOf(stage);
  /** True when a continued run stopped while waiting at this stage. */
  const stoppedAt = (stage: Stage) => reached === STAGE_ORDER.indexOf(stage);
  try {
    if (resumeFrom) {
      ctx.stage("prepare", "Continuing on the same branch");
      ctx.ws = await reopenWorkspace(ctx);
      ctx.say(`Continuing on ${run.repos.map((r) => `\`${r.branch}\` in \`${r.workPath}\``).join(" and ")}. Work that already finished is reused.`);
    }
    // 1. Intake: ClickUp task or prompt -> task brief
    if (!resumeFrom) {
      ctx.stage("intake", "Reading the task");
      if (input.notice) ctx.say(input.notice);
      if (run.demo) {
        ctx.say(
          "**Demo mode:** what follows is a scripted example (an S3 photo upload). It ignores your task, doesn't call Claude and doesn't touch your repos. Start Aviator with `npm run dev` (port 3210) for real runs.",
        );
      }
      if (input.source === "clickup") {
        const ref = parseClickUpRef(input.text);
        if (!ref) throw new Error(`"${input.text}" doesn't look like a ClickUp task link or ID.`);
        ctx.say(`Fetching ClickUp task \`${ref.id}\`…`);
        run.brief = run.demo ? demoBrief(ref.id) : await fetchClickUpTask(ref);
      }
      run.title = run.brief.title;
      ctx.save();
      ctx.say(
        [
          `**${run.brief.title}**${run.brief.url ? ` · [open in ClickUp](${run.brief.url})` : ""}`,
          run.brief.acceptanceCriteria.length ? `${run.brief.acceptanceCriteria.length} acceptance criteria` : "",
          run.brief.attachments.length ? `${run.brief.attachments.length} attachment(s)` : "",
          run.brief.comments.length ? `${run.brief.comments.length} comment(s)` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );

      // 2. Branch (or worktree) per repo so the agents' work stays isolated; you name it
      ctx.stage("prepare", "Naming the branch");
      const branch = await chooseBranch(ctx);
      ctx.stage("prepare", "Creating a branch");
      ctx.ws = await prepareWorkspace(ctx, branch);
      ctx.say(
        run.repos
          .map((r) => `- Branch \`${r.branch}\` ${r.workPath === r.originalPath ? "in" : "as a worktree of"} \`${r.originalPath}\``)
          .join("\n"),
      );
    }
    const ws = ctx.ws!;
    // Your checks on the untouched code, run alongside research and planning. A continued run
    // keeps the results from before (the code isn't untouched any more).
    const runsBaseline = !run.demo && !resumeFrom && ws.checks.length > 0;
    let baselineDone = !runsBaseline;
    const baseline: Promise<BaselineCheck[] | undefined> = runsBaseline
      ? runChecks(ws, live.abort.signal)
          .catch(() => undefined)
          .finally(() => (baselineDone = true))
      : Promise.resolve(run.baseline);

    // 3. Research (read-only); a continued run that finished it reuses the findings (and asks
    // its questions again if it stopped while waiting for your answers)
    const saved = past("clarify") || (stoppedAt("clarify") && run.research) ? savedResearch(run) : undefined;
    let research: ResearchOutput;
    if (saved) {
      research = saved;
    } else {
      ctx.stage("research", "Researching the codebase");
      ({ value: research } = await ctx.structured<ResearchOutput>({
        agent: "researcher",
        prompt: researchPrompt(run, ws),
        images: input.images,
        cwd: ws.primary,
        additionalDirectories: ws.others,
        schema: SCHEMAS.researcher,
      }));
      run.research = { ...research };
      ctx.save();
      writeRunFile(run.id, "research.md", research.summary);
      ctx.emit("researcher", { kind: "text", text: `## Research findings\n\n${research.summary}` });
    }

    // 4. Ask the developer when the task is genuinely ambiguous
    if ((!saved || stoppedAt("clarify")) && !research.clear && research.questions.length) {
      ctx.stage("clarify", "Waiting for your answers");
      run.pendingQuestions = research.questions;
      ctx.emit("researcher", { kind: "question", questions: research.questions });
      ctx.status("waiting_input");
      const answer = await waitFor<string>(live, "answer");
      run.pendingQuestions = undefined;
      run.brief.clarifications.push({ questions: research.questions, answer });
      ctx.status("running");
    }

    // Your custom agents placed after research: their notes go to the planner.
    const afterResearch = saved ? { notes: "" } : await runStepAgents(
      ctx,
      "after-research",
      [briefMarkdown(run.brief), `## Research findings\n${research.summary}`, `## Workspace\n${ws.description}`].join("\n\n"),
    );
    if (afterResearch.notes) research.summary += `\n\n${afterResearch.notes}`;

    // 5. Plan + contract, optionally approved by the developer. A continued run keeps its plan
    // when it got past approval, or shows it again if it stopped while waiting for approval.
    const approved = past("approval") && !!run.plan;
    const keepPlan = approved || (stoppedAt("approval") && !!run.plan);
    ctx.stage("plan", keepPlan ? "Using the plan from before" : "Planning");
    // Revisions continue the planner's session, so it doesn't explore the code all over again.
    let plannerSession: string | undefined = keepPlan ? run.agents.planner?.sessionId : undefined;
    const planOnce = async (feedback?: string, previous?: PlanOutput) => {
      const revise = !!(feedback && plannerSession);
      const { value, sessionId } = await ctx.structured<PlanOutput>({
        agent: "planner",
        prompt: revise
          ? `## Developer feedback: revise the plan accordingly\n${feedback}\n\nReturn the complete revised plan. You have already explored the code; read more only where the feedback needs it.`
          : plannerPrompt(run, research, ws, feedback, previous),
        images: revise ? undefined : input.images,
        cwd: ws.primary,
        additionalDirectories: ws.others,
        schema: SCHEMAS.planner,
        resume: revise ? plannerSession : undefined,
      });
      plannerSession = sessionId ?? plannerSession;
      // Your custom agents placed after planning review it; their notes become part of the plan.
      const review = await runStepAgents(
        ctx,
        "after-plan",
        [briefMarkdown(run.brief), `## Plan\n${value.planMd}`, `## Contract\n${value.contractMd}`].join("\n\n"),
      );
      if (review.notes) value.planMd += `\n\n## Reviews\n${review.notes}`;
      run.plan = value;
      ctx.save();
      writeRunFile(run.id, "plan.md", value.planMd);
      writeRunFile(run.id, "contract.md", value.contractMd);
      return value;
    };
    let plan = keepPlan ? run.plan! : await planOnce();
    if (!approved && project.requirePlanApproval) {
      for (;;) {
        ctx.stage("approval", "Waiting for plan approval");
        ctx.emit("planner", { kind: "approval", planMd: plan.planMd, contractMd: plan.contractMd });
        ctx.status("waiting_approval");
        const decision = await waitFor<ApprovalDecision>(live, "decide");
        ctx.status("running");
        if (decision.approved) {
          ctx.say("Plan approved. Starting the builders.");
          break;
        }
        ctx.stage("plan", "Revising the plan");
        plan = await planOnce(decision.feedback, plan);
      }
    } else if (!keepPlan) {
      ctx.emit("planner", { kind: "text", text: `## Plan\n\n${plan.planMd}\n\n## Contract\n\n${plan.contractMd}` });
    }

    // 6. Build: backend and frontend in parallel, relaying messages between them. A continued
    // run skips builders that finished and resumes the others' sessions where they stopped.
    const buildDone = past("build");
    if (!baselineDone) ctx.say("Waiting for your checks to finish on the untouched code before building…");
    run.baseline = await baseline;
    ctx.save();
    const alreadyFailing = (run.baseline ?? []).filter((c) => !c.passed);
    if (!resumeFrom && alreadyFailing.length) {
      ctx.say(
        `These checks already fail before any change, so the agents won't treat them as their job:\n${alreadyFailing.map((c) => `- \`${c.command}\``).join("\n")}`,
      );
    }
    ctx.stage("build", buildDone ? "Building (already done)" : "Building");
    const builders = (["backend", "frontend"] as BuilderName[]).filter((b) => {
      const task = b === "backend" ? plan.backendTask : plan.frontendTask;
      return task.trim() && ws.scopes[b];
    });
    for (const b of ["backend", "frontend"] as BuilderName[]) {
      if (!builders.includes(b)) ctx.setAgent(b, { status: "skipped" });
    }
    const makeRequest = (b: BuilderName): AgentRequest => {
      const scope = ws.scopes[b]!;
      return {
        agent: b,
        prompt: builderPrompt(b, run, plan, ws),
        images: input.images,
        cwd: scope.cwd,
        additionalDirectories: scope.additional,
        ownedPaths: scope.owned,
        peer: builders.length === 2 ? (b === "backend" ? "frontend" : "backend") : null,
      };
    };
    const sessions: Partial<Record<BuilderName, string>> = resumeFrom
      ? Object.fromEntries(builders.map((b) => [b, run.agents[b]?.sessionId]).filter(([, id]) => id))
      : {};
    if (!builders.length) ctx.say("The plan needs no code changes.");
    const toBuild = buildDone ? [] : builders.filter((b) => !(resumeFrom && run.agents[b]?.status === "done"));
    await Promise.all(
      toBuild.map(async (b) => {
        const result = await ctx.agent(
          sessions[b]
            ? {
                ...makeRequest(b),
                images: undefined,
                resume: sessions[b],
                prompt: [
                  "You were stopped partway through (for example by the usage limit). Continue your task from where you left off: check `git status` and `git diff` to see what you already changed, finish the rest, run the checks, then summarize.",
                  input.note
                    ? `## Note from the developer\n${input.note}\n\nThey may have changed files themselves while you were stopped; treat the current files as the starting point and don't undo their changes.`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : makeRequest(b),
        );
        sessions[b] = result.sessionId ?? sessions[b];
        if (result.isError) ctx.emit(b, { kind: "error", message: result.errors.filter(Boolean).join("\n") });
      }),
    );
    await drainRelays(ctx, sessions, makeRequest);

    // Your custom agents placed after building review the changes before QA. Blocking findings
    // go back to the builder that owns them (one round), like QA failures.
    let reviewNotes = "";
    if (toBuild.length) {
      const review = await runStepAgents(
        ctx,
        "after-build",
        [briefMarkdown(run.brief), `## Plan\n${plan.planMd}`, `## Contract\n${plan.contractMd}`, `## See the changes\n${changesHint(run)}`].join(
          "\n\n",
        ),
      );
      reviewNotes = review.notes;
      const blockers = review.findings.filter((f) => f.severity === "blocker");
      const owners = builders.filter((b) => blockers.some((f) => f.owner === b));
      await Promise.all(
        owners.map(async (b) => {
          const mine = blockers.filter((f) => f.owner === b);
          for (const from of new Set(mine.map((f) => f.from))) {
            ctx.emit(from, {
              kind: "relay",
              from,
              to: b,
              text: mine.filter((f) => f.from === from).map((f) => `- ${f.summary}`).join("\n"),
            });
          }
          const result = await ctx.agent({
            ...makeRequest(b),
            images: undefined,
            prompt: `Reviewers found problems that must be fixed before this ships. Fix them, re-run the relevant checks, then summarize.\n\n${mine
              .map((f) => `### ${f.summary} (from ${f.from})\n${f.details}`)
              .join("\n\n")}`,
            resume: sessions[b],
          });
          sessions[b] = result.sessionId ?? sessions[b];
        }),
      );
      if (owners.length) await drainRelays(ctx, sessions, makeRequest);
    }

    // 7. QA + review; failures go back to the builder that owns them
    let qa: QaOutput | undefined;
    if (builders.length && !past("qa")) {
      // Re-tests continue QA's session: it already knows the plan and the diff, so it only
      // reviews what the builders changed since its last pass.
      let qaSession: string | undefined;
      for (let attempt = 1; attempt <= MAX_QA_ATTEMPTS; attempt++) {
        ctx.stage("qa", attempt === 1 ? "Testing and reviewing" : `Re-testing (attempt ${attempt} of ${MAX_QA_ATTEMPTS})`);
        if (ws.checks.length && !run.demo) ctx.say("Running your checks…");
        const results = ws.checks.length && !run.demo ? await runChecks(ws, live.abort.signal) : undefined;
        if (results) {
          const failing = results.filter((c) => !c.passed);
          ctx.say(
            failing.length
              ? `${results.length - failing.length} of ${results.length} checks pass. Failing:\n${failing.map((c) => `- \`${c.command}\``).join("\n")}`
              : `All ${results.length} checks pass.`,
          );
        }
        const recheck = !!qaSession;
        const out = await ctx.structured<QaOutput>({
          agent: "qa",
          prompt: recheck
            ? [
                `# QA pass ${attempt}: the builders fixed what you reported`,
                results?.length ? checkResultsMarkdown(run, results) : `## Checks to run\n${checksMarkdown(ws)}`,
                `Review what changed since your last pass (\`git diff\` and \`git status\`), then return the complete result for the whole change, not only the fixes.`,
              ].join("\n\n")
            : qaPrompt(run, plan, ws, attempt, reviewNotes, results),
          cwd: ws.primary,
          additionalDirectories: ws.others,
          schema: SCHEMAS.qa,
          resume: recheck ? qaSession : undefined,
        });
        qa = out.value;
        qaSession = out.sessionId ?? qaSession;
        if (qa.passed || attempt === MAX_QA_ATTEMPTS) break;
        const owners = builders.filter((b) => qa!.failures.some((f) => f.owner === b));
        if (!owners.length) break;
        await Promise.all(
          owners.map(async (b) => {
            const failures = qa!.failures.filter((f) => f.owner === b);
            ctx.emit("qa", { kind: "relay", from: "qa", to: b, text: failures.map((f) => `- ${f.summary}`).join("\n") });
            const result = await ctx.agent({
              ...makeRequest(b),
              images: undefined,
              prompt: `QA found problems in your area. Fix them, re-run the failing checks, then summarize.\n\n${failures
                .map((f) => `### ${f.summary}\n${f.details}`)
                .join("\n\n")}`,
              resume: sessions[b],
            });
            sessions[b] = result.sessionId ?? sessions[b];
          }),
        );
        await drainRelays(ctx, sessions, makeRequest);
      }
    }
    run.qaPassed = builders.length === 0 || (past("qa") ? run.qaPassed === true : qa?.passed === true);
    ctx.save();

    // 8. Report: before/after, how it works, files, test steps
    ctx.stage("report", "Writing the report");
    // Your custom agents placed before the report (e.g. a docs writer) run before the diff is taken.
    const beforeReport = await runStepAgents(
      ctx,
      "before-report",
      [
        briefMarkdown(run.brief),
        `## Plan\n${plan.planMd}`,
        `## QA result\n${qa ? JSON.stringify(qa, null, 2) : "QA did not run."}`,
        `## See the changes\n${changesHint(run)}`,
      ].join("\n\n"),
    );
    reviewNotes = [reviewNotes, beforeReport.notes].filter(Boolean).join("\n\n");
    const diff = run.demo ? demoDiff(run) : await Promise.all(run.repos.map(diffRepo));
    run.diff = diff;
    ctx.save();
    const { value: report } = await ctx.structured<ReportOutput>({
      agent: "reporter",
      prompt: reportPrompt(run, plan, research, qa, diff, reviewNotes),
      cwd: ws.primary,
      additionalDirectories: ws.others,
      schema: SCHEMAS.reporter,
    });
    run.report = report;
    ctx.save();
    writeRunFile(run.id, "report.json", JSON.stringify(report, null, 2));
    ctx.emit("reporter", { kind: "report", report, diff });

    // 9. Done. Nothing committed, nothing pushed.
    ctx.stage("done", "Done");
    const where = run.repos.map((r) => `\`git -C "${r.workPath}" diff\``).join(" and ");
    ctx.status(
      run.qaPassed ? "done" : "partial",
      run.qaPassed
        ? `All checks passed. Nothing was committed or pushed. Review with ${where}.`
        : `Finished with failing checks after ${MAX_QA_ATTEMPTS} QA rounds. Nothing was committed or pushed. Review with ${where}.`,
    );
  } catch (err) {
    for (const agent of Object.keys(run.agents) as AgentName[]) {
      if (run.agents[agent].status === "running") ctx.setAgent(agent, { status: "error", endedAt: Date.now() });
    }
    if (live.abort.signal.aborted && live.stopReason) {
      run.error = live.stopReason;
      const resets = resetTime(run.planUsage);
      ctx.emit("orchestrator", { kind: "error", message: live.stopReason });
      ctx.status(
        "failed",
        `${live.stopReason}${resets ? ` Your limit resets ${new Date(resets).toLocaleString()}.` : ""} Anything the agents already changed is still on the branch.`,
      );
    } else if (live.abort.signal.aborted) {
      ctx.status("cancelled", "Cancelled. Anything the agents already changed is still on the branch.");
    } else {
      run.error = err instanceof Error ? err.message : String(err);
      if (err instanceof DirtyRepoError) {
        run.errorCode = "dirty_repo";
        run.errorRepo = err.repo;
      }
      ctx.emit("orchestrator", { kind: "error", message: run.error });
      ctx.status("failed", run.error);
    }
  }
}
