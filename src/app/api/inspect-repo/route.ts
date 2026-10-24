import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectRepo } from "@/lib/inspectRepo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { root?: string; dirs?: string[] };
  const raw = String(body.root ?? "").trim();
  if (!raw) return Response.json({ error: "No folder given." }, { status: 400 });
  const root = path.resolve(raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(1)) : raw);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return Response.json({ error: `${root} does not exist.` }, { status: 404 });
  }
  return Response.json(inspectRepo(root, Array.isArray(body.dirs) ? body.dirs.map(String) : []));
}
