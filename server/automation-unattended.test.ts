import { afterEach, expect, test, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { ReviewClassifier, classifierPrompt, helperSpeed } from "./review-classifier";
import { ToolServer } from "./tool-server";
import { skillText } from "./skill-source";
import { summarySettingsValues } from "../shared/summary";
import { unattendedNote, type AutomationJob, type AutomationSettings } from "../shared/automation";

// Unattended projects, requirement-driven review and the classifier's speed (AUTOMATION-SPEC §5.3). Fake SDK and temp
// directories only: nothing here reaches a daemon.
const roots: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupAutomationFixtures();
});

const stamp = () => new Date().toISOString();
const job = (extra: Partial<AutomationJob>): AutomationJob => ({
  taskId: "t", projectId: "p", role: "implementer", state: "working", generation: 1,
  nudges: 0, failures: 0, reviewRounds: 0, queuedAt: stamp(), updatedAt: stamp(), ...extra,
});
const settings = (unattended: boolean): AutomationSettings => ({
  enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2, ...(unattended ? { unattended: true } : {}),
});

/** Card t driven by automation: `actor` is its implementer, or its reviewer with `second` as the implementer. */
async function card({ unattended = true, role = "implementer", state = "working" }: { unattended?: boolean; role?: "implementer" | "reviewer"; state?: AutomationJob["state"] } = {}) {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((board) => {
    board.projects[0].automation = settings(unattended);
    if (role === "reviewer") board.tasks[0].status = "in_review";
    board.automation.push(job(role === "reviewer" ? { role: "reviewer", state, implementerId: "second", reviewerId: "actor", reviewRounds: 1 } : { state, implementerId: "actor" }));
  });
  return x;
}
type Fixture = Awaited<ReturnType<typeof card>>;
const signed = async (x: Fixture, identity = x.identity) => {
  const ctx = await x.service.get(identity);
  return { expectedRevision: ctx.revision, request: ctx.request };
};
const question = { kind: "question", note: "Does reporting every route as infeasible meet the acceptance criteria?" };
const blocker = { kind: "blocker", note: "The inputs contradict each other." };
const blocked = { status: "blocked", note: "The inputs contradict each other." };
const recorded = async (x: Fixture) => {
  const board = await x.store.read();
  return { events: board.events, receipts: board.agentReceipts, automation: board.automation };
};

test("an unattended project refuses the implementer's questions and blockers before anything is recorded", async () => {
  const x = await card();
  for (const [action, fields] of [["progress", question], ["progress", blocker], ["status", blocked]] as const) {
    const input = { ...(await signed(x)), ...fields };
    const before = await recorded(x);
    await expect(x.service.write(x.identity, action, input), `${action} ${JSON.stringify(fields)}`).rejects.toMatchObject({
      code: "UNATTENDED",
      message: expect.stringContaining("take the most reasonable reading of the card, write your assumption in the workpad and the delivery note, and continue to a delivery"),
    });
    expect(await recorded(x)).toEqual(before);
  }
});

test("an unattended project's reviewer is told to give its verdict instead of asking", async () => {
  const x = await card({ role: "reviewer", state: "reviewing" });
  const input = { ...(await signed(x)), ...question };
  const before = await recorded(x);
  await expect(x.service.write(x.identity, "progress", input)).rejects.toMatchObject({
    code: "UNATTENDED",
    message: expect.stringContaining("give your verdict now with flowly_submit_review: approve, or changes with your doubts as concrete findings"),
  });
  expect(await recorded(x)).toEqual(before);
});

test("questions still reach a person when the project is attended, from a person's own session, and after the job stopped driving the card", async () => {
  const attended = await card({ unattended: false });
  await expect(attended.service.write(attended.identity, "progress", { ...(await signed(attended)), ...question })).resolves.toMatchObject({ receipt: expect.anything() });

  const own = await card();
  const person = { ...own.identity, agentId: "second" }; // a session on the card that automation did not start
  await expect(own.service.write(person, "progress", { ...(await signed(own, person)), ...question })).resolves.toMatchObject({ receipt: expect.anything() });

  const delivered = await card({ state: "delivered" });
  await expect(delivered.service.write(delivered.identity, "progress", { ...(await signed(delivered)), ...question })).resolves.toMatchObject({ receipt: expect.anything() });
});

test("a question recorded before the switch was turned on is replayed, not refused", async () => {
  const x = await card({ unattended: false });
  const input = { ...(await signed(x)), ...question };
  const first = await x.service.write(x.identity, "progress", input);
  await x.store.mutate((board) => { board.projects[0].automation = settings(true); });
  await expect(x.service.write(x.identity, "progress", input)).resolves.toMatchObject({ receipt: first.receipt, replayed: true });
});

const luna = { provider: "codex", model: "gpt-6-luna" };

test("an unattended project's sessions are told nobody answers: the opening, the reminder and the review round", async () => {
  const x = await automationFixture({ enabled: true, unattended: true, reviewer: luna });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  expect(x.created[0].prompt).toContain(unattendedNote);
  await x.turn(impl, "a");
  expect(x.sent.at(-1)).toMatchObject({ agentId: impl });
  expect(x.sent.at(-1)!.text).toContain("Your turn ended without a delivery (reminder 1 of 2)");
  expect(x.sent.at(-1)!.text).toContain("Nobody answers questions in this project: do not ask or report a blocker.");
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  const review = x.created[1].prompt;
  expect(review).toContain("nobody answers questions in this project: decide the verdict yourself");
  expect(review).not.toContain("kind=question");
  expect(review).toContain("list each explicit requirement and prohibition in the card's description");
});

test("an attended project's opening does not carry the unattended rule", async () => {
  const x = await automationFixture({ enabled: true, reviewer: luna });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created[0].prompt).not.toContain(unattendedNote);
  expect(x.created[0].prompt).toContain("Doubt is not a reason to stop");
});

