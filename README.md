# ✻ Aviator

A Claude Code-style cockpit that turns a ClickUp task or a prompt into finished, **unpushed** code
changes. A team of agents works on it: a researcher, a planner, backend and frontend builders,
QA, and a reporter. You watch each agent's thinking and tool calls live and approve the plan.
At the end you get a before/after report with the diff. Under the hood every agent is a
Claude Code session run through the Claude Agent SDK.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3210
```

Then in the app:
1. Click **Sign in with Claude** (uses your Pro/Max subscription; paste the code Claude shows you).
2. `/new-project`, then **Choose folder…** to pick your repo(s) in the system folder dialog.
3. Describe a task or paste a ClickUp link.

Try the UI without using any Claude usage: `npm run demo` (http://localhost:3100). Every run there
is the same scripted example (an S3 photo upload) whatever you type; it never calls Claude or
touches git, and a yellow banner marks it.

## Signing in: your Claude Code login, no API key

```
 Aviator (Next.js server)
   │  query() from @anthropic-ai/claude-agent-sdk
   ▼
 Claude Code engine (bundled with the SDK, one process per agent)
   │  reads your login from macOS Keychain / ~/.claude and refreshes it itself
   ▼
 Claude, billed to your Pro/Max subscription usage
```

- **Default (`AVIATOR_AUTH=claude-code`)**: agents run on your Claude Code login (OAuth). Aviator
  never reads, copies or stores the token; the Claude Code engine handles it, including refresh.
- **Sign in with Claude** in the app (or `/login`, or `npm run login` from the aviator folder) runs
  `claude auth login --claudeai` with the Claude Code binary that ships
  inside the SDK, so you don't need a separate Claude Code install. `npm run auth:status` shows
  which account the agents will use; `/status` in the app checks it too.
- **Headless machine?** `npm run setup-token` creates a long-lived subscription token. Put it in
  `.env.local` as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Safety**: in this mode `ANTHROPIC_API_KEY` is removed from the agents' environment, so a stray
  key can never switch you to pay-per-use billing. Variables from a surrounding Claude session
  (for example when started from Claude Code's terminal) are removed too, so agents always use
  your own login.
- **API billing instead**: set `AVIATOR_AUTH=api-key` and `ANTHROPIC_API_KEY`.
- **Included plan usage only, no dollars**: Aviator shows your plan usage as Claude reports it
  (for example "34% of 5-hour limit used · resets 6:00 PM") and tokens per agent; it never shows
  or sets dollar amounts. If Claude reports that it switched to paid extra usage or credits,
  Aviator stops the run immediately, and it won't start a new run while your plan limit is
  reached. For a hard guarantee, keep extra usage turned off in your Claude account settings,
  so requests past your limit are refused instead of billed.
- One run starts several agent sessions, so a big task can use a good share of a Pro plan's
  5-hour limit. Lower the effort in project settings for small tasks.
- **Personal use**: using your own subscription login on your own machine is how Claude Code
  itself works. If you ever offer Aviator to other people as a product, Anthropic's terms
  require API-key auth for that (claude.ai login can't be offered in third-party products
  without Anthropic's approval).

## Platforms

Works on macOS, Windows and Linux (Node 20+, git).
- **Folder picker**: Finder's dialog on macOS, the standard folder dialog on Windows, zenity
  (GNOME) or kdialog (KDE) on Linux. Without one, type the path.
- **Windows**: install Git for Windows; Claude Code uses its Git Bash (PowerShell commands are
  guarded by the same safety rules). `npm run demo` works in cmd and PowerShell.
- **Linux**: the right Claude Code build (glibc or musl) is picked automatically.

## Pipeline

```
ClickUp task / prompt
  → intake        task brief (title, description, checklist → acceptance criteria, comments)
  → prepare       new branch (or worktree) in each repo
  → researcher    read-only; asks you questions only if the task is genuinely ambiguous
  → planner       plan.md + contract.md + one task per builder; you approve or request changes
  → backend ║ frontend    in parallel, each limited to its own repo/folders,
                          messaging each other through the message_agent tool
  → qa            runs checks, reviews the diff; failures go back to the owning builder (3 rounds max)
  → reporter      before/after table, how it works, files, manual test steps, risks
  → done          nothing committed, nothing pushed
