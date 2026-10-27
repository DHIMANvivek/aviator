import { looksLikeClickUp } from "@/lib/clickup";
import { startRun } from "@/lib/agents/pipeline";
import { settleRun } from "@/lib/runtime";
import { attachFiles, checkImages, listRuns } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const runs = listRuns().map(settleRun);
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
  const body = (await req.json()) as { projectId?: string; text?: string; source?: "prompt" | "clickup"; images?: unknown; files?: unknown };
  const { images, error } = checkImages(body.images);
  if (error) return Response.json({ error }, { status: 400 });
  const typed = (body.text ?? "").trim();
  if (!body.projectId) return Response.json({ error: "Pick a project first." }, { status: 400 });
  const source = body.source ?? (looksLikeClickUp(typed) ? "clickup" : "prompt");
  const hasFiles = Array.isArray(body.files) && body.files.length > 0;
  if (source === "clickup" && hasFiles) return Response.json({ error: "Attach files to a typed task, not a ClickUp link." }, { status: 400 });
  const files = attachFiles(typed, body.files);
  if (files.error) return Response.json({ error: files.error }, { status: 400 });
  const text = files.text;
  if (!text && !images.length) return Response.json({ error: "Describe the task or paste a ClickUp link." }, { status: 400 });
  try {
    const run = startRun({ projectId: body.projectId, source, text: text || "See the attached screenshot(s).", images });
    return Response.json(run, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
