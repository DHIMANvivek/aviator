import { loadConnections, sdkConfig } from "../connections";
import { emit, getLive, registerLive, setPlanUsage, takePending, unregisterLive, type LiveRun } from "../runtime";
import { getChat, getProject, newId, saveChat, saveRunImages } from "../store";
import { CHAT_AGENT, DEFAULT_CHAT_OPTIONS, type Chat, type ChatOptions, type ImageInput, type Project } from "../types";
import type { Connection } from "../connectionTypes";
import { EFFORTS } from "../agentPresets";
import { assertPlanUsage } from "./pipeline";
import { runAgent, type AgentHost } from "./runAgent";

// General chat: you talk to one Claude Code session that works directly in the project's
// folders, like running `claude` there yourself. Unlike task runs there is no branch, no
// folder limits and no command guard. Each message resumes the same session; messages sent
// while it is working are delivered into the running turn.

/** Chat mode: Claude can read and search the code and the web but not change anything. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];

/** Options sent while a chat is working; its next turn picks them up. */
const nextOptions = new Map<string, ChatOptions>();

/** Keeps what the composer sent when it's valid, else the chat's current options. */
export function checkChatOptions(raw: unknown, fallback: ChatOptions = DEFAULT_CHAT_OPTIONS): ChatOptions {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ChatOptions, unknown>>;
  const flag = (k: "userSettings" | "webSearch" | "memory") => (typeof v[k] === "boolean" ? (v[k] as boolean) : (fallback[k] ?? DEFAULT_CHAT_OPTIONS[k]));
  const off = Array.isArray(v.offConnections) ? v.offConnections.filter((c): c is string => typeof c === "string").slice(0, 100) : undefined;
  return {
    mode: v.mode === "chat" || v.mode === "code" ? v.mode : fallback.mode,
    model: typeof v.model === "string" && v.model.length <= 100 ? v.model : fallback.model,
    effort: EFFORTS.includes(v.effort as ChatOptions["effort"]) ? (v.effort as ChatOptions["effort"]) : fallback.effort,
    userSettings: flag("userSettings"),
    webSearch: flag("webSearch"),
    memory: flag("memory"),
    offConnections: off ?? fallback.offConnections ?? [],
  };
}

/** Which Claude Code settings a chat loads: your ~/.claude ones, and the project's (CLAUDE.md, .claude/). */
export function chatSettingSources(options: ChatOptions): ("user" | "project" | "local")[] {
  return [...(options.userSettings ? ["user" as const] : []), ...(options.memory ? ["project" as const, "local" as const] : [])];
}

export function folders(project: Project): { cwd: string; others: string[] } {
  if (project.layout === "monorepo") {
    if (!project.root) throw new Error("This project has no repo folder set.");
    return { cwd: project.root, others: [] };
  }
  const all = [project.backendPath, project.frontendPath].filter((p): p is string => !!p);
  if (!all.length) throw new Error("This project has no repo folders set.");
  return { cwd: all[0], others: all.slice(1) };
}

