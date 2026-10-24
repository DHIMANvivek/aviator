import { openPath } from "@/lib/openPath";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { path?: string; how?: string };
  try {
    await openPath(String(body.path ?? ""), body.how === "editor" ? "editor" : "folder");
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
