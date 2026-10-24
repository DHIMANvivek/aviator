import { getLive } from "@/lib/runtime";
import { getRun, markOrphaned } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  return Response.json(markOrphaned(run, !!getLive(id)));
}
