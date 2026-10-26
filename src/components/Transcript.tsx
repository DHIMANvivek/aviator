"use client";

import { Fragment, useState } from "react";
import { EFFORT_LABEL } from "@/lib/agentPresets";
import { actorColor, FINAL, tokens, type Derived } from "@/lib/client";
import type { Actor, AviatorEvent, RunStatus } from "@/lib/types";
import { Markdown } from "./Markdown";
import { DiffView, ReportCard } from "./Report";

type ToolUse = Extract<AviatorEvent, { kind: "tool_use" }>;
type ToolResult = Extract<AviatorEvent, { kind: "tool_result" }>;
type Item = { type: "tool"; use: ToolUse; result?: ToolResult } | { type: "event"; event: AviatorEvent };

export type Filter = Actor | "all";

/** Events that are page structure rather than something an agent said or did. */
const STANDALONE = new Set(["stage", "status", "user", "report"]);

function buildItems(events: AviatorEvent[], filter: Filter): Item[] {
  const results = new Map<string, ToolResult>();
  const uses = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_result") results.set(e.toolUseId, e);
    if (e.kind === "tool_use") uses.add(e.toolUseId);
  }
  const items: Item[] = [];
  for (const e of events) {
    if (e.kind === "agent" || e.kind === "usage" || e.kind === "plan_usage") continue;
    if (e.kind === "status" && !FINAL.includes(e.status)) continue;
    if (e.kind === "tool_result" && uses.has(e.toolUseId)) continue;
    if (e.kind === "user" && e.actor === "user" && filter !== "all") continue;
    if (filter !== "all" && !STANDALONE.has(e.kind) && e.actor !== filter && !(e.kind === "relay" && e.to === filter)) {
      continue;
    }
    items.push(e.kind === "tool_use" ? { type: "tool", use: e, result: results.get(e.toolUseId) } : { type: "event", event: e });
  }
  return items;
}

function lines(text: string): string[] {
  const all = text.replace(/\n+$/, "").split("\n");
  return all.length === 1 && all[0] === "" ? [] : all;
}

function resultSummary(name: string, content: string, isError: boolean): { head: string; more: boolean } {
  const ls = lines(content);
  const first = (ls[0] ?? "").slice(0, 200);
  if (isError) return { head: first || "Error", more: ls.length > 1 || first.length < (ls[0]?.length ?? 0) };
  switch (name) {
    case "Read":
      return { head: `Read ${ls.length} lines`, more: ls.length > 0 };
    case "Grep":
      return /no (matches|files)/i.test(first) ? { head: first, more: false } : { head: `Found ${ls.length} lines`, more: ls.length > 0 };
    case "Glob":
      return /no files/i.test(first) ? { head: first, more: false } : { head: `Found ${ls.length} files`, more: ls.length > 0 };
    case "TodoWrite":
      return { head: "Updated the todo list", more: false };
    case "Bash": {
      const shown = ls.slice(0, 3).join("\n") || "(no output)";
      return { head: ls.length > 3 ? `${shown}\n… +${ls.length - 3} lines` : shown, more: ls.length > 3 };
    }
    default:
      return { head: first || "Done", more: ls.length > 1 || first.length < (ls[0]?.length ?? 0) };
  }
}

/** Edit/Write inputs as a small diff, like Claude Code's edit preview. */
function editPatch(use: ToolUse): string | null {
  const input = (use.input ?? {}) as Record<string, unknown>;
  const asLines = (v: unknown, prefix: string) =>
    typeof v === "string" ? v.split("\n").map((l) => prefix + l) : [];
  if (use.name === "Write" && typeof input.content === "string") return asLines(input.content, "+").join("\n");
  if (use.name === "Edit" && typeof input.old_string === "string") {
    return ["@@ edit @@", ...asLines(input.old_string, "-"), ...asLines(input.new_string, "+")].join("\n");
  }
  if (use.name === "MultiEdit" && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[])
      .flatMap((ed) => ["@@ edit @@", ...asLines(ed.old_string, "-"), ...asLines(ed.new_string, "+")])
      .join("\n");
  }
  return null;
}

