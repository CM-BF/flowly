// End-to-end check for WORKSPACE-RESTORE-SPEC against the installed plugin.
// Creates its own temp repo, Kanban project (+ native Paseo project), worktree
// and directory cards with one idle session each (never prompted); wraps them
// up, moves them back to Todo and checks the workspaces come back. Everything
// it creates is removed in `finally`.
// Usage: node e2e.mjs <plugin root>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.argv[2];
const { DaemonClient } = await import(join(root, "node_modules/@getpaseo/client/dist/daemon-client.js"));
const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const listen = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")).listen;
const token = readFileSync(join(home, "local-credential"), "utf8").trim();
const client = new DaemonClient({
  url: `ws://${listen}/ws`, clientId: "ultra-kanban-restore-e2e", clientType: "cli",
  localCredential: () => token, reconnect: { enabled: false }, connectTimeoutMs: 5000,
});
await client.connect();
const rpc = (method, input) => client.invokePluginRpc("paseo-ultra-kanban", method, input);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const log = [];
const note = (...parts) => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  log.push(line);
  console.log(line);
};
const created = { repo: null, projectId: null, paseoProjectId: null, tasks: [], workspaces: [], agents: [], worktrees: [] };
const failures = [];
const check = (ok, what) => {
  note(ok ? "PASS" : "FAIL", what);
  if (!ok) failures.push(what);
};

const board = () => rpc("board.read", {});
const task = async (id) => (await board()).tasks.find((t) => t.id === id);
const events = async (id) => (await board()).events.filter((e) => e.taskId === id);
const workspace = async (id) => {
  const page = await client.fetchWorkspaces({});
  const all = page.entries ?? page.workspaces ?? [];
  return all.map((e) => e.workspace ?? e).find((w) => (w.id ?? w.workspaceId) === id) ?? null;
};
const waitFor = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

