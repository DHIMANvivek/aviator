import { normalizeProject, validateProject } from "@/lib/projects";
import { listProjects, newId, saveProject } from "@/lib/store";
import type { Project } from "@/lib/types";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(listProjects());
}

export async function POST(req: Request) {
  const input = normalizeProject(await req.json());
  const errors = await validateProject(input, process.env.AVIATOR_DEMO === "1");
  if (errors.length) return Response.json({ errors }, { status: 400 });
  const project: Project = { ...input, id: newId("prj"), createdAt: Date.now() };
  saveProject(project);
  return Response.json(project, { status: 201 });
}