function ToolRow({ use, result, live }: { use: ToolUse; result?: ToolResult; live: boolean }) {
  const [open, setOpen] = useState(false);
  const state = result ? (result.isError ? "err" : "ok") : live ? "pending" : "err";
  const summary = result ? resultSummary(use.name, result.content, result.isError) : null;
  const patch = editPatch(use);
  return (
    <>
      <div className="row">
        <span className={`dot ${state}`}>⏺</span>
        <div>
          <span className="tool-name">{use.name}</span>
          <span className="tool-arg">({use.summary})</span>
        </div>
      </div>
      <div className={`result ${result?.isError ? "err" : ""}`}>
        <span className="elbow">⎿</span>
        {summary ? (
          <button className="expander" onClick={() => setOpen(!open)} title="Show full output">
            <span style={{ whiteSpace: "pre-wrap" }}>{summary.head}</span>
            {(summary.more || patch) && <span className="hint"> {open ? "(collapse)" : "(expand)"}</span>}
          </button>
        ) : (
          <span className="faint">{live ? "Running…" : "No result"}</span>
        )}
      </div>
      {open && result && (
        <div style={{ paddingLeft: 44 }}>
          {patch && <DiffView patch={patch} />}
          {result.content && <pre className="block">{result.content}</pre>}
        </div>
      )}
    </>
  );
}

