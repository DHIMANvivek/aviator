import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./auth";
import type { Effort } from "./types";

// The models your Claude login can use, as Claude Code reports them. Asking sends no prompt,
// so it uses none of your plan.

export type ModelOption = {
  value: string;
  label: string;
  description: string;
  /** Effort levels this model accepts; undefined when Claude Code doesn't say. */
  efforts?: Effort[];
};

let cached: { at: number; list: ModelList } | undefined;
const CACHE_MS = 10 * 60_000;

export type ModelList = {
  models: ModelOption[];
  /** The model your plan's default stands for, e.g. "Opus 5.5". */
  defaultModel?: string;
};

export async function listModels(): Promise<ModelList> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  let close: (() => void) | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => (close = () => resolve({ done: true, value: undefined }))),
    }),
  };
  const q = query({ prompt: idle, options: { env: agentEnv(), settingSources: [], persistSession: false } });
  try {
    const list = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out listing models.")), 30_000)),
    ]);
    // "default" is Claude Code's alias for the plan default, which Aviator already offers as "".
    const models = list.filter((m) => m.value !== "default").map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
      description: m.description,
      efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels,
    }));
    // Its description starts with the model it stands for: "Opus 5.5 · Best for …".
    const fallback = list.find((m) => m.value === "default");
    const defaultModel = fallback?.description.split("·")[0].trim() || undefined;
    cached = { at: Date.now(), list: { models, defaultModel } };
    return cached.list;
  } finally {
    close?.();
    q.close();
  }
}
