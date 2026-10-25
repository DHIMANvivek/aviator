import type { AgentName, TaskBrief } from "../types";

// Each agent's tools and the JSON shape it must return. Prompts are editable templates in
// prompts.ts; model, effort and turns are per-agent settings (agentPresets.ts, agentSettings.ts).

export const AGENT_TOOLS: Record<AgentName, string[]> = {
  researcher: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
  planner: ["Read", "Grep", "Glob"],
  backend: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "TodoWrite"],
  frontend: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "TodoWrite"],
  qa: ["Read", "Grep", "Glob", "Bash"],
  reporter: ["Read", "Grep", "Glob"],
};

export function briefMarkdown(brief: TaskBrief): string {
  const parts = [`# Task: ${brief.title}`];
  if (brief.clickupId) parts.push(`ClickUp: ${brief.clickupId}${brief.url ? ` (${brief.url})` : ""}`);
  if (brief.description) parts.push(`## Description\n${brief.description}`);
  if (brief.acceptanceCriteria.length) {
    parts.push(`## Acceptance criteria\n${brief.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  if (brief.comments.length) parts.push(`## Comments\n${brief.comments.map((c) => `- ${c}`).join("\n")}`);
  if (brief.attachments.length) {
    parts.push(`## Attachments\n${brief.attachments.map((a) => `- ${a.name}: ${a.url}`).join("\n")}`);
  }
  for (const c of brief.clarifications) {
    parts.push(
      `## Clarification from the developer\nQuestions:\n${c.questions.map((q) => `- ${q}`).join("\n")}\n\nAnswer:\n${c.answer}`,
    );
  }
  return parts.join("\n\n");
}

// ---------- structured output schemas ----------

const str = { type: "string" };
const strList = { type: "array", items: str };
const owner = { type: "string", enum: ["backend", "frontend"] };

function obj(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const SCHEMAS = {
  researcher: obj({
    clear: { type: "boolean" },
    questions: strList,
    taskType: { type: "string", enum: ["feature", "bug", "chore"] },
    areas: { type: "array", items: owner },
    relevantFiles: strList,
    summary: str,
  }),
  planner: obj({
    planMd: str,
    contractMd: str,
    backendTask: str,
    frontendTask: str,
    acceptanceCriteria: strList,
    risks: strList,
  }),
  qa: obj({
    passed: { type: "boolean" },
    checks: { type: "array", items: obj({ command: str, passed: { type: "boolean" }, summary: str }) },
    failures: { type: "array", items: obj({ owner, summary: str, details: str }) },
    reviewNotes: strList,
  }),
  /** Custom agents placed at a pipeline step. */
  step: obj({
    summary: str,
    findings: {
      type: "array",
      items: obj({
        owner: { type: "string", enum: ["backend", "frontend", "none"] },
        severity: { type: "string", enum: ["blocker", "suggestion"] },
        summary: str,
        details: str,
      }),
    },
  }),
  reporter: obj({
    summary: str,
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    confidenceReason: str,
    beforeAfter: { type: "array", items: obj({ area: str, before: str, after: str }) },
    howItWorks: str,
    files: { type: "array", items: obj({ path: str, change: str }) },
    manualTestSteps: strList,
    risks: strList,
  }),
} as const;