/** What an agent was given: its settings, the system prompt Aviator added, and the task message. */
function InstructionsRow({ e }: { e: Extract<AviatorEvent, { kind: "prompt" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="row">
        <span className="dot thinking">⚙</span>
        <button className="expander" onClick={() => setOpen(!open)}>
          <span className="tool-name">{e.followUp ? "Follow-up instructions" : "Instructions"}</span>
          <span className="instr-meta">
            {" "}
            · {e.model || "plan default model"} · effort {EFFORT_LABEL[e.effort]} · up to {e.maxTurns} turns
          </span>
          <span className="hint"> {open ? "(collapse)" : "(see exactly what it was told)"}</span>
        </button>
      </div>
      {open && (
        <div className="instr-body" style={{ paddingLeft: 22 }}>
          <h4>system prompt (added after Claude Code&apos;s built-in prompt; your repo&apos;s CLAUDE.md is loaded too)</h4>
          <pre className="block">{e.system}</pre>
          <h4>{e.followUp ? "message sent to the running agent" : "task message"}</h4>
          <pre className="block">{e.message}</pre>
          <a href="#agents" className="link-btn">
            Change this agent&apos;s prompt or settings
          </a>
        </div>
      )}
    </>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").slice(0, 150);
  return (
    <div className="row">
      <span className="dot thinking">✻</span>
      <button className="expander" onClick={() => setOpen(!open)}>
        <span className="thinking-text">
          {open ? <span style={{ whiteSpace: "pre-wrap" }}>{text}</span> : <>Thinking… {preview}{text.length > 150 ? "…" : ""}</>}
        </span>
        <span className="hint"> {open ? "(collapse)" : "(expand)"}</span>
      </button>
    </div>
  );
}

type Handlers = {
  onApprove: () => void;
  onRequestChanges: () => void;
  /** Name the run's branch. */
  onBranch: (name: string) => void;
};

function EventRow({
  event: e,
  status,
  derived,
  handlers,
}: {
  event: AviatorEvent;
  status?: RunStatus;
  derived: Derived;
  handlers: Handlers;
}) {
  switch (e.kind) {
    case "stage":
      return (
        <div className="stage-divider">
          <span>
            <b>{e.label}</b>
          </span>
        </div>
      );
    case "user":
      return (
        <div className="user-msg">
          <span className="caret">&gt;</span>
          <span>
            {e.text}
            {e.images?.length ? (
              <span className="user-images">
                {e.images.map((name) => (
                  <a key={name} href={`/api/runs/${e.runId}/images/${name}`} target="_blank" rel="noreferrer" title="Open full size">
                    <img src={`/api/runs/${e.runId}/images/${name}`} alt="Attached screenshot" />
                  </a>
                ))}
              </span>
            ) : null}
          </span>
        </div>
      );
    case "text":
      return (
        <div className="row">
          <span className="dot">⏺</span>
          <Markdown text={e.text} />
        </div>
      );
    case "thinking":
      return <ThinkingRow text={e.text} />;
    case "prompt":
      return <InstructionsRow e={e} />;
    case "relay":
      return (
        <div className="row">
          <span className="dot relay">⇄</span>
          <div>
            <span style={{ color: actorColor(e.from) }}>{e.from}</span>
            <span className="muted"> → </span>
            <span style={{ color: actorColor(e.to) }}>{e.to}</span>
            <div className="muted">
              <Markdown text={e.text} />
            </div>
          </div>
        </div>
      );
    case "denied":
      return (
        <>
          <div className="row">
            <span className="dot err">⏺</span>
            <div>
              <span className="tool-name bad">Blocked</span> <span className="tool-arg">{e.tool}</span>
            </div>
          </div>
          <div className="result err">
            <span className="elbow">⎿</span>
            <span>{e.reason}</span>
          </div>
        </>
      );
    case "error":
      return (
        <div className="row">
          <span className="dot err">⏺</span>
          <span className="bad" style={{ whiteSpace: "pre-wrap" }}>
            {e.message}
          </span>
        </div>
      );
    case "tool_result":
      return (
        <div className={`result ${e.isError ? "err" : ""}`}>
          <span className="elbow">⎿</span>
          <span>{lines(e.content)[0]}</span>
        </div>
      );
    case "question": {
      const active = status === "waiting_input" && e.seq === derived.lastQuestionSeq;
      return (
        <div className="card amber">
          <h3 className="warn">? The researcher needs your input</h3>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {e.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
          <div className="muted" style={{ marginTop: 8 }}>
            {active ? "Type your answer below and press Enter." : "Answered."}
          </div>
        </div>
      );
    }
    case "branch":
      return <BranchCard event={e} active={status === "waiting_input" && e.seq === derived.lastBranchSeq} onBranch={handlers.onBranch} />;
    case "approval": {
      const active = status === "waiting_approval" && e.seq === derived.lastApprovalSeq;
      return (
        <div className="card violet">
          <h3 style={{ color: "var(--violet)" }}>Plan ready for review</h3>
          <Markdown text={e.planMd} />
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Contract between backend and frontend
            </summary>
            <div style={{ marginTop: 6 }}>
              <Markdown text={e.contractMd} />
            </div>
          </details>
          {active ? (
            <div className="actions">
              <button className="btn solid" onClick={handlers.onApprove}>
                Approve and build
              </button>
              <button className="btn" onClick={handlers.onRequestChanges}>
                Request changes
              </button>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 8 }}>
              {e.seq === derived.lastApprovalSeq ? "Approved." : "Revised below."}
            </div>
          )}
        </div>
      );
    }
    case "report":
      return <ReportCard report={e.report} diff={e.diff} />;
    case "status": {
      const title = {
        done: "✓ Done",
        partial: "◐ Finished with failing checks",
        failed: "✗ Failed",
        cancelled: "○ Cancelled",
      }[e.status as "done" | "partial" | "failed" | "cancelled"];
      return (
        <div className={`final ${e.status}`}>
          <div>
            {title}
            <span className="muted"> · {tokens(derived.tokens)} tokens</span>
          </div>
          {e.message && (
            <div className="detail">
              <Markdown text={e.message} />
            </div>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

function BranchCard({
  event,
  active,
  onBranch,
}: {
  event: Extract<AviatorEvent, { kind: "branch" }>;
  active: boolean;
  onBranch: (name: string) => void;
}) {
  const [name, setName] = useState(event.suggested);
  if (!active) return null;
  return (
    <div className="card amber">
      <h3 className="warn">? Name the branch for this run</h3>
      {event.problem && <div className="bad" style={{ marginBottom: 8 }}>{event.problem}</div>}
      <form
        className="branch-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          onBranch(name.trim());
        }}
      >
        <input value={name} onChange={(ev) => setName(ev.target.value)} spellCheck={false} aria-label="Branch name" autoFocus />
        <button className="btn solid" type="submit" disabled={!name.trim()}>
          Create branch
        </button>
      </form>
      <div className="muted" style={{ marginTop: 8 }}>
        Edit the name, or type one below and press Enter.
      </div>
    </div>
  );
}

export function Transcript({
  events,
  filter,
  status,
  derived,
  handlers,
}: {
  events: AviatorEvent[];
  filter: Filter;
  status?: RunStatus;
  derived: Derived;
  handlers: Handlers;
}) {
  const items = buildItems(events, filter);
  const live = !!status && !FINAL.includes(status);
  let lastActor: Actor | null = null;

  return (
    <>
      {items.map((item) => {
        const e = item.type === "tool" ? item.use : item.event;
        const standalone = STANDALONE.has(e.kind) || e.actor === "user";
        let head: React.ReactNode = null;
        if (standalone) {
          lastActor = null;
        } else if (e.actor !== lastActor) {
          lastActor = e.actor;
          head = (
            <div className="actor-head" style={{ color: actorColor(e.actor) }}>
              ● {e.actor}
            </div>
          );
        }
        return (
          <Fragment key={e.seq}>
            {head}
            {item.type === "tool" ? (
              <ToolRow use={item.use} result={item.result} live={live} />
            ) : (
              <EventRow event={item.event} status={status} derived={derived} handlers={handlers} />
            )}
          </Fragment>
        );
      })}
    </>
  );
}
