// Live acceptance for PROJECT-PICKER-SPEC against the installed paseo-ultra-kanban plugin.
// Test-only SDK use. Creates one fixture project and removes it (native registry, board record,
// linked root, temp dirs) in finally. Output omits credentials.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../../../../server/store";
import { dataDirectory, linkedDirectory } from "../../../../server/service";

const pluginId = "paseo-ultra-kanban";
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ultra-picker-live-")));
const [a, b, c] = ["repo-a", "repo-b", "repo-c"].map((n) => join(fixture, n));
for (const d of [a, b, c]) mkdirSync(d);
execFileSync("git", ["init", "-q", a]);
const title = `ultra-picker-fixture-${Date.now()}`;
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: `picker-acceptance-${randomUUID()}`,
  clientType: "cli",
  connectTimeoutMs: 3000,
  reconnect: { enabled: false },
});
const call = (method: string, input: unknown) => client.invokePluginRpc(pluginId, method, input) as Promise<any>;
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, detail });
const linkedBefore = existsSync(linkedDirectory()) ? readdirSync(linkedDirectory()) : [];
let project: any = null;

try {
  await client.connect();
  const home = await call("fs.list-directories", {});
  check("list-directories defaults to home", home.path === realpathSync(home.home), { path: home.path, native: home.native, entries: home.entries.length });
  check("macOS reports Finder dialog", home.native === "finder", home.native);
  const page = await call("fs.list-directories", { path: fixture });
  check("fixture listing marks git", JSON.stringify(page.entries.map((e: any) => [e.name, e.git])) === JSON.stringify([["repo-a", true], ["repo-b", false], ["repo-c", false]]), page.entries);

  const bad = await call("projects.create-linked", { title, links: [a, join(fixture, "missing")] }).then(() => "created", (e) => String(e.message || e));
  check("invalid target rejected", bad.includes("Not an existing directory"), bad);
  const after = existsSync(linkedDirectory()) ? readdirSync(linkedDirectory()) : [];
  check("rejected create left no directory", after.length === linkedBefore.length, after);

  project = await call("projects.create-linked", { title, description: "Disposable picker acceptance fixture", links: [a, b] });
  check("linked root under fixed parent", project.primaryPath === join(realpathSync(linkedDirectory()), title), project.primaryPath);
  check("links recorded", JSON.stringify(project.links) === JSON.stringify([{ name: "repo-a", target: a }, { name: "repo-b", target: b }]), project.links);
  check("symlinks on disk", project.links.every((l: any) => readlinkSync(join(project.primaryPath, l.name)) === l.target));
  const natives = JSON.parse(execFileSync("paseo", ["project", "ls", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const native = (Array.isArray(natives) ? natives : natives.projects || []).find((p: any) => (p.projectId || p.id) === project.paseoProjectId);
  check("native project registered at linked root", !!native && JSON.stringify(native).includes(project.primaryPath), native);

  const edited = await call("projects.set-links", { id: project.id, revision: project.revision, links: [a, c] });
  check("set-links swaps b for c", JSON.stringify(edited.links.map((l: any) => l.name)) === JSON.stringify(["repo-a", "repo-c"]) && !existsSync(join(project.primaryPath, "repo-b")) && existsSync(b), edited.links);
  const stale = await call("projects.set-links", { id: project.id, revision: project.revision, links: [a] }).then(() => "saved", (e) => String(e.message || e));
  check("stale revision rejected", stale.includes("Revision conflict"), stale);
  project = edited;
  const ctx = await call("board.read", {});
  check("board shows linked project", ctx.projects.some((p: any) => p.id === project.id && p.links?.length === 2));
} catch (e) {
  check("unexpected error", false, String((e as Error)?.stack || e));
} finally {
  const cleanup: Record<string, unknown> = {};
  if (project) {
    try {
      execFileSync("paseo", ["project", "delete", project.paseoProjectId, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
      cleanup.native = "deleted";
    } catch (e) {
      cleanup.native = String(e);
    }
    const store = new BoardStore(dataDirectory());
    await store.mutate((board) => {
      board.projects = board.projects.filter((p) => p.id !== project.id);
    });
    cleanup.board = (await store.read()).projects.some((p) => p.id === project.id) ? "still present" : "removed";
    // The linked root holds only fixture symlinks; never follow them.
    for (const name of readdirSync(project.primaryPath)) if (lstatSync(join(project.primaryPath, name)).isSymbolicLink()) rmSync(join(project.primaryPath, name));
    try { rmdirSync(project.primaryPath); } catch {}
    cleanup.linkedRoot = existsSync(project.primaryPath) ? "still present" : "removed";
    const natives = execFileSync("paseo", ["project", "ls", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    cleanup.nativeGone = !natives.includes(project.paseoProjectId);
  }
  rmSync(fixture, { recursive: true, force: true });
  cleanup.fixture = existsSync(fixture) ? "still present" : "removed";
  await client.close?.();
  const report = { at: new Date().toISOString(), title, checks, cleanup };
  writeFileSync(new URL("./live-evidence.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
