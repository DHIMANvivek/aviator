import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_MAX_TURNS,
  EFFORTS,
  RESERVED_IDS,
  slugify,
  STEPS,
  TOOL_CHOICES,
  type AgentConfig,
  type AgentSettings,
  type CustomAgent,
  type WriteAccess,
} from "./agentPresets";
import { DEFAULT_PROMPTS, type PromptTarget } from "./agents/prompts";
import { dataDir, newId } from "./store";
import { AGENTS, type AgentName, type Effort } from "./types";

// Agent settings live in .aviator/agents.json and apply to every project.

const file = () => path.join(dataDir, "agents.json");
const HISTORY_PER_PROMPT = 25;
const MAX_PROMPT_CHARS = 20_000;
const MAX_CUSTOM_AGENTS = 30;
const TARGETS: PromptTarget[] = ["shared", ...AGENTS];
const WRITE_ACCESS: WriteAccess[] = ["none", "frontend", "backend", "all"];

function sanitizeConfig(value: unknown, fallback: AgentConfig, defaultTurns: number): AgentConfig {
  const v = (value ?? {}) as Partial<AgentConfig>;
  const turns = Math.round(Number(v.maxTurns));
  return {
    model: typeof v.model === "string" ? v.model.trim() : fallback.model,
    effort: EFFORTS.includes(v.effort as Effort) ? (v.effort as Effort) : fallback.effort,
    maxTurns: Number.isFinite(turns) && turns >= 1 && turns <= 500 ? turns : fallback.maxTurns || defaultTurns,
    showThinking: typeof v.showThinking === "boolean" ? v.showThinking : fallback.showThinking,
  };
}

const CUSTOM_FALLBACK: AgentConfig = { model: "", effort: "medium", maxTurns: 40, showThinking: true };

function sanitizeCustom(value: unknown, taken: Set<string>): CustomAgent | null {
  const v = (value ?? {}) as Partial<CustomAgent>;
  const name = String(v.name ?? "").trim().slice(0, 60);
  if (!name) return null;
  let id = slugify(String(v.id || name));
  if (RESERVED_IDS.has(id)) id = `${id}-agent`;
  let unique = id;
  for (let i = 2; taken.has(unique); i++) unique = `${id}-${i}`;
  taken.add(unique);
  const tools = Array.isArray(v.tools) ? v.tools.filter((t) => TOOL_CHOICES.some((c) => c.name === t)) : ["Read", "Grep", "Glob"];
  const stepId = (v.placement as { step?: string } | undefined)?.step;
  const placement: CustomAgent["placement"] =
    v.placement?.mode === "on-demand"
      ? { mode: "on-demand", helps: (v.placement.helps ?? []).filter((a): a is AgentName => AGENTS.includes(a)) }
      : { mode: "step", step: STEPS.find((s) => s.id === stepId)?.id ?? "after-build" };
  return {
    id: unique,
    name,
    description: String(v.description ?? "").trim().slice(0, 500),
    prompt: String(v.prompt ?? "").slice(0, MAX_PROMPT_CHARS).replace(/\r\n/g, "\n"),
    config: sanitizeConfig(v.config, CUSTOM_FALLBACK, CUSTOM_FALLBACK.maxTurns),
    tools,
    writeAccess: WRITE_ACCESS.includes(v.writeAccess as WriteAccess) ? (v.writeAccess as WriteAccess) : "none",
    placement,
    enabled: v.enabled !== false,
  };
}

export function loadAgentSettings(): AgentSettings {
  let raw: Partial<AgentSettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    // no settings saved yet: defaults
  }
  const agents = Object.fromEntries(
    AGENTS.map((a) => [a, sanitizeConfig(raw.agents?.[a], DEFAULT_AGENT_SETTINGS.agents[a], DEFAULT_MAX_TURNS[a])]),
  ) as Record<AgentName, AgentConfig>;
  const prompts: AgentSettings["prompts"] = {};
  for (const t of TARGETS) {
    const p = raw.prompts?.[t];
    if (typeof p === "string") prompts[t] = p;
  }
  const taken = new Set<string>();
  const custom = (Array.isArray(raw.custom) ? raw.custom : [])
    .map((c) => sanitizeCustom(c, taken))
    .filter((c): c is CustomAgent => !!c);
  return { agents, prompts, custom, history: Array.isArray(raw.history) ? raw.history : [] };
}

function write(settings: AgentSettings) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file());
}

export function promptFor(settings: AgentSettings, target: PromptTarget): string {
  return settings.prompts[target] ?? DEFAULT_PROMPTS[target];
}

export type SettingsUpdate = {
  agents?: Partial<Record<AgentName, Partial<AgentConfig>>>;
  /** New text for a prompt, or null to reset it to the default. */
  prompts?: Partial<Record<PromptTarget, string | null>>;
  /** The full list of custom agents, in order (replaces the current list). */
  custom?: unknown[];
};

/** Apply an update. Every prompt change keeps the previous text in history so it can be restored. */
export function updateAgentSettings(update: SettingsUpdate): AgentSettings {
  const current = loadAgentSettings();
  const next: AgentSettings = { ...current, agents: { ...current.agents }, prompts: { ...current.prompts } };
  const remember = (target: string, before: string) => {
    next.history = [{ id: newId("ver"), target, at: Date.now(), text: before }, ...next.history];
  };

  for (const a of AGENTS) {
    if (update.agents?.[a]) {
      next.agents[a] = sanitizeConfig({ ...current.agents[a], ...update.agents[a] }, current.agents[a], DEFAULT_MAX_TURNS[a]);
    }
  }

  for (const t of TARGETS) {
    if (!update.prompts || !(t in update.prompts)) continue;
    const value = update.prompts[t];
    const before = promptFor(current, t);
    if (value === null) delete next.prompts[t];
    else {
      const text = String(value).slice(0, MAX_PROMPT_CHARS).replace(/\r\n/g, "\n");
      if (text.trim() === DEFAULT_PROMPTS[t].trim()) delete next.prompts[t];
      else next.prompts[t] = text;
    }
    if (promptFor(next, t) !== before) remember(t, before);
  }

  if (Array.isArray(update.custom)) {
    const taken = new Set<string>();
    next.custom = update.custom
      .slice(0, MAX_CUSTOM_AGENTS)
      .map((c) => sanitizeCustom(c, taken))
      .filter((c): c is CustomAgent => !!c);
    for (const c of next.custom) {
      const old = current.custom.find((o) => o.id === c.id);
      if (old && old.prompt !== c.prompt) remember(`custom:${c.id}`, old.prompt);
    }
  }

  // Keep the newest versions of each prompt.
  const kept: Record<string, number> = {};
  next.history = next.history.filter((v) => (kept[v.target] = (kept[v.target] ?? 0) + 1) <= HISTORY_PER_PROMPT);

  write(next);
  return next;
}
