import { sendChat } from "@/lib/agents/chat";
import { checkImages } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = (await req.json()) as { text?: string; images?: unknown };
  const { images, error } = checkImages(raw.images);
  if (error) return Response.json({ error }, { status: 400 });
  const text = String(raw.text ?? "").trim() || (images.length ? "See the attached screenshot(s)." : "");
  if (!text) return Response.json({ error: "Empty message." }, { status: 400 });
  try {
    return Response.json({ delivered: sendChat(id, text, images) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
