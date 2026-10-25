import { getLive } from "../runtime";
import type { BuilderName, PlanOutput, QaOutput, RepoDiff, ReportOutput, ResearchOutput, Run, TaskBrief } from "../types";
import { EXTRA_USAGE_STOP, type AgentHost, type AgentRequest, type AgentResult } from "./runAgent";

// AVIATOR_DEMO=1: a scripted run (an S3 image-upload feature) that exercises every part of
// the UI without calling Claude or touching git. Nothing here is real agent output.

type Step =
  | { think: string }
  | { say: string }
  | { tool: string; input: Record<string, unknown>; summary: string; result: string; error?: boolean }
  | { denied: string; reason: string }
  | { relay: BuilderName; text: string };

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function demoBrief(id: string): TaskBrief {
  return {
    source: "clickup",
    clickupId: id,
    url: `https://app.clickup.com/t/${id}`,
    title: "Capture profile photos and upload them to S3",
    description:
      "Users should be able to take a photo with their camera (or pick an image) on the profile page and save it as their avatar. Store images in our S3 bucket using PutObject. Max 5 MB, JPEG/PNG/WebP only.",
    acceptanceCriteria: [
      "User can capture a photo from the camera or pick a file",
      "Images over 5 MB or with other types are rejected with a clear message",
      "Image is stored in S3 under avatars/<userId>/",
      "Profile shows the new avatar after upload",
    ],
    comments: ["priya: please don't make the bucket public, use presigned URLs"],
    attachments: [{ name: "profile-mockup.png", url: "https://example.com/profile-mockup.png" }],
    clarifications: [],
  };
}

const research = (clear: boolean): ResearchOutput => ({
  clear,
  questions: clear
    ? []
    : [
        "Should the browser upload straight to S3 with a presigned URL, or should images go through the API server?",
      ],
  taskType: "feature",
  areas: ["backend", "frontend"],
  relevantFiles: ["api/src/routes/profile.ts", "api/src/config.ts", "web/src/pages/Profile.tsx", "web/src/lib/api.ts"],
  summary: [
    "- **Backend** is Express + TypeScript (`api/src/app.ts`). Routes live in `api/src/routes/*` and use the `requireAuth` middleware; `req.user.id` holds the user.",
    "- No AWS SDK yet. Config is read via `api/src/config.ts` (zod-validated env). Add `S3_BUCKET` and `AWS_REGION` there.",
    "- `PATCH /profile` already updates `avatarUrl` on the user (Prisma, `prisma/schema.prisma`).",
    "- **Frontend** is React + Vite. `web/src/pages/Profile.tsx` renders the avatar; API calls go through `web/src/lib/api.ts` (fetch wrapper with auth).",
    "- Tests: `npm test` (vitest) in both apps; `npm run typecheck` in web.",
    "- Pattern to copy: `api/src/routes/profile.ts` for auth + validation, `web/src/components/AvatarBadge.tsx` for UI styling.",
  ].join("\n"),
});

const plan = (revised: boolean): PlanOutput => ({
  planMd: [
    revised ? "_Revised per your feedback._\n" : "",
    "1. **Backend**: add `POST /uploads/avatar/presign` that validates type and size and returns a presigned S3 PutObject URL for `avatars/<userId>/<uuid>.<ext>`.",
    "2. **Backend**: add `S3_BUCKET`, `AWS_REGION` to config and `.env.example`; tests with a mocked S3 client.",
    "3. **Frontend**: `ImageCapture` component (camera via `getUserMedia`, file picker fallback), client-side 5 MB / type checks.",
    "4. **Frontend**: upload to the presigned URL, then `PATCH /profile` with the returned `publicUrl`; show the new avatar.",
    revised ? "5. **Backend**: also cap presign requests at 10 per user per hour." : "",
  ]
    .filter(Boolean)
    .join("\n"),
  contractMd: [
    "`POST /uploads/avatar/presign` (auth required)",
    "```json",
    '{ "contentType": "image/jpeg", "size": 123456 }',
    "```",
    "→ `200`",
    "```json",
    '{ "uploadUrl": "https://…", "key": "avatars/u_1/3f2c.jpg", "publicUrl": "https://cdn…/avatars/u_1/3f2c.jpg", "expiresIn": 300 }',
    "```",
    "→ `400` `{ \"error\": \"unsupported_type\" | \"too_large\" }`",
  ].join("\n"),
  backendTask: "Implement the presign endpoint, config and tests as in the plan.",
  frontendTask: "Build ImageCapture, wire upload + profile update as in the plan.",
  acceptanceCriteria: demoBrief("x").acceptanceCriteria,
  risks: ["Bucket CORS must allow PUT from the web origin.", "The IAM role needs s3:PutObject on avatars/* only."],
});

