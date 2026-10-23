import { afterEach, expect, test, vi } from "vitest";
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
  expect(Object.keys(comments![0]).sort()).toEqual(["at", "id", "text", "unread"]);
  expect(Date.parse(comments![0].at)).not.toBeNaN();
});

test("a long comment reaches a session in full while unread; once read it is shortened, and the note says where the rest is", async () => {
  const x = await setup();
  const requirements = Array.from({ length: 100 }, (_, i) => `Requirement ${i + 1}: keep the v1 endpoint working for client ${i + 1}.`).join("\n");
  const long = requirements + "\nFINAL REQUIREMENT: keep the v1 endpoint.";
  expect(long.length).toBeGreaterThan(commentLimits.agentChars);
  await addComment(x.store, { taskId: "t", text: long, operationId: "long" });
  // Never read by this session (it may never have been sent to it): the exact text, nothing cut.
  const [first] = (await x.service.get(x.identity)).comments!;
  expect(first).toMatchObject({ text: long, unread: true });
  // Read: shortened, and the note is true for every session (it read the full text above).
  const [again] = (await x.service.get(x.identity)).comments!;
  expect(again.unread).toBe(false);
  expect(again.text.length).toBeLessThanOrEqual(commentLimits.agentChars);
  expect(again.text.startsWith(long.slice(0, 3500))).toBe(true);
  expect(again.text).not.toContain("FINAL REQUIREMENT");
  expect(again.text).toMatch(new RegExp(`shortened.*of ${long.length} characters`, "i"));
  expect(again.text).toMatch(/full text.*earlier flowly_get_task/i);
  expect(again.text).not.toMatch(/was sent to the card's session/);
  // Another session (a reviewer, a new session) has not read it: it gets all of it.
  const [other] = (await x.service.get({ ...x.identity, agentId: "second" })).comments!;
  expect(other).toMatchObject({ text: long, unread: true });
  // Exactly at the bound: never shortened.
  await addComment(x.store, { taskId: "t", text: "b".repeat(commentLimits.agentChars), operationId: "exact" });
  await x.service.get(x.identity);
  expect((await x.service.get(x.identity)).comments!.at(-1)!.text).toBe("b".repeat(commentLimits.agentChars));
});

test("unread marks the comments written since this session last read the card, even on a card without artifacts", async () => {
  // Whole seconds between steps, so no write shares a millisecond with a read.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let now = Date.now();
    const tick = () => vi.setSystemTime((now += 1000));
    tick();
    const x = await setup();
    tick();
    await addComment(x.store, { taskId: "t", text: "What's the ETA?", operationId: "a" });
    tick();
    const read = await x.service.get(x.identity);
    expect(read.artifacts).toEqual([]);
    expect(read.comments!.map((c) => [c.text, c.unread])).toEqual([["What's the ETA?", true]]);
    tick();
    // Answered last turn: the next turn's read does not ask for it again.
    expect((await x.service.get(x.identity)).comments!.map((c) => c.unread)).toEqual([false]);
    tick();
    await addComment(x.store, { taskId: "t", text: "Also add a test", operationId: "b" });
    tick();
    // The context returned after a write shows the flags without clearing them.
    await x.service.get(x.identity, false);
    expect((await x.service.get(x.identity)).comments!.map((c) => [c.text, c.unread])).toEqual([
      ["What's the ETA?", false],
      ["Also add a test", true],
    ]);
    // A session that never read the card (a new one, the reviewer) sees every comment as unread.
      expect((await x.service.get({ ...x.identity, agentId: "second" })).comments!.map((c) => c.unread)).toEqual([true, true]);
  } finally {
    vi.useRealTimers();
  }
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
  // Handled comments stay listed: only unread ones are acted on, so an old question is not answered every turn.
  expect(skillText).toMatch(/Handle unread inputs and unread comments first/);
  expect(skillText).toMatch(/unread=true marks the comments written since this session last read the card/);
  expect(skillText).not.toMatch(/each cut at 4000 characters/);
  expect(skillText).toMatch(/reviewer[^.]*comments/i);
  // The reviewer's round prompt points at them too.
  expect(reviewPrompt(1, 3)).toMatch(/comments/);
});
