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

let cached: { at: number; models: ModelOption[] } | undefined;
const CACHE_MS = 10 * 60_000;

export async function listModels(): Promise<ModelOption[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
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
    cached = { at: Date.now(), models };
    return models;
  } finally {
    close?.();
    q.close();
  }
}
