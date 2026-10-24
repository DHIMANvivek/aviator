import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Aviator runs on your own machine, so the server can open the operating system's real
// folder picker and hand the chosen absolute path back to the browser (browsers themselves
// never reveal full paths). macOS: Finder dialog. Windows: the standard folder dialog.
// Linux: zenity (GNOME) or kdialog (KDE).

const CANCELLED = Symbol("cancelled");
type ExecError = { code?: number | string; stderr?: string };

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function mac(prompt: string, start?: string) {
  const location = start ? ` default location (POSIX file ${appleString(start)})` : "";
  try {
    const { stdout } = await exec("osascript", ["-e", `set f to choose folder with prompt ${appleString(prompt)}${location}`, "-e", "POSIX path of f"]);
    return stdout.trim().replace(/\/$/, "");
  } catch (err) {
    if (/-128|User canceled/i.test((err as ExecError).stderr ?? "")) return CANCELLED;
    throw err;
  }
}

async function windows(prompt: string, start?: string) {
  // A hidden topmost owner keeps the dialog in front of the browser window.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = ${psString(prompt)}`,
    "$d.ShowNewFolderButton = $false",
    start ? `$d.SelectedPath = ${psString(start)}` : "",
    "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    "$owner.Dispose()",
  ]
    .filter(Boolean)
    .join("; ");
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { windowsHide: true });
  return stdout.trim() || CANCELLED;
}

async function linux(prompt: string, start?: string) {
  const attempts: [string, string[]][] = [
    ["zenity", ["--file-selection", "--directory", `--title=${prompt}`, ...(start ? [`--filename=${start}/`] : [])]],
    ["kdialog", ["--getexistingdirectory", start ?? process.env.HOME ?? "/", "--title", prompt]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await exec(cmd, args);
      return stdout.trim().replace(/\/$/, "") || CANCELLED;
    } catch (err) {
      const e = err as ExecError;
      if (e.code === "ENOENT") continue; // not installed; try the next one
      if (e.code === 1) return CANCELLED;
      throw err;
    }
  }
  throw Object.assign(new Error("no picker"), { code: "ENOENT" });
}

/** Returns the chosen folder, or null if the dialog was cancelled. */
export async function pickFolder(prompt: string, startIn?: string): Promise<string | null> {
  const start = startIn && fs.existsSync(startIn) ? startIn : undefined;
  try {
    const picked =
      process.platform === "darwin"
        ? await mac(prompt, start)
        : process.platform === "win32"
          ? await windows(prompt, start)
          : await linux(prompt, start);
    return picked === CANCELLED || !picked ? null : picked;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === "ENOENT") {
      throw new Error(
        process.platform === "linux"
          ? "No folder picker found. Install zenity or kdialog, or type the path."
          : "The system folder picker isn't available here. Type the path instead.",
      );
    }
    throw new Error(e.stderr?.trim() || "Couldn't open the folder picker. Type the path instead.");
  }
}
