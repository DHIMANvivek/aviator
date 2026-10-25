// Browser-side helpers shared by the UI components.
import type { AgentName, AgentState, AviatorEvent, PlanUsage, Run, RunStatus, Stage } from "./types";

export type RunSummary = Pick<
  Run,
  "id" | "projectId" | "title" | "status" | "stage" | "createdAt" | "updatedAt" | "tokens" | "demo"
>;

export class ApiError extends Error {
  constructor(
    message: string,
    public errors: string[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors: string[] = Array.isArray(data.errors) ? data.errors : [];
    throw new ApiError(data.error ?? (errors.join("\n") || res.statusText), errors);
  }
  return data as T;
}

export const FINAL: RunStatus[] = ["done", "partial", "failed", "cancelled"];

export const STAGES: { stage: Stage; label: string }[] = [
  { stage: "intake", label: "Read task" },
  { stage: "prepare", label: "Branch" },
  { stage: "research", label: "Research" },
  { stage: "plan", label: "Plan" },
  { stage: "build", label: "Build" },
  { stage: "qa", label: "Test & review" },
  { stage: "report", label: "Report" },
];

/** clarify happens inside research and approval inside plan. */
export function stageIndex(stage?: Stage): number {
  if (!stage) return -1;
  if (stage === "clarify") return 2;
  if (stage === "approval") return 3;
  if (stage === "done") return STAGES.length;
  return STAGES.findIndex((s) => s.stage === stage);
}

export const VERBS: Partial<Record<Stage, string>> = {
  intake: "Reading the task",
  prepare: "Creating a branch",
  research: "Researching",
  plan: "Planning",
  build: "Building",
  qa: "Testing",
  report: "Writing the report",
};

export type Derived = {
  status?: RunStatus;
  stage?: Stage;
  stageLabel?: string;
  tokens: number;
  planUsage?: PlanUsage;
  agents: Record<string, AgentState>;
  lastQuestionSeq: number;
  lastApprovalSeq: number;
  finalMessage?: string;
};

export function derive(events: AviatorEvent[]): Derived {
  const d: Derived = { tokens: 0, agents: {}, lastQuestionSeq: 0, lastApprovalSeq: 0 };
  for (const e of events) {
    switch (e.kind) {
      case "status":
        d.status = e.status;
        if (FINAL.includes(e.status)) d.finalMessage = e.message;
        break;
      case "stage":
        d.stage = e.stage;
        d.stageLabel = e.label;
        break;
      case "usage":
        d.tokens = e.tokens;
        break;
      case "plan_usage":
        d.planUsage = e.usage;
        break;
      case "agent":
        d.agents[e.agent] = e.state;
        break;
      case "question":
        d.lastQuestionSeq = e.seq;
        break;
      case "approval":
        d.lastApprovalSeq = e.seq;
        break;
    }
  }
  return d;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const WINDOW_NAME: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
};

/** One line about the plan's included usage, e.g. "34% of 5-hour limit used · resets 6:00 PM". */
export function planUsageLine(u?: PlanUsage): { text: string; cls: "ok" | "warn" | "bad" } | null {
  if (!u) return null;
  const name = WINDOW_NAME[u.window ?? ""] ?? "plan limit";
  const resetMs = u.resetsAt ? (u.resetsAt < 1e12 ? u.resetsAt * 1000 : u.resetsAt) : undefined;
  const resets = resetMs
    ? new Date(resetMs).toDateString() === new Date().toDateString()
      ? new Date(resetMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : new Date(resetMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
    : "";
  const suffix = resets ? ` · resets ${resets}` : "";
  if (u.usingExtraUsage) return { text: `Plan usage used up; extra usage blocked${suffix}`, cls: "bad" };
  if (u.status === "rejected") return { text: `${name} reached${suffix}`, cls: "bad" };
  const pct = u.utilization === undefined ? undefined : Math.round(u.utilization <= 1 ? u.utilization * 100 : u.utilization);
  return {
    text: pct === undefined ? `Within your ${name}${suffix}` : `${pct}% of ${name} used${suffix}`,
    cls: u.status === "allowed_warning" ? "warn" : "ok",
  };
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATUS_GLYPH: Record<RunStatus, { glyph: string; cls: string; label: string }> = {
  running: { glyph: "●", cls: "running", label: "running" },
  waiting_input: { glyph: "?", cls: "waiting", label: "needs your answer" },
  waiting_approval: { glyph: "?", cls: "waiting", label: "plan needs approval" },
  done: { glyph: "✓", cls: "done", label: "done" },
  partial: { glyph: "◐", cls: "partial", label: "done, checks failing" },
  failed: { glyph: "✗", cls: "failed", label: "failed" },
  cancelled: { glyph: "○", cls: "cancelled", label: "cancelled" },
};

export const AGENT_GLYPH: Record<AgentState["status"], string> = {
  idle: "·",
  running: "●",
  done: "✓",
  error: "✗",
  skipped: "–",
};

/** Built-in agents have their own color; custom agents share a violet one. */
export const actorColor = (actor: string) => `var(--a-${actor}, var(--a-custom))`;

export function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode); the UI works without it
  }
  return null;
}
