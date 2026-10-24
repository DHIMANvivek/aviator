import { getLive } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { approved?: boolean; feedback?: string };
  const live = getLive(id);
  if (!live?.decide) return Response.json({ error: "No plan is waiting for approval." }, { status: 409 });
  if (body.approved) live.decide({ approved: true });
  else live.decide({ approved: false, feedback: String(body.feedback ?? "").trim() || "Please revise the plan." });
  return Response.json({ ok: true });
}
