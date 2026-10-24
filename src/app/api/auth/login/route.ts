import { cancelLogin, loginStatus, startLogin, submitLoginCode } from "@/lib/login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(loginStatus());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; code?: string };
  try {
    switch (body.action) {
      case "start":
        return Response.json(startLogin());
      case "code":
        return Response.json(submitLoginCode(String(body.code ?? "")));
      case "cancel":
        return Response.json(cancelLogin());
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ state: "failed", message: err instanceof Error ? err.message : String(err) });
  }
}
