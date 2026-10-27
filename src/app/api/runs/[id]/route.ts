import { forget, settleRun, stopAndWait } from "@/lib/runtime";
import { deleteRun, getRun } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  return Response.json(settleRun(run));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return Response.json({ error: "Run not found." }, { status: 404 });
  await stopAndWait(id);
  deleteRun(id);
  forget(id);
  return new Response(null, { status: 204 });
}
