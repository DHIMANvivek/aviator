import type { TaskBrief } from "./types";

const API = "https://api.clickup.com/api/v2";

export type ClickUpRef = { id: string; custom: boolean; teamId?: string };

/**
 * Accepts a task link (app.clickup.com/t/<id> or /t/<teamId>/<CUSTOM-ID>),
 * "CU-<id>", "#<id>", a custom ID like "DEV-123", or a bare task ID.
 */
export function parseClickUpRef(input: string): ClickUpRef | null {
  const text = input.trim();
  const url = text.match(/clickup\.com\/t\/([^/?#\s]+)(?:\/([^/?#\s]+))?/i);
  if (url) {
    return url[2] ? { id: url[2], custom: true, teamId: url[1] } : { id: url[1], custom: false };
  }
  const cu = text.match(/^(?:CU-|#)([a-z0-9]+)$/i);
  if (cu) return { id: cu[1], custom: false };
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(text)) return { id: text, custom: true };
  if (/^[a-z0-9]{6,15}$/i.test(text)) return { id: text, custom: false };
  return null;
}

/** Only links and "CU-" ids are treated as ClickUp automatically; anything else needs /clickup. */
export function looksLikeClickUp(input: string): boolean {
  const text = input.trim();
  return /^\S*clickup\.com\/t\/\S+$/i.test(text) || /^CU-[a-z0-9]+$/i.test(text);
}

async function call<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ClickUp ${res.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

type ClickUpTask = {
  id: string;
  custom_id?: string | null;
  name: string;
  url: string;
  markdown_description?: string | null;
  text_content?: string | null;
  description?: string | null;
  attachments?: { title?: string; url: string }[];
  checklists?: { name: string; items: { name: string }[] }[];
  tags?: { name: string }[];
};

export async function fetchClickUpTask(ref: ClickUpRef): Promise<TaskBrief> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    throw new Error("CLICKUP_API_TOKEN is not set. Add it to .env.local, or describe the task as a prompt instead.");
  }
  const teamId = ref.teamId ?? process.env.CLICKUP_TEAM_ID;
  if (ref.custom && !teamId) {
    throw new Error(`"${ref.id}" is a custom task ID; set CLICKUP_TEAM_ID in .env.local or paste the task link.`);
  }
  const custom = ref.custom ? `&custom_task_ids=true&team_id=${encodeURIComponent(teamId!)}` : "";
  const id = encodeURIComponent(ref.id);

  const task = await call<ClickUpTask>(`/task/${id}?include_markdown_description=true${custom}`, token);
  const comments = await call<{ comments: { comment_text: string; user?: { username?: string } }[] }>(
    `/task/${encodeURIComponent(task.id)}/comment`,
    token,
  ).catch(() => ({ comments: [] }));

  const acceptanceCriteria = (task.checklists ?? []).flatMap((c) => c.items.map((i) => i.name));
  return {
    source: "clickup",
    clickupId: task.custom_id || task.id,
    url: task.url,
    title: task.name,
    description: task.markdown_description || task.text_content || task.description || "",
    acceptanceCriteria,
    comments: comments.comments
      .map((c) => `${c.user?.username ?? "someone"}: ${c.comment_text}`.trim())
      .filter((c) => c.length > 0),
    attachments: (task.attachments ?? []).map((a) => ({ name: a.title ?? a.url, url: a.url })),
    clarifications: [],
  };
}
