import { readRunImage } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Screenshots attached to a run, shown in the transcript.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  const img = readRunImage(id, name);
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.data), { headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" } });
}
