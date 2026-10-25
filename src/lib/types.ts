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
};

export type AgentState = {
  status: "idle" | "running" | "done" | "error" | "skipped";
  sessionId?: string;
  tokens: number;
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
  createdAt: number;
  updatedAt: number;
  repos: RunRepo[];
  tokens: number;
  planUsage?: PlanUsage;
  /** Built-in agents always; custom agents once they run. */
  agents: Record<string, AgentState>;
  pendingQuestions?: string[];
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
  | { kind: "approval"; planMd: string; contractMd: string }
  | { kind: "status"; status: RunStatus; message?: string }
  | { kind: "agent"; agent: string; state: AgentState }
  | { kind: "usage"; tokens: number }
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
