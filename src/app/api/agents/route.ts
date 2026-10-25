import { DEFAULT_PROMPTS } from "@/lib/agents/prompts";
import { AGENT_TOOLS } from "@/lib/agents/definitions";
import { loadAgentSettings, updateAgentSettings, type SettingsUpdate } from "@/lib/agentSettings";
import { CUSTOM_TEMPLATES } from "@/lib/agentPresets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-agent model, effort, turns and prompts (with history) for the Agents page.
export function GET() {
  return Response.json({ settings: loadAgentSettings(), defaults: DEFAULT_PROMPTS, tools: AGENT_TOOLS, templates: CUSTOM_TEMPLATES });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as SettingsUpdate;
  return Response.json({ settings: updateAgentSettings(body) });
}
