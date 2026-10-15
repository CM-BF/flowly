import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { nativePickers } from "../shared/rpc";
import { directory } from "./service";

const execute = promisify(execFile);
const maxEntries = 500;
type NativePicker = (typeof nativePickers)[number];

/** Child directories of `path` (home by default) for the in-app folder browser. Read-only. */
export async function listDirectories(path: string | undefined, native: NativePicker | null) {
  const home = homedir();
  const current = await directory(path?.trim() || home);
  const names = (await readdir(current, { withFileTypes: true }))
    .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const entries: { name: string; path: string; git: boolean }[] = [];
  for (const name of names) {
    if (entries.length >= maxEntries) break;
    const full = join(current, name);
    // Symlinks count only when they resolve to a directory; unreadable entries are skipped.
    if (!(await stat(full).then((s) => s.isDirectory(), () => false))) continue;
    entries.push({ name, path: full, git: await exists(join(full, ".git")) });
  }
  const parent = dirname(current);
  return {
    path: current,
    parent: parent === current ? null : parent,
    home,
    native,
    truncated: names.length > entries.length && entries.length >= maxEntries,
    entries,
  };
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function onPath(command: string) {
  const which = process.platform === "win32" ? "where" : "which";
  return execute(which, [command], { timeout: 5000 }).then(() => true, () => false);
}

/** Which system folder dialog this daemon host can open, if any. */
export async function detectNativePicker(): Promise<NativePicker | null> {
  if (process.platform === "darwin") return "finder";
  if (process.platform === "win32") return "explorer";
  if (await onPath("zenity")) return "zenity";
  if (await onPath("kdialog")) return "kdialog";
  return null;
}

const macScript = (multiple: boolean) => `activate
set picked to choose folder with prompt "Choose a folder for the Kanban project"${multiple ? " with multiple selections allowed" : ""}
if class of picked is not list then set picked to {picked}
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out`;

const windowsScript = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a folder for the Kanban project'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }`;

function command(picker: NativePicker, multiple: boolean): [string, string[]] {
  switch (picker) {
    case "finder":
      return ["osascript", ["-e", macScript(multiple)]];
    case "explorer":
      return ["powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", windowsScript]];
    case "zenity":
      return ["zenity", ["--file-selection", "--directory", "--title=Choose a folder", ...(multiple ? ["--multiple", "--separator=\n"] : [])]];
    case "kdialog":
      return ["kdialog", ["--getexistingdirectory", homedir()]];
  }
}

/** True when the dialog process exited because the user cancelled it. */
function cancelled(picker: NativePicker, error: { code?: unknown; stderr?: unknown }) {
  if (picker === "finder") return String(error.stderr ?? "").includes("-128");
  // zenity/kdialog exit 1 on cancel.
  return error.code === 1;
}

/** Serializes system folder dialogs; they open on the daemon host's screen. */
export class NativeDirectoryPicker {
  private open = false;
  constructor(private readonly picker: Promise<NativePicker | null>) {}
  available() {
    return this.picker;
  }
  async pick(multiple: boolean): Promise<{ paths: string[] }> {
    const picker = await this.picker;
    if (!picker) throw new Error("No system folder dialog is available on the Paseo computer. Browse or type the path instead.");
    if (this.open) throw new Error("A folder dialog is already open on the Paseo computer.");
    this.open = true;
    try {
      const [file, args] = command(picker, multiple);
      const output = await execute(file, args, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }).then(
        (r) => r.stdout,
        (e: { code?: unknown; stderr?: unknown; killed?: boolean }) => {
          if (cancelled(picker, e)) return "";
          if (e.killed) throw new Error("The folder dialog timed out.");
          throw new Error(`Could not open the folder dialog: ${String(e.stderr || "").trim() || "unknown error"}`);
        },
      );
      const paths = output
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p));
      return { paths: multiple ? paths : paths.slice(0, 1) };
    } finally {
      this.open = false;
    }
  }
}
