"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, derive, duration, tokens } from "@/lib/client";
import { CHAT_AGENT, DEFAULT_CHAT_OPTIONS, type AviatorEvent, type Chat, type ChatOptions, type FileInput, type ImageInput, type Project } from "@/lib/types";
import { EFFORT_LABEL, EFFORTS } from "@/lib/agentPresets";
import type { Connection } from "@/lib/connectionTypes";
import type { ModelOption } from "@/lib/models";
import type { SkillOption } from "@/lib/skills";
import { Composer, type Activity, type ComposerHandle, type MenuEntry } from "./Composer";
import { Transcript } from "./Transcript";

const CHAT_COMMANDS = [
  { cmd: "/new", args: "", desc: "Start a new chat" },
  { cmd: "/cancel", args: "", desc: "Stop Claude's current turn" },
  { cmd: "/delete", args: "", desc: "Delete this chat" },
];

const noHandlers = { onApprove: () => {}, onRequestChanges: () => {}, onBranch: () => {} };

/** New chats start with the options you picked last (kept in this browser only). */
const LAST_OPTIONS = "aviator.chatOptions";

function lastOptions(): ChatOptions {
  try {
    return { ...DEFAULT_CHAT_OPTIONS, ...JSON.parse(localStorage.getItem(LAST_OPTIONS) ?? "{}") };
  } catch {
    return DEFAULT_CHAT_OPTIONS;
  }
}

