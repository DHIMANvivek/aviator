import { startRun } from "@/lib/agents/pipeline";
import { stashChanges } from "@/lib/git";
import { getProject, getRun, listRuns, saveProject } from "@/lib/store";
import type { Run } from "@/lib/types";

const FIX_WORDS = /^\s*((let'?s|lets|please|ok|okay|yes|go|then)[\s,]+)*(stash|use\s+(a\s+)?(separate\s+)?work\s?tree|work\s?tree|retry|try\s+again)\b/i;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Retry a run's task, optionally fixing what stopped it first:
//   stash    — stash uncommitted changes in the project's repos (git stash pop brings them back)
//   worktree — switch the project to separate worktrees, leaving your checkout as it is
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { fix?: "stash" | "worktree" };
  const run = getRun(id);
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  const project = getProject(run.projectId);
  if (!project) return Response.json({ error: "This run's project no longer exists." }, { status: 404 });

  const inputOf = (r: Run) =>
    r.input ?? {
      source: r.brief.source,
      text: r.brief.source === "clickup" ? (r.brief.url ?? r.brief.clickupId ?? "") : r.brief.description,
    };
  // A "task" like "lets stash" was really an instruction about the failure, not work to do:
  // retry the last real task for this project instead.
  const isInstruction = (r: Run) => {
    const t = inputOf(r);
    return t.source === "prompt" && t.text.length < 60 && FIX_WORDS.test(t.text);
  };
  const target = isInstruction(run)
    ? listRuns().find((r) => r.projectId === run.projectId && r.createdAt < run.createdAt && !isInstruction(r))
    : run;
  if (!target) return Response.json({ error: "There's no earlier task to retry. Type the task you want instead." }, { status: 400 });
  const input = inputOf(target);
  let notice: string | undefined;

  try {
    if (body.fix === "stash") {
      const repos = [project.root, project.frontendPath, project.backendPath].filter((r): r is string => !!r);
      const label = `aviator: before "${target.title.slice(0, 60)}" (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;
      const stashed: string[] = [];
      for (const repo of repos) if (await stashChanges(repo, label)) stashed.push(repo);
      if (stashed.length) {
        notice = `Stashed your uncommitted changes in ${stashed.map((r) => `\`${r}\``).join(" and ")}. Get them back any time with ${stashed
          .map((r) => `\`git -C "${r}" stash pop\``)
          .join(" / ")}.`;
      }
    } else if (body.fix === "worktree") {
      saveProject({ ...project, isolation: "worktree" });
      notice = "This project now runs in a separate worktree, so your checkout and its uncommitted changes stay exactly as they are.";
    }
    const next = startRun({ projectId: project.id, source: input.source, text: input.text, notice });
    return Response.json(next, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
