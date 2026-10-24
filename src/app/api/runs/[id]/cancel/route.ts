import { getLive } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = getLive(id);
  if (!live) return Response.json({ error: "This run is not active." }, { status: 409 });
  live.abort.abort();
  return Response.json({ ok: true });
}
