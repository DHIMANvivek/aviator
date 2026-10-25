// MCP connections: tool servers you connect so agents can use your own tools (screenshots, Figma,
// Sentry, GitHub, databases…). Pure types and helpers, shared by the server and the UI.

/** What one tool of a connection is for, and which agents may use it. */
export type ToolRule = {
  name: string;
  description?: string;
  /** Added to the agents' prompts: "use it for …". */
  purpose: string;
  /** Agent ids (built-in or custom). Empty = the connection's agents. */
  agents: string[];
  /** Off for tools that look destructive until you allow them. */
  allowed: boolean;
  destructive?: boolean;
  readOnly?: boolean;
};

export type Connection = {
  /** Server name agents see in tool names: mcp__<id>__<tool>. */
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  /** Local command (stdio). */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Remote server (http/sse). */
  url: string;
  headers: Record<string, string>;
  /** Agents that may use this connection's allowed tools. */
  agents: string[];
  /** Tools found by the last Test, with your rules. */
  tools: ToolRule[];
  enabled: boolean;
  lastStatus?: string;
  lastError?: string;
  testedAt?: number;
};

/** Shown instead of saved secret values; sending it back keeps the saved value. */
export const MASK = "••••••••";

/** Tool names that look destructive need an explicit allow. */
export const RISKY_TOOL = /(delete|remove|drop|destroy|deploy|publish|merge|push|send|truncate|revoke|terminate|kill|reset|wipe|transfer|payment|charge)/i;

export const CONNECTION_EXAMPLES: { name: string; note: string; conn: Partial<Connection> }[] = [
  {
    name: "Playwright",
    note: "Open pages in a browser and take screenshots (great for UI review).",
    conn: { name: "Playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
  },
  {
    name: "GitHub",
    note: "Issues, pull requests and code search. Needs a GitHub token in the Authorization header.",
    conn: { name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer YOUR_TOKEN" } },
  },
  {
    name: "Figma (desktop app)",
    note: "Read designs from the Figma desktop app (turn on its MCP server first).",
    conn: { name: "Figma", transport: "http", url: "http://127.0.0.1:3845/mcp" },
  },
  {
    name: "Docs folder",
    note: "Let agents read a folder of specs or docs outside the repo.",
    conn: {
      name: "Docs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/docs"],
    },
  },
];

export function connectionSlug(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return !id || id === "aviator" ? `${id || "tool"}_mcp` : id;
}