try {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `uk-restore-e2e-${stamp}-`)));
  created.repo = repo;
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "init");
  note("repo", repo);

  const project = await rpc("projects.create", { title: `UK restore e2e ${stamp}`, primaryPath: repo });
  created.projectId = project.id;
  created.paseoProjectId = project.paseoProjectId;
  note("project", project.id, project.paseoProjectId);

  for (const mode of ["worktree", "directory"]) {
    const t = await rpc("tasks.create", {
      projectId: project.id, operationId: `uk-restore-e2e-${stamp}-${mode}`, title: `Restore ${mode} ${stamp}`,
      mode, baseRef: mode === "worktree" ? "main" : "",
    });
    created.tasks.push(t.id);
    created.workspaces.push(t.workspaceId);
    const ws = await workspace(t.workspaceId);
    const dir = ws?.workspaceDirectory ?? ws?.directory ?? ws?.cwd;
    if (mode === "worktree") created.worktrees.push(dir);
    note("card", mode, t.id, t.workspaceId, ws?.workspaceKind, dir, "ownsWorkspace", t.ownsWorkspace);

    let agentId = null;
    try {
      const agent = await client.createAgent({
        config: { provider: "claude", model: "haiku", cwd: dir, title: `restore e2e ${mode}` },
        workspaceId: t.workspaceId,
        initialPrompt: "Reply with the single word OK. Do not use tools.",
      });
      agentId = agent.id;
      // A session that has run has provider persistence, like a real card session.
      note("session first turn:", (await client.waitForFinish(agentId, 120000)).status);
      created.agents.push(agentId);
      note("session", agentId);
    } catch (e) {
      note("session not created:", e.message);
    }
    const branch = mode === "worktree" ? git(dir, "rev-parse", "--abbrev-ref", "HEAD") : null;

    // Done, then wrap up keeping the card (what the Done prompt does), unless auto wrap-up already did.
    let current = await rpc("tasks.update", { id: t.id, revision: t.revision, status: "done" });
    await sleep(3000);
    const auto = (await events(t.id)).some((e) => e.action === "workspace_auto_archived");
    if (!auto) {
      current = await task(t.id);
      const result = await rpc("tasks.wrapup", { id: t.id, revision: current.revision, acknowledgeWarnings: true, keepCard: true });
      note("wrap-up", result.note);
    } else note("auto wrap-up archived it");
    const archived = await client.inspectWorkspaceRecovery(t.workspaceId);
    check(archived.kind === "recoverable", `${mode}: workspace archived and recoverable (${archived.kind}/${archived.action ?? archived.reason})`);
    if (mode === "worktree") note("worktree dir after archive exists:", existsSync(dir));

    // Move it out of Done.
    current = await task(t.id);
    await rpc("tasks.update", { id: t.id, revision: current.revision, status: "todo" });
    const restored = await waitFor(
      async () => (await events(t.id)).find((e) => e.action === "workspace_restored" || e.action === "workspace_restore_skipped"),
      `${mode} restore event`,
    );
    note("event", restored.action, restored.note);
    check(restored.action === "workspace_restored", `${mode}: restore recorded`);
    const after = await client.inspectWorkspaceRecovery(t.workspaceId);
    check(after.kind === "unavailable" && after.reason === "workspace_not_archived", `${mode}: same workspace ID is active again`);
    const ws2 = await workspace(t.workspaceId);
    check(!!ws2, `${mode}: workspace listed by Paseo`);
    check(existsSync(dir), `${mode}: directory exists`);
    if (branch) check(git(dir, "rev-parse", "--abbrev-ref", "HEAD") === branch, `worktree: back on branch ${branch}`);
    check((await task(t.id)).workspaceId === t.workspaceId, `${mode}: card still bound to ${t.workspaceId}`);
    if (agentId) {
      const a = await client.fetchAgent(agentId);
      const archivedAt = a?.agent?.archivedAt ?? a?.archivedAt ?? null;
      check(!archivedAt, `${mode}: session ${agentId} restored (archivedAt ${archivedAt})`);
    }
  }

  // A second move out of Done without a new wrap-up must not restore again.
  const first = created.tasks[1];
  let cur = await task(first);
  cur = await rpc("tasks.update", { id: first, revision: cur.revision, status: "done" });
  cur = await rpc("tasks.update", { id: first, revision: cur.revision, status: "todo" });
  await sleep(3000);
  const count = (await events(first)).filter((e) => e.action.startsWith("workspace_restore")).length;
  check(count === 1, `no extra restore without a new wrap-up (restore events: ${count})`);
} catch (e) {
  failures.push(e.message);
  note("ERROR", e.stack || e.message);
} finally {
  note("cleanup", created);
  for (const id of created.agents) await client.deleteAgent(id).catch((e) => note("agent delete failed", id, e.message));
  for (const id of created.workspaces) await client.archiveWorkspace(id).catch(() => undefined);
  if (created.projectId) {
    const p = (await board()).projects.find((x) => x.id === created.projectId);
    if (p) await rpc("projects.remove", { id: p.id, revision: p.revision, alsoPaseo: true }).catch((e) => note("project remove failed", e.message));
  }
  if (created.repo) {
    for (const dir of created.worktrees) {
      if (dir && existsSync(dir)) {
        try { git(created.repo, "worktree", "remove", "--force", dir); } catch (e) { note("worktree remove failed", dir, e.message); }
      }
      // The per-project worktree parent was created for this fixture; remove it only when empty.
      if (dir) try { rmdirSync(dirname(dir)); } catch {}
    }
    rmSync(created.repo, { recursive: true, force: true });
  }
  const b = await board();
  check(!b.projects.some((p) => p.id === created.projectId), "cleanup: Kanban project removed");
  check(!b.tasks.some((t) => created.tasks.includes(t.id)), "cleanup: cards removed");
  const projects = await client.fetchProjects?.().catch(() => null);
  if (projects) note("native projects still listing fixture:", JSON.stringify(projects).includes(created.paseoProjectId ?? "none"));
  for (const id of created.agents) check(!(await client.fetchAgent(id).catch(() => null)), `cleanup: session ${id} deleted`);
  check(!created.repo || !existsSync(created.repo), "cleanup: temp repo removed");
  for (const dir of created.worktrees) check(!dir || !existsSync(dir), `cleanup: worktree ${dir} removed`);
  await client.close();
  writeFileSync(join(root, "docs/verification/fixtures/workspace-restore/last-run.log"), log.join("\n") + "\n");
  console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL PASSED");
  process.exit(failures.length ? 1 : 0);
}