const qa = (attempt: number): QaOutput =>
  attempt === 1
    ? {
        passed: false,
        checks: [
          { command: "npm test (api)", passed: true, summary: "12 passed" },
          { command: "npm test (web)", passed: false, summary: "1 failed: ImageCapture rejects files over 5 MB" },
          { command: "npm run typecheck (web)", passed: true, summary: "no errors" },
        ],
        failures: [
          {
            owner: "frontend",
            summary: "ImageCapture accepts a 6 MB file",
            details: "FAIL src/components/ImageCapture.test.tsx > rejects files over 5 MB\nExpected error message, got upload call. Size check uses 5_000_000 bytes and the test file is 5.5 MiB, but the check runs after compression.",
          },
        ],
        reviewNotes: ["Consider setting Cache-Control on uploaded avatars."],
      }
    : {
        passed: true,
        checks: [
          { command: "npm test (api)", passed: true, summary: "12 passed" },
          { command: "npm test (web)", passed: true, summary: "9 passed" },
          { command: "npm run typecheck (web)", passed: true, summary: "no errors" },
        ],
        failures: [],
        reviewNotes: ["Consider setting Cache-Control on uploaded avatars."],
      };

const report: ReportOutput = {
  summary:
    "Users can now capture or pick a profile photo and it's stored in S3 through a presigned PutObject URL. The bucket stays private, uploads never pass through the API server, and type and size are validated on both sides.",
  confidence: "high",
  confidenceReason: "All 21 tests and the typecheck pass; every acceptance criterion is covered by a test.",
  beforeAfter: [
    { area: "Profile photo", before: "Only an initials badge; no way to set a photo", after: "Capture from camera or pick a file, preview, then save" },
    { area: "Upload path", before: "None", after: "Browser → presigned S3 PUT (no file bytes through the API)" },
    { area: "Backend API", before: "No upload endpoints", after: "POST /uploads/avatar/presign returns uploadUrl, key, publicUrl" },
    { area: "Validation", before: "None", after: "JPEG/PNG/WebP only, ≤ 5 MB, checked in browser and API" },
    { area: "Config", before: "No AWS settings", after: "S3_BUCKET and AWS_REGION, documented in .env.example" },
  ],
  howItWorks: [
    "1. `ImageCapture` opens the camera (`getUserMedia`) or a file picker and checks type and size.",
    "2. It calls `POST /uploads/avatar/presign` with `contentType` and `size`.",
    "3. The API validates again and signs a `PutObjectCommand` for `avatars/<userId>/<uuid>.<ext>` (5-minute expiry).",
    "4. The browser `PUT`s the file straight to S3, then calls `PATCH /profile` with `publicUrl`.",
    "5. The profile page re-renders with the new avatar.",
  ].join("\n"),
  files: [
    { path: "api/src/routes/uploads.ts", change: "New presign endpoint with validation" },
    { path: "api/src/lib/s3.ts", change: "S3 client + presign helper" },
    { path: "api/src/config.ts", change: "S3_BUCKET, AWS_REGION" },
    { path: "api/src/routes/uploads.test.ts", change: "Tests with mocked S3" },
    { path: "web/src/components/ImageCapture.tsx", change: "Camera/file capture with checks" },
    { path: "web/src/pages/Profile.tsx", change: "Uses ImageCapture, refreshes avatar" },
  ],
  manualTestSteps: [
    "Set S3_BUCKET and AWS_REGION in api/.env and allow PUT from your web origin in the bucket CORS.",
    "Run both apps, open /profile, click Change photo, take a photo, Save.",
    "Check the object exists under avatars/<yourUserId>/ and the avatar updates.",
    "Try a 6 MB file and a .gif: both should show an error.",
  ],
  risks: ["Bucket CORS must allow PUT from the web origin.", "Scope the IAM policy to s3:PutObject on avatars/*."],
};

