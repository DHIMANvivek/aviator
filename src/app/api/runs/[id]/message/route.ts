import { deliver, emit, getLive } from "@/lib/runtime";
import { AGENTS, type AgentName } from "@/lib/types";

export const dynamic = "force-dynamic";

// One input box, three meanings: answer the researcher's questions, give feedback on a
// pending plan, or steer agents mid-run ("@backend use multer" targets one agent).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const text = String(((await req.json()) as { text?: string }).text ?? "").trim();
  if (!text) return Response.json({ error: "Empty message." }, { status: 400 });
  const live = getLive(id);
  if (!live) return Response.json({ error: "This run is no longer active." }, { status: 409 });

  emit(id, "user", { kind: "user", text });

  if (live.answer) {
    live.answer(text);
    return Response.json({ delivered: "answer" });
  }
  if (live.decide) {
    live.decide({ approved: false, feedback: text });
    return Response.json({ delivered: "feedback" });
  }

  const mention = text.match(/^@(\w+)\s+([\s\S]+)$/);
  const named = mention && (AGENTS as readonly string[]).includes(mention[1]) ? (mention[1] as AgentName) : null;
  const body = named ? mention![2] : text;
  const running = [...live.inboxes.keys()];
  const targets: AgentName[] = named ? [named] : running.length ? running : ["backend", "frontend"];
  const results = targets.map((to) => {
    emit(id, "user", { kind: "relay", from: "user", to, text: body });
    return { to, delivery: deliver(id, to, `[Message from the developer]\n${body}`) };
  });
  return Response.json({ delivered: "steer", results });
}
