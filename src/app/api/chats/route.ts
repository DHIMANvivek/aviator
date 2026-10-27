import { startChat } from "@/lib/agents/chat";
import { getLive, settleChat } from "@/lib/runtime";
import { checkImages, listChats } from "@/lib/store";
import type { ChatSummary } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(
    listChats()
      .map(settleChat)
      .map(
        ({ id, projectId, title, createdAt, updatedAt, tokens }): ChatSummary => ({
          id,
          projectId,
          title,
          createdAt,
          updatedAt,
          tokens,
          busy: !!getLive(id),
        }),
      ),
  );
}

export async function POST(req: Request) {
  const body = (await req.json()) as { projectId?: string; text?: string; images?: unknown };
  const { images, error } = checkImages(body.images);
  if (error) return Response.json({ error }, { status: 400 });
  const text = (body.text ?? "").trim();
  if (!body.projectId) return Response.json({ error: "Pick a project first." }, { status: 400 });
  if (!text && !images.length) return Response.json({ error: "Type a message." }, { status: 400 });
  try {
    const chat = startChat({ projectId: body.projectId, text: text || "See the attached screenshot(s).", images });
    return Response.json(chat, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