function script(req: AgentRequest, briefHasAnswers: boolean): { steps: Step[]; structured?: unknown; text: string } {
  const qaAttempt = Number(req.prompt.match(/QA pass (\d+)/)?.[1] ?? 1);
  const isFollowUp = !!req.resume;
  // A queued developer or peer message, delivered after the builder finished.
  if (isFollowUp && (req.agent === "backend" || req.agent === "frontend") && !req.prompt.startsWith("QA found")) {
    const message = req.prompt.match(/\[Message from[^\]]*\]\n([^\n]+)/)?.[1] ?? "the new request";
    return {
      steps: [
        { think: `New message after I finished: "${message}". Apply it without breaking what's done.` },
        { tool: "Edit", input: { file_path: `${req.agent === "frontend" ? "web/src/components/ImageCapture.tsx" : "api/src/routes/uploads.ts"}` }, summary: req.agent === "frontend" ? "web/src/components/ImageCapture.tsx" : "api/src/routes/uploads.ts", result: "Updated 1 location" },
        { tool: "Bash", input: { command: "npm test" }, summary: "npm test", result: "Tests  passed" },
        { say: `Done: ${message}.` },
      ],
      text: "Done.",
    };
  }
  switch (req.agent) {
    case "researcher":
      return {
        steps: [
          { think: "The task is an S3 image upload. I need to know the backend framework, how config/env is handled, whether an AWS SDK is already present, and how the profile page renders avatars." },
          { tool: "Grep", input: { pattern: "S3Client|aws-sdk" }, summary: '"S3Client|aws-sdk"', result: "No matches found" },
          { tool: "Glob", input: { pattern: "api/src/routes/*.ts" }, summary: "api/src/routes/*.ts", result: "api/src/routes/auth.ts\napi/src/routes/profile.ts\napi/src/routes/health.ts" },
          { tool: "Read", input: { file_path: "api/src/routes/profile.ts" }, summary: "api/src/routes/profile.ts", result: "import { Router } from 'express';\nimport { requireAuth } from '../middleware/auth';\n…\nrouter.patch('/profile', requireAuth, async (req, res) => {\n  const body = ProfileUpdate.parse(req.body);\n…" },
          { tool: "Read", input: { file_path: "web/src/pages/Profile.tsx" }, summary: "web/src/pages/Profile.tsx", result: "export function Profile() {\n  const { user } = useAuth();\n  return <AvatarBadge name={user.name} />\n…" },
          { tool: "WebSearch", input: { query: "aws sdk v3 getSignedUrl PutObjectCommand content-length" }, summary: "aws sdk v3 getSignedUrl PutObjectCommand content-length", result: "docs.aws.amazon.com — Uploading objects with presigned URLs (SDK for JavaScript v3) …" },
          { think: "There is no existing upload path. A presigned URL keeps the bucket private, which matches the comment, but whether to proxy through the API is a product choice worth confirming." },
        ],
        structured: research(briefHasAnswers),
        text: "Research complete.",
      };
    case "planner": {
      const revised = req.prompt.includes("Developer feedback");
      return {
        steps: [
          { think: revised ? "The developer wants rate limiting on presign. Add it to the backend task." : "Split into a backend presign endpoint and a frontend capture component, with a contract for the presign response." },
          { tool: "Read", input: { file_path: "api/src/config.ts" }, summary: "api/src/config.ts", result: "export const config = z.object({ DATABASE_URL: z.string(), … }).parse(process.env)" },
        ],
        structured: plan(revised),
        text: "Plan ready.",
      };
    }
    case "backend":
      return isFollowUp
        ? {
            steps: [
              { say: "Handling the new request." },
              { tool: "Edit", input: { file_path: "api/src/routes/uploads.ts" }, summary: "api/src/routes/uploads.ts", result: "Updated 1 location" },
              { tool: "Bash", input: { command: "npm test" }, summary: "npm test", result: " ✓ src/routes/uploads.test.ts (5)\n Test Files  4 passed\n Tests  12 passed" },
            ],
            text: "Done.",
          }
        : {
            steps: [
              { tool: "TodoWrite", input: { todos: [1, 2, 3, 4] }, summary: "4 todos", result: "Todos updated" },
              { tool: "Bash", input: { command: "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner" }, summary: "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner", result: "added 87 packages in 6s" },
              { tool: "Write", input: { file_path: "api/src/lib/s3.ts" }, summary: "api/src/lib/s3.ts", result: "File created (38 lines)" },
              { tool: "Write", input: { file_path: "api/src/routes/uploads.ts" }, summary: "api/src/routes/uploads.ts", result: "File created (52 lines)" },
              { relay: "frontend", text: "Presign response also includes `publicUrl` (CDN URL) so you can PATCH /profile without building the URL yourself. Contract unchanged otherwise." },
              { tool: "Edit", input: { file_path: "api/src/config.ts" }, summary: "api/src/config.ts", result: "Updated 1 location" },
              { tool: "Write", input: { file_path: "api/src/routes/uploads.test.ts" }, summary: "api/src/routes/uploads.test.ts", result: "File created (71 lines)" },
              { denied: "Bash(git commit -am \"add uploads\")", reason: "Aviator manages git itself. Agents never commit, push or change branches." },
              { tool: "Bash", input: { command: "npm test" }, summary: "npm test", result: " ✓ src/routes/uploads.test.ts (5)\n Test Files  4 passed\n Tests  12 passed" },
              { say: "Backend done: `POST /uploads/avatar/presign` with type/size validation, S3 helper, config and 5 tests. All 12 API tests pass." },
            ],
            text: "Backend done.",
          };
    case "frontend":
      return isFollowUp
        ? {
            steps: [
              { think: "The size check runs after compression, so a 6 MB original passes. Validate the original file before compressing." },
              { tool: "Edit", input: { file_path: "web/src/components/ImageCapture.tsx" }, summary: "web/src/components/ImageCapture.tsx", result: "Updated 2 locations" },
              { tool: "Bash", input: { command: "npm test -- ImageCapture" }, summary: "npm test -- ImageCapture", result: " ✓ src/components/ImageCapture.test.tsx (4)\n Tests  4 passed" },
              { say: "Fixed: size and type are now checked on the original file before compression." },
            ],
            text: "Fixed.",
          }
        : {
            steps: [
              { tool: "Read", input: { file_path: "web/src/components/AvatarBadge.tsx" }, summary: "web/src/components/AvatarBadge.tsx", result: "export function AvatarBadge({ name, url }: Props) { … }" },
              { tool: "Write", input: { file_path: "web/src/components/ImageCapture.tsx" }, summary: "web/src/components/ImageCapture.tsx", result: "File created (118 lines)" },
              { tool: "Edit", input: { file_path: "web/src/lib/api.ts" }, summary: "web/src/lib/api.ts", result: "Updated 1 location" },
              { tool: "Edit", input: { file_path: "web/src/pages/Profile.tsx" }, summary: "web/src/pages/Profile.tsx", result: "Updated 2 locations" },
              { tool: "Write", input: { file_path: "web/src/components/ImageCapture.test.tsx" }, summary: "web/src/components/ImageCapture.test.tsx", result: "File created (64 lines)" },
              { tool: "Bash", input: { command: "npm run typecheck" }, summary: "npm run typecheck", result: "tsc --noEmit\n(no errors)" },
              { say: "Frontend done: `ImageCapture` with camera + file picker, upload via presigned URL, profile refresh. Using `publicUrl` from the backend's message." },
            ],
            text: "Frontend done.",
          };
    case "qa":
      return {
        steps: [
          { tool: "Bash", input: { command: "npm test" }, summary: "cd api && npm test", result: "Tests  12 passed" },
          qaAttempt === 1
            ? { tool: "Bash", input: { command: "npm test" }, summary: "cd web && npm test", result: "FAIL src/components/ImageCapture.test.tsx > rejects files over 5 MB\nTests  1 failed | 8 passed", error: true }
            : { tool: "Bash", input: { command: "npm test" }, summary: "cd web && npm test", result: "Tests  9 passed" },
          { tool: "Bash", input: { command: "git diff" }, summary: "git -C api diff", result: "api/src/routes/uploads.ts | 52 +++\napi/src/lib/s3.ts | 38 +++\n…" },
          { think: qaAttempt === 1 ? "One frontend test fails. The bucket stays private and the API validates input, so security looks fine." : "All checks pass and every acceptance criterion has a test." },
        ],
        structured: qa(qaAttempt),
        text: "QA complete.",
      };
    case "reporter":
      return {
        steps: [{ think: "Summarize the before/after per area and give clear manual test steps." }],
        structured: report,
        text: "Report ready.",
      };
    default:
      // Your custom agents: a short generic review so the demo shows where they run.
      return {
        steps: [
          { think: `Checking the work for this step as "${req.agent}".` },
          { tool: "Grep", input: { pattern: "TODO|FIXME" }, summary: '"TODO|FIXME"', result: "No matches found" },
          { tool: "Read", input: { file_path: "api/src/routes/uploads.ts" }, summary: "api/src/routes/uploads.ts", result: "export const uploads = Router();\n…" },
        ],
        structured: {
          summary: `Demo review by ${req.agent}: no blocking problems.`,
          findings: [
            {
              owner: "backend",
              severity: "suggestion",
              summary: "Add a per-user rate limit to the presign endpoint",
              details: "api/src/routes/uploads.ts: the endpoint can be called repeatedly.",
            },
          ],
        },
        text: "Review done.",
      };
  }
}

