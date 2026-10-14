import { createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BoardStore } from "../../../server/store";

// One-time cleanup of the test fixtures documented in phase-01, phase-02 and
// single-root verification. Run --dry-run first, disable the plugin, then run
// --apply --expected-sha=<dry-run sha>. Never run against another daemon home.
const expectedNativeIds = new Set([
  "prj_8859e85f82a61739",
  "prj_e407569cf50aaf84",
  "prj_1afef1b7823a1da7",
  "prj_fcaa08989a7d6e40",
  "prj_5bd4211381fc57a3",
  "prj_5ce28ecbfd960c39",
  "prj_50bba1aeffc87a13",
  "prj_13036dd24dd2254c",
  "prj_7c2a73557bef90fc",
  "prj_42c0f91eb26092aa",
  "prj_5ca9e1be4d41f74b",
]);
const fixtureRoots = [
  "/private/tmp/ultra-kanban-acceptance-20261013",
  "/private/tmp/ultra-kanban-phase2-20261013",
  "/private/tmp/ultra-kanban-single-root-20261013",
];
const inFixture = (path: string) =>
  fixtureRoots.some((root) => path === root || path.startsWith(root + "/"));
const dataDir =
  process.env.ULTRA_KANBAN_DATA_DIR ||
  resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data/paseo-ultra-kanban");
if (dataDir !== join(homedir(), ".paseo/plugin-data/paseo-ultra-kanban"))
  throw new Error("Refusing a non-default plugin data directory.");
const store = new BoardStore(dataDir);
async function main() {
const raw = await readFile(store.path);
const sha = createHash("sha256").update(raw).digest("hex");
const before = await store.read();
const targets = before.projects.filter((p) => expectedNativeIds.has(p.paseoProjectId));
if (targets.length !== expectedNativeIds.size)
  throw new Error(`Expected ${expectedNativeIds.size} exact fixture project IDs, found ${targets.length}; inspect before cleanup.`);
for (const p of targets) {
  if (!inFixture(p.primaryPath) || !/^(Ultra Kanban Acceptance|Phase 2 live acceptance|Single-root live acceptance)/.test(p.title))
    throw new Error(`Fixture ownership is uncertain for ${p.id}; refusing cleanup.`);
}
const projectIds = new Set(targets.map((p) => p.id));
const targetTasks = before.tasks.filter((t) => projectIds.has(t.projectId));
const taskIds = new Set(targetTasks.map((t) => t.id));
const summary = {
  beforeSha256: sha,
  projects: targets.length,
  tasks: targetTasks.length,
  events: before.events.filter((e) => taskIds.has(e.taskId)).length,
  receipts: before.agentReceipts.filter((r) => taskIds.has(r.taskId)).length,
  unrelatedProjects: before.projects.length - targets.length,
  unrelatedTasks: before.tasks.length - targetTasks.length,
};
const apply = process.argv.includes("--apply");
if (!apply) {
  if (!process.argv.includes("--dry-run")) throw new Error("Use --dry-run or --apply --expected-sha=<sha>.");
  console.log(JSON.stringify({ mode: "dry-run", ...summary }));
} else {
  const expected = process.argv.find((arg) => arg.startsWith("--expected-sha="))?.slice(15);
  if (expected !== sha) throw new Error("Board changed after dry-run; inspect and repeat the inventory.");
  await store.mutate((board) => {
    board.projects = board.projects.filter((p) => !projectIds.has(p.id));
    board.tasks = board.tasks.filter((t) => !taskIds.has(t.id));
    board.events = board.events.filter((e) => !taskIds.has(e.taskId));
    board.agentReceipts = board.agentReceipts.filter((r) => !taskIds.has(r.taskId));
  });
  const removedContextFiles: Record<string, number> = { sessions: 0, preparations: 0 };
  for (const subdir of ["sessions", "preparations"] as const) {
    const dir = join(dataDir, subdir);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const data = JSON.parse(await readFile(path, "utf8"));
      const identity = subdir === "sessions" ? data.identity : data;
      if (identity && taskIds.has(identity.taskId)) {
        await unlink(path);
        removedContextFiles[subdir]++;
      }
    }
  }
  const after = await store.read();
  if (after.projects.some((p) => projectIds.has(p.id)) || after.tasks.some((t) => taskIds.has(t.id)))
    throw new Error("Fixture records remain after cleanup.");
  console.log(JSON.stringify({
    mode: "applied",
    ...summary,
    remainingProjects: after.projects.length,
    remainingTasks: after.tasks.length,
    removedContextFiles,
    afterSha256: createHash("sha256").update(await readFile(store.path)).digest("hex"),
  }));
}
}
void main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
