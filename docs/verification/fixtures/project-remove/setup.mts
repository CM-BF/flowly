// Creates (arg "create") or cleans up (arg "cleanup <projectId> <nativeId> <dir>") a disposable fixture project.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const client = new DaemonClient({ url: "ws://127.0.0.1:6767/ws", clientId: `remove-acceptance-${randomUUID()}`, clientType: "cli", connectTimeoutMs: 3000, reconnect: { enabled: false } });
const call = (m: string, i: unknown) => client.invokePluginRpc("paseo-ultra-kanban", m, i) as Promise<any>;
const natives = () => execFileSync("paseo", ["project", "ls", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
await client.connect();
const [mode, ...rest] = process.argv.slice(2);
if (mode === "create") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ultra-remove-fixture-")));
  const p = await call("projects.create", { title: rest[0] || "Remove fixture", description: "Disposable", primaryPath: dir });
  console.log(JSON.stringify({ projectId: p.id, nativeId: p.paseoProjectId, dir }));
} else {
  const [projectId, nativeId, dir] = rest;
  const board = await call("board.read", {});
  const onBoard = board.projects.some((p: any) => p.id === projectId);
  const nativeKept = natives().includes(nativeId);
  if (nativeKept) execFileSync("paseo", ["project", "delete", nativeId, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
  const backups = join(process.env.HOME!, ".paseo/plugin-data/paseo-ultra-kanban/removed");
  const backupFiles = existsSync(backups) ? readdirSync(backups).filter((f) => f.startsWith(projectId)) : [];
  for (const f of backupFiles) rmSync(join(backups, f));
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ onBoardAfterRemove: onBoard, nativeKeptAfterRemove: nativeKept, backupFiles, nativeGone: !natives().includes(nativeId), dirGone: !existsSync(dir) }));
}
await client.close?.();
process.exit(0);
