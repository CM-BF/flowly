import { afterEach, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { forgetHistory } from "./provider-history";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { AutomationService, type AutomationDeps } from "./automation";
import { beginRotation, type AutomationHandoffBridge, type RotationContext } from "./automation-rotation";
import type { SessionPolicyFacts } from "../shared/session-measurement";
import type { AutomationSettings } from "../shared/automation";
const services: AutomationService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.stop())); await cleanupAutomationFixtures(); forgetHistory(); });

async function fixture(settings: Partial<AutomationSettings> = {}) {
  const x = await automationFixture({ enabled: true, ...settings }); await x.automation.stop();
  const observations = new Map<string, Partial<SessionPolicyFacts>>(), prepared = new Map<string, string>();
  const comments = new Map<string, { text: string; messageId: string; mode?: "steer" | "interrupt" | "queue"; fresh?: boolean }>();
  const results: { sourceId: string; kind: string; agentId?: string }[] = [];
  const bridge: AutomationHandoffBridge = {
    measure: vi.fn(async ({ agentId }): Promise<SessionPolicyFacts> => ({ agentId, provider: x.agents.get(agentId)?.provider ?? "claude", at: Date.parse(x.at()), C: 50_000, C0: 10_000, W: 1_000_000, B: 1000, peakC: 50_000, lastTurnEndAt: Date.parse(x.at()) - 1000, ttlKind: "claude-1h", ...observations.get(agentId) })),
    prepare: vi.fn(async () => ({})), seal: vi.fn(async (_c: RotationContext) => ({ prompt: "SEALED-HANDOFF", revision: 3 })),
    committed: vi.fn(async () => {}), abandoned: vi.fn(async () => {}),
  };
  const deps: AutomationDeps = {
    handoff: bridge, clock: () => Date.parse(x.at()), historyBytes: async agent => x.hooks.history?.(agent.id!) ?? null,
    globalModel: async () => null,
    prepare: async (taskId, op) => { if (!prepared.has(op)) prepared.set(op, `policy-${prepared.size + 1}`); return { agentId: prepared.get(op)!, instructions: "card tools", contextFile: "ctx", cliPath: "cli", skillPath: "skill", mcp: { type: "http", url: "http://fixture", headers: {} } }; },
    readComment: async (_taskId, id) => comments.get(id),
    sendComment: async ({ agentId, text, messageId, mode }) => {
      if (mode === "queue" && x.agents.get(agentId)?.status === "running") return { kind: "queued" };
      await x.paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer", messageId }); return { kind: "sent" };
    },
    commentResult: async (taskId, sourceId, result) => { results.push({ sourceId, ...result }); await x.store.mutate(board => { const route=board.commentRoutes?.find(r => r.taskId === taskId && r.sourceId === sourceId); if(route) { route.phase=result.kind; if(result.agentId) route.agentId=result.agentId; } }); },
  };
  let automation = new AutomationService(x.store, deps); services.push(automation); automation.attach(x.paseo); await automation.kick();
  let serial = 0;
  const boundary = async (kind: "wake" | "retry" | "changes" = "wake") => {
    const j = await x.job("a"); x.agents.get(j.implementerId!)!.status = "idle";
    await x.store.mutate(board => { const job = board.automation[0]; job.state = "working"; job.role = "implementer"; job.instruction = { id: `instruction-${++serial}`, role: "implementer", kind, text: "unfinished exact instruction", fresh: "unfinished exact instruction" }; job.workInstructions = { ...job.workInstructions, implementer: { ...job.instruction, kind: "wake" } }; });
    await automation.kick();
  };
  const start = async (id: string) => { x.advance(1000); x.agents.get(id)!.status = "running"; await x.record("a", { actor: "system", action: "agent.turn_started", agentId: id }); await automation.turnStarted(id, "a"); };
  const end = async (id: string) => { x.advance(1000); x.agents.get(id)!.status = "idle"; await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: id, outcome: "completed" }); await automation.turnEnded(id); await automation.kick(); };
  const reload = async () => { await automation.stop(); automation = new AutomationService(x.store, deps); services.push(automation); automation.attach(x.paseo); await automation.kick(); };
  await automation.queue("a"); await automation.kick();
  return { ...x, get a() { return automation; }, deps, bridge, observations, boundary, start, end, reload, comments, results };
}

