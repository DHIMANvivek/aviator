import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  USAGE_TRANSITION_PREFIXES,
  type McpServerConfig,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentEnv } from "../auth";
import { deliver, getLive } from "../runtime";
import type { Actor, AgentName, AgentState, BuilderName, EventBody, PlanUsage, Project } from "../types";
import { AGENT_MAX_TURNS, AGENT_TOOLS, rolePrompt } from "./definitions";
import { checkTool, type GuardScope } from "./guard";

/** What an agent needs from the run it belongs to. */
export type AgentHost = {
  runId: string;
  project: Project;
  abort: AbortController;
  emit: (actor: Actor, body: EventBody) => void;
  setAgent: (agent: AgentName, patch: Partial<AgentState>) => void;
  addUsage: (agent: AgentName, tokens: number, turns: number) => void;
  planUsage: (usage: PlanUsage) => void;
  /** End the whole run with a reason shown to the developer. */
  stop: (reason: string) => void;
};

/** Notices Claude sends when it starts drawing on paid extra usage or credits. */
const PAID_USAGE_NOTICES = USAGE_TRANSITION_PREFIXES.filter((p) => /credits|extra usage/i.test(p));

export const EXTRA_USAGE_STOP =
  "Your plan's included usage ran out and Claude started using paid extra usage, so Aviator stopped the run. Aviator only uses your plan's included usage.";

export type AgentRequest = {
  agent: AgentName;
  prompt: string;
  cwd: string;
  additionalDirectories?: string[];
  /** Folders a builder may write to (absolute). */
  ownedPaths?: string[];
  /** The other builder working in parallel, if any; enables the message_agent tool. */
  peer?: BuilderName | null;
  schema?: Record<string, unknown>;
  /** Continue an earlier session of this agent instead of starting fresh. */
  resume?: string;
};

export type AgentResult = {
  sessionId?: string;
  text: string;
  structured?: unknown;
  isError: boolean;
  errors: string[];
};

const MAX_LOGGED_RESULT = 30_000;

/** User messages fed to a running session; stays open so steering and relays can arrive mid-run. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiting?: (result: IteratorResult<SDKUserMessage>) => void;
  closed = false;

  push(text: string): boolean {
    if (this.closed) return false;
    const message = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: message, done: false });
    } else {
      this.buffer.push(message);
    }
    return true;
  }

  get pending() {
    return this.buffer.length;
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
        if (block && typeof block === "object" && "type" in block) return `[${String(block.type)}]`;
        return "";
      })
      .join("\n");
  }
  return value == null ? "" : JSON.stringify(value);
}

export function toolLabel(name: string): string {
  return name.replace(/^mcp__aviator__/, "");
}

/** The short argument shown next to a tool name, e.g. Read(src/app.ts). */
export function summarizeTool(name: string, input: unknown, cwd: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : "");
  const rel = (p: string) => (p && path.isAbsolute(p) ? path.relative(cwd, p) || "." : p);
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return rel(s("file_path"));
    case "NotebookEdit":
      return rel(s("notebook_path"));
    case "Bash":
    case "PowerShell":
      return s("command");
    case "Grep":
      return `"${s("pattern")}"${s("path") ? ` in ${rel(s("path"))}` : ""}`;
    case "Glob":
      return s("pattern");
    case "WebSearch":
      return s("query");
    case "WebFetch":
      return s("url");
    case "TodoWrite":
      return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
    case "mcp__aviator__message_agent":
      return `to ${s("to")}`;
    default:
      return JSON.stringify(input ?? {}).slice(0, 160);
  }
}

function relayServer(host: AgentHost, from: BuilderName, to: BuilderName): McpServerConfig {
  return createSdkMcpServer({
    name: "aviator",
    version: "0.1.0",
    tools: [
      tool(
        "message_agent",
        `Send a message to the ${to} builder working on this task in parallel: contract changes, fields or endpoints you need, or changes you made that affect them. Keep it specific. Delivery is immediate if they are running, otherwise on their next turn.`,
        { to: z.enum([to]), message: z.string().min(1) },
        async ({ message }) => {
          host.emit(from, { kind: "relay", from, to, text: message });
          const result = deliver(host.runId, to, `[Message from the ${from} builder]\n${message}`);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  result === "now"
                    ? `Delivered to the ${to} builder. Continue with your own work.`
                    : `The ${to} builder is not running right now; Aviator will deliver this on its next turn. Continue with your own work.`,
              },
            ],
          };
        },
      ),
    ],
  });
}

/**
 * Run one agent as a Claude Agent SDK session and stream everything it does to the run's
 * event log. The session takes streaming input, so the developer's steering messages and the
 * other builder's relays are delivered while it works.
 */
