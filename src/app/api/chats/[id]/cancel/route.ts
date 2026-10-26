import { getLive } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = getLive(id);
  if (!live) return Response.json({ error: "Claude isn't working on this chat right now." }, { status: 409 });
  live.abort.abort();
  return Response.json({ ok: true });
}
