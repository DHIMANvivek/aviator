import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffFile, RepoDiff, RunRepo } from "./types";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** A short default branch name: the first few words of the title, e.g. aviator/add-photo-upload. */
export function suggestBranch(title: string, clickupId?: string): string {
  const words = slugify(title).split("-").filter(Boolean);
  let slug = "";
  for (const w of words) {
    if (slug && slug.length + w.length + 1 > 28) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  return `aviator/${[clickupId?.toLowerCase(), slug.slice(0, 28) || "task"].filter(Boolean).join("-")}`;
}

/** Why a branch name can't be used in these repos, or null if it can. */
export async function branchProblem(name: string, repoPaths: string[]): Promise<string | null> {
  if (!name) return "Type a branch name.";
  if (/\s/.test(name)) return `"${name}" has spaces; use dashes instead.`;
  try {
    await exec("git", ["check-ref-format", "--branch", name]);
  } catch {
    return `"${name}" isn't a valid git branch name.`;
  }
  for (const repo of repoPaths) {
    try {
      await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return `A branch called "${name}" already exists in ${repo}.`;
    } catch {
      // doesn't exist yet: good
    }
  }
  return null;
}

export class DirtyRepoError extends Error {
  constructor(public repo: string) {
    super(
      `${repo} has uncommitted changes, so Aviator won't switch it to a new branch (your work would get mixed into the agents' changes). Stash them, or run in a separate worktree that leaves your checkout untouched.`,
    );
  }
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ["status", "--porcelain"])).trim().length > 0;
}

/** Stash everything uncommitted (including new files); `git stash pop` brings it back. */
export async function stashChanges(repo: string, message: string): Promise<boolean> {
  if (!(await isDirty(repo))) return false;
  await git(repo, ["stash", "push", "--include-untracked", "-m", message]);
  return true;
}

/**
 * Give a run its own branch. "branch" switches the user's checkout (it must be clean so
 * the final diff only contains the agents' work); "worktree" checks the branch out in a
 * separate folder and never touches the user's checkout.
 */
export async function prepareRepo(opts: {
  role: RunRepo["role"];
  repoPath: string;
  branch: string;
  isolation: "branch" | "worktree";
  worktreeDir: string;
}): Promise<RunRepo> {
  const { role, repoPath, branch, isolation, worktreeDir } = opts;
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path not found: ${repoPath}`);
  if (!(await isGitRepo(repoPath))) throw new Error(`${repoPath} is not a git repository.`);
  const baseCommit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  if (isolation === "worktree") {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    await git(repoPath, ["worktree", "add", "-b", branch, worktreeDir, baseCommit]);
    return { role, originalPath: repoPath, workPath: worktreeDir, branch, baseCommit };
  }

  if (await isDirty(repoPath)) throw new DirtyRepoError(repoPath);
  await git(repoPath, ["switch", "-c", branch]);
  return { role, originalPath: repoPath, workPath: repoPath, branch, baseCommit };
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Everything the agents changed since the run started: tracked edits plus new untracked files. */
export async function diffRepo(repo: RunRepo): Promise<RepoDiff> {
  const cwd = repo.workPath;
  const files: DiffFile[] = [];

  const numstat = await git(cwd, ["diff", "--numstat", "-M", repo.baseCommit]);
  const nameStatus = await git(cwd, ["diff", "--name-status", "-M", repo.baseCommit]);
  const statusByPath = new Map<string, DiffFile["status"]>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [code, ...paths] = line.split("\t");
    const file = paths[paths.length - 1];
    const status = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : code.startsWith("R")
          ? "renamed"
          : "modified";
    statusByPath.set(file, status);
  }
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    // Renames print as "old => new" or "dir/{old => new}"; resolve to the new path.
    const raw = rest.join("\t");
    const file = raw.includes("=>")
      ? raw.replace(/\{[^{}]*=> ([^{}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/")
      : raw;
    const patch = await git(cwd, ["diff", "-M", repo.baseCommit, "--", file]).catch(() => "");
    files.push({
      path: file,
      status: statusByPath.get(file) ?? "modified",
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
      patch,
    });
  }

  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  for (const file of untracked) {
    const buf = fs.readFileSync(path.join(cwd, file));
    if (isBinary(buf)) {
      files.push({ path: file, status: "added", additions: 0, deletions: 0, patch: "Binary file added" });
      continue;
    }
    const lines = buf.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const patch = [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join(
      "\n",
    );
    files.push({ path: file, status: "added", additions: lines.length, deletions: 0, patch });
  }

  return { role: repo.role, path: repo.originalPath, branch: repo.branch, files };
}