export async function runAgent(host: AgentHost, req: AgentRequest): Promise<AgentResult> {
  const { agent, cwd } = req;
  const { project } = host;
  const scope: GuardScope = { cwd, writableRoots: req.ownedPaths ?? [] };
  const input = new InputQueue();
  input.push(req.prompt);

  const live = getLive(host.runId);
  live?.inboxes.set(agent, (text) => input.push(text));

  const mcpServers: Record<string, McpServerConfig> = {};
  if (req.peer && (agent === "backend" || agent === "frontend")) {
    mcpServers.aviator = relayServer(host, agent, req.peer);
  }

  let stderrTail = "";
  let sessionId = req.resume;
  let text = "";
  let structured: unknown;
  let isError = false;
  const errors: string[] = [];
  let lastTokens = 0;
  let lastTurns = 0;
  const toolNames = new Map<string, string>();

  host.setAgent(agent, { status: "running", startedAt: Date.now(), endedAt: undefined });

  try {
    const q = query({
      prompt: input,
      options: {
        cwd,
        additionalDirectories: req.additionalDirectories,
        model: project.model || undefined,
        effort: project.effort,
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: rolePrompt(agent, { ownedPaths: req.ownedPaths, peer: req.peer }),
        },
        // Loads the repo's CLAUDE.md so agents follow the project's own conventions.
        settingSources: ["project"],
        // On Windows, Claude Code may run commands through PowerShell instead of Git Bash.
        tools:
          process.platform === "win32" && AGENT_TOOLS[agent].includes("Bash")
            ? [...AGENT_TOOLS[agent], "PowerShell"]
            : AGENT_TOOLS[agent],
        allowedTools: req.peer ? ["mcp__aviator__message_agent"] : [],
        mcpServers,
        permissionMode: "default",
        canUseTool: async (toolName, toolInput) => {
          const decision = checkTool(scope, toolName, toolInput);
          return decision.allow
            ? { behavior: "allow", updatedInput: toolInput }
            : { behavior: "deny", message: decision.reason };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== "PreToolUse") return {};
                  const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  const decision = checkTool(scope, hookInput.tool_name, toolInput);
                  if (decision.allow) return {};
                  host.emit(agent, {
                    kind: "denied",
                    tool: `${toolLabel(hookInput.tool_name)}(${summarizeTool(hookInput.tool_name, toolInput, cwd)})`,
                    reason: decision.reason,
                  });
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: decision.reason,
                    },
                  };
                },
              ],
            },
          ],
        },
        outputFormat: req.schema ? { type: "json_schema", schema: req.schema } : undefined,
        maxTurns: AGENT_MAX_TURNS[agent],
        resume: req.resume,
        abortController: host.abort,
        // Runs on your Claude Code login by default; see lib/auth.ts.
        env: agentEnv(),
        stderr: (data) => {
          stderrTail = (stderrTail + data).slice(-4000);
        },
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        host.setAgent(agent, { sessionId });
        continue;
      }

      // Plan usage: show it, and never let a run continue on paid extra usage.
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        const usage: PlanUsage = {
          status: info.status,
          window: info.rateLimitType,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
          usingExtraUsage: !!(info.isUsingOverage || info.overageInUse || info.rateLimitType === "overage"),
          updatedAt: Date.now(),
        };
        host.planUsage(usage);
        if (usage.usingExtraUsage) host.stop(EXTRA_USAGE_STOP);
        else if (usage.status === "rejected") {
          host.stop("Your Claude plan's usage limit is reached. Start the task again after it resets.");
        }
        continue;
      }
      if (msg.type === "system" && (msg.subtype === "informational" || msg.subtype === "notification")) {
        const notice = msg.subtype === "informational" ? msg.content : msg.text;
        if (PAID_USAGE_NOTICES.some((p) => notice.startsWith(p))) host.stop(EXTRA_USAGE_STOP);
        continue;
      }

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            host.emit(agent, { kind: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking.trim()) {
            host.emit(agent, { kind: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            host.emit(agent, {
              kind: "tool_use",
              toolUseId: block.id,
              name: toolLabel(block.name),
              input: block.input,
              summary: summarizeTool(block.name, block.input, cwd),
            });
          }
        }
        continue;
      }

      if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          let content = asText(block.content);
          if (content.length > MAX_LOGGED_RESULT) {
            content = `${content.slice(0, MAX_LOGGED_RESULT)}\n… (${content.length - MAX_LOGGED_RESULT} more characters not shown in the log)`;
          }
          host.emit(agent, {
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            content,
          });
        }
        continue;
      }

      if (msg.type === "result") {
        // Token and turn counts are cumulative for the session; record the increase.
        const u = msg.usage;
        const total = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
        const tokens = Math.max(0, total - lastTokens);
        const turns = Math.max(0, msg.num_turns - lastTurns);
        lastTokens = total;
        lastTurns = msg.num_turns;
        host.addUsage(agent, tokens, turns);

        if (msg.subtype === "success") {
          text = msg.result;
          if (msg.structured_output !== undefined) structured = msg.structured_output;
          isError = msg.is_error;
          if (msg.is_error) errors.push(msg.result);
        } else {
          isError = true;
          errors.push(msg.subtype, ...(msg.errors ?? []));
        }
        // Keep the session open while steering or relay messages are waiting.
        if (input.pending === 0) input.close();
      }
    }
  } catch (err) {
    if (host.abort.signal.aborted) throw err;
    isError = true;
    errors.push(err instanceof Error ? err.message : String(err));
    if (stderrTail.trim()) errors.push(stderrTail.trim());
  } finally {
    input.close();
    live?.inboxes.delete(agent);
  }

  if (structured === undefined && req.schema && text) {
    try {
      structured = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      // handled by the caller
    }
  }

  host.setAgent(agent, { status: isError ? "error" : "done", endedAt: Date.now(), sessionId });
  return { sessionId, text, structured, isError, errors };
}
