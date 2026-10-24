import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AuthStatus } from "./types";

// How agents authenticate.
//
// "claude-code" (default): agents run on your Claude Code login, i.e. your Claude
// subscription (Pro/Max) over OAuth. The Agent SDK launches the Claude Code engine, which
// reads the login you already have (macOS Keychain or ~/.claude) and refreshes it itself.
// Aviator never reads, copies or stores that token. For a headless machine, run
// `claude setup-token` and put the result in CLAUDE_CODE_OAUTH_TOKEN.
// API-key variables are removed from the agents' environment in this mode, so a stray
// ANTHROPIC_API_KEY can never switch you to pay-per-use billing.
//
// "api-key": agents use ANTHROPIC_API_KEY (pay-per-use API billing).

export type AuthMode = "claude-code" | "api-key";

export function authMode(): AuthMode {
  return process.env.AVIATOR_AUTH === "api-key" ? "api-key" : "claude-code";
}

/**
 * Variables a surrounding Claude session (Claude Code terminal, Claude desktop app) sets for
 * its own child processes. Agents must not inherit them, or they would act as part of that
 * session instead of using your own Claude Code login.
 */
const HOST_SESSION_VAR = /^CLAUDE(CODE|_CODE_|_AGENT_SDK_|_PID|_EFFORT|_PREVIEW_)/;

/** process.env without a surrounding Claude session's variables. */
export function cleanHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (HOST_SESSION_VAR.test(key) && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
  }
  return env;
}

export function agentEnv(): Record<string, string | undefined> {
  const env = cleanHostEnv();
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "aviator/0.1.0";
  if (authMode() === "claude-code") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

let cached: { at: number; status: AuthStatus } | undefined;
const CACHE_MS = 60_000;

/**
 * Asks the Claude Code engine which account it would use. It sends no prompt, so it uses
 * none of your plan's usage.
 */
export async function checkAuth(force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const mode = authMode();
  let close: (() => void) | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => (close = () => resolve({ done: true, value: undefined }))),
    }),
  };
  const q = query({ prompt: idle, options: { env: agentEnv(), settingSources: [], persistSession: false } });
  let status: AuthStatus;
  try {
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out. macOS may be asking for Keychain access; click Allow.")), 30_000),
      ),
    ]);
    const signedIn = !!(info.subscriptionType || info.email || (info.apiKeySource && info.apiKeySource !== "none"));
    status = {
      mode,
      ok: signedIn,
      plan: info.subscriptionType,
      email: info.email,
      source: info.tokenSource || info.apiKeySource,
      error: signedIn
        ? undefined
        : mode === "claude-code"
          ? "Not signed in to Claude yet. Click \"Sign in with Claude\" (or type /login) to use your Claude subscription."
          : "AVIATOR_AUTH=api-key but ANTHROPIC_API_KEY is not set.",
    };
  } catch (err) {
    status = { mode, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    close?.();
    q.close();
  }
  cached = { at: Date.now(), status };
  return status;
}
