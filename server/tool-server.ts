import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import {
  ideaInputSchema,
  ideaRemovalSchema,
  ideaUpdateInputSchema,
  rememberInputSchema,
  recallInputSchema,
  recallResultSchema,
  artifactInputSchema,
  artifactRemovalSchema,
  readExternalInputSchema,
  externalReadSchema,
  tagsInputSchema,
  typeInputSchema,
  metadataInputSchema,
  nextMovesInputSchema,
  workpadInputSchema,
  progressInputSchema,
  statusInputSchema,
  toolContextSchema,
  toolResultSchema,
  type ToolIdentity,
  type ToolPreparation,
} from "../shared/tools";
import { handoffGetInputSchema } from "../shared/handoff-api";
import { sessionHistoryQuerySchema, sessionHistoryPageSchema } from "../shared/session-history";
import { handoffUpdateSchema, handoffWriteResultSchema } from "../shared/handoff";
import { judgementInputSchema, reviewInputSchema, reviewResultSchema } from "../shared/automation-schema";
import { reviewerOfCard } from "../shared/automation";
import { createCardInputSchema, createCardResultSchema, updateCardInputSchema, updateCardResultSchema } from "../shared/tools";
import { AgentService } from "./agent-service";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ToolSecrets, writePrivate } from "./tool-context";
import { ToolError, toolFailure } from "./tool-error";
import { cliSource } from "./cli-source";
import { skillText, workingInstructions } from "./skill-source";
import { logFailure } from "./error-report";

const maxBody = 262144;