test("64 MiB replaces on a retry while keeping the 200 MiB noRead constant and exact launch model", async () => {
  const x = await fixture(); const old = x.created[0].agentId;
  x.observations.set(old, { B: 64 * 2 ** 20 });
  await x.boundary("retry");
  expect(x.created).toHaveLength(2); expect(x.created[1].provider).toBe(x.created[0].provider);
  expect(x.created[1].prompt).toContain("unfinished exact instruction");
  expect(await x.job("a")).toMatchObject({ rotations: { bytes: 1, soft: 0 } });
});

test("soft context replacement commits once across a commit retry and a reload", async () => {
  const x = await fixture(); const old = x.created[0].agentId;
  x.observations.set(old, { C: 310_000, peakC: 310_000 });
  let fail = true; x.bridge.committed = vi.fn(async () => { if (fail) throw new Error("record unavailable"); });
  await x.boundary(); expect(x.created).toHaveLength(2); expect((await x.job("a")).rotations?.soft ?? 0).toBe(0);
  await x.reload(); expect(x.created).toHaveLength(2); fail = false; await x.a.kick(); await x.a.kick();
  expect((await x.job("a")).rotations?.soft).toBe(1); expect((await x.job("a")).rotation).toBeUndefined();
});

test("the third byte trigger holds its unsent instruction without stopping or creating another worker", async () => {
  const x = await fixture();
  for (let i = 0; i < 3; i++) { x.observations.set((await x.job("a")).implementerId!, { B: 64 * 2 ** 20 }); await x.boundary("retry"); }
  expect(x.created).toHaveLength(3); expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted", hold: "history_runaway", rotations: { bytes: 3 }, instruction: { text: "unfinished exact instruction" } });
  await x.reload(); expect(x.created).toHaveLength(3);
  const c={taskId:"a",sourceId:"comment:hold",messageId:"comment:hold",text:"saved while runaway is held"};
  expect(await x.a.routeComment(c)).toMatchObject({kind:"pending"}); expect((await x.job("a")).rotations?.bytes).toBe(3);
  await expect(x.a.requestFresh("a")).rejects.toMatchObject({code:"NEEDS_PERSON"});
});

test("an unknown create keeps the same identity and does not spend the byte budget twice", async () => {
  const x = await fixture(), old = x.created[0].agentId;
  x.observations.set(old, { B: 64 * 2 ** 20 });
  x.hooks.create = async () => { throw Object.assign(new Error("agent_request_outcome_unknown"), { code: "agent_request_outcome_unknown" }); };
  await x.boundary(); const before = await x.job("a");
  expect(before).toMatchObject({ state: "needs_human", unconfirmed: true, rotations: { bytes: 1 }, rotation: { stage: "creating" } });
  await x.reload(); expect(x.created).toHaveLength(1); expect((await x.job("a")).rotation?.toAgentId).toBe(before.rotation?.toAgentId); expect((await x.job("a")).rotations?.bytes).toBe(1);
});

test("new cycles get a new reviewer while same-cycle changes keep the healthy review session", async () => {
  const x = await fixture({ reviewer: { provider: "codex", model: "gpt-6-luna" } }); const impl = x.created[0].agentId;
  await x.deliver(impl, "a"); await x.end(impl); const rev = x.created[1].agentId;
  x.agents.get(rev)!.status = "idle";
  await x.a.submitReview({ taskId: "a", workspaceId: "w-a", agentId: rev }, { verdict: "changes", summary: "one fix", findings: ["fix it"], risks: [] }); await x.a.kick();
  await x.deliver(impl, "a"); await x.start(impl); await x.end(impl);
  expect((await x.job("a")).reviewerId).toBe(rev); expect((await x.job("a")).reviewRounds).toBe(2);
  x.agents.get(rev)!.status = "idle";
  await x.a.submitReview({ taskId: "a", workspaceId: "w-a", agentId: rev }, { verdict: "approve", summary: "done", findings: [], risks: [] });
  await x.start(impl); await x.deliver(impl, "a"); await x.end(impl);
  const job = await x.job("a"); expect(job.reviewerId).not.toBe(rev); expect(job.reviewRounds).toBe(1); expect(job.reviewerCycle).toBe(job.cycle);
  expect(x.bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ role: "reviewer", reason: "new_cycle", allowFinalize: false }));
});

