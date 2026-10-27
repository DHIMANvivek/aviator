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

## Shared host login with projects on developer devices

The experimental `npm run share` portal keeps your saved Claude Pro/Max login on the host and
routes project tools to a connector on each developer's device. It requires no API key.
See [remote-session setup and limitations](remote-session/README.md) for invitations, ngrok,
local command approvals, and the distinction between host orchestration and device execution.

## One address for everyone: the hub

Each person runs Aviator on their own computer; a small hub server gives everyone the same link
and sends each signed-in person to *their* computer. Nobody's code touches the hub or anyone
else's machine.

```
                        https://aviator.example.com   (same link for everyone)
                                     │
 Alice's browser ──► ┌───────────────┴───────────────┐ ◄── outbound WebSocket ── Alice's PC: Aviator + runner
                     │ hub/server.mjs                │
 Bob's browser   ──► │ sign-in · user → computer     │ ◄── outbound WebSocket ── Bob's PC:   Aviator + runner
                     └───────────────────────────────┘
```

**Run the hub** (any always-on Node 22.5+ host, not serverless: it holds connections open):

```bash
npm run hub                     # http://localhost:8080; or deploy hub/ with its Dockerfile / fly.toml
```

Settings: `HUB_PUBLIC_URL` (e.g. `https://aviator.example.com`), `HUB_TRUST_PROXY=1` behind a TLS
proxy, `HUB_DATA_DIR` (SQLite file, default `./.hub`), `HUB_ALLOWED_EMAILS` to limit sign-ups.

**Add a computer**: sign up on the hub, click **Add my computer**, and run the command it shows in
an Aviator checkout on that computer:

```bash
npm run runner -- pair K7Q-4XM --hub https://aviator.example.com   # once; saves ~/.aviator/runner.json
npm run runner                                                     # afterwards: builds if needed, starts, connects
npm run runner -- install-service                                  # optional: start at login (systemd, launchd, Task Scheduler)
```

The runner starts Aviator as a production build on `127.0.0.1:3210`, opens an outbound connection
to the hub (no open ports, no ngrok) and replays the hub's requests against it, streaming answers
back (live run updates included). Each person signs in to Claude on their own computer; for other
people, use API-key auth (see above).

- **Several computers**: each is listed on the hub's **Your computers** page; pick one per device.
- **From your phone**: when the hub sees the browser on a different address than the computer,
  **Choose folder…** opens an in-page folder browser instead of the native dialog, and the
  "open folder" / "VS Code" buttons are hidden (they'd open on the computer's screen).
- **Privacy**: the hub stores accounts and which computer belongs to whom. Transcripts and diffs
  pass through it (encrypted in transit with HTTPS) but are never saved there.
- Removing a computer on the hub disconnects it right away; `npm run runner -- unpair` forgets the
  link on the computer.

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
| `hub/server.mjs` | The hub: accounts, pairing codes, user → computer routing over WebSockets |
| `runner/aviator-runner.mjs` | The runner: pairs this computer, starts Aviator, relays the hub's requests to it |

## Configuration (`.env.local`, all optional)

See `.env.example`: `AVIATOR_AUTH`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `AVIATOR_DATA_DIR`, `AVIATOR_DEMO`.

Each repo's `CLAUDE.md` is loaded by every agent, so your conventions apply automatically.

## License

MIT, see [LICENSE](LICENSE).
