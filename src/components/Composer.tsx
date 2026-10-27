"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FileInput, ImageInput } from "@/lib/types";
import { api } from "@/lib/client";
import { ImageViewer } from "./ImageViewer";

type ImageAttachment = ImageInput & { kind: "image"; url: string };
type FileAttachment = FileInput & { kind: "file"; size: number };
type Attachment = ImageAttachment | FileAttachment;

const MAX_ATTACHMENTS = 6;
const MAX_SIDE = 1800;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** One row of the + menu. Pages add their own after the built-in ones (files, screenshot, project file). */
export type MenuEntry =
  | { kind: "divider" }
  | { kind: "item"; icon: string; label: string; hint?: string; title?: string; checked?: boolean; onSelect: () => void; stayOpen?: boolean }
  | { kind: "submenu"; icon: string; label: string; title?: string; entries: MenuEntry[]; empty?: string };

type ProjectFile = { path: string; repo: string };

/** Any other file, sent as-is for Claude to read from disk. */
async function readFile(file: File): Promise<FileAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    r.readAsDataURL(file);
  });
  return { kind: "file", name: file.name || "file", data: dataUrl.slice(dataUrl.indexOf(",") + 1), size: file.size };
}

/** One frame of a screen, window or tab you pick in the browser's share dialog. */
async function captureScreen(): Promise<File | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser can't capture the screen here (it needs a desktop browser, on https or localhost).");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return null; // you closed the share dialog
  }
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new File([blob], `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`, { type: "image/png" }) : null;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Read a screenshot for sending: large ones are scaled down (max 1800px) so they stay under
 * the 5 MB limit and use less of your plan. Returns base64 data plus a preview URL.
 */
async function readImage(file: File): Promise<ImageAttachment> {
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
  return { kind: "image", mediaType, data, name: file.name || "screenshot", url };
}

