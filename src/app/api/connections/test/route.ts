import { loadConnections, saveConnections, testConnection } from "@/lib/connections";
import { MASK, type Connection } from "@/lib/connectionTypes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Start a connection briefly and list its tools. Saved connections keep the results.
export async function POST(req: Request) {
  const { connection } = (await req.json().catch(() => ({}))) as { connection?: Connection };
  if (!connection?.name) return Response.json({ error: "Save the connection with a name first." }, { status: 400 });
  const saved = loadConnections();
  const before = saved.find((c) => c.id === connection.id);
  // Masked secrets in the request mean "the saved value".
  for (const key of ["env", "headers"] as const) {
    for (const [k, v] of Object.entries(connection[key] ?? {})) {
      if (v === MASK) connection[key][k] = before?.[key][k] ?? "";
    }
  }
  try {
    const result = await testConnection({ ...connection, tools: before?.tools ?? connection.tools ?? [] });
    if (before) {
      const next = saved.map((c) =>
        c.id === before.id ? { ...c, tools: result.tools, lastStatus: result.status, lastError: result.error, testedAt: Date.now() } : c,
      );
      saveConnections(next);
    }
    return Response.json(result);
  } catch (err) {
    return Response.json({ status: "failed", error: err instanceof Error ? err.message : String(err), tools: [] });
  }
}