function ChatTools({ options, models, onChange }: { options: ChatOptions; models: ModelOption[]; onChange: (o: ChatOptions) => void }) {
  const set = (patch: Partial<ChatOptions>) => onChange({ ...options, ...patch });
  const efforts = models.find((m) => m.value === options.model)?.efforts ?? EFFORTS;
  return (
    <>
      <div className="segmented" role="group" aria-label="Mode">
        <button className={options.mode === "chat" ? "on" : ""} onClick={() => set({ mode: "chat" })} title="Reads and searches the code and the web; changes nothing">
          Chat
        </button>
        <button className={options.mode === "code" ? "on" : ""} onClick={() => set({ mode: "code" })} title="Full access: edits files and runs commands">
          Code
        </button>
      </div>
      <span className="spacer" />
      <select value={options.model} onChange={(e) => set({ model: e.target.value })} aria-label="Model">
        <option value="">Plan default</option>
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.label}
          </option>
        ))}
        {options.model && !models.some((m) => m.value === options.model) && <option value={options.model}>{options.model}</option>}
      </select>
      {efforts.length > 0 && (
        <select
          value={efforts.includes(options.effort) ? options.effort : efforts[0]}
          onChange={(e) => set({ effort: e.target.value as ChatOptions["effort"] })}
          aria-label="Effort"
          title="Higher effort thinks longer and uses more tokens"
        >
          {efforts.map((e) => (
            <option key={e} value={e}>
              {EFFORT_LABEL[e]}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

type Props = {
  project: Project | null;
  chatId: string | null;
  /** Open a chat (null = a new one). */
  onOpen: (id: string | null) => void;
  /** The chat list changed (new chat, deleted, title). */
  onChanged: () => void;
  onOpenConnections: () => void;
};

/** General chat: one Claude Code session with full access to the project's folders. */
export function ChatPage({ project, chatId, onOpen, onChanged, onOpenConnections }: Props) {
  const [chat, setChat] = useState<(Chat & { busy: boolean }) | null>(null);
  const [events, setEvents] = useState<AviatorEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [options, setOptions] = useState<ChatOptions>(DEFAULT_CHAT_OPTIONS);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[] | null>(null);
  const [skillsError, setSkillsError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const derived = useMemo(() => derive(events), [events]);
  const agent = derived.agents[CHAT_AGENT];
  const busy = agent ? agent.status === "running" : !!chat?.busy;

  useEffect(() => {
    api<{ models: ModelOption[] }>("/api/models")
      .then((r) => setModels(r.models))
      .catch(() => {});
    api<{ connections: Connection[] }>("/api/connections")
      .then((r) => setConnections(r.connections.filter((c) => c.enabled)))
      .catch(() => {});
  }, []);

  // Skills come from the project folder and the settings this chat loads.
  const projectKey = project?.id;
  useEffect(() => {
    setSkills(null);
    setSkillsError("");
    if (!projectKey) return;
    let stale = false;
    api<{ skills: SkillOption[]; error?: string }>(
      `/api/chats/skills?projectId=${projectKey}&userSettings=${options.userSettings ? 1 : 0}&memory=${options.memory ? 1 : 0}`,
    )
      .then((r) => {
        if (stale) return;
        setSkills(r.skills);
        setSkillsError(r.error ?? "");
      })
      .catch((err) => !stale && setSkillsError(err.message));
    return () => {
      stale = true;
    };
  }, [projectKey, options.userSettings, options.memory]);

  useEffect(() => {
    setEvents([]);
    setChat(null);
    setError(null);
    setOptions(lastOptions());
    if (!chatId) return;
    stickToBottom.current = true;
    api<Chat & { busy: boolean }>(`/api/chats/${chatId}`)
      .then((c) => {
        setChat(c);
        setOptions({ ...DEFAULT_CHAT_OPTIONS, ...c.options });
      })
      .catch((err) => setError(err.message));
    const es = new EventSource(`/api/chats/${chatId}/events`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AviatorEvent;
      setEvents((prev) => (prev.length && prev[prev.length - 1].seq >= e.seq ? prev : [...prev, e]));
    };
    return () => es.close();
  }, [chatId]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  useEffect(() => composer.current?.focus(), [chatId]);

  function changeOptions(next: ChatOptions) {
    setOptions(next);
    try {
      localStorage.setItem(LAST_OPTIONS, JSON.stringify(next));
    } catch {
      // only a convenience
    }
  }

  const fail = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    return false;
  };

  async function cancel() {
    if (!chatId) return;
    try {
      await api(`/api/chats/${chatId}/cancel`, { method: "POST" });
    } catch (err) {
      fail(err);
    }
  }

  async function submit(text: string, images: ImageInput[] = [], files: FileInput[] = []): Promise<boolean> {
    setError(null);
    stickToBottom.current = true;
    if (text.startsWith("/") && !images.length && !files.length) {
      const cmd = text.split(/\s+/)[0];
      if (cmd === "/new") {
        onOpen(null);
        return true;
      }
      if (cmd === "/cancel") {
        await cancel();
        return true;
      }
      if (cmd === "/delete") {
        if (!chatId || !window.confirm("Delete this chat? Its history is removed; changes Claude made to your files stay.")) return false;
        await api(`/api/chats/${chatId}`, { method: "DELETE" }).catch(fail);
        onChanged();
        onOpen(null);
        return true;
      }
      // Anything else (e.g. a path like /etc/hosts) goes to Claude as typed.
    }
    try {
      if (chatId) {
        await api(`/api/chats/${chatId}/message`, { method: "POST", json: { text, images, files, options } });
      } else {
        if (!project) return fail(new Error("Connect a project first."));
        const created = await api<Chat>("/api/chats", { method: "POST", json: { projectId: project.id, text, images, files, options } });
        onChanged();
        onOpen(created.id);
      }
      return true;
    } catch (err) {
      return fail(err);
    }
  }

  const toggle = (key: "userSettings" | "webSearch" | "memory") => () => changeOptions({ ...options, [key]: !options[key] });
  const menu: MenuEntry[] = [
    {
      kind: "submenu",
      icon: "✦",
      label: "Skills",
      title: "Claude Code skills and commands available in this project",
      entries: (skills ?? []).map((sk) => ({
        kind: "item" as const,
        icon: "/",
        label: sk.name,
        title: [sk.description, sk.argumentHint && `Arguments: ${sk.argumentHint}`].filter(Boolean).join("\n"),
        onSelect: () => composer.current?.focus(`/${sk.name} `),
      })),
      empty: skillsError || (skills === null ? "Loading…" : "No skills or commands found."),
    },
    {
      kind: "submenu",
      icon: "⚡",
      label: "Connectors",
      title: "Your connections this chat may use",
      entries: [
        ...connections.map((c) => ({
          kind: "item" as const,
          icon: "·",
          label: c.name,
          checked: !options.offConnections.includes(c.id),
          stayOpen: true,
          onSelect: () =>
            changeOptions({
              ...options,
              offConnections: options.offConnections.includes(c.id)
                ? options.offConnections.filter((id) => id !== c.id)
                : [...options.offConnections, c.id],
            }),
        })),
        ...(connections.length ? [{ kind: "divider" as const }] : []),
        { kind: "item", icon: "+", label: "Manage connections…", onSelect: onOpenConnections },
      ],
    },
    {
      kind: "item",
      icon: "🧩",
      label: "Your plugins & MCP",
      title: "Load your ~/.claude settings, plugins and MCP servers, like the CLI. They are sent with every turn, so they use more tokens.",
      checked: options.userSettings,
      stayOpen: true,
      onSelect: toggle("userSettings"),
    },
    { kind: "divider" },
    { kind: "item", icon: "🌐", label: "Web search", title: "Let Claude search and fetch web pages", checked: options.webSearch, stayOpen: true, onSelect: toggle("webSearch") },
    {
      kind: "item",
      icon: "🧠",
      label: "Memory",
      title: "Load the project's CLAUDE.md files and its .claude settings and skills",
      checked: options.memory,
      stayOpen: true,
      onSelect: toggle("memory"),
    },
  ];
  const commands = [
    ...CHAT_COMMANDS,
    ...(skills ?? [])
      .filter((sk) => !CHAT_COMMANDS.some((c) => c.cmd === `/${sk.name}`))
      .map((sk) => ({ cmd: `/${sk.name}`, args: sk.argumentHint, desc: sk.description })),
  ];

  const folders = project
    ? project.layout === "monorepo"
      ? [project.root]
      : [project.backendPath, project.frontendPath]
    : [];

  const activity: Activity = busy
    ? {
        kind: "working",
        verb: "Working",
        meta: [agent?.startedAt ? duration(now - agent.startedAt) : "", `${tokens(derived.tokens || chat?.tokens || 0)} tokens`]
          .filter(Boolean)
          .join(" · "),
      }
    : { kind: "none" };

  return (
    <main className="main">
      <header className="topbar">
        <span className="title">{chatId ? (chat?.title ?? "…") : "New chat"}</span>
        {options.mode === "code" ? (
          <span className="pill partial" title="No branch, no folder limits, no command guard">
            full access
          </span>
        ) : (
          <span className="pill" title="Claude can read and search but not edit files or run commands">
            read only
          </span>
        )}
      </header>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!chatId ? (
          <div className="welcome">
            <h1>
              <span className="star">✻</span>General chat
            </h1>
            <div className="muted">
              Ask anything about your code, or have Claude change it, like running Claude Code in your repo yourself.
            </div>
            {project ? (
              <>
                <div style={{ marginTop: 10 }}>
                  Works in{" "}
                  {folders.filter(Boolean).map((f, i) => (
                    <span key={f}>
                      {i > 0 && " + "}
                      <code>{f}</code>
                    </span>
                  ))}
                </div>
                {options.mode === "code" ? (
                  <div className="warn" style={{ marginTop: 10 }}>
                    No guardrails: Claude works directly in your checkout (no branch) and may edit any file, run any command, and
                    commit or push if you ask. Task runs keep their usual limits.
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 10 }}>
                    Chat mode: Claude reads and searches your code and the web, and changes nothing. Switch to Code below to let it
                    edit and run commands.
                  </div>
                )}
              </>
            ) : (
              <div className="bad" style={{ marginTop: 10 }}>
                Connect a project first.
              </div>
            )}
          </div>
        ) : (
          <Transcript events={events} filter="all" status={busy ? "running" : undefined} derived={derived} handlers={noHandlers} />
        )}
      </div>

      {error && (
        <div style={{ padding: "0 24px" }}>
          <div className="errors" style={{ margin: "0 0 6px", padding: "6px 12px" }}>
            {error}
            <button className="btn icon" style={{ float: "right", border: 0 }} onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}

      <Composer
        ref={composer}
        placeholder={busy ? "Add to what Claude is doing…" : project ? `Ask anything about ${project.name}…` : "Connect a project first"}
        activity={activity}
        cancellable={busy}
        disabled={!project && !chatId}
        hintRight={[project?.name, "general chat"].filter(Boolean).join(" · ")}
        commands={commands}
        projectId={project?.id}
        menu={menu}
        onSubmit={submit}
        onCancel={cancel}
        toolbar={<ChatTools options={options} models={models} onChange={changeOptions} />}
      />
    </main>
  );
}
