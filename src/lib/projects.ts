import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitRepo } from "./git";
import type { Effort, ProjectInput } from "./types";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function dir(value: unknown): string | undefined {
  const p = typeof value === "string" ? value.trim() : "";
  return p ? path.resolve(expandHome(p)) : undefined;
}

export function normalizeProject(body: Record<string, unknown>): ProjectInput {
  const layout = body.layout === "monorepo" ? "monorepo" : "separate";
  const tests = (body.testCommands ?? {}) as Record<string, unknown>;
  const effort = EFFORTS.includes(body.effort as Effort) ? (body.effort as Effort) : "high";
  return {
    name: String(body.name ?? "").trim(),
    layout,
    root: layout === "monorepo" ? dir(body.root) : undefined,
    frontendDirs: layout === "monorepo" ? list(body.frontendDirs) : undefined,
    backendDirs: layout === "monorepo" ? list(body.backendDirs) : undefined,
    frontendPath: layout === "separate" ? dir(body.frontendPath) : undefined,
    backendPath: layout === "separate" ? dir(body.backendPath) : undefined,
    testCommands: { frontend: list(tests.frontend), backend: list(tests.backend) },
    isolation: body.isolation === "worktree" ? "worktree" : "branch",
    requirePlanApproval: body.requirePlanApproval !== false,
    model: String(body.model ?? "").trim(),
    effort,
  };
}

/** Returns human-readable problems; empty when the project is usable. */
export async function validateProject(p: ProjectInput, demo: boolean): Promise<string[]> {
  const errors: string[] = [];
  if (!p.name) errors.push("Give the project a name.");
  const repos: [string, string | undefined][] =
    p.layout === "monorepo"
      ? [["Repo root", p.root]]
      : [
          ["Frontend repo", p.frontendPath],
          ["Backend repo", p.backendPath],
        ];
  if (p.layout === "monorepo" && !p.root) errors.push("Set the monorepo root folder.");
  if (p.layout === "separate" && !p.frontendPath && !p.backendPath) errors.push("Set at least one repo path.");
  if (demo) return errors;
  for (const [label, repo] of repos) {
    if (!repo) continue;
    if (!fs.existsSync(repo)) errors.push(`${label}: ${repo} does not exist.`);
    else if (!(await isGitRepo(repo))) errors.push(`${label}: ${repo} is not a git repository.`);
  }
  if (p.layout === "monorepo" && p.root && fs.existsSync(p.root)) {
    for (const d of [...(p.frontendDirs ?? []), ...(p.backendDirs ?? [])]) {
      if (!fs.existsSync(path.resolve(p.root, d))) errors.push(`Folder "${d}" isn't in ${p.root}. Remove it, or pick this repo's folders with the suggestions or "+ Other folder…".`);
    }
  }
  return errors;
}
