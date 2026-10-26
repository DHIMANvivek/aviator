"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, derive, duration, tokens } from "@/lib/client";
import { CHAT_AGENT, type AviatorEvent, type Chat, type ImageInput, type Project } from "@/lib/types";
import { Composer, type Activity, type ComposerHandle } from "./Composer";
import { Transcript } from "./Transcript";

const CHAT_COMMANDS = [
  { cmd: "/new", args: "", desc: "Start a new chat" },
  { cmd: "/cancel", args: "", desc: "Stop Claude's current turn" },
  { cmd: "/delete", args: "", desc: "Delete this chat" },
];

const noHandlers = { onApprove: () => {}, onRequestChanges: () => {}, onBranch: () => {} };

type Props = {
  project: Project | null;
  chatId: string | null;
  /** Open a chat (null = a new one). */
  onOpen: (id: string | null) => void;
  /** The chat list changed (new chat, deleted, title). */
  onChanged: () => void;
};

/** General chat: one Claude Code session with full access to the project's folders. */
export function ChatPage({ project, chatId, onOpen, onChanged }: Props) {
  const [chat, setChat] = useState<(Chat & { busy: boolean }) | null>(null);
  const [events, setEvents] = useState<AviatorEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const derived = useMemo(() => derive(events), [events]);
  const agent = derived.agents[CHAT_AGENT];
  const busy = agent ? agent.status === "running" : !!chat?.busy;

  useEffect(() => {
    setEvents([]);
    setChat(null);
    setError(null);
    if (!chatId) return;
    stickToBottom.current = true;
    api<Chat & { busy: boolean }>(`/api/chats/${chatId}`)
      .then(setChat)
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

  async function submit(text: string, images: ImageInput[] = []): Promise<boolean> {
    setError(null);
    stickToBottom.current = true;
    if (text.startsWith("/") && !images.length) {
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
        await api(`/api/chats/${chatId}/message`, { method: "POST", json: { text, images } });
      } else {
        if (!project) return fail(new Error("Connect a project first."));
        const created = await api<Chat>("/api/chats", { method: "POST", json: { projectId: project.id, text, images } });
        onChanged();
        onOpen(created.id);
      }
      return true;
    } catch (err) {
      return fail(err);
    }
  }

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
        <span className="pill partial" title="No branch, no folder limits, no command guard">
          full access
        </span>
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
                <div className="warn" style={{ marginTop: 10 }}>
                  No guardrails: Claude works directly in your checkout (no branch) and may edit any file, run any command, and
                  commit or push if you ask. Task runs keep their usual limits.
                </div>
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
        commands={CHAT_COMMANDS}
        onSubmit={submit}
        onCancel={cancel}
      />
    </main>
  );
}
