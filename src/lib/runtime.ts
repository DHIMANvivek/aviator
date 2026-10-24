import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runDir } from "./store";
import type { Actor, AgentName, AviatorEvent, EventBody, PlanUsage } from "./types";

// In-process state for live runs: the event log each browser tab streams from,
// and the hooks the HTTP routes use to answer questions, approve plans, steer
// agents and cancel. Kept on globalThis so dev-server hot reloads don't drop it.

export type ApprovalDecision = { approved: true } | { approved: false; feedback: string };

export type LiveRun = {
  abort: AbortController;
  /** Set when Aviator itself stops the run (e.g. plan usage ran out) rather than the developer. */
  stopReason?: string;
  answer?: (text: string) => void;
  decide?: (decision: ApprovalDecision) => void;
  /** Agents currently running, keyed by name: push a user message into their session. */
  inboxes: Map<AgentName, (text: string) => boolean>;
  /** Messages for agents that weren't running when they arrived; delivered on their next turn. */
  pending: Map<AgentName, string[]>;
};

type Runtime = {
  emitter: EventEmitter;
  history: Map<string, AviatorEvent[]>;
  live: Map<string, LiveRun>;
  planUsage?: PlanUsage;
};

const g = globalThis as unknown as { __aviatorRuntime?: Runtime };
const rt: Runtime =
  g.__aviatorRuntime ??
  (g.__aviatorRuntime = { emitter: new EventEmitter().setMaxListeners(0), history: new Map(), live: new Map() });

export function setPlanUsage(usage: PlanUsage) {
  rt.planUsage = usage;
}

export function getPlanUsage(): PlanUsage | undefined {
  return rt.planUsage;
}

/** Claude reports reset times in seconds; accept milliseconds too. */
export function resetTime(usage?: PlanUsage): number | undefined {
  if (!usage?.resetsAt) return undefined;
  return usage.resetsAt < 1e12 ? usage.resetsAt * 1000 : usage.resetsAt;
}

const eventsFile = (runId: string) => path.join(runDir(runId), "events.jsonl");

export function history(runId: string): AviatorEvent[] {
  let events = rt.history.get(runId);
  if (!events) {
    events = [];
    try {
      for (const line of fs.readFileSync(eventsFile(runId), "utf8").split("\n")) {
        if (line.trim()) events.push(JSON.parse(line));
      }
    } catch {
      // no events yet
    }
    rt.history.set(runId, events);
  }
  return events;
}

export function emit(runId: string, actor: Actor, body: EventBody): AviatorEvent {
  const events = history(runId);
  const event = { ...body, seq: events.length + 1, ts: Date.now(), runId, actor } as AviatorEvent;
  events.push(event);
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.appendFileSync(eventsFile(runId), JSON.stringify(event) + "\n");
  rt.emitter.emit(runId, event);
  return event;
}

export function subscribe(runId: string, listener: (e: AviatorEvent) => void): () => void {
  rt.emitter.on(runId, listener);
  return () => rt.emitter.off(runId, listener);
}

export function registerLive(runId: string): LiveRun {
  const live: LiveRun = { abort: new AbortController(), inboxes: new Map(), pending: new Map() };
  rt.live.set(runId, live);
  return live;
}

export function getLive(runId: string): LiveRun | undefined {
  return rt.live.get(runId);
}

export function unregisterLive(runId: string) {
  rt.live.delete(runId);
}

/** Deliver a message to an agent now if it is running, otherwise queue it for its next turn. */
export function deliver(runId: string, to: AgentName, text: string): "now" | "queued" | "no-run" {
  const live = rt.live.get(runId);
  if (!live) return "no-run";
  const push = live.inboxes.get(to);
  if (push && push(text)) return "now";
  const queue = live.pending.get(to) ?? [];
  queue.push(text);
  live.pending.set(to, queue);
  return "queued";
}

export function takePending(runId: string, agent: AgentName): string[] {
  const live = rt.live.get(runId);
  const queue = live?.pending.get(agent) ?? [];
  live?.pending.delete(agent);
  return queue;
}
