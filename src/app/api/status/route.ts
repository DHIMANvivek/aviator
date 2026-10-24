import { checkAuth } from "@/lib/auth";
import { getPlanUsage } from "@/lib/runtime";
import type { AppStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.has("refresh");
  const status: AppStatus = {
    demo: process.env.AVIATOR_DEMO === "1",
    auth: await checkAuth(force),
    hasClickUp: !!process.env.CLICKUP_API_TOKEN,
    planUsage: getPlanUsage(),
  };
  return Response.json(status);
}
