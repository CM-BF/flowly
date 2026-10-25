import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HandoffService } from "./handoff-service";
import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { composerStateSchema, type ComposerState, type OutgoingImage } from "../shared/composer";
import { megabytes, oversized } from "./provider-history";

type QueuedImage = { file: string; mimeType: OutgoingImage["mimeType"] };
const extension: Record<OutgoingImage["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const empty = (): ComposerState => ({ version: 1, sessions: {} });

/**
 * Unsent drafts and queued follow-ups per session, persisted on the daemon so a
 * plugin reload or app refresh keeps them. Serialized writes, atomic replace,
 * invalid files are preserved (never reset).
 */
export class ComposerStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "composer.json");
  }
  /** Queued messages' images live beside composer.json until sent or removed. */
  get imageDirectory() {
    return join(this.directory, "composer-images");
  }
  async writeImages(itemId: string, images: readonly OutgoingImage[]): Promise<QueuedImage[]> {
    if (!images.length) return [];
    await mkdir(this.imageDirectory, { recursive: true, mode: 0o700 });
    return Promise.all(
      images.map(async (image, index) => {
        const file = `${itemId}-${index}.${extension[image.mimeType]}`;
        await writeFile(join(this.imageDirectory, file), Buffer.from(image.data, "base64"), { mode: 0o600 });
        return { file, mimeType: image.mimeType };
      }),
    );
  }
  async readImages(images: readonly QueuedImage[] = []): Promise<OutgoingImage[]> {
    return Promise.all(
      images.map(async (image) => {
        try {
          return { data: (await readFile(join(this.imageDirectory, image.file))).toString("base64"), mimeType: image.mimeType };
        } catch {
          throw new Error("An image attached to this queued message is missing.");
        }
      }),
    );
  }
  async removeImages(images: readonly QueuedImage[] = []) {
    await Promise.all(images.map((image) => rm(join(this.imageDirectory, image.file), { force: true })));
  }
  private async load(): Promise<ComposerState> {
    try {
      return composerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error(`Composer data is invalid; preserved at ${this.path}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  mutate<T>(operation: (state: ComposerState) => T): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const value = operation(state);
      for (const [id, entry] of Object.entries(state.sessions))
        if (!entry.draft && !entry.queue.length && !entry.lastError) delete state.sessions[id];
      const next = composerStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.path);
      return value;
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}

type Send = (paseo: PaseoApi, agentId: string, text: string, steer: boolean, images?: OutgoingImage[], messageId?: string) => Promise<void>;
const defaultSend: Send = async (paseo, agentId, text, steer, images, messageId) => {
  // The queued item's ID becomes the message ID, so the sending client can match its images.
  await paseo.agents.ref(agentId).send(text, {
    ...(steer ? { activeTurnBehavior: "steer" as const } : {}),
    ...(images?.length ? { images } : {}),
    ...(messageId ? { messageId } : {}),
  });
};

const tooLarge = (bytes: number) => `This session's history is ${megabytes(bytes)} MB, too large for Paseo to load safely; the message stays queued. Send it to a new session instead.`;

export class ComposerService {
  handoffs?: HandoffService;
  private draining = new Set<string>();
  private lastDrain = new Map<string, number>();
  constructor(
    readonly store: ComposerStore,
    readonly board: BoardStore,
    readonly send: Send = defaultSend,
    readonly clock = () => Date.now(),
  ) {}

  private entry(state: ComposerState, agentId: string, taskId: string) {
    return (state.sessions[agentId] ??= { taskId, draft: "", draftAt: null, queue: [], lastError: null });
  }

  /** The session must exist, belong to the card's workspace, and the card must be live. */
  private async verify(taskId: string, agentId: string, paseo: PaseoApi) {
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt)
      throw new Error("Task is unavailable or archived.");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent || agent.workspaceId !== task.workspaceId)
      throw new Error("Session is unavailable or belongs to a different workspace.");
    if (this.handoffs) {
      this.handoffs.attach(paseo);
      await this.handoffs.assertWriter({ taskId, agentId, workspaceId: task.workspaceId }, board);
      if (board.automation.some((job) => job.taskId === taskId && job.rotation?.fromAgentId === agentId)) throw new Error("This session is being replaced. The message stays queued; continue in the new session.");
    }
    return agent;
  }

  read() {
    return this.store.read();
  }

  saveDraft(input: { taskId: string; agentId: string; text: string }) {
    return this.store.mutate((state) => {
      const entry = this.entry(state, input.agentId, input.taskId);
      entry.draft = input.text;
      entry.draftAt = new Date(this.clock()).toISOString();
      return { ok: true };
    });
  }

  async push(input: { taskId: string; agentId: string; text: string; images?: OutgoingImage[]; messageId?: string }, paseo: PaseoApi) {
    const actor = await this.verify(input.taskId, input.agentId, paseo);
    const id = input.messageId ? /^[A-Za-z0-9-]+$/.test(input.messageId) ? input.messageId : createHash("sha256").update(input.messageId).digest("hex") : randomUUID();
    const previous = (await this.store.read()).sessions[input.agentId]?.queue.find((item) => item.id === id);
    if (previous) {
      if (previous.text !== input.text || JSON.stringify(await this.store.readImages(previous.images)) !== JSON.stringify(input.images ?? [])) throw new Error("This queued message identity already has different content.");
      return previous;
    }
    if (this.handoffs) await this.handoffs.recordInput({ ...input, workspaceId: actor.workspaceId!, messageId: input.messageId ?? id, via: input.messageId?.startsWith("comment:") ? "comment" : "session" });
    const images = await this.store.writeImages(id, input.images || []);
    const item = { id, text: input.text, ...(input.messageId ? { messageId: input.messageId } : {}), at: new Date(this.clock()).toISOString(), ...(images.length ? { images } : {}) };
    try {
      await this.store.mutate((state) => {
        const entry = this.entry(state, input.agentId, input.taskId);
        if (entry.queue.some((existing) => existing.id === id)) return;
        if (entry.queue.length >= 50) throw new Error("Queue is full (50 messages).");
        entry.queue.push(item);
        entry.lastError = null;
      });
    } catch (error) {
      await this.store.removeImages(images);
      throw error;
    }
    // The turn may already have ended between the client's check and now.
    void this.drain(input.agentId, paseo);
    return item;
  }

  async remove(input: { agentId: string; id: string }) {
    const entry = (await this.store.read()).sessions[input.agentId], item = entry?.queue.find((message) => message.id === input.id);
    if (item && this.handoffs) await this.handoffs.withdrawQueued(entry.taskId, input.agentId, item.messageId ?? item.id);
    const removed = await this.store.mutate((state) => {
      const entry = state.sessions[input.agentId];
      const found = entry?.queue.find((m) => m.id === input.id);
      if (entry) entry.queue = entry.queue.filter((m) => m.id !== input.id);
      return found;
    });
    await this.store.removeImages(removed?.images);
    return { ok: true };
  }

  /** "Send now": steer the running turn with a queued message (Paseo parity). */
  async sendNow(input: { taskId: string; agentId: string; id: string }, paseo: PaseoApi) {
    const agent = await this.verify(input.taskId, input.agentId, paseo);
    const bytes = await oversized(paseo, input.agentId);
    if (bytes) throw new Error(tooLarge(bytes));
    const item = await this.store.mutate((state) => {
      const entry = state.sessions[input.agentId];
      const found = entry?.queue.find((m) => m.id === input.id);
      if (!entry || !found) throw new Error("That queued message was already sent or removed.");
      entry.queue = entry.queue.filter((m) => m.id !== input.id);
      return found;
    });
    const running = agent.status === "running" || agent.status === "initializing";
    try {
      const images = await this.store.readImages(item.images);
      const send = (busy: boolean) => this.send(paseo, input.agentId, item.text, busy, images, item.messageId ?? item.id);
      if (this.handoffs) await this.handoffs.send({ taskId: input.taskId, workspaceId: agent.workspaceId!, agentId: input.agentId, messageId: item.messageId ?? item.id, text: item.text, images, via: item.messageId?.startsWith("comment:") ? "comment" : "session" }, "steer", send);
      else await send(running);
      await this.store.removeImages(item.images);
    } catch (error) {
      await this.store.mutate((state) => {
        const entry = this.entry(state, input.agentId, input.taskId);
        entry.queue.unshift(item);
      });
      throw error;
    }
    return { sent: true };
  }

  /**
   * Sends the oldest queued message once the session is idle. Called on
   * turn end, after a push, and opportunistically on reads; one message per
   * turn (a short cooldown prevents a stale "idle" snapshot double-sending).
   */
  async drain(agentId: string, paseo: PaseoApi) {
    if (this.draining.has(agentId)) return false;
    if (this.clock() - (this.lastDrain.get(agentId) || 0) < 8000) return false;
    this.draining.add(agentId);
    try {
      const state = await this.store.read();
      const entry = state.sessions[agentId];
      if (!entry?.queue.length) return false;
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!agent || agent.status === "running" || agent.status === "initializing") return false;
      if (agent.pendingPermissions?.length) return false;
      // Sending makes Paseo load the session; an oversized Codex history would crash it (AUTOMATION-SPEC §4.6).
      const bytes = await oversized(paseo, agentId);
      if (bytes) {
        this.lastDrain.set(agentId, this.clock());
        if (entry.lastError !== tooLarge(bytes))
          await this.store.mutate((s) => {
            const e = s.sessions[agentId];
            if (e) e.lastError = tooLarge(bytes);
          });
        return false;
      }
      const board = await this.board.read();
      const task = board.tasks.find((t) => t.id === entry.taskId);
      if (!task || task.archivedAt || agent.workspaceId !== task.workspaceId) return false;
      try { await this.verify(task.id, agentId, paseo); }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.lastDrain.set(agentId, this.clock());
        if (entry.lastError !== text) await this.store.mutate((s) => { if (s.sessions[agentId]) s.sessions[agentId].lastError = text; });
        return false;
      }
      const item = await this.store.mutate((s) => {
        const e = s.sessions[agentId];
        return e?.queue.shift() ?? null;
      });
      if (!item) return false;
      this.lastDrain.set(agentId, this.clock());
      try {
        const images = await this.store.readImages(item.images);
        const send = (busy: boolean) => this.send(paseo, agentId, item.text, busy, images, item.messageId ?? item.id);
        if (this.handoffs) await this.handoffs.send({ taskId: task.id, workspaceId: task.workspaceId, agentId, messageId: item.messageId ?? item.id, text: item.text, images, via: item.messageId?.startsWith("comment:") ? "comment" : "session" }, "steer", send);
        else await send(false);
        await this.store.removeImages(item.images);
        await this.store.mutate((s) => {
          const e = s.sessions[agentId];
          if (e) e.lastError = null;
        });
        return true;
      } catch (error) {
        await this.store.mutate((s) => {
          const e = this.entry(s, agentId, entry.taskId);
          e.queue.unshift(item);
          e.lastError = error instanceof Error ? error.message : String(error);
        });
        return false;
      }
    } finally {
      this.draining.delete(agentId);
    }
  }

  async drainAll(paseo: PaseoApi) {
    // Drafts/queues of wrapped-up (archived) or deleted cards are dropped.
    const board = await this.board.read();
    const live = new Set(board.tasks.filter((t) => !t.archivedAt).map((t) => t.id));
    const before = await this.store.read();
    if (Object.values(before.sessions).some((e) => !live.has(e.taskId))) {
      const dropped = await this.store.mutate((s) => {
        const images: QueuedImage[] = [];
        for (const [id, e] of Object.entries(s.sessions))
          if (!live.has(e.taskId)) {
            for (const m of e.queue) images.push(...(m.images || []));
            delete s.sessions[id];
          }
        return images;
      });
      await this.store.removeImages(dropped);
    }
    const state = await this.store.read();
    for (const [agentId, entry] of Object.entries(state.sessions))
      if (entry.queue.length) void this.drain(agentId, paseo);
  }
}
