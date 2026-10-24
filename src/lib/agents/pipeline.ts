import path from "node:path";
import { fetchClickUpTask, parseClickUpRef } from "../clickup";
import { diffRepo, DirtyRepoError, prepareRepo, slugify } from "../git";
import {
  emit as emitEvent,
  getPlanUsage,
  registerLive,
  resetTime,
  setPlanUsage,
  takePending,
  unregisterLive,
  type ApprovalDecision,
  type LiveRun,
} from "../runtime";
import { dataDir, emptyAgents, getProject, newId, saveRun, writeRunFile } from "../store";
import type {
  Actor,
  AgentName,
  AgentState,
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
  RunStatus,
  Stage,
  TaskBrief,
} from "../types";
import { briefMarkdown, SCHEMAS } from "./definitions";
import { demoBrief, demoDiff, runDemoAgent } from "./demo";
import { runAgent, type AgentHost, type AgentRequest, type AgentResult } from "./runAgent";

export type StartRunInput = {
  projectId: string;
  source: "prompt" | "clickup";
  text: string;
  /** Shown at the start of the run, e.g. "Stashed your changes in …". */
  notice?: string;
};

const MAX_QA_ATTEMPTS = 3;
const MAX_RELAY_ROUNDS = 3;
const MAX_REPORT_PATCH_CHARS = 200_000;

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
    this.save();
    this.emit("orchestrator", { kind: "stage", stage, label });
  }
  status(status: RunStatus, message?: string) {
    this.run.status = status;
    this.save();
    this.emit("orchestrator", { kind: "status", status, message });
  }
  setAgent(agent: AgentName, patch: Partial<AgentState>) {
    Object.assign(this.run.agents[agent], patch);
    this.save();
    this.emit("orchestrator", { kind: "agent", agent, state: { ...this.run.agents[agent] } });
  }
  addUsage(agent: AgentName, tokens: number, turns: number) {
    this.run.agents[agent].tokens += tokens;
    this.run.agents[agent].turns += turns;
    this.run.tokens += tokens;
    this.save();
    this.emit("orchestrator", { kind: "usage", tokens: this.run.tokens });
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
  agent(req: AgentRequest): Promise<AgentResult> {
    return this.run.demo ? runDemoAgent(this, req) : runAgent(this, req);
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

export function startRun(input: StartRunInput): Run {
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project not found. Set one up with /project first.");
  const now = Date.now();
  // Only included plan usage is used: don't start while the plan limit is reached.
  const usage = getPlanUsage();
  const resets = resetTime(usage);
  if (usage && (usage.status === "rejected" || usage.usingExtraUsage) && (!resets || resets > now)) {
    throw new Error(
      `Your Claude plan's included usage is used up${resets ? ` until ${new Date(resets).toLocaleString()}` : ""}. Aviator doesn't use paid extra usage, so start this after the limit resets.`,
    );
  }
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
  emitEvent(run.id, "user", { kind: "user", text: input.source === "clickup" ? `/clickup ${input.text}` : input.text });
  const live = registerLive(run.id);
  void execute(new RunContext(run, project, live), input).finally(() => unregisterLive(run.id));
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

async function prepareWorkspace(ctx: RunContext): Promise<Workspace> {
  const { project, run } = ctx;
  const branch = `aviator/${slugify(run.brief.clickupId ? `${run.brief.clickupId}-${run.brief.title}` : run.brief.title)}-${run.id.slice(-4)}`;
  const worktree = (role: string) => path.join(dataDir, "worktrees", run.id, role);
  const prepare = async (role: "monorepo" | BuilderName, repoPath: string) =>
    run.demo
      ? { role, originalPath: repoPath, workPath: repoPath, branch, baseCommit: "demo" }
      : prepareRepo({ role, repoPath, branch, isolation: project.isolation, worktreeDir: worktree(role) });

  if (project.layout === "monorepo") {
    if (!project.root) throw new Error("This monorepo project has no repo root set.");
    const repo = await prepare("monorepo", project.root);
    run.repos = [repo];
    ctx.save();
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

  const backend = project.backendPath ? await prepare("backend", project.backendPath) : undefined;
  const frontend = project.frontendPath ? await prepare("frontend", project.frontendPath) : undefined;
  if (!backend && !frontend) throw new Error("This project has no repo paths set.");
  run.repos = [backend, frontend].filter((r) => !!r);
  ctx.save();
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

function builderPrompt(agent: BuilderName, run: Run, plan: PlanOutput, ws: Workspace): string {
  const task = agent === "backend" ? plan.backendTask : plan.frontendTask;
  return [
    `# Your task (${agent})\n${task}`,
    `## Contract shared with the other builder\n${plan.contractMd}`,
    `## Overall plan, for context\n${plan.planMd}`,
    plan.acceptanceCriteria.length ? `## Acceptance criteria\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}` : "",
    `## Checks\n${checksMarkdown(ws)}`,
    `## Original task\n${briefMarkdown(run.brief)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function qaPrompt(run: Run, plan: PlanOutput, ws: Workspace, attempt: number): string {
  return [
    `# QA pass ${attempt} for: ${run.brief.title}`,
    `## Acceptance criteria\n${plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "- (none listed; use the plan)"}`,
    `## Checks to run\n${checksMarkdown(ws)}`,
    `## See the changes\n${run.repos.map((r) => `- \`git -C ${r.workPath} diff ${r.baseCommit}\` and \`git -C ${r.workPath} status\``).join("\n")}`,
    `## Plan\n${plan.planMd}`,
    `## Contract\n${plan.contractMd}`,
    `Builders: ${Object.keys(ws.scopes).join(", ")}. Assign every failure to one of them.`,
  ].join("\n\n");
}

function reportPrompt(run: Run, plan: PlanOutput, research: ResearchOutput, qa: QaOutput | undefined, diff: RepoDiff[]): string {
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
    `## Changed files\n${stat}`,
    patchSection,
  ].join("\n\n");
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
        const result = await ctx.agent({
          ...makeRequest(b),
          prompt: `${messages.join("\n\n")}\n\nHandle these, re-run the relevant checks, then summarize what changed.`,
          resume: sessions[b],
        });
        sessions[b] = result.sessionId ?? sessions[b];
      }),
    );
  }
}

