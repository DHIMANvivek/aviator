import { git } from "@/lib/git";
import { getProject } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const cache = new Map<string, { at: number; files: string[] }>();
const CACHE_MS = 30_000;

/** Tracked and new files in a repo (ignored ones left out), cached briefly while you type. */
async function repoFiles(repo: string): Promise<string[]> {
  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  cache.set(repo, { at: Date.now(), files });
  return files;
}

// Files in the project's repos matching what you typed, for "Add from project" in the composer.
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return Response.json({ files: [], error: "Project not found." }, { status: 404 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const repos =
    project.layout === "monorepo"
      ? [{ role: "", path: project.root }]
      : [
          { role: "backend", path: project.backendPath },
          { role: "frontend", path: project.frontendPath },
        ];
  const found: { path: string; repo: string; score: number }[] = [];
  for (const repo of repos) {
    if (!repo.path) continue;
    const files = await repoFiles(repo.path).catch(() => []);
    for (const file of files) {
      const lower = file.toLowerCase();
      const at = lower.indexOf(q);
      if (q && at < 0) continue;
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      // File-name matches first, then shorter paths.
      const score = (q && base.startsWith(q) ? 0 : q && base.includes(q) ? 1 : 2) * 1000 + file.length;
      found.push({ path: file, repo: repo.role, score });
    }
  }
  found.sort((a, b) => a.score - b.score);
  return Response.json({ files: found.slice(0, 30).map(({ path, repo }) => ({ path, repo })) });
}
