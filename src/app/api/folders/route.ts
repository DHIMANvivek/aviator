import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Lists the folders inside one folder on this machine, for the in-page folder browser. That's
// how you pick a repo from another device (e.g. your phone, through the hub): the native
// dialog would open on this computer's screen instead.

const LIMIT = 2000;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** "/" on macOS and Linux; the drives that exist (C:\, D:\, …) on Windows. */
function roots(): string[] {
  if (process.platform !== "win32") return ["/"];
  return "CDEFGHIJKLMNOPQRSTUVWXYZAB"
    .split("")
    .map((letter) => `${letter}:\\`)
    .filter(isDir);
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const home = os.homedir();
  const target = path.resolve(params.get("path")?.trim() || home);
  const hidden = params.get("hidden") === "1";
  try {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const names = entries
      .filter((e) => (hidden || !e.name.startsWith(".")) && e.name !== "node_modules")
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(target, e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const folders = names.slice(0, LIMIT).map((name) => {
      const full = path.join(target, name);
      return { name, path: full, git: fs.existsSync(path.join(full, ".git")) };
    });
    const parent = path.dirname(target);
    return Response.json({
      path: target,
      parent: parent === target ? null : parent,
      home,
      roots: roots(),
      git: fs.existsSync(path.join(target, ".git")),
      folders,
      truncated: names.length > LIMIT,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const error =
      code === "ENOENT"
        ? `${target} doesn't exist.`
        : code === "ENOTDIR"
          ? `${target} isn't a folder.`
          : code === "EACCES" || code === "EPERM"
            ? `Aviator isn't allowed to read ${target}.`
            : err instanceof Error
              ? err.message
              : String(err);
    return Response.json({ error }, { status: 400 });
  }
}
