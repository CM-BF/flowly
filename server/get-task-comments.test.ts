import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { addComment } from "./comments";
import { commentLimits } from "../shared/comments";
import { toolContextSchema } from "../shared/tools";
import { reviewPrompt } from "../shared/automation";
import { skillText } from "./skill-source";

// flowly_get_task `comments` (CARD-COMMENTS-SPEC §3): the latest human comments, oldest first, each bounded.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const x = await agentFixture();
  roots.push(x.root);
  return x;
}

test("get_task has no comments until a person writes one", async () => {
  const x = await setup();
  const context = await x.service.get(x.identity);
  expect(context.comments).toEqual([]);
  expect(toolContextSchema.parse(context).comments).toEqual([]);
});

test("get_task lists the latest 20 human comments, oldest first, as id, time and text", async () => {
  const x = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push((await addComment(x.store, { taskId: "t", text: `Comment ${i}`, operationId: `op-${i}` })).id);
  // Other activity (an agent's note) is not a comment.
  await x.store.mutate((b) => void x.store.event(b, { taskId: "t", actor: "agent", agentId: "actor", action: "progress_reported", note: "Agent note" }));
  const { comments } = await x.service.get(x.identity);
  expect(comments).toHaveLength(commentLimits.agentCount);
  expect(comments!.map((c) => c.text)).toEqual(Array.from({ length: 20 }, (_, i) => `Comment ${i + 5}`));
  expect(comments!.map((c) => c.id)).toEqual(ids.slice(5));
  expect(Object.keys(comments![0]).sort()).toEqual(["at", "id", "text"]);
  expect(Date.parse(comments![0].at)).not.toBeNaN();
});

test("a long comment reaches the agent cut to 4000 characters, with the cut said in the text", async () => {
  const x = await setup();
  const long = "a".repeat(8000) + "END";
  await addComment(x.store, { taskId: "t", text: long, operationId: "long" });
  await addComment(x.store, { taskId: "t", text: "b".repeat(commentLimits.agentChars), operationId: "exact" });
  const [clipped, exact] = (await x.service.get(x.identity)).comments!;
  expect(clipped.text.length).toBeLessThanOrEqual(commentLimits.agentChars);
  expect(clipped.text.startsWith("a".repeat(3500))).toBe(true);
  expect(clipped.text).not.toContain("END");
  expect(clipped.text).toMatch(/truncated.*8003 characters/i);
  // Exactly at the bound: unchanged.
  expect(exact.text).toBe("b".repeat(commentLimits.agentChars));
});

test("a comment is not repeated in activity, so its 4000-character bound holds", async () => {
  const x = await setup();
  await addComment(x.store, { taskId: "t", text: "c".repeat(9000), operationId: "long" });
  await x.store.mutate((b) => void x.store.event(b, { taskId: "t", actor: "agent", agentId: "actor", action: "progress_reported", note: "Agent note" }));
  const context = await x.service.get(x.identity);
  expect(context.activity.map((e) => e.action)).not.toContain("commented");
  expect(context.activity.at(-1)).toMatchObject({ action: "progress_reported", note: "Agent note" });
  expect(context.comments).toHaveLength(1);
});

test("the agent-facing text tells agents and reviewers what comments are", () => {
  // The skill (both copies are compared byte for byte in tool-server.test.ts).
  expect(skillText).toMatch(/comments in flowly_get_task/);
  expect(skillText).toMatch(/reviewer[^.]*comments/i);
  // The reviewer's round prompt points at them too.
  expect(reviewPrompt(1, 3)).toMatch(/comments/);
});
