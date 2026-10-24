import fs from "node:fs";
import path from "node:path";

/**
 * The Claude Code binary that ships inside the Agent SDK for this OS and CPU:
 * macOS (darwin-x64/arm64), Windows (win32-x64/arm64, claude.exe) and Linux
 * (linux-x64/arm64, plus the -musl builds used on Alpine).
 */
export function claudeBinary(): string {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [base, ...(process.platform === "linux" ? [`${base}-musl`] : [])].map((pkg) =>
    path.join(process.cwd(), "node_modules", pkg, exe),
  );
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`Claude Code binary for ${process.platform}-${process.arch} not found. Run npm install.`);
  return found;
}
