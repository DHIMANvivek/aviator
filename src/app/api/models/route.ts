import { listModels } from "@/lib/models";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await listModels());
  } catch (err) {
    return Response.json({ models: [], error: err instanceof Error ? err.message : String(err) });
  }
}
