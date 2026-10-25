"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ImageInput } from "@/lib/types";

type Attachment = ImageInput & { url: string };

const MAX_ATTACHMENTS = 6;
const MAX_SIDE = 1800;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Read a screenshot for sending: large ones are scaled down (max 1800px) so they stay under
 * the 5 MB limit and use less of your plan. Returns base64 data plus a preview URL.
 */
async function readImage(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`${file.name} isn't an image Aviator can read.`));
    el.src = dataUrl;
  });
  let url = dataUrl;
  let mediaType = (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) ? file.type : "image/png") as ImageInput["mediaType"];
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale < 1 || file.size > MAX_BYTES || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL("image/jpeg", 0.88);
    mediaType = "image/jpeg";
  }
  const data = url.slice(url.indexOf(",") + 1);
  if (data.length * 0.75 > MAX_BYTES) throw new Error(`${file.name} is still larger than 5 MB after resizing.`);
  return { mediaType, data, name: file.name || "screenshot", url };
}

export const COMMANDS = [
  { cmd: "/clickup", args: "<link or id>", desc: "Start a run from a ClickUp task" },
  { cmd: "/new", args: "", desc: "Start a new task" },
  { cmd: "/approve", args: "", desc: "Approve the plan waiting for review" },
  { cmd: "/cancel", args: "", desc: "Cancel the current run" },
  { cmd: "/agents", args: "", desc: "Model, effort, prompts and your custom agents" },
  { cmd: "/connections", args: "", desc: "Connect MCP tools for your agents" },
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
  onSubmit: (text: string, images: ImageInput[]) => Promise<boolean>;
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);

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
    if ((!trimmed && !attachments.length) || busy) return;
    setBusy(true);
    const ok = await onSubmit(
      trimmed,
      attachments.map(({ url: _url, ...img }) => img),
    );
    setBusy(false);
    if (ok) {
      if (trimmed) history.current.unshift(trimmed);
      histPos.current = -1;
      setValue("");
      setAttachments([]);
      setAttachError("");
    }
  }

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    if (attachments.length + images.length > MAX_ATTACHMENTS) {
      setAttachError(`Attach at most ${MAX_ATTACHMENTS} screenshots at a time.`);
      return;
    }
    try {
      const read = await Promise.all(images.map(readImage));
      setAttachments((prev) => [...prev, ...read]);
      setAttachError("");
    } catch (e) {
      setAttachError((e as Error).message);
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
      <div
        className={`inputbox ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div className="attachment" key={i} title={a.name}>
                <img src={a.url} alt={a.name ?? `Screenshot ${i + 1}`} />
                <button aria-label={`Remove ${a.name ?? "screenshot"}`} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
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
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          autoFocus
          spellCheck={false}
        />
        <button className="attach-btn" onClick={() => fileInput.current?.click()} title="Attach screenshots (or paste / drop them)" aria-label="Attach screenshots" disabled={disabled}>
          📎
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {attachError && <div className="bad" style={{ fontSize: 12, padding: "4px 4px 0" }}>{attachError}</div>}
      <div className="hints">
        <span>/ for commands · ⇧⏎ new line · paste or drop screenshots{cancellable ? " · esc esc to cancel" : ""}</span>
        <span>{hintRight}</span>
      </div>
    </div>
  );
});
