import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureWithClaude, heuristicSuggestion } from "@/lib/agents/configure";
import { inspectRepo } from "@/lib/inspectRepo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

// Claude reads the monorepo and proposes frontend/backend folders and checks.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { root?: string };
  const raw = String(body.root ?? "").trim();
  const root = path.resolve(raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(1)) : raw);
  if (!raw || !fs.existsSync(root)) return Response.json({ error: "Choose an existing repo folder first." }, { status: 400 });
  if (process.env.AVIATOR_DEMO === "1") return Response.json(heuristicSuggestion(inspectRepo(root)));
  try {
    return Response.json(await configureWithClaude(root, req.signal));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
