import { checkChatOptions, sendChat } from "@/lib/agents/chat";
import { attachFiles, checkImages, getChat } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = (await req.json()) as { text?: string; images?: unknown; files?: unknown; options?: unknown };
  const { images, error } = checkImages(raw.images);
  if (error) return Response.json({ error }, { status: 400 });
  const files = attachFiles(String(raw.text ?? "").trim(), raw.files);
  if (files.error) return Response.json({ error: files.error }, { status: 400 });
  const text = files.text || (images.length ? "See the attached screenshot(s)." : "");
  if (!text) return Response.json({ error: "Empty message." }, { status: 400 });
  try {
    const options = raw.options === undefined ? undefined : checkChatOptions(raw.options, getChat(id)?.options);
    return Response.json({ delivered: sendChat(id, text, images, options) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
