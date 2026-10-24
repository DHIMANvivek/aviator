import path from "node:path";

// Safety rules enforced in code on every tool call, whatever the prompt says:
// nothing is committed or pushed, secrets aren't read, cloud/deploy commands
// don't run, and builders only write inside the folders they own.

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

const SECRET_FILE = /(^|[\\/])(\.env(?!\.(example|sample|template|dist)\b)[^\\/]*|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]+\.pem|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

const BLOCKED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\bgit\s+(-C\s+\S+\s+)?(push|commit|reset|rebase|merge|cherry-pick|revert|checkout|switch|stash|clean|remote|tag|worktree|config|filter-branch|update-ref|am|pull|fetch)\b/,
    reason: "Aviator manages git itself. Agents never commit, push or change branches.",
  },
  { pattern: /\bgit\s+branch\s+-[dDmMf]/, reason: "Aviator manages branches itself." },
  { pattern: /\bgh\s+(pr|release|repo)\b/, reason: "Publishing to GitHub is up to the developer." },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/, reason: "Publishing packages is not allowed." },
  { pattern: /\baws\s+(?!--version\b)\S/, reason: "AWS CLI calls touch real cloud resources. Use mocks or local stubs in tests." },
  { pattern: /\b(terraform|pulumi|cdk)\s+(apply|destroy|deploy|up)\b/, reason: "Infrastructure changes are not allowed." },
  { pattern: /\b(kubectl|helm)\s+(apply|delete|install|upgrade|rollout)\b/, reason: "Cluster changes are not allowed." },
  { pattern: /\b(vercel|netlify|fly|heroku|firebase)\s+(deploy|--prod)/, reason: "Deploys are not allowed." },
  { pattern: /\bsudo\b/, reason: "sudo is not allowed." },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, reason: "Recursive delete outside the project is not allowed." },
  // Windows (PowerShell / cmd) equivalents
  {
    pattern: /\b(Remove-Item|rm|ri|del|rd|rmdir)\b[^|;]*(-Recurse|\/s)\b[^|;]*([A-Za-z]:\\?(\s|$|["'])|~|\$HOME|\$env:USERPROFILE|\.\.)/i,
    reason: "Recursive delete outside the project is not allowed.",
  },
  { pattern: /\b(format|diskpart|reg\s+(add|delete)|Set-ExecutionPolicy|Start-Process\b[^|;]*-Verb\s+RunAs)\b/i, reason: "System changes are not allowed." },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, reason: "Piping downloads into a shell is not allowed." },
  { pattern: /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i, reason: "Piping downloads into a shell is not allowed." },
  {
    pattern: /(^|[\s"'=/\\])\.env(?!\.(example|sample|template|dist)\b)(\.[\w-]+)?(\s|$|["'])/,
    reason: "Reading .env files is blocked so secrets never reach the model or logs.",
  },
];

/** Shell tools: Bash everywhere, plus PowerShell on Windows. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export type GuardScope = {
  /** Absolute folders this agent may modify. Empty = read-only agent. */
  writableRoots: string[];
  cwd: string;
};

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function checkTool(scope: GuardScope, toolName: string, input: Record<string, unknown>): GuardDecision {
  if (WRITE_TOOLS.has(toolName)) {
    const target = str(input.file_path) || str(input.notebook_path);
    if (!target) return { allow: false, reason: "Missing file path." };
    const abs = path.resolve(scope.cwd, target);
    if (SECRET_FILE.test(abs)) return { allow: false, reason: "Writing secret files (.env, keys) is blocked." };
    if (scope.writableRoots.length === 0) return { allow: false, reason: "This agent is read-only." };
    if (!scope.writableRoots.some((root) => inside(abs, root))) {
      return {
        allow: false,
        reason: `You can only modify files under: ${scope.writableRoots.join(", ")}. Ask the other agent via message_agent if a change is needed elsewhere.`,
      };
    }
    return { allow: true };
  }

  if (READ_TOOLS.has(toolName)) {
    const target = str(input.file_path) || str(input.path) || str(input.pattern);
    if (target && SECRET_FILE.test(target)) {
      return { allow: false, reason: "Reading .env and key files is blocked so secrets never reach the model or logs." };
    }
    return { allow: true };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = str(input.command);
    for (const rule of BLOCKED_COMMANDS) {
      if (rule.pattern.test(command)) return { allow: false, reason: rule.reason };
    }
    return { allow: true };
  }

  return { allow: true };
}
