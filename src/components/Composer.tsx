"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export const COMMANDS = [
  { cmd: "/clickup", args: "<link or id>", desc: "Start a run from a ClickUp task" },
  { cmd: "/new", args: "", desc: "Start a new task" },
  { cmd: "/approve", args: "", desc: "Approve the plan waiting for review" },
  { cmd: "/cancel", args: "", desc: "Cancel the current run" },
  { cmd: "/project", args: "", desc: "Edit the current project" },
  { cmd: "/new-project", args: "", desc: "Connect another project" },
  { cmd: "/login", args: "", desc: "Sign in with your Claude subscription" },
  { cmd: "/status", args: "", desc: "Re-check your Claude sign-in" },
  { cmd: "/help", args: "", desc: "Show help" },
];

const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export type Activity =
  | { kind: "none" }
  | { kind: "working"; verb: string; meta: string }
  | { kind: "waiting"; text: string };

export type ComposerHandle = { focus: (prefill?: string) => void };

type Props = {
  placeholder: string;
  activity: Activity;
  cancellable: boolean;
  disabled?: boolean;
  hintRight: string;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { placeholder, activity, cancellable, disabled, hintRight, onSubmit, onCancel },
  ref,
) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [armed, setArmed] = useState(false);
  const [sel, setSel] = useState(0);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: (prefill?: string) => {
      if (prefill !== undefined) setValue(prefill);
      area.current?.focus();
    },
  }));

  useEffect(() => {
    if (activity.kind !== "working") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 120);
    return () => clearInterval(t);
  }, [activity.kind]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2000);
    return () => clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const menu = value.startsWith("/") && !value.includes(" ") ? COMMANDS.filter((c) => c.cmd.startsWith(value)) : [];

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await onSubmit(trimmed);
    setBusy(false);
    if (ok) {
      history.current.unshift(trimmed);
      histPos.current = -1;
      setValue("");
    }
  }

  function complete(i: number) {
    const c = menu[i];
    if (!c) return;
    if (c.args) setValue(`${c.cmd} `);
    else void submit(c.cmd);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menu.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % menu.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + menu.length) % menu.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && menu[sel] && value !== menu[sel].cmd)) {
        e.preventDefault();
        complete(sel);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(value);
      return;
    }
    if (e.key === "Escape") {
      if (value) {
        setValue("");
      } else if (cancellable) {
        if (armed) {
          setArmed(false);
          onCancel();
        } else setArmed(true);
      }
      return;
    }
    if (e.key === "ArrowUp" && !value.includes("\n") && history.current.length) {
      const next = Math.min(histPos.current + 1, history.current.length - 1);
      if (next !== histPos.current) {
        e.preventDefault();
        histPos.current = next;
        setValue(history.current[next]);
      }
    } else if (e.key === "ArrowDown" && histPos.current >= 0 && !value.includes("\n")) {
      e.preventDefault();
      histPos.current -= 1;
      setValue(histPos.current >= 0 ? history.current[histPos.current] : "");
    }
  }

  return (
    <div className="composer">
      <div className={`activity ${armed ? "arm" : activity.kind === "waiting" ? "waiting" : ""}`}>
        {armed ? (
          <span>Press Esc again to cancel the run</span>
        ) : activity.kind === "working" ? (
          <>
            <span className="star">{SPINNER[frame]}</span>
            <span>{activity.verb}…</span>
            <span className="meta">({activity.meta})</span>
          </>
        ) : activity.kind === "waiting" ? (
          <span>? {activity.text}</span>
        ) : null}
      </div>
      <div className="inputbox">
        {menu.length > 0 && (
          <div className="cmd-menu" role="listbox">
            {menu.map((c, i) => (
              <button
                key={c.cmd}
                className={i === sel ? "sel" : ""}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(i);
                }}
              >
                <span>
                  <span className="cmd">{c.cmd}</span> <span className="faint">{c.args}</span>
                </span>
                <span>{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <span className="caret">&gt;</span>
        <textarea
          ref={area}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          autoFocus
          spellCheck={false}
        />
      </div>
      <div className="hints">
        <span>/ for commands · ⇧⏎ new line{cancellable ? " · esc esc to cancel" : ""}</span>
        <span>{hintRight}</span>
      </div>
    </div>
  );
});
