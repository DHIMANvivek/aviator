// Per-agent run settings, presets, and custom agents. Pure data, shared by the server and the UI.

import { AGENTS, type AgentName, type Effort } from "./types";
import type { PromptTarget } from "./agents/prompts";

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABEL: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
  max: "max",
};

export type AgentConfig = {
  /** Empty = your Claude plan's default model. */
  model: string;
  effort: Effort;
  maxTurns: number;
  /** Stream the agent's (summarized) thinking into the live view. */
  showThinking: boolean;
};

/** target is a PromptTarget, or "custom:<id>" for a custom agent's prompt. */
export type PromptVersion = { id: string; target: string; at: number; text: string };

// ---------- custom agents ----------

/** Where in the pipeline a "step" agent runs, and what happens with its output. */
export const STEPS = [
  { id: "after-research", label: "After research", hint: "Its notes go to the planner." },
  { id: "after-plan", label: "After planning", hint: "Reviews the plan. Notes appear in the approval card and go to the builders." },
  {
    id: "after-build",
    label: "After building",
    hint: "Reviews the changes before QA. Blocking findings go back to the builder that owns them.",
  },
  { id: "before-report", label: "Before the report", hint: "Its notes go into the final report." },
] as const;
export type StepId = (typeof STEPS)[number]["id"];

/** Built-in tools a custom agent can be given. Writes still only land in the folders it may change. */
export const TOOL_CHOICES: { name: string; label: string }[] = [
  { name: "Read", label: "Read files" },
  { name: "Grep", label: "Search code" },
  { name: "Glob", label: "Find files" },
  { name: "WebSearch", label: "Web search" },
  { name: "WebFetch", label: "Fetch web pages" },
  { name: "Bash", label: "Run commands" },
  { name: "Edit", label: "Edit files" },
  { name: "Write", label: "Create files" },
];

export type WriteAccess = "none" | "frontend" | "backend" | "all";

export const WRITE_ACCESS_LABEL: Record<WriteAccess, string> = {
  none: "Nothing (read-only)",
  frontend: "The frontend folders",
  backend: "The backend folders",
  all: "All project folders",
};

export type Placement = { mode: "step"; step: StepId } | { mode: "on-demand"; helps: AgentName[] };

export type CustomAgent = {
  /** Lowercase id used in logs and by other agents, e.g. "security-reviewer". */
  id: string;
  name: string;
  /** What it's for. On-demand helpers are called when this matches the work. */
  description: string;
  /** Role prompt (template; {{ownedPaths}} works here too). */
  prompt: string;
  config: AgentConfig;
  tools: string[];
  writeAccess: WriteAccess;
  placement: Placement;
  enabled: boolean;
};

export type AgentSettings = {
  agents: Record<AgentName, AgentConfig>;
  /** Only prompts you changed; the rest use the defaults. */
  prompts: Partial<Record<PromptTarget, string>>;
  /** Your own agents, in the order they run within a step. */
  custom: CustomAgent[];
  /** Earlier versions of prompts, newest first. */
  history: PromptVersion[];
};

export const DEFAULT_MAX_TURNS: Record<AgentName, number> = {
  researcher: 60,
  planner: 30,
  backend: 150,
  frontend: 150,
  qa: 60,
  reporter: 30,
};

export type Preset = { id: string; name: string; description: string; effort: Record<AgentName, Effort> };

export const PRESETS: Preset[] = [
  {
    id: "balanced",
    name: "Balanced",
    description: "Think hardest where it matters most: research and planning extra high, coding medium, QA high.",
    effort: { researcher: "xhigh", planner: "xhigh", backend: "medium", frontend: "medium", qa: "high", reporter: "low" },
  },
  {
    id: "save-usage",
    name: "Save usage",
    description: "Uses the least of your plan. Fine for small, clear tasks.",
    effort: { researcher: "medium", planner: "high", backend: "low", frontend: "low", qa: "medium", reporter: "low" },
  },
  {
    id: "max-quality",
    name: "Max quality",
    description: "Every agent thinks as hard as it can. Slower, and uses much more of your plan.",
    effort: { researcher: "xhigh", planner: "max", backend: "xhigh", frontend: "xhigh", qa: "xhigh", reporter: "medium" },
  },
];

export function presetAgents(preset: Preset, base?: Record<AgentName, AgentConfig>): Record<AgentName, AgentConfig> {
  return Object.fromEntries(
    AGENTS.map((a) => [
      a,
      {
        model: base?.[a].model ?? "",
        effort: preset.effort[a],
        maxTurns: base?.[a].maxTurns ?? DEFAULT_MAX_TURNS[a],
        showThinking: base?.[a].showThinking ?? true,
      },
    ]),
  ) as Record<AgentName, AgentConfig>;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agents: presetAgents(PRESETS[0]),
  prompts: {},
  custom: [],
  history: [],
};