function systemNote(project: Project, cwd: string, others: string[], connections: Connection[]): string {
  const where =
    project.layout === "monorepo"
      ? [
          `- Monorepo: ${cwd}`,
          project.frontendDirs?.length ? `  - frontend folders: ${project.frontendDirs.join(", ")}` : "",
          project.backendDirs?.length ? `  - backend folders: ${project.backendDirs.join(", ")}` : "",
        ]
      : [
          project.backendPath ? `- Backend repo: ${project.backendPath}` : "",
          project.frontendPath ? `- Frontend repo: ${project.frontendPath}` : "",
        ];
  return [
    `# Aviator general chat · project "${project.name}"`,
    "The developer is chatting with you directly, as in the Claude Code CLI. This is not Aviator's task pipeline: work in the folders below as they are (no separate branch), answer questions about the code, and do what they ask.",
    "## Project folders",
    ...where.filter(Boolean),
    others.length ? `You start in ${cwd}; the other folders are added as working directories.` : "",
    connections.length ? `## Connected tools\n${connections.map((c) => `- ${c.name}: tools named mcp__${c.id}__*`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function host(chat: Chat, project: Project, live: LiveRun): AgentHost {
  return {
    runId: chat.id,
    project,
    abort: live.abort,
    emit: (actor, body) => void emit(chat.id, actor, body),
    setAgent: (_agent, patch) => {
      Object.assign(chat.agent, patch);
      saveChat(chat);
      emit(chat.id, "orchestrator", { kind: "agent", agent: CHAT_AGENT, state: { ...chat.agent } });
    },
    addUsage: (_agent, tokens, turns, cached = 0) => {
      chat.agent.tokens += tokens;
      chat.agent.cachedTokens = (chat.agent.cachedTokens ?? 0) + cached;
      chat.agent.turns += turns;
      chat.tokens += tokens;
      chat.cachedTokens = (chat.cachedTokens ?? 0) + cached;
      saveChat(chat);
      emit(chat.id, "orchestrator", { kind: "usage", tokens: chat.tokens, cached: chat.cachedTokens });
    },
    planUsage: (usage) => {
      setPlanUsage(usage);
      emit(chat.id, "orchestrator", { kind: "plan_usage", usage });
    },
    stop: (reason) => {
      if (live.abort.signal.aborted) return;
      live.stopReason = reason;
      live.abort.abort();
    },
  };
}

/** Run turns until no messages are waiting, then let the chat go idle. */
async function converse(chat: Chat, project: Project, text: string, images?: ImageInput[]) {
  const live = registerLive(chat.id);
  const h = host(chat, project, live);
  const { cwd, others } = folders(project);
  try {
    let next: { text: string; images?: ImageInput[] } | undefined = { text, images };
    while (next) {
      // Read each turn, so a change in the composer applies from the next message on.
      const changed = nextOptions.get(chat.id);
      nextOptions.delete(chat.id);
      if (changed) chat.options = changed;
      const options = { ...DEFAULT_CHAT_OPTIONS, ...chat.options };
      const connections = loadConnections().filter((c) => c.enabled && !options.offConnections.includes(c.id));
      const tools = options.mode === "chat" ? READ_ONLY_TOOLS : [];
      const result = await runAgent(h, {
        agent: CHAT_AGENT,
        prompt: next.text,
        images: next.images?.length ? next.images : undefined,
        cwd,
        additionalDirectories: others,
        resume: chat.sessionId,
        config: { model: options.model, effort: options.effort, maxTurns: 200, showThinking: true },
        system: systemNote(project, cwd, others, connections),
        tools: options.webSearch ? tools : tools.filter((t) => !WEB_TOOLS.includes(t)),
        disallowedTools: options.webSearch ? undefined : WEB_TOOLS,
        connections: { servers: Object.fromEntries(connections.map((c) => [c.id, sdkConfig(c)])), check: () => ({ allow: true }) },
        unguarded: true,
        settingSources: chatSettingSources(options),
      });
      if (result.sessionId) chat.sessionId = result.sessionId;
      saveChat(chat);
      if (result.isError) {
        emit(chat.id, "orchestrator", { kind: "error", message: result.errors.filter(Boolean).join("\n") || "Claude stopped with an error." });
      }
      // Messages that arrived just as the turn ended start the next one.
      const waiting = takePending(chat.id, CHAT_AGENT);
      next = waiting.length
        ? { text: waiting.map((m) => m.text).join("\n\n"), images: waiting.flatMap((m) => m.images ?? []) }
        : undefined;
    }
  } catch (err) {
    const message = live.stopReason ?? (live.abort.signal.aborted ? "Stopped." : err instanceof Error ? err.message : String(err));
    emit(chat.id, "orchestrator", { kind: "error", message });
  } finally {
    if (chat.agent.status === "running") {
      Object.assign(chat.agent, { status: "idle", endedAt: Date.now() });
      emit(chat.id, "orchestrator", { kind: "agent", agent: CHAT_AGENT, state: { ...chat.agent } });
    }
    saveChat(chat);
    unregisterLive(chat.id);
  }
}

function checkAvailable() {
  if (process.env.AVIATOR_DEMO === "1") throw new Error("General chat calls Claude for real, so it's off in demo mode.");
  assertPlanUsage();
}

export function startChat(input: { projectId: string; text: string; images?: ImageInput[]; options?: ChatOptions }): Chat {
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project not found. Set one up with /project first.");
  checkAvailable();
  folders(project);
  const now = Date.now();
  const firstLine = input.text.trim().split("\n")[0];
  const chat: Chat = {
    id: newId("chat"),
    projectId: project.id,
    title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
    createdAt: now,
    updatedAt: now,
    tokens: 0,
    agent: { status: "idle", tokens: 0, turns: 0 },
    options: input.options ?? DEFAULT_CHAT_OPTIONS,
  };
  saveChat(chat);
  emit(chat.id, "user", { kind: "user", text: input.text, images: input.images?.length ? saveRunImages(chat.id, input.images) : undefined });
  void converse(chat, project, input.text, input.images);
  return chat;
}

/** Send a message: into the running turn if Claude is working, otherwise as a new turn. */
export function sendChat(chatId: string, text: string, images: ImageInput[] = [], options?: ChatOptions): "now" | "queued" | "started" {
  const chat = getChat(chatId);
  if (!chat) throw new Error("Chat not found.");
  const live = getLive(chatId);
  // A running chat holds its own copy, so it gets new options for its next turn instead.
  if (options && live) nextOptions.set(chatId, options);
  else if (options) {
    chat.options = options;
    saveChat(chat);
  }
  const project = getProject(chat.projectId);
  if (!live) {
    if (!project) throw new Error("This chat's project was deleted.");
    checkAvailable();
  }
  emit(chatId, "user", { kind: "user", text, images: images.length ? saveRunImages(chatId, images) : undefined });
  if (live) {
    const push = live.inboxes.get(CHAT_AGENT);
    if (push?.(text, images.length ? images : undefined)) return "now";
    const queue = live.pending.get(CHAT_AGENT) ?? [];
    queue.push({ text, images });
    live.pending.set(CHAT_AGENT, queue);
    return "queued";
  }
  void converse(chat, project!, text, images);
  return "started";
}
