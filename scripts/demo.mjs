// `npm run demo`: Next.js dev server in demo mode on port 3100. Written as a script because
// inline `VAR=1 cmd` doesn't work in Windows cmd or PowerShell.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next");
const env = { ...process.env, AVIATOR_DEMO: "1", AVIATOR_DATA_DIR: process.env.AVIATOR_DATA_DIR || ".aviator-demo" };
const child = spawn(process.execPath, [next, "dev", "-p", "3100"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
