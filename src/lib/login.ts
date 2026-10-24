import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { checkAuth, cleanHostEnv } from "./auth";
import { claudeBinary } from "./claudeBinary";

// In-app "Sign in with Claude": runs `claude auth login --claudeai` with the Claude Code binary
// bundled in the Agent SDK. The browser part (approving access on claude.com) happens in your
// own browser; Claude then shows a one-time code that you paste into Aviator, which hands it to
// the login process. Claude Code stores the resulting login itself; Aviator never sees a token.

export type LoginStatus = {
  state: "idle" | "waiting" | "verifying" | "done" | "failed";
  url?: string;
  message?: string;
};

type LoginRuntime = { child?: ChildProcessWithoutNullStreams; status: LoginStatus; output: string; timer?: NodeJS.Timeout };

const g = globalThis as unknown as { __aviatorLogin?: LoginRuntime };
const rt: LoginRuntime = g.__aviatorLogin ?? (g.__aviatorLogin = { status: { state: "idle" }, output: "" });

const TIMEOUT_MS = 10 * 60_000;

function lastLines(text: string): string {
  return text
    .replace(/https:\/\/\S+/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Paste code here"))
    .slice(-3)
    .join(" ");
}

export function loginStatus(): LoginStatus {
  return rt.status;
}

export function startLogin(): LoginStatus {
  if (rt.child && rt.status.state !== "failed") return rt.status;
  rt.output = "";
  rt.status = { state: "waiting" };
  // On macOS/Linux, BROWSER=true (a no-op command) stops the CLI from opening a second
  // browser tab, since the UI opens the link. Windows has no `true` command, so there the
  // CLI opens your default browser itself and the UI's button is a fallback.
  const env = cleanHostEnv();
  if (process.platform !== "win32") env.BROWSER = "true";
  const child = spawn(claudeBinary(), ["auth", "login", "--claudeai"], { env, stdio: "pipe", windowsHide: true });
  rt.child = child;
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    rt.output = (rt.output + text).slice(-20_000);
    const url = rt.output.match(/https:\/\/\S*oauth\/authorize\S*/)?.[0];
    if (url && !rt.status.url) rt.status = { ...rt.status, url };
    // A malformed code is rejected but the login keeps waiting for another try.
    if (/invalid code/i.test(text)) {
      rt.status = { ...rt.status, state: "waiting", message: "That code wasn't accepted. Copy the whole code from Claude and paste it again." };
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (rt.child !== child) return;
    rt.child = undefined;
    clearTimeout(rt.timer);
    if (code === 0) {
      rt.status = { state: "done", message: lastLines(rt.output) || "Signed in." };
      void checkAuth(true);
    } else if (rt.status.state !== "failed") {
      rt.status = { state: "failed", message: lastLines(rt.output) || `Sign-in exited with code ${code}.` };
    }
  });
  child.on("error", (err) => {
    rt.status = { state: "failed", message: err.message };
  });
  rt.timer = setTimeout(() => {
    rt.status = { state: "failed", message: "Sign-in timed out after 10 minutes. Try again." };
    child.kill();
  }, TIMEOUT_MS);
  return rt.status;
}

export function submitLoginCode(code: string): LoginStatus {
  const trimmed = code.trim();
  if (!rt.child) return (rt.status = { state: "failed", message: "No sign-in in progress. Start again." });
  if (!trimmed) return rt.status;
  rt.child.stdin.write(`${trimmed}\n`);
  rt.status = { ...rt.status, state: "verifying", message: undefined };
  return rt.status;
}

export function cancelLogin(): LoginStatus {
  rt.child?.kill();
  rt.child = undefined;
  clearTimeout(rt.timer);
  rt.status = { state: "idle" };
  return rt.status;
}