async function execute(ctx: RunContext, input: StartRunInput) {
  const { run, project, live } = ctx;
  try {
    // 1. Intake: ClickUp task or prompt -> task brief
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

    // 2. Branch (or worktree) per repo so the agents' work stays isolated
    ctx.stage("prepare", "Creating a branch");
    const ws = await prepareWorkspace(ctx);
    ctx.say(
      run.repos
        .map((r) => `- Branch \`${r.branch}\` ${r.workPath === r.originalPath ? "in" : "as a worktree of"} \`${r.originalPath}\``)
        .join("\n"),
    );

    // 3. Research (read-only)
    ctx.stage("research", "Researching the codebase");
    const { value: research } = await ctx.structured<ResearchOutput>({
      agent: "researcher",
      prompt: researchPrompt(run, ws),
      cwd: ws.primary,
      additionalDirectories: ws.others,
      schema: SCHEMAS.researcher,
    });
    writeRunFile(run.id, "research.md", research.summary);
    ctx.emit("researcher", { kind: "text", text: `## Research findings\n\n${research.summary}` });

    // 4. Ask the developer when the task is genuinely ambiguous
    if (!research.clear && research.questions.length) {
      ctx.stage("clarify", "Waiting for your answers");
      run.pendingQuestions = research.questions;
      ctx.emit("researcher", { kind: "question", questions: research.questions });
      ctx.status("waiting_input");
      const answer = await waitFor<string>(live, "answer");
      run.pendingQuestions = undefined;
      run.brief.clarifications.push({ questions: research.questions, answer });
      ctx.status("running");
    }

    // 5. Plan + contract, optionally approved by the developer
    ctx.stage("plan", "Planning");
    const planOnce = async (feedback?: string, previous?: PlanOutput) => {
      const { value } = await ctx.structured<PlanOutput>({
        agent: "planner",
        prompt: plannerPrompt(run, research, ws, feedback, previous),
        cwd: ws.primary,
        additionalDirectories: ws.others,
        schema: SCHEMAS.planner,
      });
      run.plan = value;
      ctx.save();
      writeRunFile(run.id, "plan.md", value.planMd);
      writeRunFile(run.id, "contract.md", value.contractMd);
      return value;
    };
    let plan = await planOnce();
    if (project.requirePlanApproval) {
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
    } else {
      ctx.emit("planner", { kind: "text", text: `## Plan\n\n${plan.planMd}\n\n## Contract\n\n${plan.contractMd}` });
    }

    // 6. Build: backend and frontend in parallel, relaying messages between them
    ctx.stage("build", "Building");
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
        cwd: scope.cwd,
        additionalDirectories: scope.additional,
        ownedPaths: scope.owned,
        peer: builders.length === 2 ? (b === "backend" ? "frontend" : "backend") : null,
      };
    };
    const sessions: Partial<Record<BuilderName, string>> = {};
    if (!builders.length) ctx.say("The plan needs no code changes.");
    await Promise.all(
      builders.map(async (b) => {
        const result = await ctx.agent(makeRequest(b));
        sessions[b] = result.sessionId;
        if (result.isError) ctx.emit(b, { kind: "error", message: result.errors.filter(Boolean).join("\n") });
      }),
    );
    await drainRelays(ctx, sessions, makeRequest);

    // 7. QA + review; failures go back to the builder that owns them
    let qa: QaOutput | undefined;
    if (builders.length) {
      for (let attempt = 1; attempt <= MAX_QA_ATTEMPTS; attempt++) {
        ctx.stage("qa", attempt === 1 ? "Testing and reviewing" : `Re-testing (attempt ${attempt} of ${MAX_QA_ATTEMPTS})`);
        ({ value: qa } = await ctx.structured<QaOutput>({
          agent: "qa",
          prompt: qaPrompt(run, plan, ws, attempt),
          cwd: ws.primary,
          additionalDirectories: ws.others,
          schema: SCHEMAS.qa,
        }));
        if (qa.passed || attempt === MAX_QA_ATTEMPTS) break;
        const owners = builders.filter((b) => qa!.failures.some((f) => f.owner === b));
        if (!owners.length) break;
        await Promise.all(
          owners.map(async (b) => {
            const failures = qa!.failures.filter((f) => f.owner === b);
            ctx.emit("qa", { kind: "relay", from: "qa", to: b, text: failures.map((f) => `- ${f.summary}`).join("\n") });
            const result = await ctx.agent({
              ...makeRequest(b),
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
    run.qaPassed = builders.length === 0 || qa?.passed === true;
    ctx.save();

    // 8. Report: before/after, how it works, files, test steps
    ctx.stage("report", "Writing the report");
    const diff = run.demo ? demoDiff(run) : await Promise.all(run.repos.map(diffRepo));
    run.diff = diff;
    ctx.save();
    const { value: report } = await ctx.structured<ReportOutput>({
      agent: "reporter",
      prompt: reportPrompt(run, plan, research, qa, diff),
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
