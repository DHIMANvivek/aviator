// Runs the Claude Code binary that ships with the Agent SDK, so you can sign in without
// installing the Claude Code CLI separately:
//   npm run login          sign in with your Claude subscription (opens the browser)
//   npm run auth:status    show which account Aviator's agents will use
//   npm run setup-token    long-lived subscription token for CLAUDE_CODE_OAUTH_TOKEN
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
// macOS, Windows (claude.exe) and Linux, including the -musl builds used on Alpine.
const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
let binary;
for (const pkg of [base, `${base}-musl`]) {
  try {
    binary = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
    break;
  } catch {
    // not installed for this platform; try the next candidate
  }
}
if (!binary) {
  console.error(`Couldn't find ${base}. Run npm install first.`);
  process.exit(1);
}

// Same clean environment the agents get (see src/lib/auth.ts): no variables from a
// surrounding Claude session, so the login lands in your normal Claude Code config.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if ((/^CLAUDE(CODE|_CODE_|_AGENT_SDK_|_PID|_EFFORT|_PREVIEW_)/.test(key)) && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
