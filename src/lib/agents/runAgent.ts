import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  USAGE_TRANSITION_PREFIXES,
  type AgentDefinition,
  type McpServerConfig,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentEnv } from "../auth";
import { deliver, getLive } from "../runtime";
import type { AgentConfig } from "../agentPresets";
import type { Actor, AgentName, AgentState, BuilderName, EventBody, ImageInput, PlanUsage, Project } from "../types";
import { checkTool, type GuardDecision, type GuardScope } from "./guard";

/** What an agent needs from the run it belongs to. */
export type AgentHost = {
  runId: string;
  project: Project;
  abort: AbortController;
  emit: (actor: Actor, body: EventBody) => void;
  setAgent: (agent: string, patch: Partial<AgentState>) => void;
  addUsage: (agent: string, tokens: number, turns: number) => void;
  planUsage: (usage: PlanUsage) => void;
  /** End the whole run with a reason shown to the developer. */
  stop: (reason: string) => void;
};

/** Notices Claude sends when it starts drawing on paid extra usage or credits. */
const PAID_USAGE_NOTICES = USAGE_TRANSITION_PREFIXES.filter((p) => /credits|extra usage/i.test(p));

export const EXTRA_USAGE_STOP =
  "Your plan's included usage ran out and Claude started using paid extra usage, so Aviator stopped the run. Aviator only uses your plan's included usage.";

export type AgentRequest = {
  /** A built-in agent or a custom agent's id. */
  agent: AgentName | (string & {});
  prompt: string;
  /** Screenshots sent along with the prompt. */
  images?: ImageInput[];
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

/** An on-demand custom agent another agent can call, with its own limits. */
export type Helper = { definition: AgentDefinition; scope: GuardScope; check: (tool: string) => GuardDecision };

/** A request with the agent's settings, prompt, tools and permissions, ready to run. */
export type PreparedRequest = AgentRequest & {
  config: AgentConfig;
  system: string;
  /** Built-in Claude Code tools this agent gets. */
  tools: string[];
  /** Your MCP connections this agent may use, and the per-tool permission check. */
  connections?: { servers: Record<string, McpServerConfig>; check: (tool: string) => GuardDecision };
  /** Custom agents it can call on demand, by id. */
  helpers?: Record<string, Helper>;
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

  push(text: string, images?: ImageInput[]): boolean {
    if (this.closed) return false;
    // Screenshots go first as image blocks, then the text that refers to them.
    const content = images?.length
      ? [
          ...images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text" as const, text },
        ]
      : text;
    const message = {
      type: "user",
      message: { role: "user", content },
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
    case "Agent":
      return `${s("subagent_type") || "helper"}: ${s("description")}`;
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
export async function runAgent(host: AgentHost, req: PreparedRequest): Promise<AgentResult> {
  const { agent, cwd, config } = req;
  const scope: GuardScope = { cwd, writableRoots: req.ownedPaths ?? [] };
  const helpers = req.helpers ?? {};
  const input = new InputQueue();
  input.push(req.prompt, req.images);

  const live = getLive(host.runId);
  live?.inboxes.set(agent, (text, images) => input.push(text, images));

  // Your connections, plus Aviator's own server that lets the two builders message each other.
  const mcpServers: Record<string, McpServerConfig> = { ...(req.connections?.servers ?? {}) };
  if (req.peer && (agent === "backend" || agent === "frontend")) {
    mcpServers.aviator = relayServer(host, agent as BuilderName, req.peer);
  }

  /**
   * One permission check for every tool call. `who` is the helper agent making the call, if any,
   * so each custom helper keeps its own folders and tools.
   */
  const decide = (who: string | undefined, toolName: string, toolInput: Record<string, unknown>): GuardDecision => {
    const helper = who ? helpers[who] : undefined;
    if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__aviator__")) {
      const check = helper ? helper.check : req.connections?.check;
      return check ? check(toolName) : { allow: false, reason: `No connections are set up for ${who ?? agent}.` };
    }
    return checkTool(helper ? helper.scope : scope, toolName, toolInput);
  };
  const helperIds = Object.keys(helpers);
  const builtInTools = helperIds.length ? [...req.tools, "Agent"] : req.tools;
  /** Agent-tool calls by id, so a helper's work is shown under the helper's name. */
  const helperOfCall = new Map<string, string>();
  const actorFor = (parentToolUseId: string | null | undefined) =>
    (parentToolUseId && helperOfCall.get(parentToolUseId)) || agent;

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
        // Per-agent settings from the Agents page.
        model: config.model || undefined,
        effort: config.effort,
        thinking: { type: "adaptive", display: config.showThinking ? "summarized" : "omitted" },
        // Claude Code's own prompt, then Aviator's shared rules and this agent's role.
        systemPrompt: { type: "preset", preset: "claude_code", append: req.system },
        // Loads the repo's CLAUDE.md so agents follow the project's own conventions.
        settingSources: ["project"],
        // On Windows, Claude Code may run commands through PowerShell instead of Git Bash.
        tools: process.platform === "win32" && builtInTools.includes("Bash") ? [...builtInTools, "PowerShell"] : builtInTools,
        allowedTools: req.peer ? ["mcp__aviator__message_agent"] : [],
        mcpServers,
        // On-demand custom agents this agent can call through the Agent tool.
        agents: helperIds.length ? Object.fromEntries(helperIds.map((id) => [id, helpers[id].definition])) : undefined,
        forwardSubagentText: helperIds.length > 0,
        permissionMode: "default",
        // The PreToolUse hook below applies each agent's exact limits; this only has to let
        // through what at least one of them (the agent or a helper) may do.
        canUseTool: async (toolName, toolInput) => {
          const decision = [undefined, ...helperIds]
            .map((who) => decide(who, toolName, toolInput))
            .find((d) => d.allow) ?? decide(undefined, toolName, toolInput);
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
                  const who = hookInput.agent_type && helpers[hookInput.agent_type] ? hookInput.agent_type : undefined;
                  const decision = decide(who, hookInput.tool_name, toolInput);
                  if (decision.allow) return {};
                  host.emit(who ?? agent, {
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
        maxTurns: config.maxTurns,
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
        const actor = actorFor(msg.parent_tool_use_id);
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            host.emit(actor, { kind: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking.trim()) {
            host.emit(actor, { kind: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            const helper = block.name === "Agent" ? (block.input as { subagent_type?: string })?.subagent_type : undefined;
            if (helper && helpers[helper]) helperOfCall.set(block.id, helper);
            host.emit(actor, {
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
        const actor = actorFor(msg.parent_tool_use_id);
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          let content = asText(block.content);
          if (content.length > MAX_LOGGED_RESULT) {
            content = `${content.slice(0, MAX_LOGGED_RESULT)}\n… (${content.length - MAX_LOGGED_RESULT} more characters not shown in the log)`;
          }
          host.emit(actor, {
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