```

While a run is going, the one input box does three things:
- **Answers the researcher** when it asks a question.
- **Gives plan feedback** when a plan is waiting; the planner revises it.
- **Steers running agents** at any other time. Start with `@backend` or `@frontend` to target one.

Messages reach a running agent mid-session, because the session takes streaming input.

## Make it yours

**Agents page** (`⚙ Agents` or `/agents`)
- Per-agent model (only what your plan offers), effort, max turns and thinking display. Presets:
  **Balanced** (research and planning extra high, coding medium, QA high, report low; the default),
  **Save usage**, **Max quality**.
- Edit every prompt: the rules all agents share and each agent's role, with preview, reset to
  default, and version history. Each run shows each agent's **Instructions**: exactly what it was told.

**Custom agents** (also on the Agents page; six templates to start from)
- Name, purpose, prompt, model/effort/turns, built-in tools, which folders it may change, and which
  connected tools it may use.
- Run it **at a pipeline step** (after research, after planning, after building, before the report):
  its notes feed the next stage, and "blocker" findings after building go back to the builder that
  owns them before QA.
- Or **on demand**: built-in agents call it when its purpose fits (e.g. a test writer for the backend).
  Its work shows under its own name, with its own folder and tool limits.

**Connections** (`⚡ Connections` or `/connections`): MCP tool servers
- Local command or URL; **Test** lists the tools. For each tool, say what it's for (added to the
  agents' prompts), whether it's allowed (destructive-looking tools start off), and which agents may
  use it. Keys and tokens are stored only in `.aviator/connections.json` (owner-only), masked in the
  UI, never logged or committed.

**Screenshots**: paste, drop or 📎 attach images in the chat box. They go to the researcher, planner
and builders as images (and to running agents when you steer), and show in the transcript.

## Safety rules (enforced in code, `src/lib/agents/guard.ts`)

- No `git commit/push/checkout/reset/...`, no `gh pr`, no package publishing.
- No AWS/terraform/kubectl/deploy commands, no `sudo`, no `curl | sh`.
- `.env` and key files can't be read or written.
- Builders can only write inside their own repo or folders. The researcher, planner, QA and
  reporter are read-only.
- Branch mode refuses to start on a repo with uncommitted changes, so the final diff contains
  only the agents' work.

## Project layout

| Path | What it does |
|---|---|
| `src/lib/auth.ts` | Sign-in mode, clean agent environment, account check |
| `src/lib/agents/pipeline.ts` | Orchestrator: stages, approval, parallel builders, custom step agents, QA loop, report |
| `src/lib/agents/prompts.ts` | Default prompts as editable templates |
| `src/lib/agentPresets.ts`, `src/lib/agentSettings.ts` | Per-agent settings, presets, custom agents, prompt history (`.aviator/agents.json`) |
| `src/lib/connections.ts` | MCP connections, per-agent tool permissions, connection test |
| `src/lib/agents/runAgent.ts` | One agent = one Agent SDK session; streams thinking/tools to the UI |
| `src/lib/agents/definitions.ts` | Agent roles, tools, structured output schemas |
| `src/lib/agents/guard.ts` | Tool-call safety rules |
| `src/lib/agents/demo.ts` | Scripted demo run |
| `src/lib/git.ts` | Branch/worktree setup and diffs |
| `src/lib/clickup.ts` | ClickUp task + comments → task brief |
| `src/lib/runtime.ts` | Live event log (SSE), answers/approvals/steering, agent mailboxes |
| `src/lib/store.ts` | JSON storage in `.aviator/` (projects, runs, event logs for replay) |
| `src/components/*` | Claude Code-style UI |
| `scripts/claude.mjs` | Runs the SDK's bundled Claude Code binary (login, status, setup-token) |

## Configuration (`.env.local`, all optional)

See `.env.example`: `AVIATOR_AUTH`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `AVIATOR_DATA_DIR`, `AVIATOR_DEMO`.

Each repo's `CLAUDE.md` is loaded by every agent, so your conventions apply automatically.

## License

MIT, see [LICENSE](LICENSE).
