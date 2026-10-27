import { chatSettingSources, folders } from "@/lib/agents/chat";
import { listSkills } from "@/lib/skills";
import { getProject } from "@/lib/store";
import { DEFAULT_CHAT_OPTIONS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The skills and slash commands a general chat in this project can use, for the composer's
// menu: they depend on the project folder and on which settings the chat loads.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = getProject(url.searchParams.get("projectId") ?? "");
  if (!project) return Response.json({ skills: [], error: "Project not found." }, { status: 404 });
  const sources = chatSettingSources({
    ...DEFAULT_CHAT_OPTIONS,
    userSettings: url.searchParams.get("userSettings") === "1",
    memory: url.searchParams.get("memory") !== "0",
  });
  try {
    return Response.json({ skills: await listSkills(folders(project).cwd, sources) });
  } catch (err) {
    return Response.json({ skills: [], error: err instanceof Error ? err.message : String(err) });
  }
}