test("cold comments create once with their exact first text and message identity and carry the prior instruction", async () => {
  const x = await fixture(), old = x.created[0].agentId; x.agents.get(old)!.status = "idle";
  x.observations.set(old, { C: 150_000, peakC: 150_000, lastTurnEndAt: Date.parse(x.at()) - 4 * 3_600_000 });
  await x.store.mutate(b => { b.automation[0].instruction = { id: "prior", role: "implementer", kind: "wake", text: "finish original wake", fresh: "finish original wake" }; });
  const comment = { taskId: "a", sourceId: "comment:one", messageId: "comment:one", text: "  人的原话\n" };
  x.comments.set(comment.sourceId, comment); expect((await x.a.routeComment(comment)).kind).toBe("pending"); await x.a.kick();
  expect(x.created).toHaveLength(2); expect(x.created[1]).toMatchObject({ prompt: comment.text, clientMessageId: comment.messageId });
  expect(x.bridge.seal).toHaveBeenCalledWith(expect.objectContaining({ continuation: expect.objectContaining({ text: "finish original wake" }) }));
  expect(x.results).toContainEqual(expect.objectContaining({ sourceId: comment.sourceId, kind: "fresh", agentId: x.created[1].agentId })); expect((await x.job("a")).pendingInputs).toEqual([]);
});

test("an unsent review instruction is never replaced by a cold comment; approval drains the saved source", async () => {
  const x = await fixture({ reviewer: { provider: "codex", model: "gpt-6-luna" } }), impl = x.created[0].agentId;
  await x.deliver(impl, "a"); await x.end(impl); const rev = x.created[1].agentId;
  x.agents.get(rev)!.status = "idle"; x.agents.get(impl)!.status = "idle";
  await x.store.mutate(b => { b.automation[0].instruction = { id: "held-review", role: "reviewer", text: "review exact", fresh: "review exact", kind: "round", reviewDelivery: b.automation[0].deliveryEvent }; });
  x.observations.set(impl, { C: 150_000, peakC: 150_000, lastTurnEndAt: Date.parse(x.at()) - 4 * 3_600_000 });
  const c = { taskId: "a", sourceId: "comment:pending", messageId: "comment:pending", text: "next instruction" }; x.comments.set(c.sourceId, c);
  expect((await x.a.routeComment(c)).kind).toBe("pending"); expect((await x.job("a")).instruction?.id).toBe("held-review");
  await x.store.mutate(b => { delete b.automation[0].instruction; });
  await x.a.submitReview({ taskId: "a", workspaceId: "w-a", agentId: rev }, { verdict: "approve", summary: "accepted", findings: [], risks: [] }); await x.a.kick();
  expect(x.results).toContainEqual(expect.objectContaining({ sourceId: c.sourceId, kind: "fresh", agentId: x.created[2].agentId })); expect((await x.job("a")).pendingInputs).toEqual([]);
});


test("a reserved comment recovers after a crash before pendingInputs, even behind a non-comment input", async () => {
  const x = await fixture(), impl = x.created[0].agentId; x.agents.get(impl)!.status = "idle";
  const comment = { text: "durable original", messageId: "comment:recover" }; x.comments.set("source:recover", comment);
  await x.store.mutate(board => {
    const j = board.automation[0]; j.state = "needs_human"; j.code = "question"; j.pendingInputs = ["human:session-direct"];
    board.commentRoutes = [{ taskId: "a", sourceId: "source:recover", eventId: "comment-event", messageId: comment.messageId, choice: "auto", phase: "prepared", at: x.at() }];
  });
  await x.reload(); await x.a.kick();
  expect(x.sent.filter(s => s.messageId === comment.messageId)).toHaveLength(1);
  expect((await x.job("a")).pendingInputs).toEqual(["human:session-direct"]);
});

