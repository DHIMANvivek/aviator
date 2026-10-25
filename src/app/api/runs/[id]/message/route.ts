import { deliver, emit, getLive } from "@/lib/runtime";
import { checkImages, saveRunImages } from "@/lib/store";
import { AGENTS, type AgentName } from "@/lib/types";

export const dynamic = "force-dynamic";

// One input box, three meanings: answer the researcher's questions, give feedback on a
// pending plan, or steer agents mid-run ("@backend use multer" targets one agent).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = (await req.json()) as { text?: string; images?: unknown };
  const { images, error } = checkImages(raw.images);
  if (error) return Response.json({ error }, { status: 400 });
  const text = String(raw.text ?? "").trim() || (images.length ? "See the attached screenshot(s)." : "");
  if (!text) return Response.json({ error: "Empty message." }, { status: 400 });
  const live = getLive(id);
  if (!live) return Response.json({ error: "This run is no longer active." }, { status: 409 });

  emit(id, "user", { kind: "user", text, images: images.length ? saveRunImages(id, images) : undefined });

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
  const targets: string[] = named ? [named] : running.length ? running : ["backend", "frontend"];
  const results = targets.map((to) => {
    emit(id, "user", { kind: "relay", from: "user", to, text: body });
    return { to, delivery: deliver(id, to, `[Message from the developer]\n${body}`, images.length ? images : undefined) };
  });
  return Response.json({ delivered: "steer", results });
}
