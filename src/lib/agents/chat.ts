import { loadConnections, sdkConfig } from "../connections";
import { emit, getLive, registerLive, setPlanUsage, takePending, unregisterLive, type LiveRun } from "../runtime";
import { getChat, getProject, newId, saveChat, saveRunImages } from "../store";
import { CHAT_AGENT, type Chat, type ImageInput, type Project } from "../types";
import type { AgentConfig } from "../agentPresets";
import { assertPlanUsage } from "./pipeline";
import { runAgent, type AgentHost } from "./runAgent";

// General chat: you talk to one Claude Code session that works directly in the project's
// folders, like running `claude` there yourself. Unlike task runs there is no branch, no
// folder limits and no command guard. Each message resumes the same session; messages sent
// while it is working are delivered into the running turn.

const CHAT_CONFIG: AgentConfig = { model: "", effort: "high", maxTurns: 200, showThinking: true };

function folders(project: Project): { cwd: string; others: string[] } {
  if (project.layout === "monorepo") {
    if (!project.root) throw new Error("This project has no repo folder set.");
    return { cwd: project.root, others: [] };
  }
  const all = [project.backendPath, project.frontendPath].filter((p): p is string => !!p);
  if (!all.length) throw new Error("This project has no repo folders set.");
  return { cwd: all[0], others: all.slice(1) };
}

function systemNote(project: Project, cwd: string, others: string[]): string {
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
  const connections = loadConnections().filter((c) => c.enabled);
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
    addUsage: (_agent, tokens, turns) => {
      chat.agent.tokens += tokens;
      chat.agent.turns += turns;
      chat.tokens += tokens;
      saveChat(chat);
      emit(chat.id, "orchestrator", { kind: "usage", tokens: chat.tokens });
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
  const system = systemNote(project, cwd, others);
  const connections = loadConnections().filter((c) => c.enabled);
  try {
    let next: { text: string; images?: ImageInput[] } | undefined = { text, images };
    while (next) {
      const result = await runAgent(h, {
        agent: CHAT_AGENT,
        prompt: next.text,
        images: next.images?.length ? next.images : undefined,
        cwd,
        additionalDirectories: others,
        resume: chat.sessionId,
        config: CHAT_CONFIG,
        system,
        tools: [],
        connections: { servers: Object.fromEntries(connections.map((c) => [c.id, sdkConfig(c)])), check: () => ({ allow: true }) },
        unguarded: true,
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

export function startChat(input: { projectId: string; text: string; images?: ImageInput[] }): Chat {
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
  };
  saveChat(chat);
  emit(chat.id, "user", { kind: "user", text: input.text, images: input.images?.length ? saveRunImages(chat.id, input.images) : undefined });
  void converse(chat, project, input.text, input.images);
  return chat;
}

/** Send a message: into the running turn if Claude is working, otherwise as a new turn. */
export function sendChat(chatId: string, text: string, images: ImageInput[] = []): "now" | "queued" | "started" {
  const chat = getChat(chatId);
  if (!chat) throw new Error("Chat not found.");
  const live = getLive(chatId);
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
