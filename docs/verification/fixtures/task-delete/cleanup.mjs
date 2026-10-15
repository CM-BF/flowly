// Deletes the Ultra Kanban project's archived cards whose worktree workspace the
// old wrap-up removed, through the running plugin's `tasks.delete` RPC.
// Usage: node cleanup.mjs <repo root> [--apply]   (dry run without --apply)
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.argv[2];
const apply = process.argv.includes("--apply");
const projectId = "154c66d4-9d96-4ff1-b810-205a5d016330";
const ids = [
  "ae271b08-feec-431b-80ac-70ba44af8f60", "88654613-2506-420c-a5ce-8dbbc6f9761f",
  "6068af73-759e-4376-8b19-a544aa7411f3", "1155cee0-c01b-41ba-8e3d-a0733b03736e",
  "f875804b-95d9-4f51-a2e5-fa14b4cbb0a1", "9bb8c80c-184f-46d2-8204-2362080ad626",
  "31eecb7b-5186-4caa-9f72-11352470c929", "a03ab7ce-8ae4-4859-9d7d-87887bfd7d34",
  "a948f7d7-af90-4005-92d0-79db61584515", "7019d517-2e21-493f-923e-f2a93ab932bd",
  "f6d59d7e-dc56-4e99-8c9b-d9c9f61913a5",
];
const { DaemonClient } = await import(join(root, "node_modules/@getpaseo/client/dist/daemon-client.js"));
const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const listen = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")).listen;
const token = readFileSync(join(home, "local-credential"), "utf8").trim();
const workspaces = JSON.parse(readFileSync(join(home, "projects/workspaces.json"), "utf8"));
const byId = new Map((Array.isArray(workspaces) ? workspaces : Object.values(workspaces)).map((w) => [w.workspaceId ?? w.id, w]));
const client = new DaemonClient({
  url: `ws://${listen}/ws`, clientId: "ultra-kanban-task-delete", clientType: "cli",
  localCredential: () => token, reconnect: { enabled: false }, connectTimeoutMs: 5000,
});
await client.connect();
const rpc = (method, input) => client.invokePluginRpc("paseo-ultra-kanban", method, input);
try {
  const board = await rpc("board.read", {});
  for (const id of ids) {
    const t = board.tasks.find((x) => x.id === id);
    if (!t) { console.log(`skip ${id}: already gone`); continue; }
    const w = byId.get(t.workspaceId);
    const dir = w?.cwd ?? w?.directory;
    const dead = t.projectId === projectId && t.archivedAt && w?.kind === "worktree" && w.archivedAt && !existsSync(dir);
    if (!dead) { console.log(`skip ${id} ${t.title}: not an archived card with a removed worktree`); continue; }
    if (!apply) { console.log(`would delete ${id} ${t.title}`); continue; }
    const r = await rpc("tasks.delete", { id, revision: t.revision });
    console.log(`deleted ${id} ${t.title} backup=${r.backup}`);
  }
  const after = await rpc("board.read", {});
  const left = after.tasks.filter((t) => t.projectId === projectId && t.archivedAt);
  console.log(`archived cards left in project: ${left.map((t) => t.title).join(", ") || "none"}`);
} finally {
  await client.close?.();
}
