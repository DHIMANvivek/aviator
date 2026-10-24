import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../auth";
import { inspectRepo, type RepoInspection } from "../inspectRepo";
import { setPlanUsage } from "../runtime";
import { checkTool } from "./guard";
import { EXTRA_USAGE_STOP } from "./runAgent";

// "Set up with Claude": a short, read-only Claude session that looks at a monorepo and decides
// which folders the frontend and backend builders own and which checks QA should run.

export type ProjectSuggestion = {
  frontendDirs: string[];
  backendDirs: string[];
  frontendChecks: string[];
  backendChecks: string[];
  notes: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    frontendDirs: { type: "array", items: { type: "string" } },
    backendDirs: { type: "array", items: { type: "string" } },
    frontendChecks: { type: "array", items: { type: "string" } },
    backendChecks: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["frontendDirs", "backendDirs", "frontendChecks", "backendChecks", "notes"],
  additionalProperties: false,
};

const ROLE = `
You are setting up Aviator, a multi-agent coding tool, for this monorepo. Aviator has a frontend
builder agent and a backend builder agent; each may only edit the folders it owns. You are
read-only: look, don't change anything.

Decide:
- frontendDirs: folders with user-facing apps (web, admin, mobile) and UI packages they use.
- backendDirs: folders with servers/APIs/workers and packages only they use.
- Shared packages (types, SDKs, config) go to the side that mainly changes them; never list a
  folder on both sides, and never list the repo root itself.
- frontendChecks / backendChecks: fast commands, run from the repo root, that verify each side:
  tests, lint, typecheck. Use the package manager this repo uses and scripts that really exist.
  No dev servers, watchers, long builds, deploys or anything that needs secrets.
- notes: 2-4 short sentences for the developer explaining the split (mention each app by name).

Paths are relative to the repo root with forward slashes. Be quick: package.json files,
workspace config and a glance at each app are enough.`;

function clean(root: string, dirs: unknown): string[] {
  if (!Array.isArray(dirs)) return [];
  return [
    ...new Set(
      dirs
        .map((d) => String(d).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""))
        .filter((d) => d && d !== "." && !d.startsWith("..") && !path.isAbsolute(d) && fs.existsSync(path.join(root, d))),
    ),
  ];
}

function safeChecks(root: string, checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  return checks
    .map((c) => String(c).trim())
    .filter((c) => c && checkTool({ cwd: root, writableRoots: [] }, "Bash", { command: c }).allow);
}

/** Suggestions from folder names and package.json alone, used in demo mode and as Claude's starting point. */
export function heuristicSuggestion(info: RepoInspection): ProjectSuggestion {
  const of = (kind: "frontend" | "backend") => info.candidates.filter((c) => c.kind === kind);
  return {
    frontendDirs: of("frontend").map((c) => c.path),
    backendDirs: of("backend").map((c) => c.path),
    frontendChecks: of("frontend").flatMap((c) => c.checks),
    backendChecks: of("backend").flatMap((c) => c.checks),
    notes: "Suggested from folder names and package.json (demo mode doesn't call Claude).",
  };
}

export async function configureWithClaude(root: string, signal?: AbortSignal): Promise<ProjectSuggestion> {
  const info = inspectRepo(root);
  const abort = new AbortController();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const timer = setTimeout(() => abort.abort(), 150_000);
  const scope = { cwd: root, writableRoots: [] as string[] };
  let structured: unknown;
  let failure = "";

  try {
    const q = query({
      prompt: `Repo root: ${root}\n\nA quick scan found these folders (kind is a guess from names and dependencies):\n${JSON.stringify(
        info.candidates,
        null,
        1,
      )}\n\nVerify and decide the setup.`,
      options: {
        cwd: root,
        tools: ["Read", "Glob", "Grep"],
        systemPrompt: { type: "preset", preset: "claude_code", append: ROLE },
        settingSources: ["project"],
        permissionMode: "default",
        canUseTool: async (name, input) => {
          const d = checkTool(scope, name, input);
          return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (h) => {
                  if (h.hook_event_name !== "PreToolUse") return {};
                  const d = checkTool(scope, h.tool_name, (h.tool_input ?? {}) as Record<string, unknown>);
                  return d.allow
                    ? {}
                    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
                },
              ],
            },
          ],
        },
        outputFormat: { type: "json_schema", schema: SCHEMA },
        effort: "low",
        maxTurns: 15,
        persistSession: false,
        abortController: abort,
        env: agentEnv(),
      },
    });
    for await (const msg of q) {
      if (msg.type === "rate_limit_event") {
        const i = msg.rate_limit_info;
        const usingExtraUsage = !!(i.isUsingOverage || i.overageInUse || i.rateLimitType === "overage");
        setPlanUsage({ status: i.status, window: i.rateLimitType, utilization: i.utilization, resetsAt: i.resetsAt, usingExtraUsage, updatedAt: Date.now() });
        if (usingExtraUsage || i.status === "rejected") {
          failure = usingExtraUsage ? EXTRA_USAGE_STOP : "Your Claude plan's usage limit is reached; try again after it resets.";
          abort.abort();
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) structured = msg.structured_output;
        else failure = msg.subtype === "success" ? msg.result : (msg.errors ?? []).join("; ") || msg.subtype;
      }
    }
  } catch (err) {
    if (!failure) failure = abort.signal.aborted ? "Claude took too long; the folder suggestions are filled in instead." : String((err as Error).message ?? err);
  } finally {
    clearTimeout(timer);
  }

  if (!structured) throw new Error(failure || "Claude didn't return a setup.");
  const s = structured as Record<string, unknown>;
  const backendDirs = clean(root, s.backendDirs);
  return {
    frontendDirs: clean(root, s.frontendDirs).filter((d) => !backendDirs.includes(d)),
    backendDirs,
    frontendChecks: safeChecks(root, s.frontendChecks),
    backendChecks: safeChecks(root, s.backendChecks),
    notes: String(s.notes ?? "").trim(),
  };
}