test("deferred explicit fresh is recovered as fresh rather than sent to a warm worker", async () => {
  const x = await fixture(), impl = x.created[0].agentId; x.agents.get(impl)!.status = "idle";
  const comment = { text: "fresh explicitly", messageId: "comment:explicit", fresh: true }; x.comments.set("source:explicit", comment);
  await x.store.mutate(board => { board.automation[0].state = "delivered"; board.commentRoutes = [{ taskId: "a", sourceId: "source:explicit", eventId: "event", messageId: comment.messageId, choice: "fresh", phase: "pending", at: x.at() }]; });
  await x.reload(); await x.a.kick();
  expect(x.created).toHaveLength(2); expect(x.created[1]).toMatchObject({ prompt: comment.text, clientMessageId: comment.messageId });
  expect(x.results).toContainEqual(expect.objectContaining({ sourceId: "source:explicit", kind: "fresh" }));
});

test("warm comments send while a held reviewer instruction is preserved", async () => {
  const x = await fixture({ reviewer: { provider: "codex", model: "gpt-6-luna" } }), impl = x.created[0].agentId;
  await x.deliver(impl, "a"); await x.end(impl); const rev = x.created[1].agentId; x.agents.get(impl)!.status = "idle"; x.agents.get(rev)!.status = "idle";
  await x.store.mutate(b => { b.automation[0].instruction = { id: "held", role: "reviewer", text: "review evidence", fresh: "review evidence", kind: "round" }; });
  const c = { taskId: "a", sourceId: "comment:warm", messageId: "comment:warm", text: "question in warm context" };
  expect(await x.a.routeComment(c)).toMatchObject({ kind: "sent", agentId: impl });
  expect((await x.job("a")).instruction?.id).toBe("held"); expect(x.created).toHaveLength(2);
});

test("cached keep survives retries but a newly grown main history still forces replacement", async () => {
  const x = await fixture(), old = x.created[0].agentId; x.agents.get(old)!.status = "idle";
  x.hooks.send = async () => { throw new Error("temporary transport unavailable"); };
  await x.boundary(); const first = await x.job("a"); expect(first.instruction?.rotationDecision?.action).toBe("keep");
  x.observations.set(old, { C: 400_000, peakC: 400_000 }); x.hooks.send = undefined;
  await x.store.mutate(b => { b.automation[0].state = "working"; delete b.automation[0].retryAt; }); await x.a.kick();
  expect(x.created).toHaveLength(1);
  await x.store.mutate(b => { b.automation[0].instruction = first.instruction; b.automation[0].state = "working"; });
  x.observations.set(old, { B: 64 * 2 ** 20 }); await x.a.kick(); expect(x.created).toHaveLength(2);
});

test("a byte replacement midway through review preserves its accepted plan, seat, round and delivery", async () => {
  const x = await fixture({ reviewer: { provider: "codex", model: "gpt-6-luna" } }), impl = x.created[0].agentId;
  await x.deliver(impl, "a"); await x.end(impl); const rev = x.created[1].agentId; x.agents.get(rev)!.status = "idle";
  await x.store.mutate(b => { const j=b.automation[0]; j.review = { level: "deep", reason: { kind: "card" }, max: 4, size: 3 }; j.seat="deep"; j.risks=["scale under load"]; j.instruction={id:"review-retry",role:"reviewer",kind:"retry",text:"continue round",fresh:"continue round",reviewDelivery:j.deliveryEvent}; });
  const before = await x.job("a"); x.observations.set(rev, { B: 64 * 2 ** 20 }); await x.a.kick();
  expect(await x.job("a")).toMatchObject({ reviewRounds: before.reviewRounds, review: before.review, seat: before.seat, deliveryEvent: before.deliveryEvent, risks: before.risks });
  expect(x.created[2].prompt).toContain("3 independent reviewers"); expect(x.created[2].prompt).toContain("scale under load");
});

