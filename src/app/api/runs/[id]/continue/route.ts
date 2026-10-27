import { continueRun } from "@/lib/agents/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Pick a stopped run back up on its branch (e.g. once your plan's usage limit resets).
// An optional note tells the agents what changed meanwhile (e.g. fixes you made yourself).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { note?: string };
  try {
    return Response.json(continueRun(id, typeof body.note === "string" ? body.note.slice(0, 20_000) : undefined));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