const sol = { provider: "codex", model: "gpt-6.1-sol", thinking: "max", featureValues: { service_tier: "fast" } };
const speed = [{ type: "select", id: "service_tier", label: "Speed", value: null, options: [{ id: "fast", label: "Fast" }, { id: "flex", label: "Flex" }] }];
const features = (result: unknown) => {
  const listFeatures = vi.fn(async () => result);
  return { listFeatures, paseo: { providers: { listFeatures } } as unknown as PaseoApi };
};

test("a classifier helper inherits the speed of the project's model with the same provider and model, only what the provider supports", async () => {
  const project = { automation: { ...settings(false), reviewer: sol } };
  const ok = features({ features: speed });
  expect(await helperSpeed(ok.paseo, "codex/gpt-6.1-sol", project, "/w")).toEqual({ service_tier: "fast" });
  expect(ok.listFeatures).toHaveBeenCalledWith({ provider: "codex/gpt-6.1-sol", cwd: "/w" });

  const other = features({ features: speed });
  expect(await helperSpeed(other.paseo, "codex/gpt-6-luna", project, "/w")).toBeUndefined();
  expect(other.listFeatures).not.toHaveBeenCalled();

  // A role model inherits the same-provider project default's speed, as automation sessions do.
  const inherited = { automation: { ...settings(false), implementer: { provider: "codex", model: "gpt-6.1-sol" } }, agentModel: { provider: "codex", model: "gpt-6-luna", featureValues: { service_tier: "fast" } } };
  expect(await helperSpeed(features({ features: speed }).paseo, "codex/gpt-6.1-sol", inherited, "/w")).toEqual({ service_tier: "fast" });

  const unsupported = { automation: { ...settings(false), reviewer: { ...sol, featureValues: { service_tier: "turbo" } } } };
  expect(await helperSpeed(features({ features: speed }).paseo, "codex/gpt-6.1-sol", unsupported, "/w")).toBeUndefined();
  expect(await helperSpeed(features({ error: "provider unavailable" }).paseo, "codex/gpt-6.1-sol", project, "/w")).toBeUndefined();
  const failing = { providers: { listFeatures: async () => { throw new Error("socket hang up"); } } } as unknown as PaseoApi;
  expect(await helperSpeed(failing, "codex/gpt-6.1-sol", project, "/w")).toBeUndefined();
});

test("the classifier creates its helper with the project's speed and never its reasoning depth", async () => {
  const x = await automationFixture({ enabled: true, reviewer: sol });
  // Only card a needs a classification: the background scan would otherwise classify b too.
  await x.store.mutate((b) => { b.tasks.find((t) => t.id === "b")!.reviewLevel = "standard"; });
  const configs: Record<string, unknown>[] = [];
  let helpers = 0;
  const api = {
    agents: { ref: (id: string) => ({ id, refresh: async () => null, archive: async () => {} }) },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }),
      listModels: async () => ({ models: [{ id: "gpt-6.1-sol" }] }),
      listFeatures: async () => ({ features: speed }),
    },
    workspaces: { ref: () => ({ agents: { create: async (input: { agentId: string; config: Record<string, unknown> }) => {
      configs.push(input.config);
      return { id: input.agentId, archive: async () => {}, waitForFinish: async () => ({ status: "idle", lastMessage: JSON.stringify({ level: "standard", reason: "The card changes one screen." }) }) };
    } } }) },
  } as unknown as PaseoApi;
  const service = new ReviewClassifier(x.store, async () => summarySettingsValues({ summaryModels: ["codex/gpt-6.1-sol"] }), {
    debounceMs: 5, modelMs: 500, runMs: 3000, waitMs: 2000, stopGraceMs: 10, newHelperId: () => `helper-${helpers++}`, remove: async () => {},
  });
  stops.push(() => service.stop().then(() => service.helpers.drained()));
  await service.forReview("a", api);
  expect(configs).toEqual([{ provider: "codex/gpt-6.1-sol", featureValues: { service_tier: "fast" } }]);
  expect((await x.store.read()).tasks.find((t) => t.id === "a")!.reviewClassification).toMatchObject({ status: "ready", verdict: { level: "standard" } });
});

test("the narrowed Deep criteria and the directory sub-card rule read the same in the skill, the classifier and create_card", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  const server = new ToolServer(x.store);
  stops.push(() => server.stop());
  await server.start();
  const { url } = JSON.parse(await readFile(x.store.directory + "/tool-endpoint.json", "utf8"));
  const response = await fetch(url + "mcp", {
    method: "POST",
    headers: { Authorization: "Bearer " + server.secrets.credential(x.identity), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).at(-1)! : body;
  const createCard = (JSON.parse(json).result.tools as { name: string; description: string }[]).find((t) => t.name === "flowly_create_card")!.description;

  const board = await x.store.read();
  for (const [name, text] of [["skill", skillText], ["create_card", createCard], ["classifier", classifierPrompt(board, board.tasks[0])]] as const)
    expect(text, name).toMatch(/[Aa] self-contained program verified by tests[^.]* is [Ss]tandard/);
  expect(skillText).toContain("foundation cards that later cards or stored data depend on");
  expect(createCard).toContain("foundation cards that later cards or stored data depend on");
  expect(skillText).toContain("automated sub-cards there run one at a time, so splitting does not make the work parallel");
  expect(createCard).toContain("automated sub-cards there run one at a time and splitting does not make the work parallel");
  expect(skillText).toContain("Doubt is not a reason to stop");
  expect(skillText).toContain("Whether the delivery meets the card is yours to decide");
  expect(skillText).toContain("check that it works where it will run (another user, read-only install directories, none of this session's caches or environment)");
});
