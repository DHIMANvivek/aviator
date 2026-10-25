import { loadConnections, masked, saveConnections } from "@/lib/connections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Your MCP connections. Secret values are masked; sending the mask back keeps the saved value.
export function GET() {
  return Response.json({ connections: masked(loadConnections()) });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { connections?: unknown[] };
  if (!Array.isArray(body.connections)) return Response.json({ error: "Send the full connections list." }, { status: 400 });
  return Response.json({ connections: masked(saveConnections(body.connections)) });
}
