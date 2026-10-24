import { looksLikeClickUp } from "@/lib/clickup";
import { startRun } from "@/lib/agents/pipeline";
import { getLive } from "@/lib/runtime";
import { listRuns, markOrphaned } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const runs = listRuns().map((r) => markOrphaned(r, !!getLive(r.id)));
  return Response.json(
    runs.map(({ id, projectId, title, status, stage, createdAt, updatedAt, tokens, demo }) => ({
      id,
      projectId,
      title,
      status,
      stage,
      createdAt,
      updatedAt,
      tokens: tokens ?? 0,
      demo,
    })),
  );
}

export async function POST(req: Request) {
  const body = (await req.json()) as { projectId?: string; text?: string; source?: "prompt" | "clickup" };
  const text = (body.text ?? "").trim();
  if (!body.projectId) return Response.json({ error: "Pick a project first." }, { status: 400 });
  if (!text) return Response.json({ error: "Describe the task or paste a ClickUp link." }, { status: 400 });
  const source = body.source ?? (looksLikeClickUp(text) ? "clickup" : "prompt");
  try {
    const run = startRun({ projectId: body.projectId, source, text });
    return Response.json(run, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
