import type { PaseoApi } from "@getpaseo/client";
import type { CommentInput, RoutedCommentDelivery } from "../shared/comments";
import { jobOf } from "../shared/automation";
import type { BoardStore } from "./store";
import type { HandoffService } from "./handoff-service";
import type { ComposerService } from "./composer";
import { handoffSource } from "./handoff-source";
import { ToolError } from "./tool-error";
import { commentMode, commentSettled as terminal } from "./comment-routing-state";

type ManagedResult = { kind: "sent" | "queued" | "pending" | "fresh" | "saved"; agentId?: string };
type RouteRequest = { taskId: string; sourceId: string; messageId: string; text: string; mode?: "steer" | "interrupt" | "queue"; fresh?: boolean };
type SendRequest = RouteRequest & { agentId: string };

/** Routing references recover alongside the existing dispatcher; this class owns no timer or native creator. */
export class CommentRouter {
  routeManaged?: (input: RouteRequest) => Promise<ManagedResult>;
  private tails = new Map<string, Promise<unknown>>();
  constructor(private board: BoardStore, private handoffs: HandoffService, private composer: ComposerService, private paseo: () => PaseoApi) {}
  async deliveries(taskId: string) {
    const board = await this.board.read();
    if (!board.tasks.some(task => task.id === taskId)) throw new ToolError("NOT_FOUND", "Card not found.");
    return (board.commentRoutes ?? []).filter(route => route.taskId === taskId).slice(-70).map(route => ({ eventId: route.eventId, delivery: {
      kind: route.phase === "prepared" || route.phase === "sending" ? "pending" as const : route.phase,
      ...(route.agentId ? { agentId: route.agentId } : {}), ...(route.error ? { error: route.error } : {}),
      ...(route.phase === "sending" ? { reason: "send_unconfirmed" } : route.reason ? { reason: route.reason } : {}),
    } }));
  }
  async resend(taskId: string, eventId: string) {
    const board = await this.board.read(), route = board.commentRoutes?.find(r => r.taskId === taskId && r.eventId === eventId);
    if (!route || !route.messageId.startsWith("comment:")) throw new ToolError("NOT_FOUND", "The comment routing receipt is unavailable.");
    const original = board.events.find(e => e.id === eventId && e.taskId === taskId)?.note ?? await this.handoffs.records.inputText(taskId, route.sourceId, 10000);
    if (original === undefined) throw new ToolError("HANDOFF_UNAVAILABLE", "The original comment is unavailable; resend was refused.");
    return this.post({ taskId, operationId: route.messageId.slice(8), text: original, deliver: route.choice, whenRunning: route.mode });
  }
  private serial<T>(taskId: string, run: () => Promise<T>) {
    const work = (this.tails.get(taskId) ?? Promise.resolve()).then(run), tail = work.catch(() => undefined);
    this.tails.set(taskId, tail); void tail.finally(() => { if (this.tails.get(taskId) === tail) this.tails.delete(taskId); });
    return work;
  }
  async read(taskId: string, sourceId: string) {
    await this.handoffs.reconcile(taskId);
    const route = (await this.board.read()).commentRoutes?.find(r => r.taskId === taskId && r.sourceId === sourceId);
    if (!route || route.choice === "save") return undefined;
    const input = await this.handoffs.records.inputRecord(taskId, sourceId);
    if (input?.unconfirmed) throw new ToolError("HANDOFF_PENDING", "The original comment has not yet been confirmed by its accepting transaction.");
    if (input && input.status !== "open") {
      await this.result(taskId, sourceId, { kind: input.status === "received" ? "sent" : "saved", reason: input.status === "received" ? "received_in_session" : "handled_on_card" });
      return undefined;
    }
    const text = await this.handoffs.records.inputText(taskId, sourceId, 10000);
    if (text === undefined) throw new ToolError("HANDOFF_UNAVAILABLE", "The recorded comment is unavailable; it was not replaced with a summary.");
    return { text, messageId: route.messageId, ...(route.mode ? { mode: route.mode } : {}), ...(route.choice === "fresh" ? { fresh: true } : {}) };
  }
  async result(taskId: string, sourceId: string, result: RoutedCommentDelivery) {
    await this.board.transaction(board => {
      const route = board.commentRoutes?.find(r => r.taskId === taskId && r.sourceId === sourceId);
      if (!route) throw new ToolError("HANDOFF_UNAVAILABLE", "The comment routing receipt is unavailable.");
      if (terminal(route.phase) && route.phase !== result.kind) return { value: undefined, changed: false };
      const next = { ...route, phase: result.kind, ...(result.agentId ? { agentId: result.agentId } : {}), reason: result.reason, error: result.error };
      if (JSON.stringify(next) === JSON.stringify(route)) return { value: undefined, changed: false };
      Object.assign(route, next); return { value: undefined, changed: true };
    });
  }
  async failed(taskId: string, sourceId: string, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const current = (await this.board.read()).commentRoutes?.find(r => r.taskId === taskId && r.sourceId === sourceId);
    if (!current) return;
    if (current.phase !== "sending") return this.result(taskId, sourceId, { kind: "failed", error: message, agentId: current.agentId });
    if (current.error === message) return;
    await this.board.transaction(board => {
      const route = board.commentRoutes?.find(r => r.taskId === taskId && r.sourceId === sourceId);
      if (!route || route.phase !== "sending" || route.error === message) return { value: undefined, changed: false };
      route.error = message; return { value: undefined, changed: true };
    });
  }
  /** The selected target is durable before native dispatch. Unknown sends retry this same target and message id. */
  async send(input: SendRequest): Promise<{ kind: "sent" | "queued" }> {
    const board = await this.board.read(), task = board.tasks.find(t => t.id === input.taskId);
    if (!task) throw new ToolError("NOT_FOUND", "Card not found.");
    const route = board.commentRoutes?.find(r => r.taskId === input.taskId && r.sourceId === input.sourceId);
    if (!route) throw new ToolError("HANDOFF_UNAVAILABLE", "Record the comment's routing intent before sending.");
    if (route.phase === "sent" || route.phase === "queued") return { kind: route.phase };
    if (route.phase === "sending" && route.agentId && route.agentId !== input.agentId)
      throw new ToolError("HANDOFF_PENDING", "The prior send result is unknown. Confirm it before sending this comment to another session.");
    const beginNative = () => this.board.mutate(current => {
      const receipt = current.commentRoutes?.find(r => r.taskId === input.taskId && r.sourceId === input.sourceId);
      if (!receipt) throw new ToolError("HANDOFF_UNAVAILABLE", "The comment routing receipt is unavailable.");
      receipt.phase = "sending"; receipt.agentId = input.agentId;
    });
    const api = this.paseo(), actor = (await api.agents.ref(input.agentId).refresh())?.agent;
    if (!actor || actor.workspaceId !== task.workspaceId || actor.archivedAt) throw new ToolError("SESSION_MISMATCH", "The selected session is unavailable or belongs to another card.");
    const running = actor.status === "running" || actor.status === "initializing";
    if (input.mode === "queue" && running && !actor.pendingPermissions?.length) {
      await this.result(input.taskId, input.sourceId, { kind: "pending", agentId: actor.id });
      await this.composer.push({ taskId: task.id, agentId: actor.id, text: input.text, messageId: input.messageId }, api);
      return { kind: "queued" };
    }
    const mode = running ? input.mode === "queue" ? "interrupt" : input.mode : undefined;
    await this.handoffs.send({ taskId: task.id, workspaceId: task.workspaceId, agentId: actor.id, messageId: input.messageId, text: input.text, via: "comment" }, mode, async busy => {
      await beginNative();
      await api.agents.ref(actor.id).send(input.text, { messageId: input.messageId, ...(busy ? { activeTurnBehavior: mode ?? "steer" } : {}) });
    });
    return { kind: "sent" };
  }
  post(input: CommentInput) { return this.serial(input.taskId, async () => {
    const event = await this.handoffs.comment(input);
    if (input.deliver === undefined) return { event }; // Old clients retain their old dispatch path.
    const sourceId = handoffSource(`comment:${input.operationId}`), choice = input.deliver;
    const mode = commentMode(input);
    const route = (await this.board.read()).commentRoutes?.find(r => r.taskId === input.taskId && r.sourceId === sourceId);
    if (!route) throw new ToolError("HANDOFF_UNAVAILABLE", "The accepted comment's routing intent is unavailable; dispatch was refused.");
    if (terminal(route.phase)) return { event, delivery: { kind: route.phase, agentId: route.agentId, reason: route.reason } as RoutedCommentDelivery };
    let delivery: RoutedCommentDelivery;
    try {
      if (choice === "save") delivery = { kind: "saved" };
      else if (typeof choice === "object") delivery = await this.send({ taskId: input.taskId, sourceId, messageId: route.messageId, text: input.text, mode, agentId: choice.agentId }).then(r => ({ ...r, agentId: choice.agentId }));
      else {
        const job = jobOf(await this.board.read(), input.taskId);
        if (job && !["failed", "stopped"].includes(job.state) && this.routeManaged)
          delivery = await this.routeManaged({ taskId: input.taskId, sourceId, messageId: route.messageId, text: input.text, mode, ...(choice === "fresh" ? { fresh: true } : {}) });
        else delivery = { kind: "saved", ...(choice === "fresh" ? { reason: "manual_fresh" } : {}) };
      }
      await this.result(input.taskId, sourceId, delivery);
    } catch (error) {
      delivery = { kind: "failed", agentId: typeof choice === "object" ? choice.agentId : route.agentId, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      // A sending receipt stays unknown on failure; never free it to silently retarget another session.
      await this.failed(input.taskId, sourceId, error);
    }
    return { event, delivery };
  }); }
}