test("a known context rejection replaces once without a finalization turn", async () => {
  const x = await fixture(), old = x.created[0].agentId; x.agents.get(old)!.status = "idle";
  x.hooks.send = async () => { throw new Error("prompt too long for context window"); }; await x.boundary("retry");
  expect(x.created).toHaveLength(2); expect(x.bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ allowFinalize: false }));
});


test("soft context replacement stops after four committed successors in one generation", async () => {
  const x=await fixture();
  for(let i=0;i<5;i++) { x.observations.set((await x.job("a")).implementerId!,{C:310_000,peakC:310_000}); await x.boundary(); }
  expect(x.created).toHaveLength(5); expect((await x.job("a")).rotations).toEqual({soft:4,bytes:0});
});

test("an unknown send result containing context words is not treated as a known poisoned failure", async () => {
  const x=await fixture(),old=x.created[0].agentId; x.agents.get(old)!.status="idle";
  x.hooks.send=async()=>{throw Object.assign(new Error("context limit outcome unknown"),{code:"agent_request_outcome_unknown"});};
  await x.boundary(); await x.reload();
  expect(x.created).toHaveLength(1); expect((await x.job("a")).rotation).toBeUndefined();
  expect((await x.job("a")).unconfirmed).toBe(true);
});

test.each(["working","needs_human","retry_wait","waiting","delivered"] as const)("a recovered comment can reach an idle worker in %s",async state=>{
  const x=await fixture(),impl=x.created[0].agentId; x.agents.get(impl)!.status="idle";
  const c={text:"saved before dispatcher",messageId:`comment:${state}`};x.comments.set(`source:${state}`,c);
  await x.store.mutate(b=>{const j=b.automation[0];j.state=state;delete j.instruction;delete j.retryAt;b.commentRoutes=[{taskId:"a",sourceId:`source:${state}`,eventId:"e",messageId:c.messageId,choice:"auto",phase:"prepared",at:x.at()}];});
  await x.reload();expect(x.sent.filter(s=>s.messageId===c.messageId)).toHaveLength(1);expect((await x.job("a")).pendingInputs).toEqual([]);
});

test("running comments keep their exact text and queue preference and explicit fresh never interrupts",async()=>{
  const x=await fixture(),impl=x.created[0].agentId; x.agents.get(impl)!.status="running";
  const c={taskId:"a",sourceId:"comment:running",messageId:"comment:running",text:"exact while busy",mode:"queue" as const};
  expect(await x.a.routeComment(c)).toMatchObject({kind:"queued",agentId:impl});expect(x.created).toHaveLength(1);
  await expect(x.a.routeComment({...c,sourceId:"fresh",fresh:true})).rejects.toMatchObject({code:"SESSION_BUSY"});expect(x.created).toHaveLength(1);
});


test("a parent queue starts a new generation without reusing the previous reviewer",async()=>{
  const x=await fixture({reviewer:{provider:"codex",model:"gpt-6-luna"}}),impl=x.created[0].agentId;
  await x.deliver(impl,"a");await x.end(impl);const rev=x.created[1].agentId;x.agents.get(rev)!.status="idle";
  await x.a.submitReview({taskId:"a",workspaceId:"w-a",agentId:rev},{verdict:"approve",summary:"checked",findings:[],risks:[]});
  await x.a.queue("a",{agentId:"parent"}); await x.a.kick();
  expect((await x.job("a")).reviewerId).toBeUndefined();expect((await x.job("a")).retired).toContainEqual(expect.objectContaining({agentId:rev,role:"reviewer"}));
});