export async function runDemoAgent(host: AgentHost, req: AgentRequest): Promise<AgentResult> {
  const { agent } = req;
  const signal = host.abort.signal;
  const sessionId = req.resume ?? `demo-${agent}`;
  host.setAgent(agent, { status: "running", startedAt: Date.now(), endedAt: undefined, sessionId });
  const live = getLive(host.runId);
  live?.inboxes.set(agent, (text) => {
    host.emit(agent, { kind: "text", text: `Got it. Taking that into account: "${text.split("\n").pop()}"` });
    return true;
  });

  const { steps, structured, text } = script(req, req.prompt.includes("Clarification from the developer"));
  let n = 0;
  // "simulate extra usage" in the task shows what happens when the plan's included usage runs out.
  if (agent === "researcher" && /simulate extra usage/i.test(req.prompt)) {
    await sleep(1500, signal);
    host.planUsage({ status: "allowed", window: "five_hour", utilization: 1, resetsAt: Math.round(Date.now() / 1000) + 2 * 3600, usingExtraUsage: true, updatedAt: Date.now() });
    host.stop(EXTRA_USAGE_STOP);
    await sleep(60_000, signal);
  }
  try {
    for (const step of steps) {
      await sleep(500 + Math.random() * 700, signal);
      if ("think" in step) host.emit(agent, { kind: "thinking", text: step.think });
      else if ("say" in step) host.emit(agent, { kind: "text", text: step.say });
      else if ("denied" in step) host.emit(agent, { kind: "denied", tool: step.denied, reason: step.reason });
      else if ("relay" in step) {
        host.emit(agent, { kind: "relay", from: agent, to: step.relay, text: step.text });
        live?.inboxes.get(step.relay)?.(`[Message from the ${agent} builder]\n${step.text}`);
      } else {
        const toolUseId = `demo_${agent}_${++n}_${Date.now()}`;
        host.emit(agent, { kind: "tool_use", toolUseId, name: step.tool, input: step.input, summary: step.summary });
        await sleep(300 + Math.random() * 600, signal);
        host.emit(agent, { kind: "tool_result", toolUseId, isError: !!step.error, content: step.result });
      }
    }
  } finally {
    live?.inboxes.delete(agent);
  }
  host.addUsage(agent, Math.round(8_000 + Math.random() * 40_000), steps.length);
  if (agent === "researcher") {
    host.planUsage({ status: "allowed", window: "five_hour", utilization: 0.12, resetsAt: Math.round(Date.now() / 1000) + 3 * 3600, usingExtraUsage: false, updatedAt: Date.now() });
  }
  host.setAgent(agent, { status: "done", endedAt: Date.now() });
  return { sessionId, text, structured, isError: false, errors: [] };
}