export class ToolServer {
  readonly secrets: ToolSecrets;
  readonly agents: AgentService;
  private server?: Server;
  private handler?: McpHttpHandler;
  private starting?: Promise<void>;
  private preparation = Promise.resolve<unknown>(undefined);
  private url = "";
  private reason = "Starting Kanban tool service…";
  private stopped = false;
  constructor(readonly store: BoardStore) {
    this.secrets = new ToolSecrets(store.directory);
    this.agents = new AgentService(store, this.secrets);
  }
  attach(paseo: PaseoApi) {
    this.agents.attach(paseo);
  }
  private async taskIds() {
    return new Set((await this.store.read()).tasks.map((t) => t.id));
  }
  /** Managed sessions of cards that still exist (a deleted card's binding is not listed). */
  async managedSessions() {
    return this.secrets.managedSessions(await this.taskIds());
  }
  /** Removes the bindings and credentials of deleted cards; never throws into its caller's flow. */
  async pruneContexts() {
    return this.secrets.pruneContexts(await this.taskIds());
  }
  health() {
    const listening = !!this.server?.listening;
    return {
      listening,
      sdkReady: this.agents.sdkReady,
      ready: listening && this.agents.sdkReady,
      reason:
        this.reason ||
        (!this.agents.sdkReady
          ? "Waiting for Paseo context. Refresh the drawer or start a session turn."
          : ""),
      version: 1 as const,
    };
  }
  async start() {
    if (this.stopped)
      throw new ToolError(
        "TOOLS_UNAVAILABLE",
        "Tool service is stopping.",
        true,
      );
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    const job = this.initialize();
    this.starting = job;
    try {
      await job;
      this.reason = "";
    } catch (e) {
      this.reason = toolFailure(e).message;
      await this.closeListener();
      throw new ToolError("TOOLS_UNAVAILABLE", this.reason, true);
    } finally {
      this.starting = undefined;
    }
  }
  private token(value: string | undefined) {
    if (!value?.startsWith("Bearer "))
      throw new ToolError("UNAUTHORIZED", "Missing Kanban session credential.");
    return this.secrets.authenticate(value.slice(7));
  }
  private async initialize() {
    await this.secrets.initialize();
    // Bindings of cards deleted earlier (or before this cleanup existed). An empty board is never trusted for this.
    if ((await this.store.read()).tasks.length)
      await this.pruneContexts().catch((e) =>
        logFailure("Kanban session bindings not cleaned:", e),
      );
    await writePrivate(
      join(this.store.directory, "flowly.mjs"),
      cliSource,
      0o700,
    );
    // Refresh an existing session's old CLI entry on upgrade. Fresh installs
    // create only flowly.mjs; new instructions never advertise the old path.
    const legacyCli = join(this.store.directory, "ultra-kanban.mjs");
    try {
      await access(legacyCli);
      await writePrivate(legacyCli, cliSource, 0o700);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await writePrivate(join(this.store.directory, "SKILL.md"), skillText);
    let port = 0;
    const discoveryFile = join(this.store.directory, "tool-endpoint.json");
    try {
      port = z
        .object({
          version: z.literal(1),
          port: z.number().int().min(1).max(65535),
          url: z.string(),
        })
        .parse(JSON.parse(await readFile(discoveryFile, "utf8"))).port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError(
          "TOOLS_UNAVAILABLE",
          `Tool discovery is invalid; preserved at ${discoveryFile}.`,
        );
    }
    const wrap = async (operation: () => Promise<object>) => {
      try {
        const value = await operation();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value as Record<string, unknown>,
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify(toolFailure(e)) },
          ],
          structuredContent: { error: toolFailure(e) },
        };
      }
    };
    this.handler = createMcpHandler(
      ({ requestInfo }) => {
        const identity = this.token(
          requestInfo?.headers.get("authorization") || undefined,
        );
        const call = (operation: () => Promise<object>) => wrap(async () => { await this.agents.toolCalled(identity); return operation(); });
        const mcp = new McpServer({
          name: "flowly",
          version: "0.2.0",
        });
        mcp.registerTool(
          "flowly_get_task",
          {
            description:
              "Read this session's current Kanban card, latest turnChecklist, effective repo/worktree directories, both revisions and signed request. Read at the start of every turn, including commit/merge-only follow-ups, and before any write. Handle unread inputs (artifacts with unread=true were added or edited since your last read) and fix setup.missing (flowly_set_type, flowly_set_tags, flowly_update_workpad, flowly_update_metadata) before work; a reviewer leaves setup to the implementer. comments lists what people wrote on the card (questions about progress, opinions, requested changes), oldest first; those with unread=true were written since your last read: treat each of them like a message from the user and answer it or do what it asks. Comments you read before stay listed as context and are shortened when long. handoff is the card continuity record; respect explicit gaps and omitted counts. Use handoff=full and handoffCursor to read all pages before a successor ACK; previews are not complete original text. writable=false on a retired/finalizing session means stop ordinary card work.",
            inputSchema: handoffGetInputSchema,
            outputSchema: toolContextSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.get(identity, true, true, input)),
        );
        mcp.registerTool(
          "flowly_session_history",
          { description: "Read bounded, redacted excerpts from a session in this card's handoff ledger. Select its exact agent ID or #number; search with query, around and roles, then follow nextCursor. First access may return building. Coverage, omitted and gaps describe the indexed range; no match never proves a missing detail does not exist. Original histories are not loaded through Paseo or rewritten. Changed source snapshots require an explicit rebuild. Messages, tool arguments and tool outputs are head-and-tail excerpts (middle gives the omitted source bytes); images, reasoning and records over 256 KiB are not indexed. Use original handoff inputs for exact human wording.", inputSchema: sessionHistoryQuerySchema, outputSchema: sessionHistoryPageSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
          input => call(() => this.agents.readSessionHistory(identity, input)),
        );
        mcp.registerTool(
          "flowly_update_handoff",
          {
            description: "Update this card's durable handoff: current state, done, next, decisions with reasons, ruled-out options, problems, pitfalls, running work, references and environment. Preserve the next session's information; do not rely on its seeing this conversation. Read handoff.revision from get_task and send handoffRevision, with stable operationId for uncertain retries. Entry revisions permit unrelated concurrent edits; on HANDOFF_CONFLICT reread rather than overwrite. Original input wording, questions, reviews and repository observations are Flowly-derived; only input dispositions and explicit question-answer links can be changed. Report a missing detail with gaps=[{text,status:\"open\"}]; close an existing gap with its id, status and a note describing what you verified. A successor acknowledges all pending ids (including later full pages) after checking the actual repository heads; ACK is mechanical, not proof of understanding. Retired sessions may only add a note or update their own running work. No signed board request or expectedRevision is needed.",
            inputSchema: handoffUpdateSchema,
            outputSchema: handoffWriteResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.updateHandoff(identity, input)),
        );
        mcp.registerTool(
          "flowly_update_status",
          {
            description:
              "Move this card to one of allowedStatuses from get_task (design, development, test, blocked or in_review when they are lanes of this project; lanes lists the names the user sees). Use the work stage that matches what you are doing now: design for plans/specs/research, development for implementation, test for verification; you decide where to start and may skip or go back. Keep it current: switch when the work changes, and at the start of each turn correct the stage the card was automatically resumed in if it does not match the work. Copy revisions and request from get_task, include a note. Your own card's Done/cancelled are human decisions; direct sub-cards are accepted or cancelled only through flowly_update_card. Delivering to in_review with open workpad items returns WORKPAD_OPEN, and with missing card setup (unorganized metadata of a task.brief card, no type, no tags or no workpad) SETUP_INCOMPLETE; both change nothing. The first attempt is always refused, even with acknowledgeOpen=true. A stale handoff or missing successor ACK returns HANDOFF_STALE at in_review/blocked, combined with the same first refusal. Update it with flowly_update_handoff. Review that refusal, finish what you can, then retry with acknowledgeOpen=true and a note explaining every remaining item. Changed card/workpad/HEAD or a new turn requires a new refusal. When you deliver (in_review), pass outputs=[{target,title,note}] for the PR/MR links, reports and evidence from this call, or outputs=[] if none; omission returns a reminder. Outputs are registered atomically with this write. Also pass nextMoves: the 1-3 messages the user is most likely to send you next (same items as flowly_suggest_next_moves, recommended first; a moveTo=\"done\" move is only accepted together with in_review), or [] when nothing needs the user. Leave it out on mid-work stage changes. A delivery (in_review or blocked) that leaves this turn without next moves, or without any idea on the card, gets a reminders list in its result, and so does any write while the card setup is missing: text only, the write succeeded. A refused call records nothing: resend it with the same nextMoves. Retry identical uncertain requests only.",
            inputSchema: statusInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => call(() => this.agents.write(identity, "status", input)),
        );
        mcp.registerTool(
          "flowly_report_progress",
          {
            description:
              "Append this session's checkpoint/blocker/result/question without changing card status or task revision. kind=question or blocker first checks the same handoff soft gate (HANDOFF_STALE); update the handoff and retry with acknowledgeOpen=true only after reading its first refusal. The complete question is retained for future sessions and only an explicitly linked original answer closes it. kind=question asks the user something and marks the card Needs you until they reply; it is the fallback when you have no question tool of your own (such as AskUserQuestion) or the question is open-ended. Never report a question you already asked through that tool. Copy revisions/request from get_task. Partial contribution does not complete the card. When you ask (kind=question; the moves are the likely answers), report a blocker or give a result, pass nextMoves (same items as flowly_suggest_next_moves, 1-3 recommended first, or [] when nothing needs the user). For kind=result, pass outputs=[{target,title,note}] for the PR/MR links, reports and evidence from this call, or outputs=[] if none; omission returns a reminder. Outputs are registered atomically with this write and are invalid for other kinds. A question or result that leaves this turn without next moves gets a reminders list in its result: text only, the write succeeded.",
            inputSchema: progressInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => call(() => this.agents.write(identity, "progress", input)),
        );
        mcp.registerTool(
          "flowly_propose_idea",
          {
            description:
              "Propose a next step the user did not ask for. scope=here: an extension of this card's goal; the user may send it back to this card's session as an instruction. scope=new: divergent work (a bug found on the way, a refactor, a separate feature); the user may turn it into a new card that starts from your detail, rationale and context, whose agent cannot see this conversation, so put files, branches and findings in context. Do not propose work this card already requires, propose at most 3 per delivery, check ideas from get_task for duplicates, and never start the idea yourself. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => call(() => this.agents.write(identity, "idea", input)),
        );
        mcp.registerTool(
          "flowly_update_idea",
          {
            description:
              "Edit or dismiss an idea on this card (id from get_task ideas). Pass only the fields to change: title, detail, rationale, context, type, priority, scope or tags (tags replace the suggested ones). status=dismissed closes it: use it when the user rejected the idea in conversation or it no longer applies (for example this card already did it), instead of leaving it open. A dismissed idea stays under Closed, where only the user can restore it. Only open ideas can be edited; an accepted idea is final (IDEA_CLOSED). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaUpdateInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "idea_update", input)),
        );
        mcp.registerTool(
          "flowly_remove_idea",
          {
            description:
              "Delete an idea on this card that should never have been proposed: a duplicate, a mistake, or work this card already requires. For an idea the user rejected, prefer flowly_update_idea status=dismissed, which keeps it visible. An accepted idea cannot be removed (IDEA_CLOSED). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaRemovalSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "idea_remove", input)),
        );
        mcp.registerTool(
          "flowly_remember",
          {
            description:
              "Propose something for the project's memory that would make a later, different card's agent re-ask the user, retry a dead end or hit the same problem: a decision the user made with its reason, including a rejected option (decision); a dead end, or the general lesson behind a bug you fixed, not the fix (pitfall); how the user wants work done here that the repository does not say (convention); people, external systems and environments (contact). It is a candidate: the user confirms it before any session sees it. Not this card's progress (that is the summary), not open or deferred items (those are ideas), not what code, git or docs already say, and never a secret (say where it is kept). Only what holds beyond this card: if every later card that would need it works on the same feature, file or bug, leave it to the code and the summary. At most 3 per delivery, usually none; check memory.candidates in get_task first. To correct an entry, propose a new one with supersedes=<its id>; you cannot edit or delete entries. Returns MEMORY_DISABLED, MEMORY_DUPLICATE, MEMORY_LIMIT or MEMORY_SECRET when refused. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: rememberInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "remember", input)),
        );
        mcp.registerTool(
          "flowly_recall",
          {
            description:
              "Search the project's memory: decisions, conventions, pitfalls and contacts the user confirmed on earlier cards. get_task memory already lists the entries chosen for this card; use this when you start on an area they do not cover. Read-only; no request needed.",
            inputSchema: recallInputSchema,
            outputSchema: recallResultSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.recall(identity, input)),
        );
        mcp.registerTool(
          "flowly_add_artifact",
          {
            description:
              "Register a file or link that is an input this card worked from or an output it delivered, so the user and later sessions can find it. role=input|output; target is an http(s) link or a path (absolute, or relative to the workspace directory) inside this card's directories. Add deliverables when you produce them (specs, reports, exported files, PRs, verification evidence), not every file you touched: source code changes are already visible through the workspace diff. Use a short title and a one-line note on what it is for. Adding a recorded target again updates the one you or another agent added; one the user added stays as is. Check artifacts in get_task first. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: artifactInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "artifact", input)),
        );
        mcp.registerTool(
          "flowly_remove_artifact",
          {
            description:
              "Remove an artifact an agent added to this card (id from get_task artifacts), e.g. a wrong or replaced entry. Artifacts the user added can only be removed by the user. Never deletes the file. Copy revisions/request from get_task.",
            inputSchema: artifactRemovalSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "artifact_remove", input)),
        );
        const readExternal = {
          description:
            "Read an external input of this card (an artifact with an external field in get_task): a Jira ticket, Confluence page, GitHub/GitLab issue, pull or merge request, or Azure DevOps work item. Returns Markdown: metadata, the description or page content and the latest comments; for pull/merge requests also the branches, head commit and changed file names (no diff: fetch the branch with git to see the code). The item is part of the task: read it before you start and again when get_task marks it unread. Read-only: Flowly never changes the item, and its status is for reference only (do not set the card stage from it). Only this card's external inputs can be read; to read a linked item, first add its link with flowly_add_artifact role=input.",
          inputSchema: readExternalInputSchema,
          outputSchema: externalReadSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        };
        mcp.registerTool("flowly_read_external", readExternal, (input) => call(() => this.agents.readExternal(identity, input)));
        // Older sessions' skill names the tool flowly_read_ticket (CONNECTORS-SPEC §3.3).
        mcp.registerTool(
          "flowly_read_ticket",
          { ...readExternal, description: `Deprecated alias of flowly_read_external; use that instead. ${readExternal.description}` },
          (input) => call(() => this.agents.readExternal(identity, input)),
        );
        mcp.registerTool(
          "flowly_set_tags",
          {
            description:
              'Tag this card with the functional areas it touches and the improvement directions it serves (for example a module like "drawer" or "session-composer", or a direction like "performance", "a11y", "mobile"), so the user can filter and search cards later. Tags are not the task type, status or priority; do not repeat those. Reuse a tag from projectTags in get_task when one fits instead of inventing a synonym. Do this at the start of the work, before you change code (get_task setup.tagsMissing). Use 1-4 short lowercase tags and adjust them if the scope changes. You can only remove tags an agent added. Does not change card status or task revision. Copy revisions/request from get_task.',
            inputSchema: tagsInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "tags", input)),
        );
        mcp.registerTool(
          "flowly_update_metadata",
          {
            description: "Organize this session's card: a concise title, faithful description and priority. On a new card with brief, do this before implementation; preserve every requirement, path and acceptance criterion from the original brief, without inventing scope. Use set_type and set_tags for classification. Never overwrite human edits with stale revisions. Copy revisions/request from get_task. The original brief is immutable. Reviewers cannot use this tool.",
            inputSchema: metadataInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "metadata", input)),
        );
        mcp.registerTool(
          "flowly_set_type",
          {
            description:
              "Set this card's type (feature, bugfix, research, refactor, docs, chore) when it has none (get_task setup.typeMissing). Do this at the start of the work, before you change code. A type the user or an agent already set is kept: the call returns TYPE_ALREADY_SET and changes nothing, so do not retry with another type. Increments the task revision. Copy revisions/request from get_task.",
            inputSchema: typeInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "type", input)),
        );
        mcp.registerTool(
          "flowly_suggest_next_moves",
          {
            description:
              "For updates in the middle of a turn, or when your delivery call had no nextMoves; when you deliver or ask, pass nextMoves on flowly_update_status / flowly_report_progress instead. Offer the 1-3 next messages the user is most likely to send you (e.g. verify the change, commit and push, continue to the next stage), recommended first, or [] when nothing needs the user. Flowly shows them above the user's message box; picking one only fills the box, the user edits or sends it. Valid until the user's next message starts a new turn; calling again in the same turn replaces them. Still mention the options in your reply. Not for questions (use flowly_report_progress kind=question; its nextMoves are the likely answers) or for divergent work (use flowly_propose_idea). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: nextMovesInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "next_moves", input)),
        );
        mcp.registerTool(
          "flowly_update_workpad",
          {
            description:
              "Do this at the start of the work, before you change code (get_task setup.workpadMissing), and after each milestone. Replace this card's workpad: acceptance criteria (done or not), validation checks (pass, fail or unrun, with the command and the commit they ran on) and confusions (what in the card was unclear). The plan comes from your own todo list; do not repeat it here. Send all three lists every time; items you leave out are removed. Copy workpad.revision from get_task as workpadRevision (0 when there is none). On WORKPAD_CONFLICT the user changed it: re-read, keep their checks, retry. WORKPAD_DISABLED (workpadEnabled=false in get_task): the user turned it off for this project; report criteria and checks in your notes instead and do not retry. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: workpadInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.write(identity, "workpad", input)),
        );
        mcp.registerTool(
          "flowly_submit_review",
          {
            description:
              "Only for the reviewer session that Flowly's agent automation started for this card (your first instruction says so); every other session gets NOT_REVIEWER. Call it exactly once per review round, after you inspected the changes and ran the relevant checks: verdict=approve when the acceptance criteria are met and the checks pass (the card stays In review for the user to accept); verdict=changes with a summary and concrete findings (file, problem, expected fix) that Flowly sends to the implementer, moving the card back to work. Do not change the card status yourself. Pass risks: the risks the acceptance criteria do not cover (growth over time, cost per operation, cleanup, upgrades, failure recovery, security, interactions with other cards), at most 10, each one plain sentence under 500 characters saying what could go wrong, when and how bad, every risk you still see, including those from earlier rounds your instruction lists (Flowly keeps only the latest list and shows it to the person and the parent card); risks never block approval, so a risk that must block goes in findings with verdict=changes. Repeating the same verdict is acknowledged (replayed); REVIEW_CLOSED means the round is over or the card left In review, so end your turn. Report up to five missing continuity details in handoff={gaps:[...]}; gaps alone do not block approval, while contradictions with Git or the workpad belong in findings. No revisions or request needed. In a project with acceptance tests (get_task.acceptance), also send acceptance: { visible: { passed, failed }, holdout: { passed, failed } } from the suites' final ACCEPTANCE lines; an approval with failing checks lists each one in acceptance.disputed: [{ check, reason }] (the card text it contradicts), or it is refused with ACCEPTANCE_FAILING.",
            inputSchema: reviewInputSchema,
            outputSchema: reviewResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.review(identity, input)),
        );
        // Tournament judges only (AUTOMATION-SPEC §5.5): other sessions never see these two tools.
        const tournament = this.agents.tournament;
        if (tournament?.isJudge(identity.agentId)) {
          mcp.registerTool(
            "flowly_tournament_activate",
            {
              description: "Tournament judge only. Puts one candidate's whole tree into this card's real workspace (replacing what is there), so you can run it where and as the delivery will be used. Run its flowly-apply.sh afterwards if it has one, and stop processes the previous candidate started. Activate the winner last before flowly_submit_judgement.",
              inputSchema: z.strictObject({ candidate: z.string().trim().min(1).max(20) }),
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
            },
            (input) => call(() => tournament.activate(identity.taskId, identity.agentId, input.candidate)),
          );
          mcp.registerTool(
            "flowly_submit_judgement",
            {
              description: "Tournament judge only, once, at the end. Send every candidate's acceptance counts (visible, holdout) measured with it active, the failing checks you judge wrong in disputed (each with the card text it contradicts), the probes you ran, every disagreement with its ruling and reason (card text quoted, or a reproducible command and output), the winner, a summary and final (the winner's counts from your last run, with the winner active). Refused, with nothing recorded, when the winner has more undisputed failing checks than another candidate (TOURNAMENT_ELIMINATED), counts are missing (ACCEPTANCE_REQUIRED) or the winner is not the active candidate (WINNER_NOT_ACTIVE).",
              inputSchema: judgementInputSchema,
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            },
            (input) => call(() => tournament.submit(identity.taskId, identity.agentId, input)),
          );
        }
        mcp.registerTool(
          "flowly_create_card",
          {
            description:
              "Create a card in this project, by default a sub-card of this card (subCard=false for a separate card). Use it to split work that is too big for one session or has parts that can run in parallel, and for follow-up work that must be done (not just suggested: suggestions stay flowly_propose_idea). Each card gets its own workspace (an isolated worktree when the project root is a git repository; baseRef picks the branch or commit it starts from). Its agent cannot see this conversation: put every decision, file, branch and acceptance criterion it needs in the description, and decide shared questions (names, formats, interfaces) here once instead of letting sub-cards each pick. start=now puts it in Todo and, when the project has agent automation on, queues it for an agent; start=later parks it in Backlog. Start a direct sub-card later with flowly_update_card action=start; a person starts a separate card with Run with agent. blockedBy lists card ids it waits for (it starts once they are Done). Only a live supervised parent implementer is woken after sub-cards settle; ordinary sessions check progress themselves. Directory workspaces share the root, so automated sub-cards there run one at a time and splitting does not make the work parallel; worktrees default to the project root branch, so pass baseRef explicitly for parent-dependent changes. Creation is limited to 50 per source card and 100 across its entire creation lineage. Do not do a sub-card's work yourself. Each card needs its own request: call get_task again before the next card, also when you create several (one request in parallel calls makes one card, the others get REQUEST_REUSED). Repeating the same call returns the same card. review_level sets how hard agent automation reviews it: deep for foundation cards that later cards or stored data depend on (persistent storage formats of a long-lived system, schemas and protocols with other users, security, data migrations, concurrency), which get a panel of reviewers with fixed design questions from the first round, while a self-contained program verified by tests is standard; light for small low-risk cards (one reviewer, fewer rounds); standard; auto (the default) lets Flowly decide from tags and the card's text each round. Copy revisions/request from get_task.",
            inputSchema: createCardInputSchema,
            outputSchema: createCardResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.createCard(identity, input)),
        );
        mcp.registerTool(
          "flowly_update_card",
          {
            description:
              "Manage a direct sub-card of this card (links relation sub_card in get_task): action=start queues a never-started parked sub-card, or requests rework of an In review delivery with a required concrete note; agents may restart a sub-card's delivered work twice, then NEEDS_PERSON until a person chooses Run again or moves the card; while the sub-card's automation is still live (queued, working, under review or waiting for a person) start with a note is refused and nothing is recorded (NEEDS_PERSON when it waits for a person, who answers it in its own session; CHILD_BUSY otherwise: send the note once it settles); failed/stopped jobs require a person to choose Run again (NEEDS_PERSON/TAKEN_BY_PERSON); action=accept moves a sub-card delivered to In review to Done after you checked its result (first merge its branch where later cards and this card need its changes: accepting is what releases cards blocked by it); action=cancel cancels one that is no longer needed. Only the active unfinished parent card's non-reviewer sessions may do this; NOT_PARENT otherwise, NOT_DELIVERED when accepting a sub-card that is not In review, REVIEW_RUNNING when accepting one whose own review has not given its verdict yet, CHILD_BUSY or NEEDS_PERSON while its automation is otherwise still running (nothing changes: a supervised parent is woken when it settles; other sessions check again later). review_level (light, standard, deep or auto), alone or with action=start, sets how hard automation reviews the sub-card from its next review round: give foundation sub-cards deep; with accept or cancel it is INVALID_INPUT. Copy revisions/request from get_task.",
            inputSchema: updateCardInputSchema,
            outputSchema: updateCardResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => call(() => this.agents.updateCard(identity, input)),
        );
        return mcp;
      },
      // A full workpad with multi-byte text can exceed 64 KiB (WORKPAD-SPEC §3).
      { responseMode: "json", maxRequestBodySize: maxBody },
    );
    const nodeHandler = toNodeHandler(this.handler, {
      maxRequestBodySize: maxBody,
    });
    const host = localhostHostValidation(),
      origin = localhostOriginValidation();
    this.server = createServer((req, res) => {
      if (!host(req, res) || !origin(req, res)) return;
      void (async () => {
        if (this.stopped)
          throw new ToolError(
            "TOOLS_UNAVAILABLE",
            "Tool service is stopping.",
            true,
          );
        const identity = this.token(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        );
        const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
        if (pathname === "/mcp") {
          await nodeHandler(req, res);
          return;
        }
        if (pathname !== "/api" || req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        await this.apiRequest(req, res, identity);
      })().catch((e) =>
        this.json(
          res,
          { ok: false, error: toolFailure(e) },
          e instanceof ToolError && e.code === "UNAUTHORIZED" ? 401 : 400,
        ),
      );
    });
    this.server.requestTimeout = 25000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Kanban listener has no port.");
    this.url = `http://127.0.0.1:${address.port}/`;
    await writePrivate(
      discoveryFile,
      JSON.stringify({ version: 1, port: address.port, url: this.url }),
    );
  }
  private json(res: ServerResponse, value: unknown, status = 200) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
  }
  private async apiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    identity: ToolIdentity,
  ) {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const data = Buffer.from(chunk);
      length += data.length;
      if (length > maxBody) {
        req.resume();
        throw new ToolError("INVALID_INPUT", "Request body is too large.");
      }
      chunks.push(data);
    }
    const body = z
      .strictObject({
        action: z.enum(["get", "handoff", "session_history", "status", "progress", "idea", "idea_update", "idea_remove", "remember", "recall", "artifact", "artifact_remove", "tags", "type", "metadata", "next_moves", "workpad", "external", "ticket", "review", "create_card", "update_card"]),
        input: z.unknown(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    await this.agents.toolCalled(identity);
    const value =
      body.action === "get"
        ? await this.agents.get(identity, true, true, handoffGetInputSchema.parse(body.input))
        : body.action === "handoff"
          ? await this.agents.updateHandoff(identity, handoffUpdateSchema.parse(body.input))
        : body.action === "session_history"
          ? await this.agents.readSessionHistory(identity, sessionHistoryQuerySchema.parse(body.input))
        : body.action === "external" || body.action === "ticket"
          ? await this.agents.readExternal(identity, readExternalInputSchema.parse(body.input))
          : body.action === "recall"
            ? await this.agents.recall(identity, recallInputSchema.parse(body.input))
            : body.action === "review"
              ? await this.agents.review(identity, reviewInputSchema.parse(body.input))
              : body.action === "create_card"
                ? await this.agents.createCard(identity, createCardInputSchema.parse(body.input))
                : body.action === "update_card"
                  ? await this.agents.updateCard(identity, updateCardInputSchema.parse(body.input))
                  : await this.agents.write(identity, body.action, body.input);
    this.json(res, { ok: true, result: value });
  }
  private async prepare(
    identity: ToolIdentity,
    context: string,
    method: "mcp" | "cli",
  ): Promise<ToolPreparation> {
    await this.start();
    const contextFile = await this.secrets.writeContext(identity, method),
      cliPath = join(this.store.directory, "flowly.mjs"),
      skillPath = join(this.store.directory, "SKILL.md");
    return {
      agentId: identity.agentId,
      contextFile,
      cliPath,
      skillPath,
      instructions: workingInstructions(
        context,
        cliPath,
        contextFile,
        skillPath,
      ),
      mcp: {
        type: "http",
        url: `${this.url}mcp`,
        headers: {
          Authorization: `Bearer ${this.secrets.credential(identity)}`,
        },
      },
    };
  }
  /** `reviewer`: an automation reviewer session (AUTOMATION-SPEC §5); its context has no setup line. */
  async prepareSession(taskId: string, operationId: string, paseo: PaseoApi, options: { reviewer?: boolean } = {}) {
    this.attach(paseo);
    const job = this.preparation.then(async () => {
      await this.start();
      const board = await this.store.read(),
        task = board.tasks.find((t) => t.id === taskId);
      if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
      const ctx = await new BoardService(this.store).context(taskId, paseo, undefined, options);
      if (!ctx.available)
        throw new ToolError("RESOURCE_UNAVAILABLE", ctx.reason);
      const identity = await this.secrets.prepared(
        taskId,
        task.workspaceId,
        operationId,
      );
      // The injected memory counts as used by this card (PROJECT-MEMORY-SPEC §3.2).
      void this.agents.memory?.markUsed(ctx.memoryIds, taskId).catch(() => undefined);
      const existing = await paseo.agents.ref(identity.agentId).refresh();
      if (
        existing?.agent &&
        (existing.agent.workspaceId !== task.workspaceId ||
          existing.agent.archivedAt)
      )
        throw new ToolError(
          "SESSION_MISMATCH",
          "Prepared agent ID now belongs to an unavailable/different session.",
        );
      const continuity = await this.agents.handoffs?.context(taskId, undefined, { recordAccess: false });
      if (continuity?.unavailable) throw new ToolError("HANDOFF_UNAVAILABLE", continuity.unavailable);
      const continuation = board.automation.find(job => job.taskId === taskId)?.rotation?.carry.continuation;
      const extra = continuity && continuity.revision > 0
        ? `\n\nCard continuity (bounded preview; not a complete transcript): ${JSON.stringify(continuity)}\nRead flowly_get_task handoff=full through every page, verify actual workspace state and acknowledge all unresolved IDs before delivering. Missing coverage is unknown, not evidence that no requirement exists.` : "";
      return this.prepare(identity, ctx.context + extra + (continuation ? `\n\nAn earlier instruction was waiting when this comment arrived. It remains unfinished; inspect it together with the new comment and current card: ${JSON.stringify(continuation)}` : ""), "mcp");
    });
    this.preparation = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  async prepareExisting(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    await this.start();
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
    const identity = { taskId, agentId, workspaceId: task.workspaceId };
    const current = await this.agents.get(identity, false);
    if (current.task.archivedAt || current.project.archivedAt)
      throw new ToolError("ARCHIVED", "Task/project is archived.");
    const ctx = await new BoardService(this.store).context(taskId, paseo, undefined, { reviewer: reviewerOfCard(board, taskId, agentId) });
    void this.agents.memory?.markUsed(ctx.memoryIds, taskId).catch(() => undefined);
    return this.prepare(identity, ctx.context, "cli");
  }
  async sessionContext(
    agentId: string,
    workspaceId: string | null,
    paseo: PaseoApi,
  ) {
    this.attach(paseo);
    if (!workspaceId) return null;
    const board = await this.store.read(),
      task = board.tasks.find((t) => t.workspaceId === workspaceId),
      project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || task.archivedAt || project?.archivedAt) return null;
    // Only Kanban-managed sessions get tools: launched from the card (prepared
    // with credentials) or explicitly opted in via "Send Kanban work
    // instructions". Other sessions in a card's workspace stay untouched.
    if (!(await this.secrets.hasContext(agentId))) return null;
    await this.start();
    return this.secrets.writeContext(
      { agentId, workspaceId, taskId: task.id },
      "cli",
    );
  }
  async accessState(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId),
      actor = await paseo.agents.ref(agentId).refresh();
    if (!task || !actor?.agent || actor.agent.workspaceId !== task.workspaceId)
      throw new ToolError(
        "SESSION_MISMATCH",
        "Session does not belong to this card.",
      );
    let methods: string[] = [];
    try {
      const data = JSON.parse(
        await readFile(this.secrets.contextFile(agentId), "utf8"),
      );
      if (data.identity.taskId === taskId)
        methods = z.array(z.string()).parse(data.methods || []);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const durable = (await this.store.read()).agentReceipts
        .filter((r) => r.agentId === agentId && r.taskId === taskId)
        .at(-1),
      recent = this.agents.accesses.get(agentId);
    return {
      methods,
      lastSuccessAt: recent?.at || durable?.at || null,
      lastAction: recent?.action || durable?.action || null,
      ...this.health(),
    };
  }
  async stop() {
    this.stopped = true;
    if (this.starting) await this.starting.catch(() => undefined);
    await this.closeListener();
    await this.store.read().catch(() => undefined);
  }
  private async closeListener() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
    await this.handler?.close();
    this.server = undefined;
    this.handler = undefined;
  }
}