export const COMMANDS = [
  { cmd: "/clickup", args: "<link or id>", desc: "Start a run from a ClickUp task" },
  { cmd: "/new", args: "", desc: "Start a new task" },
  { cmd: "/approve", args: "", desc: "Approve the plan waiting for review" },
  { cmd: "/cancel", args: "", desc: "Cancel the current run" },
  { cmd: "/continue", args: "", desc: "Continue a stopped run on its branch" },
  { cmd: "/delete", args: "", desc: "Delete the open run (its branch and changes stay)" },
  { cmd: "/agents", args: "", desc: "Model, effort, prompts and your custom agents" },
  { cmd: "/connections", args: "", desc: "Connect MCP tools for your agents" },
  { cmd: "/chat", args: "", desc: "General chat with full access to the project (no guardrails)" },
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
  onSubmit: (text: string, images: ImageInput[], files: FileInput[]) => Promise<boolean>;
  onCancel: () => void;
  /** Slash commands offered while typing "/"; defaults to the task commands. */
  commands?: typeof COMMANDS;
  /** Controls shown under the input, like the chat's mode and model pickers. */
  toolbar?: React.ReactNode;
  /** Enables "Add from project" in the + menu. */
  projectId?: string;
  /** The page's own rows in the + menu. */
  menu?: MenuEntry[];
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { placeholder, activity, cancellable, disabled, hintRight, onSubmit, onCancel, commands = COMMANDS, toolbar, projectId, menu = [] },
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
  /** Index of the attachment open in the zoom viewer. */
  const [viewing, setViewing] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The + menu: closed, its main list, one of its submenus (by label), or the project file search. */
  const [view, setView] = useState<null | "root" | "files" | { sub: string }>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileHits, setFileHits] = useState<ProjectFile[]>([]);
  const menuBox = useRef<HTMLDivElement>(null);

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

  const slashMenu = value.startsWith("/") && !value.includes(" ") ? commands.filter((c) => c.cmd.startsWith(value)) : [];

  // Close the + menu on a click outside it or Escape.
  useEffect(() => {
    if (!view) return;
    const onDown = (e: MouseEvent) => {
      if (menuBox.current && !menuBox.current.contains(e.target as Node)) setView(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [view]);

  useEffect(() => {
    if (view !== "files" || !projectId) return;
    const t = setTimeout(() => {
      api<{ files: ProjectFile[] }>(`/api/projects/${projectId}/files?q=${encodeURIComponent(fileQuery)}`)
        .then((r) => setFileHits(r.files))
        .catch(() => setFileHits([]));
    }, 150);
    return () => clearTimeout(t);
  }, [view, fileQuery, projectId]);

  /** Puts text at the cursor, e.g. a file mention. */
  function insert(text: string) {
    const el = area.current;
    const at = el?.selectionStart ?? value.length;
    const before = value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? " " : "";
    setValue(`${before}${pad}${text}${value.slice(el?.selectionEnd ?? at)}`);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = before.length + pad.length + text.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  async function screenshot() {
    setView(null);
    try {
      const shot = await captureScreen();
      if (shot) await addFiles([shot]);
    } catch (e) {
      setAttachError((e as Error).message);
    }
  }

  async function submit(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || busy) return;
    setBusy(true);
    const ok = await onSubmit(
      trimmed,
      attachments.flatMap((a) => (a.kind === "image" ? [{ mediaType: a.mediaType, data: a.data, name: a.name }] : [])),
      attachments.flatMap((a) => (a.kind === "file" ? [{ name: a.name, data: a.data }] : [])),
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
    if (!files.length) return;
    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      setAttachError(`Attach at most ${MAX_ATTACHMENTS} files at a time.`);
      return;
    }
    try {
      // Images go into the message itself; anything else is saved for Claude to read.
      const read = await Promise.all(files.map((f) => (/^image\/(png|jpeg|gif|webp)$/.test(f.type) ? readImage(f) : readFile(f))));
      setAttachments((prev) => [...prev, ...read]);
      setAttachError("");
    } catch (e) {
      setAttachError((e as Error).message);
    }
  }

  function complete(i: number) {
    const c = slashMenu[i];
    if (!c) return;
    if (c.args) setValue(`${c.cmd} `);
    else void submit(c.cmd);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
      e.preventDefault();
      fileInput.current?.click();
      return;
    }
    if (slashMenu.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % slashMenu.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + slashMenu.length) % slashMenu.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && slashMenu[sel] && value !== slashMenu[sel].cmd)) {
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
      if (view) {
        setView(null);
      } else if (value) {
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

  const rootEntries: MenuEntry[] = [
    { kind: "item", icon: "📎", label: "Upload or add files", hint: "Ctrl+U", onSelect: () => fileInput.current?.click() },
    { kind: "item", icon: "📷", label: "Take a screenshot", onSelect: () => void screenshot(), stayOpen: true },
    ...(projectId
      ? [
          {
            kind: "item" as const,
            icon: "@",
            label: "Add from project",
            title: "Mention a file from the project's repos",
            onSelect: () => {
              setFileQuery("");
              setView("files");
            },
            stayOpen: true,
          },
        ]
      : []),
    ...(menu.length ? [{ kind: "divider" as const }, ...menu] : []),
  ];
  const submenu = view && typeof view === "object" ? rootEntries.find((e) => e.kind === "submenu" && e.label === view.sub) : undefined;
  const images = attachments.filter((a): a is ImageAttachment => a.kind === "image");

  const rows = (entries: MenuEntry[]) =>
    entries.map((e, i) =>
      e.kind === "divider" ? (
        <div key={i} className="plus-divider" />
      ) : (
        <button
          key={i}
          className="plus-row"
          title={e.title}
          role={e.kind === "item" && e.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
          aria-checked={e.kind === "item" && e.checked !== undefined ? e.checked : undefined}
          onClick={() => {
            if (e.kind === "submenu") return setView({ sub: e.label });
            e.onSelect();
            if (!e.stayOpen) setView(null);
          }}
        >
          <span className="plus-icon">{e.icon}</span>
          <span className="plus-label">{e.label}</span>
          {e.kind === "item" && e.hint && <span className="faint">{e.hint}</span>}
          {e.kind === "item" && e.checked !== undefined && <span className="plus-check">{e.checked ? "✓" : ""}</span>}
          {e.kind === "submenu" && <span className="faint">›</span>}
        </button>
      ),
    );

  const back = (label: string) => (
    <button className="plus-row plus-back" onClick={() => setView("root")}>
      <span className="plus-icon">‹</span>
      <span className="plus-label">{label}</span>
    </button>
  );

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
          if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
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
            {attachments.map((a, i) =>
              a.kind === "image" ? (
                <div className="attachment" key={i} title={a.name}>
                  <button className="attachment-open" onClick={() => setViewing(images.indexOf(a))} aria-label={`View ${a.name ?? "screenshot"} larger`}>
                    <img src={a.url} alt={a.name ?? `Screenshot ${i + 1}`} />
                  </button>
                  <button aria-label={`Remove ${a.name ?? "screenshot"}`} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ) : (
                <div className="attachment file" key={i} title={`${a.name} · ${Math.max(1, Math.round(a.size / 1024))} KB`}>
                  <span className="file-name">📄 {a.name}</span>
                  <button aria-label={`Remove ${a.name}`} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        {slashMenu.length > 0 && (
          <div className="cmd-menu" role="listbox">
            {slashMenu.map((c, i) => (
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
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          autoFocus
          spellCheck={false}
        />
        <div className="plus-wrap" ref={menuBox}>
          <button
            className="attach-btn plus-btn"
            onClick={() => setView(view ? null : "root")}
            title="Add files, a screenshot, a project file and more"
            aria-label="Add files and more"
            aria-haspopup="menu"
            aria-expanded={!!view}
            disabled={disabled}
          >
            +
          </button>
          {view && (
            <div className="plus-menu" role="menu">
              {view === "root" && rows(rootEntries)}
              {submenu?.kind === "submenu" && (
                <>
                  {back(submenu.label)}
                  {submenu.entries.length ? rows(submenu.entries) : <div className="plus-empty">{submenu.empty ?? "Nothing here yet."}</div>}
                </>
              )}
              {view === "files" && (
                <>
                  {back("Add from project")}
                  <input
                    className="plus-search"
                    autoFocus
                    value={fileQuery}
                    placeholder="Search files…"
                    onChange={(e) => setFileQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && fileHits[0]) {
                        e.preventDefault();
                        const f = fileHits[0];
                        insert(`@${f.path}${f.repo ? ` (in the ${f.repo} repo)` : ""} `);
                        setView(null);
                      }
                    }}
                  />
                  {fileHits.map((f) => (
                    <button
                      key={`${f.repo}:${f.path}`}
                      className="plus-row"
                      title={f.path}
                      onClick={() => {
                        insert(`@${f.path}${f.repo ? ` (in the ${f.repo} repo)` : ""} `);
                        setView(null);
                      }}
                    >
                      <span className="plus-label">{f.path}</span>
                      {f.repo && <span className="faint">{f.repo}</span>}
                    </button>
                  ))}
                  {!fileHits.length && <div className="plus-empty">No matching files.</div>}
                </>
              )}
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {viewing !== null && images[viewing] && <ImageViewer images={images} start={viewing} onClose={() => setViewing(null)} />}
      {attachError && <div className="bad" style={{ fontSize: 12, padding: "4px 4px 0" }}>{attachError}</div>}
      {toolbar && <div className="composer-tools">{toolbar}</div>}
      <div className="hints">
        <span>/ for commands · + for files and more · ⇧⏎ new line{cancellable ? " · esc esc to cancel" : ""}</span>
        <span>{hintRight}</span>
      </div>
    </div>
  );
});
