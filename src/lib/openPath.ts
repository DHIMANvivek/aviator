import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir, listProjects } from "./store";

// Open a project folder in the system file manager or in VS Code, on macOS, Windows or Linux.
// Only folders that belong to a connected project (or an Aviator worktree) can be opened.

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function allowed(abs: string): boolean {
  const roots = listProjects()
    .flatMap((p) => [p.root, p.frontendPath, p.backendPath])
    .filter((r): r is string => !!r)
    .map((r) => path.resolve(r));
  return [...roots, path.join(dataDir, "worktrees")].some((root) => inside(abs, root));
}

/** Resolves once the app has launched; rejects if the command is missing or exits with an error. */
function launch(cmd: string, args: string[], opts: { ignoreExitCode?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 1500);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || opts.ignoreExitCode) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

export async function openPath(target: string, how: "folder" | "editor"): Promise<void> {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`${abs} does not exist.`);
  if (!allowed(abs)) throw new Error("Aviator only opens folders of your connected projects.");

  if (how === "folder") {
    if (process.platform === "darwin") return launch("open", [abs]);
    // explorer.exe reports exit code 1 even when it opened the folder.
    if (process.platform === "win32") return launch("explorer.exe", [abs], { ignoreExitCode: true });
    return launch("xdg-open", [abs]);
  }

  try {
    if (process.platform === "darwin") return await launch("open", ["-a", "Visual Studio Code", abs]);
    // VS Code's `code` is a .cmd script on Windows, which has to go through cmd.exe.
    if (process.platform === "win32") return await launch("cmd.exe", ["/d", "/c", "code", abs]);
    return await launch("code", [abs]);
  } catch {
    if (process.platform === "darwin") {
      try {
        return await launch("code", [abs]);
      } catch {
        // fall through to the message below
      }
    }
    throw new Error("VS Code wasn't found. Install it (and its `code` command), or use Open folder.");
  }
}
