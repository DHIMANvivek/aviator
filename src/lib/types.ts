// Shared types used by the server pipeline and the browser UI.

export const AGENTS = ["researcher", "planner", "backend", "frontend", "qa", "reporter"] as const;
export type AgentName = (typeof AGENTS)[number];
export type BuilderName = "backend" | "frontend";
/** A built-in agent, a custom agent id, the orchestrator, or you. */
export type Actor = AgentName | "orchestrator" | "user" | (string & {});

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  layout: "monorepo" | "separate";
  /** Monorepo: one repo, agents limited to their folders (relative to root). */
  root?: string;
  frontendDirs?: string[];
  backendDirs?: string[];
  /** Separate repos: each builder works only in its own repo. */
  frontendPath?: string;
  backendPath?: string;
  testCommands: { frontend: string[]; backend: string[] };
  /** "branch" switches the repo to a new branch (needs a clean tree); "worktree" leaves your checkout untouched. */
  isolation: "branch" | "worktree";
  requirePlanApproval: boolean;
};

/** What Claude reports about your plan's included usage (from the SDK's rate-limit events). */
export type PlanUsage = {
  status: "allowed" | "allowed_warning" | "rejected";
  /** Which limit this is about, e.g. five_hour or seven_day. */
  window?: string;
  /** Share of the window used, 0-1 or 0-100 depending on what Claude sends. */
  utilization?: number;
  resetsAt?: number;
  /** True once Claude starts drawing on paid extra usage or credits. */
  usingExtraUsage: boolean;
  updatedAt: number;
};

export type ProjectInput = Omit<Project, "id" | "createdAt">;

export type TaskBrief = {
  source: "clickup" | "prompt";
  clickupId?: string;
  url?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  comments: string[];
  attachments: { name: string; url: string }[];
  clarifications: { questions: string[]; answer: string }[];
};

export type RunStatus =
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "done"
  | "partial"
  | "failed"
  | "cancelled";

export type Stage = "intake" | "prepare" | "research" | "clarify" | "plan" | "approval" | "build" | "qa" | "report" | "done";

export type RunRepo = {
  role: "monorepo" | BuilderName;
  originalPath: string;
  workPath: string;
  branch: string;
  baseCommit: string;
  /**
   * The run started on top of your uncommitted changes; `baseCommit` is a snapshot of them,
   * not a commit on any branch.
   */
  keptChanges?: boolean;
};

export type AgentState = {
  status: "idle" | "running" | "done" | "error" | "skipped";
  sessionId?: string;
  tokens: number;
  /** Of `tokens`, context re-read from the prompt cache on each step (counts far less toward plan limits). */
  cachedTokens?: number;
  turns: number;
  startedAt?: number;
  endedAt?: number;
};

export type ResearchOutput = {
  clear: boolean;
  questions: string[];
  taskType: "feature" | "bug" | "chore";
  areas: BuilderName[];
  relevantFiles: string[];
  summary: string;
};

export type PlanOutput = {
  planMd: string;
  contractMd: string;
  backendTask: string;
  frontendTask: string;
  acceptanceCriteria: string[];
  risks: string[];
};

export type QaOutput = {
  passed: boolean;
  checks: { command: string; passed: boolean; summary: string }[];
  failures: { owner: BuilderName; summary: string; details: string }[];
  reviewNotes: string[];
};

export type ReportOutput = {
  summary: string;
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  beforeAfter: { area: string; before: string; after: string }[];
  howItWorks: string;
  files: { path: string; change: string }[];
  manualTestSteps: string[];
  risks: string[];
};

/** One configured check command run by Aviator itself (no Claude usage). */
export type BaselineCheck = { label: string; command: string; passed: boolean; output: string };

export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
};

export type RepoDiff = { role: RunRepo["role"]; path: string; branch: string; files: DiffFile[] };

export type Run = {
  id: string;
  projectId: string;
  title: string;
  brief: TaskBrief;
  status: RunStatus;
  stage: Stage;
  /** The furthest stage reached, across continues; where a continued run picks up. */
  furthestStage?: Stage;
  createdAt: number;
  updatedAt: number;
  repos: RunRepo[];
  tokens: number;
  cachedTokens?: number;
  planUsage?: PlanUsage;
  /** Built-in agents always; custom agents once they run. */
  agents: Record<string, AgentState>;
  pendingQuestions?: string[];
  /** Kept so a continued run can skip research. */
  research?: ResearchOutput;
  /** Your checks as they ran on the untouched code, before any agent changed it. */
  baseline?: BaselineCheck[];
  plan?: PlanOutput;
  report?: ReportOutput;
  diff?: RepoDiff[];
  qaPassed?: boolean;
  error?: string;
  /** dirty_repo: a repo had uncommitted changes, so the run couldn't get its own branch. */
  errorCode?: "dirty_repo";
  errorRepo?: string;
  /** What you asked for, so the run can be retried. */
  input?: { source: "prompt" | "clickup"; text: string };
  demo?: boolean;
};