/** Which preset the current efforts match, or "custom". Models and turns don't affect it. */
export function matchingPreset(agents: Record<AgentName, AgentConfig>): string {
  return PRESETS.find((p) => AGENTS.every((a) => agents[a].effort === p.effort[a]))?.id ?? "custom";
}

/** Ids that custom agents can't take. */
export const RESERVED_IDS = new Set<string>([...AGENTS, "orchestrator", "user", "aviator", "all"]);

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

const READ_ONLY = ["Read", "Grep", "Glob"];

/** Starting points for custom agents. */
export const CUSTOM_TEMPLATES: Omit<CustomAgent, "id" | "enabled">[] = [
  {
    name: "Security reviewer",
    description: "Reviews the changes for security problems before QA.",
    prompt: `You are a SECURITY REVIEWER. Do not modify files. Review the changes (git diff) for: secrets in code
or logs, missing auth or permission checks, injection (SQL, shell, path, HTML), unsafe file uploads, public
storage, missing input validation or size limits, weak crypto, and dependency risks.
Report each real problem as a finding with the owner (backend or frontend), severity "blocker" for anything
exploitable and "suggestion" otherwise, and the exact file and line. Don't report style issues.`,
    config: { model: "", effort: "high", maxTurns: 40, showThinking: true },
    tools: [...READ_ONLY, "Bash"],
    writeAccess: "none",
    placement: { mode: "step", step: "after-build" },
  },
  {
    name: "Test writer",
    description: "Use when code needs more or better tests: edge cases, error paths, regressions.",
    prompt: `You are a TEST WRITER. Add focused tests for the code you're asked about, following the project's
existing test framework and style. Cover edge cases and error paths, run the tests, and fix the tests (not the
code) until they pass or clearly show a real bug. You may only change files under:
{{ownedPaths}}`,
    config: { model: "", effort: "medium", maxTurns: 60, showThinking: true },
    tools: [...READ_ONLY, "Bash", "Edit", "Write"],
    writeAccess: "all",
    placement: { mode: "on-demand", helps: ["backend", "frontend"] },
  },
  {
    name: "DB migration checker",
    description: "Use when the work adds or changes database schemas or migrations.",
    prompt: `You are a DATABASE MIGRATION CHECKER. Do not modify files. Check new or changed migrations and schema
changes for: data loss, locking on large tables, missing indexes, non-reversible steps, nullable/default
mismatches, and code that reads columns before they exist. Answer with concrete risks and fixes.`,
    config: { model: "", effort: "high", maxTurns: 30, showThinking: true },
    tools: [...READ_ONLY],
    writeAccess: "none",
    placement: { mode: "on-demand", helps: ["backend"] },
  },
  {
    name: "Design reviewer",
    description: "Checks the UI changes against the design and the existing look and feel.",
    prompt: `You are a DESIGN REVIEWER. Do not modify files. Review the frontend changes for consistency with the
existing design system (spacing, colors, typography, components), responsive layout, empty/loading/error
states, and copy that is clear for everyday users. If a screenshot tool is connected, use it to look at the
pages. Report problems as findings with owner "frontend".`,
    config: { model: "", effort: "medium", maxTurns: 40, showThinking: true },
    tools: [...READ_ONLY, "WebFetch"],
    writeAccess: "none",
    placement: { mode: "step", step: "after-build" },
  },
  {
    name: "Accessibility checker",
    description: "Checks UI changes for accessibility (labels, contrast, keyboard use).",
    prompt: `You are an ACCESSIBILITY CHECKER. Do not modify files. Review the frontend changes for: missing labels
and alt text, color contrast, keyboard navigation and focus, semantic HTML/roles, and screen-reader text.
Report problems as findings with owner "frontend" and severity "blocker" for anything that blocks use.`,
    config: { model: "", effort: "medium", maxTurns: 30, showThinking: true },
    tools: [...READ_ONLY],
    writeAccess: "none",
    placement: { mode: "step", step: "after-build" },
  },
  {
    name: "Docs writer",
    description: "Updates README and docs for what changed.",
    prompt: `You are a DOCS WRITER. Update the README and docs affected by this change: setup steps, env vars,
API usage, and screenshots placeholders where useful. Keep the existing tone. Only edit documentation files
under:
{{ownedPaths}}`,
    config: { model: "", effort: "low", maxTurns: 30, showThinking: true },
    tools: [...READ_ONLY, "Edit", "Write"],
    writeAccess: "all",
    placement: { mode: "step", step: "before-report" },
  },
];
