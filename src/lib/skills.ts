import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./auth";

// The skills and slash commands Claude Code offers in a folder, as it reports them. Asking
// sends no prompt, so it uses none of your plan.

export type SkillOption = { name: string; description: string; argumentHint: string };

type Source = "user" | "project" | "local";

const cache = new Map<string, { at: number; skills: SkillOption[] }>();
const CACHE_MS = 10 * 60_000;

export async function listSkills(cwd: string, settingSources: Source[]): Promise<SkillOption[]> {
  const key = `${cwd}\n${settingSources.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.skills;
  let close: (() => void) | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => (close = () => resolve({ done: true, value: undefined }))),
    }),
  };
  const q = query({ prompt: idle, options: { cwd, env: agentEnv(), settingSources, persistSession: false } });
  try {
    const list = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out listing skills.")), 30_000)),
    ]);
    const skills = list
      .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      .sort((a, b) => a.name.localeCompare(b.name));
    cache.set(key, { at: Date.now(), skills });
    return skills;
  } finally {
    close?.();
    q.close();
  }
}