test("a cold comment waits for the current reviewer to end before creating its successor",async()=>{
  const x=await fixture({reviewer:{provider:"codex",model:"gpt-6-luna"}}),impl=x.created[0].agentId;
  await x.deliver(impl,"a");await x.end(impl);const rev=x.created[1].agentId;x.agents.get(impl)!.status="idle";
  x.observations.set(impl,{C:150_000,peakC:150_000,lastTurnEndAt:Date.parse(x.at())-4*3_600_000});
  const c={taskId:"a",sourceId:"comment:peer",messageId:"comment:peer",text:"fresh work after current review"};
  expect(await x.a.routeComment(c)).toMatchObject({kind:"pending"});await x.a.kick();expect(x.created).toHaveLength(2);
  expect(await x.job("a")).toMatchObject({role:"implementer",reopened:true,rotation:{carry:{text:c.text}}});
  await x.end(rev);await x.a.kick();expect(x.created).toHaveLength(3);expect(x.created[2].prompt).toBe(c.text);
});


test("running byte warnings escalate once at 128 and 300 MiB while checkpoint and silence stay card-only",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;await x.start(impl);
 x.observations.set(impl,{B:128*2**20,C:700_000,W:1_000_000});x.advance(61_000);await x.a.kick();
 expect(await x.job("a")).toMatchObject({historyWarning:{agentId:impl,level:"large"},checkpoint:{agentId:impl,reason:expect.stringContaining("128 MiB")}});
 x.advance(61_000);await x.a.kick();
 x.observations.set(impl,{B:301*2**20});x.advance(61_000);await x.a.kick();x.advance(61_000);await x.a.kick();
 expect((await x.store.read()).events.filter(e=>e.action==="automation_history_large")).toHaveLength(2);expect((await x.job("a")).historyWarning?.level).toBe("critical");
 expect(x.created).toHaveLength(1);expect(x.sent).toHaveLength(0);
 x.advance(21*60_000);await x.a.kick();expect((await x.job("a")).silentSince).toBeDefined();
 x.deps.lastToolAt=()=>x.at();x.advance(61_000);await x.a.kick();expect((await x.job("a")).silentSince).toBeUndefined();
 await x.store.mutate(b=>{b.automation[0].silentSince=x.at();});await x.end(impl);expect((await x.job("a")).silentSince).toBeUndefined();
});

test("a recent real handoff suppresses the twenty-minute activity checkpoint and reviewers never receive it",async()=>{
 const x=await fixture({reviewer:{provider:"codex",model:"gpt-6-luna"}}),impl=x.created[0].agentId;
 await x.start(impl);x.deps.checkpointAt=async()=>Date.parse(x.at())-1000;x.advance(21*60_000);await x.a.kick();expect((await x.job("a")).checkpoint).toBeUndefined();
 await x.deliver(impl,"a");await x.end(impl);const rev=x.created[1].agentId;await x.start(rev);x.observations.set(rev,{C:800_000,W:1_000_000,K:1});x.advance(61_000);await x.a.kick();expect((await x.job("a")).checkpoint?.agentId).not.toBe(rev);
});


test("a fresh request installed during measurement owns the instruction even if the measured policy would keep",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;let armed=true;const original=x.bridge.measure!;
 x.bridge.measure=async context=>{if(armed){armed=false;await x.store.mutate(b=>{beginRotation(b.automation[0],"requested",x.at(),{forced:false});});}return original(context);};
 await x.boundary();expect(x.created).toHaveLength(2);expect(x.sent.filter(s=>s.agentId===impl)).toHaveLength(0);
});

test("a delayed sender failure keeps its source and records the error instead of failing the automation turn",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;x.agents.get(impl)!.status="idle";
 const c={text:"retry same original",messageId:"comment:failure"};x.comments.set("source:failure",c);
 await x.store.mutate(b=>{b.automation[0].state="needs_human";b.automation[0].pendingInputs=["source:failure"];});
 const failure=new Error("native outcome unknown");x.deps.sendComment=async()=>{throw failure;};x.deps.commentFailed=vi.fn(async()=>{});
 await x.a.kick();expect(x.deps.commentFailed).toHaveBeenCalledWith("a","source:failure",failure);
 expect(await x.job("a")).toMatchObject({state:"needs_human",pendingInputs:["source:failure"],failures:0});
});

