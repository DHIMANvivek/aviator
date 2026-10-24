import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ACTIVE_STATUSES, AGENTS, type AgentName, type AgentState, type Project, type Run } from "./types";

// Plain JSON files: easy to inspect, back up, or delete by hand.
//   .aviator/projects.json
//   .aviator/runs/<runId>/run.json      run state
//   .aviator/runs/<runId>/events.jsonl  every streamed event, for replay
//   .aviator/runs/<runId>/*.md          research, plan and contract

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

export function listRuns(): Run[] {
  const dir = path.join(dataDir, "runs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => getRun(id))
    .filter((r): r is Run => !!r)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** A run marked active on disk but with no live pipeline was cut off by a server restart. */
export function markOrphaned(run: Run, isLive: boolean): Run {
  if (!isLive && ACTIVE_STATUSES.includes(run.status)) {
    run.status = "failed";
    run.error = "Aviator restarted while this run was in progress.";
    saveRun(run);
  }
  return run;
}

export function writeRunFile(runId: string, name: string, content: string) {
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.writeFileSync(path.join(runDir(runId), name), content);
}
