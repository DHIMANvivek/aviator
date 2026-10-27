import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AGENTS, type AgentName, type AgentState, type Chat, type ImageInput, type Project, type Run } from "./types";

// Plain JSON files: easy to inspect, back up, or delete by hand.
//   .aviator/projects.json
//   .aviator/runs/<runId>/run.json      run state
//   .aviator/runs/<runId>/events.jsonl  every streamed event, for replay
//   .aviator/runs/<runId>/*.md          research, plan and contract
//   .aviator/chats/<chatId>/chat.json   general chat state (+ events.jsonl, images/)

export const dataDir = path.resolve(process.env.AVIATOR_DATA_DIR || path.join(process.cwd(), ".aviator"));

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ---------- projects ----------

const projectsFile = () => path.join(dataDir, "projects.json");

export function listProjects(): Project[] {
  return readJson<Project[]>(projectsFile(), []);
}

export function getProject(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export function saveProject(project: Project) {
  const all = listProjects().filter((p) => p.id !== project.id);
  all.push(project);
  writeJson(projectsFile(), all);
}

export function deleteProject(id: string) {
  writeJson(
    projectsFile(),
    listProjects().filter((p) => p.id !== id),
  );
}

// ---------- runs ----------

export const runDir = (runId: string) => path.join(dataDir, "runs", runId);

export function emptyAgents(): Record<AgentName, AgentState> {
  return Object.fromEntries(AGENTS.map((a) => [a, { status: "idle", tokens: 0, turns: 0 }])) as Record<
    AgentName,
    AgentState
  >;
}

export function saveRun(run: Run) {
  run.updatedAt = Date.now();
  writeJson(path.join(runDir(run.id), "run.json"), run);
}

export function getRun(runId: string): Run | undefined {
  return readJson<Run | undefined>(path.join(runDir(runId), "run.json"), undefined);
}

/** Parsed run files by id; the sidebar lists runs every few seconds, so only changed files are re-read. */
const runCache = new Map<string, { mtimeMs: number; run: Run }>();

export function listRuns(): Run[] {
  const dir = path.join(dataDir, "runs");
  if (!fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir);
  for (const id of runCache.keys()) if (!ids.includes(id)) runCache.delete(id);
  return ids
    .map((id) => {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(runDir(id), "run.json")).mtimeMs;
      } catch {
        return undefined;
      }
      const cached = runCache.get(id);
      if (cached?.mtimeMs === mtimeMs) return cached.run;
      const run = getRun(id);
      if (run) runCache.set(id, { mtimeMs, run });
      return run;
    })
    .filter((r): r is Run => !!r)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a run's record: its log, plan, report and screenshots. The branch (and worktree, if
 * any) with the agents' changes is left alone; that's your code.
 */
export function deleteRun(runId: string) {
  if (/^run_[a-f0-9]+$/.test(runId)) fs.rmSync(runDir(runId), { recursive: true, force: true });
}

// ---------- general chats ----------

export const chatDir = (chatId: string) => path.join(dataDir, "chats", chatId);

/** Where a run's or a chat's event log and screenshots live. */
export const logDir = (id: string) => (id.startsWith("chat_") ? chatDir(id) : runDir(id));

export function saveChat(chat: Chat) {
  chat.updatedAt = Date.now();
  writeJson(path.join(chatDir(chat.id), "chat.json"), chat);
}

export function getChat(chatId: string): Chat | undefined {
  if (!/^chat_[a-f0-9]+$/.test(chatId)) return undefined;
  return readJson<Chat | undefined>(path.join(chatDir(chatId), "chat.json"), undefined);
}

export function listChats(): Chat[] {
  const dir = path.join(dataDir, "chats");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => getChat(id))
    .filter((c): c is Chat => !!c)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteChat(chatId: string) {
  if (getChat(chatId)) fs.rmSync(chatDir(chatId), { recursive: true, force: true });
}

export function writeRunFile(runId: string, name: string, content: string) {
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.writeFileSync(path.join(runDir(runId), name), content);
}

export function readRunFile(runId: string, name: string): string | undefined {
  try {
    return fs.readFileSync(path.join(runDir(runId), name), "utf8");
  } catch {
    return undefined;
  }
}

// ---------- screenshots attached in the chat box ----------

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;

/** Validate pasted/uploaded images from the browser; returns problems instead of throwing. */
export function checkImages(value: unknown): { images: ImageInput[]; error?: string } {
  if (value == null) return { images: [] };
  if (!Array.isArray(value)) return { images: [], error: "Images must be a list." };
  if (value.length > MAX_IMAGES) return { images: [], error: `Attach at most ${MAX_IMAGES} screenshots at a time.` };
  const images: ImageInput[] = [];
  for (const v of value as Partial<ImageInput>[]) {
    if (!v?.mediaType || !IMAGE_EXT[v.mediaType] || typeof v.data !== "string") {
      return { images: [], error: "Only PNG, JPEG, GIF and WebP images can be attached." };
    }
    if (Buffer.byteLength(v.data, "base64") > MAX_IMAGE_BYTES) {
      return { images: [], error: `${v.name ?? "An image"} is larger than 5 MB.` };
    }
    images.push({ mediaType: v.mediaType, data: v.data, name: v.name?.slice(0, 80) });
  }
  return { images };
}

/** Saves images next to the run (or chat) so the transcript can show them; returns their file names. */
export function saveRunImages(runId: string, images: ImageInput[]): string[] {
  if (!images.length) return [];
  const dir = path.join(logDir(runId), "images");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  return images.map((img, i) => {
    const name = `${stamp}-${i + 1}.${IMAGE_EXT[img.mediaType]}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(img.data, "base64"));
    return name;
  });
}

export function readRunImage(runId: string, name: string): { data: Buffer; type: string } | null {
  if (!/^[\w-]+\.(png|jpg|gif|webp)$/.test(name) || !/^(run|chat)_[a-f0-9]+$/.test(runId)) return null;
  const file = path.join(logDir(runId), "images", name);
  if (!fs.existsSync(file)) return null;
  const ext = name.split(".").pop()!;
  const type = Object.entries(IMAGE_EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { data: fs.readFileSync(file), type };
}

/** Saved screenshots back as image input, e.g. for agents of a continued run. */
export function loadRunImages(runId: string, names: string[]): ImageInput[] {
  return names
    .map((name) => ({ name, img: readRunImage(runId, name) }))
    .filter((x): x is { name: string; img: { data: Buffer; type: string } } => !!x.img)
    .map(({ name, img }) => ({ mediaType: img.type as ImageInput["mediaType"], data: img.data.toString("base64"), name }));
}