test("confirmed receipt evidence clears a deferred comment reference without clearing unrelated inputs",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;x.agents.get(impl)!.status="idle";
 await x.store.mutate(b=>{b.automation[0].state="needs_human";b.automation[0].pendingInputs=["source:evidence","session:direct"];b.commentRoutes=[{taskId:"a",sourceId:"source:evidence",eventId:"e",messageId:"comment:evidence",choice:"auto",phase:"sent",at:x.at()}];});
 await x.a.kick();expect((await x.job("a")).pendingInputs).toEqual(["session:direct"]);expect(x.sent).toHaveLength(0);
});


test("unchanged busy minute polls preserve board bytes and revision after their first sample",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;await x.start(impl);x.advance(61_000);await x.a.kick();
 const bytes=await readFile(x.store.path,"utf8"),revision=(await x.store.read()).revision;
 for(let n=0;n<2;n++){x.advance(61_000);await x.a.kick();}
 expect((await x.store.read()).revision).toBe(revision);expect(await readFile(x.store.path,"utf8")).toBe(bytes);
});

test("an idle live job does not measure or rewrite its board on minute polls",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;x.agents.get(impl)!.status="idle";
 await x.store.mutate(b=>{b.automation[0].state="needs_human";b.automation[0].code="question";});
 const measure=vi.mocked(x.bridge.measure!);measure.mockClear();
 const bytes=await readFile(x.store.path,"utf8"),revision=(await x.store.read()).revision;
 for(let n=0;n<2;n++){x.advance(61_000);await x.a.kick();}
 expect(measure).not.toHaveBeenCalled();expect((await x.store.read()).revision).toBe(revision);expect(await readFile(x.store.path,"utf8")).toBe(bytes);
});

test("real growth still requests a checkpoint from three consecutive busy samples",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;await x.start(impl);
 for(const mb of [70,85,100]){x.observations.set(impl,{B:mb*2**20});x.advance(61_000);await x.a.kick();}
 expect((await x.job("a")).checkpoint?.reason).toContain("ten minutes");expect(x.created).toHaveLength(1);expect(x.sent).toHaveLength(0);
});


test.each([64,128,200])("completed-turn limit detection never loads a %i MiB predecessor timeline",async mb=>{
 const x=await fixture(),impl=x.created[0].agentId;let reads=0;x.hooks.history=()=>mb*2**20;x.hooks.timeline=()=>{reads++;return[];};
 await x.end(impl);expect(reads).toBe(0);
});

test("a worker becoming busy while policy is measured keeps its unsent instruction",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;const original=x.bridge.measure!;let armed=true;
 x.bridge.measure=async context=>{const facts=await original(context);if(armed){armed=false;x.agents.get(impl)!.status="running";x.agents.get(impl)!.activeTurn={turnId:"human-race"};}return facts;};
 await x.boundary();expect(x.sent.filter(s=>s.agentId===impl)).toHaveLength(0);expect((await x.job("a")).instruction?.text).toBe("unfinished exact instruction");
});

test("a new permission wait during policy measurement cannot consume or steer the pending instruction",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;const original=x.bridge.measure!;let armed=true;
 x.bridge.measure=async context=>{const facts=await original(context);if(armed){armed=false;x.agents.get(impl)!.pendingPermissions=[{id:"wait-for-person"}];}return facts;};
 await x.boundary();expect(x.sent.filter(s=>s.agentId===impl)).toHaveLength(0);expect((await x.job("a")).instruction).toBeDefined();
});


test("an unknown final snapshot defers without sending, consuming its instruction or spending failure budget",async()=>{
 const x=await fixture(),impl=x.created[0].agentId;const original=x.bridge.measure!;let measured=false;
 x.bridge.measure=async context=>{const facts=await original(context);measured=true;return facts;};
 x.hooks.refresh=async id=>{if(id===impl&&measured)throw new Error("snapshot temporarily unavailable");};
 await x.boundary();expect(x.sent).toHaveLength(0);expect(await x.job("a")).toMatchObject({state:"working",failures:0,instruction:{text:"unfinished exact instruction"}});
});
