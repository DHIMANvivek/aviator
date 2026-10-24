import { history, subscribe } from "@/lib/runtime";
import type { AviatorEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-sent events: replays the run's log after Last-Event-ID, then streams live.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: AviatorEvent) => {
        try {
          controller.enqueue(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          cleanup();
        }
      };
      // history() and subscribe() run in the same tick, so no event can slip between them.
      for (const e of history(id)) if (e.seq > after) send(e);
      const unsubscribe = subscribe(id, send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
