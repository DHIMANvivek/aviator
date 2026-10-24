import path from "node:path";
import { pickFolder } from "@/lib/folderPicker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Opens the native folder picker on this machine. With `inside`, the folder must be within
// that repo and comes back as a relative path (for monorepo frontend/backend folders).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; startIn?: string; inside?: string };
  try {
    const picked = await pickFolder(body.prompt || "Choose a folder", body.startIn || body.inside);
    if (!picked) return Response.json({ cancelled: true });
    if (body.inside) {
      const rel = path.relative(path.resolve(body.inside), picked);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return Response.json({ error: `Pick a folder inside ${body.inside}.` }, { status: 400 });
      }
      // Forward slashes on every OS; Node accepts them on Windows too.
      return Response.json({ path: rel.split(path.sep).join("/") || "." });
    }
    return Response.json({ path: picked });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
