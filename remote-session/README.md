# Shared Claude session with remote workspaces

This experimental entry point uses the Claude Pro/Max login saved on the host. It has no API-key mode. It does not copy Claude credentials to developers or accept Claude tokens from them. Anthropic may reject this use of a subscription; successful local tests do not establish provider acceptance.

```text
Developer browser → ngrok → host portal + Claude session
                                  ↕ authenticated WebSocket
                           developer workspace connector
                                  ↕
                          local files and commands
```

The agent orchestration runs on the host. Project reads, writes, and commands run on the developer's device. Requested file contents and command output transit the host and Anthropic. A browser alone cannot access the developer's filesystem: the connector must be running.

## Host setup

Use Node 22.5 or newer, install this repository's dependencies, and sign in to Claude Code on the host using its normal login flow. The host process must run as that same OS user, with access to the saved login. A subscription token supplied only through an environment variable is not used by this entry point.

```bash
npm install
npm run login
```

Create a separate invitation for each developer:

```bash
npm run share -- invite Alice
```

This prints a user ID, a browser access code, and a connector token once. Store the user ID for revocation. Send the two codes privately to that developer. These codes authenticate to Aviator; they are not Anthropic credentials. The database stores only hashes of the codes in `.aviator-share/share.db` (override with `SHARE_DATA_DIR`).

Start your ngrok tunnel, then configure the exact HTTPS origin it displays:

```bash
ngrok http 8081
```

In another terminal:

```bash
SHARE_PUBLIC_URL=https://YOUR-DOMAIN.ngrok-free.app npm run share
```

The service binds to loopback on port 8081 (`SHARE_PORT` overrides this). Share that HTTPS link and the private codes. Keep both the service and ngrok running. For local testing, omit `SHARE_PUBLIC_URL` and use `http://127.0.0.1:8081` exactly.

## Developer setup

Install this checkout and its dependencies on the developer's device. They do not need a Claude login for this connector.

```bash
npm install
read -rsp 'Connector token: ' AVIATOR_CONNECTOR_TOKEN
export AVIATOR_CONNECTOR_TOKEN
npm run share:connect -- https://YOUR-DOMAIN.ngrok-free.app /absolute/path/to/project
unset AVIATOR_CONNECTOR_TOKEN
```

The example uses Bash; on another shell set the environment variable using that shell's syntax. Keep this terminal open. In the shared browser link, enter the **browser access code**, then submit a task. Reads and directory listings are automatic. Approve or deny each file write and command in the connector terminal. No action is approved by silence.

Commands have the developer's OS user permissions, including access beyond the selected folder if the approved command requests it. File tools reject traversal, symlinks, and common credential paths, but these checks are not an OS sandbox. Use a dedicated OS account, container, or VM for stronger isolation. Do not approve a command you do not trust.

The host's built-in Claude filesystem and shell tools are disabled; only the remote workspace tools are exposed. The host starts each task in an empty temporary directory and does not load local project settings. The connector's authentication token is excluded from shell subprocess environments.

## Controls and limits

- One task at a time across the host, at most 50 model turns and 20 minutes per task.
- File reads/writes: 64 KiB. Commands: 120 seconds and bounded output. Local approval plus execution: five-minute tool deadline.
- Cancellation or disconnection aborts the Claude task and requests cancellation of active device tools. Already-written files remain; review changes with git.
- Browser sessions expire after eight hours. Connector and access codes last until revoked. Revoke and issue a new invitation to rotate them.
- A task request key prevents duplicate execution within the retained in-memory history. Tasks, browser sessions, and the last ten task records per developer are lost on host restart. Do not automatically retry an uncertain submission after restart without inspecting the project.
- Each task starts a fresh model session. Include relevant context in follow-up tasks. No automatic project upload, git push, or deployment is provided.
- The host refuses to release a prompt unless the SDK reports a Pro/Max subscription and no API-key source. Subscription limit/overage events stop the task; keep paid extra usage disabled in your Claude account if you require subscription-only spending.

Revoke a developer:

```bash
npm run share -- revoke USER-ID
```

New browser/API requests are rejected immediately. Connected devices are disconnected within 25 seconds. Stopping a job cannot undo completed changes.

## HTTP interface

Browser mutations require the configured exact Origin and an HttpOnly session cookie. Programmatic calls can use the **browser access code** in an Authorization Bearer header. Connector tokens are accepted only at `/connect`.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/login` | `{ "token": "browser-access-code" }`; creates session |
| POST | `/logout` | Removes browser session |
| GET | `/api/status` | Own device connectivity and latest job ID |
| POST | `/api/jobs` | `{ "text": "task", "key": "unique-16-to-128-character-key" }`; returns 202 and job ID |
| GET | `/api/jobs/:id` | Own job state and bounded event history |
| POST | `/api/jobs/:id/cancel` | Cancels own task |
| WS | `/connect` | Outbound developer connector, using its separate token |

Responses include 401 for missing/revoked authentication, 403 for a rejected Origin, 404 for another developer's or unknown job, 409 for a busy host or conflicting request key, and 503 for an offline connector.

## Verification

```bash
npm run test:share
npm run build
npm run typecheck
```

Tests exercise a real local HTTP/WebSocket server with a simulated Claude session, plus workspace permission checks and SDK authentication gating. They do not call Anthropic, consume a subscription, or verify live subscription acceptance. Before sharing externally, perform a small live task against a disposable project and review its diff. No public tunnel or live task is started by the tests.