export function demoDiff(run: Run): RepoDiff[] {
  const repo = (role: RepoDiff["role"]) => run.repos.find((r) => r.role === role) ?? run.repos[0];
  const backend = repo("backend");
  const frontend = repo("frontend");
  const file = (path: string, lines: string[]) => ({
    path,
    status: "added" as const,
    additions: lines.length,
    deletions: 0,
    patch: [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"),
  });
  return [
    {
      role: backend?.role ?? "backend",
      path: backend?.originalPath ?? "api",
      branch: backend?.branch ?? "aviator/demo",
      files: [
        file("api/src/routes/uploads.ts", [
          "import { Router } from 'express';",
          "import { z } from 'zod';",
          "import { requireAuth } from '../middleware/auth';",
          "import { presignAvatarUpload } from '../lib/s3';",
          "",
          "const Body = z.object({",
          "  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),",
          "  size: z.number().int().positive().max(5 * 1024 * 1024),",
          "});",
          "",
          "export const uploads = Router();",
          "uploads.post('/uploads/avatar/presign', requireAuth, async (req, res) => {",
          "  const parsed = Body.safeParse(req.body);",
          "  if (!parsed.success) return res.status(400).json({ error: 'invalid_upload' });",
          "  res.json(await presignAvatarUpload(req.user.id, parsed.data));",
          "});",
        ]),
        {
          path: "api/src/config.ts",
          status: "modified" as const,
          additions: 2,
          deletions: 0,
          patch: "@@ -4,6 +4,8 @@ export const config = z.object({\n   DATABASE_URL: z.string(),\n+  S3_BUCKET: z.string(),\n+  AWS_REGION: z.string().default('us-east-1'),\n }).parse(process.env);",
        },
      ],
    },
    {
      role: frontend?.role ?? "frontend",
      path: frontend?.originalPath ?? "web",
      branch: frontend?.branch ?? "aviator/demo",
      files: [
        file("web/src/components/ImageCapture.tsx", [
          "export function ImageCapture({ onUploaded }: { onUploaded: (url: string) => void }) {",
          "  const [error, setError] = useState<string | null>(null);",
          "  async function handle(file: File) {",
          "    if (!TYPES.includes(file.type)) return setError('Use a JPEG, PNG or WebP image.');",
          "    if (file.size > MAX_BYTES) return setError('Images must be 5 MB or smaller.');",
          "    const { uploadUrl, publicUrl } = await api.presignAvatar(file.type, file.size);",
          "    await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });",
          "    onUploaded(publicUrl);",
          "  }",
          "  …",
          "}",
        ]),
      ],
    },
  ];
}
