import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { BoardService } from "./service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A card bound to Flowly's background workspace would have its automation sessions archived by the next background run.
test("the existing-workspace picker never offers Flowly's background workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-background-picker-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  await store.mutate(() => undefined);
  await writeFile(join(store.directory, "background-workspaces.json"), JSON.stringify({ version: 1, projects: { p: "bg-ws" } }));
  const workspace = (id: string, name: string) => ({ id, name, projectId: "native", workspaceDirectory: root, status: "done" });
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "native", projectDisplayName: "Native", projectRootPath: root }] }) },
    workspaces: { list: async () => ({ entries: [workspace("bg-ws", "Flowly background"), workspace("card-ws", "Card")], pageInfo: { nextCursor: null } }) },
  } as unknown as PaseoApi;
  const resources = await new BoardService(store).resources(paseo);
  expect(resources.workspaces.map((w) => w.id)).toEqual(["card-ws"]);
});
