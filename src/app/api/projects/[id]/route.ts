import { normalizeProject, validateProject } from "@/lib/projects";
import { deleteProject, getProject, saveProject } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const existing = getProject(id);
  if (!existing) return Response.json({ errors: ["Project not found."] }, { status: 404 });
  const input = normalizeProject(await req.json());
  const errors = await validateProject(input, process.env.AVIATOR_DEMO === "1");
  if (errors.length) return Response.json({ errors }, { status: 400 });
  const project = { ...existing, ...input };
  saveProject(project);
  return Response.json(project);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteProject(id);
  return new Response(null, { status: 204 });
}
