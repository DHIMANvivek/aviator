import { forget, getLive, settleChat, stopAndWait } from "@/lib/runtime";
import { deleteChat, getChat } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = getChat(id);
  if (!chat) return Response.json({ error: "Chat not found." }, { status: 404 });
  return Response.json({ ...settleChat(chat), busy: !!getLive(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await stopAndWait(id);
  deleteChat(id);
  forget(id);
  return new Response(null, { status: 204 });
}