export type EventBody =
  | { kind: "stage"; stage: Stage; label: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** Exactly what an agent was given when it started (or a follow-up it received). */
  | {
      kind: "prompt";
      agent: string;
      model: string;
      effort: Effort;
      maxTurns: number;
      system: string;
      message: string;
      followUp: boolean;
    }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown; summary: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string }
  | { kind: "relay"; from: string; to: string; text: string }
  | { kind: "question"; questions: string[] }
  /** Asks you to name the run's branch; `problem` says why the last name didn't work. */
  | { kind: "branch"; suggested: string; problem?: string }
  | { kind: "approval"; planMd: string; contractMd: string }
  | { kind: "status"; status: RunStatus; message?: string }
  | { kind: "agent"; agent: string; state: AgentState }
  | { kind: "usage"; tokens: number; cached?: number }
  | { kind: "plan_usage"; usage: PlanUsage }
  | { kind: "user"; text: string; images?: string[] }
  | { kind: "denied"; tool: string; reason: string }
  | { kind: "error"; message: string }
  | { kind: "report"; report: ReportOutput; diff: RepoDiff[] };

export type AviatorEvent = EventBody & { seq: number; ts: number; runId: string; actor: Actor };

export type AuthStatus = {
  mode: "claude-code" | "api-key";
  ok: boolean;
  plan?: string;
  email?: string;
  source?: string;
  error?: string;
};

export type AppStatus = {
  demo: boolean;
  auth: AuthStatus;
  hasClickUp: boolean;
  /** Last plan usage Claude reported to any agent; unknown until the first run. */
  planUsage?: PlanUsage;
  /** Opened through an Aviator hub (hub/server.mjs) rather than directly. */
  viaHub?: boolean;
  /**
   * The browser is probably not on this computer (the hub saw a different address), so windows
   * Aviator opens here (folder picker, file manager, VS Code) would appear where nobody is looking.
   */
  remoteDevice?: boolean;
};

/** Empty model = whatever Claude Code uses by default for your plan. */
export const MODEL_SUGGESTIONS = ["", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export const ACTIVE_STATUSES: RunStatus[] = ["running", "waiting_input", "waiting_approval"];

/** What a custom agent placed at a pipeline step returns. */
export type StepFinding = {
  owner: BuilderName | "none";
  severity: "blocker" | "suggestion";
  summary: string;
  details: string;
};
export type StepOutput = { summary: string; findings: StepFinding[] };

/** A screenshot or image attached in the chat box, sent to agents as image content. */
export type ImageInput = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; name?: string };

/** Any other file added in the chat box (PDF, text, code…), base64. Saved to disk for Claude to read. */
export type FileInput = { name: string; data: string };

/**
 * A general chat: one Claude Code session in the project's own folders, outside the task
 * pipeline. No branch, no folder limits and no command guard.
 */
export type Chat = {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The Claude Code session each new message resumes. */
  sessionId?: string;
  tokens: number;
  cachedTokens?: number;
  agent: AgentState;
  /** Picked in the composer; each new turn uses the latest. Missing on older chats. */
  options?: ChatOptions;
};

/**
 * "chat" answers and reads the code without changing anything; "code" has Claude Code's full
 * tool set. `userSettings` loads your ~/.claude plugins, MCP servers and settings, which can
 * add a lot to every turn; `memory` loads CLAUDE.md and the project's .claude settings and skills.
 */
export type ChatOptions = {
  mode: "chat" | "code";
  model: string;
  effort: Effort;
  userSettings: boolean;
  webSearch: boolean;
  memory: boolean;
  /** Ids of your connections switched off for this chat. */
  offConnections: string[];
};

export const DEFAULT_CHAT_OPTIONS: ChatOptions = {
  mode: "code",
  model: "",
  effort: "medium",
  userSettings: false,
  webSearch: true,
  memory: true,
  offConnections: [],
};

export type ChatSummary = Pick<Chat, "id" | "projectId" | "title" | "createdAt" | "updatedAt" | "tokens"> & { busy: boolean };

/** The chat's single agent, as it appears in the transcript. */
export const CHAT_AGENT = "claude";
