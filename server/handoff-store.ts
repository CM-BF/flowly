import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, readdir, rm, cp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  cardHandoffSchema, handoffUpdateSchema, handoffEntrySchemas, handoffEntrySections, handoffSections, handoffLimits, emptyHandoff, agentCharacters, handoffOpenIds, entryOpenIds,
  type CardHandoff, type HandoffActor, type HandoffEntry, type HandoffEntrySection, type HandoffInput, type HandoffQuestion, type HandoffReview, type HandoffNote, type HandoffGap, type HandoffSession, type HandoffUpdate, type HandoffAck, type HandoffPage, type HandoffWriteResult, type CaptureCursor,
} from "../shared/handoff";
import { ToolError } from "./tool-error";
import { handoffRequirementsHash } from "./handoff-requirements";
import { gapMigration, gapRules, planGapMigration, type GapMigrationPlan } from "./handoff-gap-migration";

export class HandoffError extends ToolError {
  constructor(code: "HANDOFF_UNAVAILABLE" | "HANDOFF_CONFLICT" | "HANDOFF_TOO_LARGE" | "ACK_MISMATCH" | "OPERATION_REUSED", message: string, readonly details?: unknown) { super(code, message, code === "HANDOFF_CONFLICT"); }
}
export type HandoffContext = { by: HandoffActor; operationId?: string; sourceId?: string; unconfirmed?: boolean };
type Draft<T extends HandoffEntry> = Omit<T, "id" | "rev" | "at" | "by"> & Partial<Pick<T, "id" | "at" | "by">>;
export type HandoffInputDraft = Omit<Draft<HandoffInput>, "characters" | "status" | "atSource"> & { characters?: number; status?: HandoffInput["status"]; atSource?: HandoffInput["atSource"] };
export type HandoffQuestionDraft = Omit<Draft<HandoffQuestion>, "status"> & { status?: HandoffQuestion["status"] };
export type HandoffReviewDraft = Omit<Draft<HandoffReview>, "findings" | "risks" | "gaps"> & { findings: (string | HandoffReview["findings"][number])[]; risks?: string[]; gaps?: string[] };
/** Grouped Flowly capture gap: `count` is the absolute number of occurrences so far (replays are idempotent). */
export type HandoffCaptureGap = { id: string; sourceId: string; agentId: string; text: string; count: number; firstAt?: string; lastAt?: string };
export type HandoffCapture = { entries?: { section: HandoffEntrySection; value: Record<string, unknown> }[]; gaps?: HandoffCaptureGap[]; session?: Draft<HandoffSession>; cursor?: { agentId: string; through: CaptureCursor; capturedThrough?: number }; git?: CardHandoff["git"]; checkpoint?: CardHandoff["checkpoint"]; forgetSeen?: string[]; lastWords?: CardHandoff["lastWords"] };
type Pointer = { section: HandoffEntrySection; id: string; ref: string; rev: number; sourceId?: string; at: string; removal?: { reason: string; by: HandoffActor; at: string; rev: number } };
type Receipt = { operationId: string; digest: string; result: HandoffWriteResult };
/** `inPlace`: an observation-only write (§5.1) that keeps the revision; it has no archive lines and a receipt only for an explicit operation id. */
type Intent = { version: 1; before: number; after: CardHandoff; archiveOffset: number; archiveData: string; pointers: Pointer[]; receipt?: Receipt; inPlace?: true };
/** What a transaction stored: nothing, observation state in place (same revision), or a new revision. */
export type HandoffStored = "none" | "observation" | "revision";
type IdentityClaim = { kind: "entry" | "finding" | "background" | "state"; section: HandoffEntrySection | "state"; parent: string };
/**
 * What a transaction archives: a pointer to a body already written, or a version as it is in the record. An entry written
 * in place keeps the body of its last revision (§5.1), so a superseded version gets the body of what the record held.
 */
type History = Pointer | { section: HandoffEntrySection; entry: HandoffEntry; removal?: Pointer["removal"] };
/** `evict`: entries to move into the archive in this transaction once their new version has a body (a migration's closed gaps). */
type Mutation = { record: CardHandoff; history: History[]; changed: Set<string>; ackMissing?: string[]; evict?: { section: HandoffEntrySection; id: string }[] };
/** The top-level keys of an object that differ from another's (`set`) and those it no longer has (`unset`). */
type KeyDelta = { set: Record<string, unknown>; unset: string[] };
/**
 * Observation state written in place (§5.1), over the card file whose bytes hash to `base`: the top-level fields that differ
 * from it, and of each entry that differs (same ids, same order) only its top-level keys that differ, so a turn window,
 * background items or anchors fixed since the revision are not written again on every pass. Any rewrite of the card file
 * leaves it stale, and a stale one is ignored.
 */
type Observation = { version: 2; base: string; revision: number; fields: Record<string, unknown>; unset: string[]; entries: ({ section: HandoffEntrySection; id: string } & KeyDelta)[] };
/** The card file as stored (`base`, its bytes) and the record read from it with its observation file (`record`). */
type Stored = { record: CardHandoff; base: CardHandoff; bytes: Buffer };
const fixedFields = ["version", "taskId", "projectId", "revision"];
/** The collection rules a plugin-start sweep applied to every card (§5.1): with this version recorded, a start sweeps nothing. */
const sweepVersion = 1;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Every 64-hex token of a text: a superset of the body names it references, so a collection can only keep too much. */
const tokens = (text: string, into = new Set<string>()) => { for (const [token] of text.matchAll(/[a-f0-9]{64}/g)) into.add(token); return into; };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const keyDelta = (before: object, after: object, skip: (key: string) => boolean = () => false): KeyDelta => {
  const old = before as Record<string, unknown>, next = after as Record<string, unknown>, set: Record<string, unknown> = {}, unset: string[] = [];
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (skip(key)) continue;
    if (!Object.hasOwn(next, key)) unset.push(key); else if (!isDeepStrictEqual(old[key], next[key])) set[key] = next[key];
  }
  return { set, unset };
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validDelta = (value: unknown): value is KeyDelta => isObject(value) && isObject(value.set) && Array.isArray(value.unset) && value.unset.every((key) => typeof key === "string");
const queues = new Map<string, Promise<unknown>>();
const caps: Record<HandoffEntrySection, number> = { done: 30, next: 12, decisions: 30, ruledOut: 20, problems: 20, pitfalls: 20, running: 12, where: 30, env: 12, notes: 100, gaps: 40, inputs: 200, questions: 40, reviews: 30, ledger: 200 };
const list = (record: CardHandoff, section: HandoffEntrySection) => record[section] as HandoffEntry[];
const prefix: Record<HandoffEntrySection, string> = { done: "dn", next: "nx", decisions: "dc", ruledOut: "ro", problems: "op", pitfalls: "pf", running: "rf", where: "wh", env: "ev", notes: "nt", gaps: "g", inputs: "d", questions: "q", reviews: "rv", ledger: "s" };

/**
 * What of a session's ledger entry is history: its role, end, turns, background items and acknowledgement. Observation
 * state that changes on almost every poll (cursor, measurements, growth, narration preview, coverage text, script count)
 * is superseded in place; archiving each version made the successor's full read page through one snapshot per minute.
 */
function ledgerHistory(session: HandoffSession) {
  const { through: _through, capturedThrough: _captured, measured: _measured, growth: _growth, live: _live, skeleton: _skeleton, scriptCalls: _scripts, turnsArchived: _archived, rev: _rev, at: _at, by: _by, contentRef: _ref, ...kept } = session;
  // An in-flight placeholder (a call whose result was not read yet) comes and goes with the polls that catch it running, and
  // so does an exec session the running turn started (it is history only if the turn is over with it still open); a
  // running task's latest progress event is superseded by the next one.
  return { ...kept, background: historyBackground(session) };
}
const historyBackground = (session: HandoffSession) => session.background.filter((item) => !item.inFlight && !item.transient).map(({ event: _event, ...item }) => item);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const historyHash = (session: HandoffSession) => hash(JSON.stringify(canonical(ledgerHistory(session))));
/**
 * What a transaction must change to be written: the record without its revision, write time, writer and replay ring, its
 * entries without the rev, time and content reference that every replace stamps, and Git snapshots without their read time.
 * A mutation that only re-stamps (an archived source captured again, a confirmed source confirmed again) writes nothing.
 */
function semantic(record: CardHandoff) {
  const { revision: _revision, updatedAt: _updated, updatedBy: _by, ops: _ops, ...rest } = record;
  const entry = (value: object) => { const { rev: _rev, at: _at, contentRef: _ref, ...kept } = value as Record<string, unknown>; return kept; };
  const sections = Object.fromEntries(handoffEntrySections.map((section) => [section, list(record, section).map(entry)]));
  return JSON.stringify(canonical(JSON.parse(JSON.stringify({ ...rest, ...sections, ...(rest.state ? { state: entry(rest.state) } : {}), git: rest.git.map(({ at: _at, ...snapshot }) => snapshot) }))));
}
/**
 * What moves the revision that page cursors, ACKs and entry conflicts pin: the semantic record without its observation
 * state. Ledger observation (what ledgerHistory strips: cursor, measurements, growth, narration preview, coverage text,
 * script count, calls in flight, exec sessions of the running turn, progress events), the growth of open gaps, Git
 * snapshots (Flowly reads them again at every turn end, rotation and handoff write, and an ACK checks the heads against its
 * own fresh read) and the read cache are written in place: the successor's own running turn, observed every minute, no
 * longer restarts its full read or refuses its ACK (§5.1, §7.5).
 */
function pinned(record: CardHandoff) {
  const { revision: _revision, updatedAt: _updated, updatedBy: _by, ops: _ops, seen: _seen, git: _git, ...rest } = record;
  const entry = (value: object) => { const { rev: _rev, at: _at, contentRef: _ref, ...kept } = value as Record<string, unknown>; return kept; };
  // An open gap that grows (count, first and last occurrence) is the same obligation, as for the delivery gate
  // (handoffRequirementsHash): written in place, with the count at the revision kept (`countAtRevision`) so that an ACK or close
  // of that revision settles only what its reader could have seen. A new gap, a reopened one and a closed one are pinned.
  const gap = (value: HandoffGap) => { const kept = entry(value); if (value.status === "open") { delete kept.count; delete kept.countAtRevision; delete kept.firstAt; delete kept.lastAt; } return kept; };
  const sections = Object.fromEntries(handoffEntrySections.map((section) => [section, section === "ledger" ? record.ledger.map(ledgerHistory) : section === "gaps" ? record.gaps.map(gap) : list(record, section).map(entry)]));
  return JSON.stringify(canonical(JSON.parse(JSON.stringify({ ...rest, ...sections, ...(rest.state ? { state: entry(rest.state) } : {}) }))));
}
/** Per archive file (append-only): the newest archived version of each ledger entry and the offsets of versions whose history equals the next one's. */
type LedgerRuns = { identity: string; scanned: number; last: Map<string, { offset: number; history: string }>; superseded: Set<number> };
/** Per archive file (append-only): the body names its complete lines reference, read once and then only what was appended. */
type ArchiveRefs = { identity: string; scanned: number; refs: Set<string> };
const evict = <V>(cache: Map<string, V>, key: string, value: V) => { cache.delete(key); cache.set(key, value); if (cache.size > 16) cache.delete(cache.keys().next().value!); return value; };

/** Per-card durable current record, immutable entry bodies and append-only pointers. No provider or daemon access. */
export class HandoffStore {
  readonly root: string;
  private verifiedBodies = new Map<string, string>();
  private ledgerRuns = new Map<string, LedgerRuns>();
  private archiveRefs = new Map<string, ArchiveRefs>();
  private sealRefs = new Map<string, Map<string, { stamp: string; refs: Set<string> }>>();
  /** Cards whose bodies this process collected at its first touch (what older versions, crashes and refused writes left). */
  private collected = new Set<string>();
  constructor(directory: string, private options: { now?: () => string; fault?: (point: string) => void | Promise<void> } = {}) { this.root = join(directory, "handoffs"); }
  private now() { return this.options.now?.() ?? new Date().toISOString(); }
  private paths(taskId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(taskId)) throw new HandoffError("HANDOFF_UNAVAILABLE", "Invalid handoff card identity.");
    const folder = join(this.root, taskId);
    return { current: join(this.root, `${taskId}.json`), folder, intent: join(folder, "pending.json"), archive: join(folder, "archive.jsonl"), observation: join(folder, "observation.json"), restore: join(this.root, `${taskId}.restore.json`) };
  }
  private serial<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const key = this.paths(taskId).current;
    const result = (queues.get(key) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined); queues.set(key, tail);
    void tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }
  private async syncDirectory(path: string) { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
  private async atomic(path: string, value: string | Buffer) {
    const parent = join(path, ".."); await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); await this.syncDirectory(parent);
  }
  private async optional<T>(path: string, maxBytes = 4 * handoffLimits.currentBytes): Promise<T | null> {
    try { if ((await stat(path)).size > maxBytes) throw new Error("oversize"); return JSON.parse(await readFile(path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff data is unreadable; preserved at ${path}.`); }
  }
  private identities(record: CardHandoff, code: "HANDOFF_CONFLICT" | "HANDOFF_UNAVAILABLE" = "HANDOFF_CONFLICT") {
    const claims = new Map<string, IdentityClaim>();
    const claim = (id: string, owner: IdentityClaim) => {
      if (claims.has(id)) throw new HandoffError(code, "Different handoff entries cannot share one identity; original records are preserved.", { id, occupiedBy: claims.get(id), requestedBy: owner });
      claims.set(id, owner);
    };
    claim("state", { kind: "state", section: "state", parent: "state" });
    if (record.state && record.state.id !== "state") throw new HandoffError(code, "The handoff state has an invalid identity; original records are preserved.");
    for (const section of handoffEntrySections) for (const entry of list(record, section)) {
      claim(entry.id, { kind: "entry", section, parent: entry.id });
      if (section === "reviews") for (const finding of (entry as HandoffReview).findings) claim(finding.id, { kind: "finding", section, parent: entry.id });
      if (section === "ledger") for (const background of (entry as HandoffSession).background) claim(background.id, { kind: "background", section, parent: entry.id });
    }
    for (const entry of record.overflow) {
      claim(entry.id, { kind: "entry", section: entry.section, parent: entry.id });
      for (const id of entry.openIds) {
        if (id === entry.id && entry.section !== "reviews" && entry.section !== "ledger") continue;
        claim(id, { kind: entry.section === "reviews" ? "finding" : entry.section === "ledger" ? "background" : "entry", section: entry.section, parent: entry.id });
      }
    }
    return claims;
  }
  private async preserveIdentities(previous: CardHandoff, next: CardHandoff) {
    const before = this.identities(previous), after = this.identities(next);
    for (const [id, owner] of after) {
      const old = before.get(id);
      if (old) {
        if (!isDeepStrictEqual(old, owner)) throw new HandoffError("HANDOFF_CONFLICT", "This identity already belongs to another handoff entity; original records are preserved.", { id, occupiedBy: old, requestedBy: owner });
        continue;
      }
      // Historical top-level ownership is already indexed by id. Never scan or rewrite the archive to check it.
      const pointer = await this.optional<Pointer>(join(this.paths(next.taskId).folder, "latest", `${hash(id)}.json`));
      if (pointer && (owner.kind !== "entry" || pointer.section !== owner.section)) throw new HandoffError("HANDOFF_CONFLICT", "This identity belongs to an archived handoff entry and cannot be reassigned.", { id, occupiedBy: pointer.section, requestedBy: owner });
    }
  }
  private async current(taskId: string, projectId?: string): Promise<CardHandoff | null> {
    const stored = await this.stored(taskId, projectId);
    return stored ? stored.record : projectId ? emptyHandoff(taskId, projectId) : null;
  }
  private async stored(taskId: string, projectId?: string): Promise<Stored | null> {
    const path = this.paths(taskId);
    let file: Buffer;
    try { if ((await stat(path.current)).size > handoffLimits.currentBytes) throw new Error("oversize"); file = await readFile(path.current); }
    catch (error) { if (absent(error)) return null; throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff data is unreadable; preserved at ${path.current}.`); }
    let raw: unknown; try { raw = JSON.parse(file.toString("utf8")); } catch { throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff data is unreadable; preserved at ${path.current}.`); }
    const parsed = cardHandoffSchema.safeParse(raw);
    if (!parsed.success || parsed.data.taskId !== taskId || (projectId && parsed.data.projectId !== projectId) || bytes(raw) > handoffLimits.currentBytes)
      throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff data is invalid; preserved at ${path.current}.`);
    this.identities(parsed.data, "HANDOFF_UNAVAILABLE");
    const observation = await this.optional<Observation>(path.observation);
    if (!observation || observation.base !== hash(file)) return { record: parsed.data, base: parsed.data, bytes: file };
    return { record: this.observed(parsed.data, observation, path.observation), base: parsed.data, bytes: file };
  }
  /** The record with its observation file applied; one that does not fit the card file it names is preserved for inspection. */
  private observed(base: CardHandoff, observation: Observation, path: string) {
    const invalid = () => new HandoffError("HANDOFF_UNAVAILABLE", `Handoff observation data is invalid; preserved at ${path}.`);
    if (observation.version !== 2 || observation.revision !== base.revision || !validDelta({ set: observation.fields, unset: observation.unset }) || !Array.isArray(observation.entries)) throw invalid();
    const merged = clone(base) as unknown as Record<string, unknown>, sections = handoffEntrySections as readonly string[];
    // Applied generically: which keys are observation state is decided by the writer (`pinned`), not repeated here.
    const apply = (target: Record<string, unknown>, delta: KeyDelta) => {
      for (const key of delta.unset) delete target[key];
      for (const [key, value] of Object.entries(delta.set)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    };
    for (const key of [...observation.unset, ...Object.keys(observation.fields)]) if (sections.includes(key) || fixedFields.includes(key)) throw invalid();
    apply(merged, { set: observation.fields, unset: observation.unset });
    for (const item of observation.entries) {
      if (!validDelta(item)) throw invalid();
      const { section, id } = item, entries = typeof section === "string" && sections.includes(section) ? merged[section] as HandoffEntry[] : undefined, index = entries?.findIndex((entry) => entry.id === id) ?? -1;
      if (index < 0 || Object.hasOwn(item.set, "id") || item.unset.includes("id")) throw invalid();
      apply(entries![index] as unknown as Record<string, unknown>, item);
    }
    const parsed = cardHandoffSchema.safeParse(merged);
    if (!parsed.success || parsed.data.taskId !== base.taskId || parsed.data.projectId !== base.projectId || parsed.data.revision !== base.revision || bytes(merged) > handoffLimits.currentBytes) throw invalid();
    this.identities(parsed.data, "HANDOFF_UNAVAILABLE");
    return parsed.data;
  }
  /** What an in-place write changes against the card file: null when it is not observation-shaped (other entries or order). */
  private delta(base: CardHandoff, written: CardHandoff): Omit<Observation, "version" | "base" | "revision"> | null {
    const before = base as unknown as Record<string, unknown>, after = clone(written) as unknown as Record<string, unknown>, sections = handoffEntrySections as readonly string[];
    if (fixedFields.some((key) => !isDeepStrictEqual(before[key], after[key]))) return null;
    const top = keyDelta(before, after, (key) => sections.includes(key) || fixedFields.includes(key)), entries: Observation["entries"] = [];
    for (const section of handoffEntrySections) {
      const old = list(base, section), next = after[section] as HandoffEntry[];
      if (old.length !== next.length) return null;
      for (const [index, entry] of next.entries()) {
        if (old[index].id !== entry.id) return null;
        const change = keyDelta(old[index], entry);
        if (change.unset.length || Object.keys(change.set).length) entries.push({ section, id: entry.id, ...change });
      }
    }
    return { fields: top.set, unset: top.unset, entries };
  }
  /**
   * An in-place write (§5.1): the observation file holds what differs from the card file, which is not rewritten; a pass
   * writes the keys changed since the revision, not the card or whole entries. Without a card file (or not
   * observation-shaped) the card is written.
   */
  private async observe(taskId: string, stored: Stored | null, record: CardHandoff) {
    const path = this.paths(taskId), delta = stored && this.delta(stored.base, record);
    if (!delta) { await this.atomic(path.current, JSON.stringify(record)); await this.unobserve(taskId); return; }
    if (!delta.unset.length && !delta.entries.length && !Object.keys(delta.fields).length) { await this.unobserve(taskId, true); return; }
    await this.atomic(path.observation, JSON.stringify({ version: 2, base: hash(stored!.bytes), revision: record.revision, ...delta } satisfies Observation));
  }
  /** Removes the observation file once the card file holds what it held (`sync` when the card file did not change). */
  private async unobserve(taskId: string, sync = false) {
    const path = this.paths(taskId);
    const removed = await unlink(path.observation).then(() => true, (error) => { if (absent(error)) return false; throw error; });
    if (removed && sync) await this.syncDirectory(path.folder);
  }
  private async recover(taskId: string) {
    await this.recoverRestore(taskId);
    await this.finish(taskId);
    if (this.collected.has(taskId)) return;
    // First touch in this process: what older versions (their in-place writes left a body per pass), a crash before an
    // unfinished write was durable, or a refused write left. A body an older version's reader at this revision may still
    // page is kept until the revision moves (`grace`).
    this.collected.add(taskId);
    const record = await this.current(taskId).catch(() => null);
    if (record) await this.collect(taskId, record, true).catch(this.collectFailed);
  }
  private collectFailed = (error: unknown) => console.error("Flowly handoff body cleanup will retry:", error instanceof Error ? error.message : String(error));
  /**
   * Plugin start (§5.1): every card's first-touch collection, once per collection version, also of cards nothing opens,
   * polls or writes again (a done or stopped card would keep what older versions left). One card at a time in its queue,
   * `pauseMs` apart; stopped, it records nothing and the next start sweeps again. Recorded in handoffs/.collected.json.
   */
  async sweep(options: { pauseMs?: number; stopped?: () => boolean } = {}) {
    const marker = join(this.root, ".collected.json");
    if (((await this.optional<{ version?: unknown }>(marker).catch(() => null))?.version ?? 0) === sweepVersion) return { cards: 0, recorded: true };
    const names = await readdir(this.root).catch((error) => { if (absent(error)) return [] as string[]; throw error; });
    let cards = 0;
    for (const name of names.sort()) {
      const taskId = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\.json$/.exec(name)?.[1];
      if (!taskId || name.endsWith(".restore.json")) continue;
      if (options.stopped?.()) return { cards, recorded: false };
      await this.serial(taskId, () => this.recover(taskId)).catch((error) => console.error(`Flowly handoff body cleanup skipped card ${taskId}:`, error instanceof Error ? error.message : String(error)));
      cards++;
      if (options.pauseMs) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
    }
    if (options.stopped?.() || !names.length) return { cards, recorded: false };
    await this.atomic(marker, JSON.stringify({ version: sweepVersion, at: this.now(), cards }));
    return { cards, recorded: true };
  }
  /**
   * The one-time migration of the gaps older builds wrote once per occurrence (SESSION-HANDOFF-SPEC §21.17), one card: one
   * Flowly transaction under a fixed operation id, so a crash is finished from its unfinished write and a rerun after it
   * committed meets its receipt. It takes a new revision, so a reader paging the previous one is told its view changed.
   * Nothing to migrate writes nothing. A closed gap leaves the current record and its overflow index for the archive with the
   * reason; its open version is not archived again (the closed one holds its text, source and time). The caller runs it in
   * the card's queue (HandoffService.serial), never inside another transaction.
   */
  async migrateLegacyGaps(taskId: string): Promise<{ stored: HandoffStored; replayed: boolean; plan?: GapMigrationPlan }> {
    const found = await this.read(taskId);
    if (!found) return { stored: "none", replayed: false };
    let plan: GapMigrationPlan | undefined;
    const by = { kind: "flowly" as const };
    const { result, stored } = await this.write(taskId, found.projectId, { action: "migrate-gaps", rules: gapRules }, { by, operationId: gapMigration.operationId }, async (change) => {
      const record = change.record, archived = record.overflow.filter((entry) => entry.section === "gaps");
      const gaps = [...record.gaps, ...await Promise.all(archived.map((entry) => this.object(taskId, entry.contentRef) as Promise<HandoffGap>))];
      // Session numbers and providers, also of sessions whose ledger entry is archived.
      const sessions = new Map(record.ledger.map((entry) => [entry.agentId, { n: entry.n, provider: entry.provider }]));
      for (const agentId of new Set(gaps.flatMap((gap) => gap.agentId && !sessions.has(gap.agentId) ? [gap.agentId] : []))) {
        const entry = await this.entry(record, "ledger", `s:${hash(agentId).slice(0, 32)}`) as HandoffSession | null;
        if (entry?.agentId === agentId) sessions.set(agentId, { n: entry.n, provider: entry.provider });
      }
      plan = planGapMigration(gaps, sessions);
      if (!plan.close.length) return;
      change.evict = [];
      for (const { id, note } of plan.close) {
        const { contentRef: _ref, ...gap } = gaps.find((value) => value.id === id)!;
        this.replace(change, "gaps", handoffEntrySchemas.gaps.parse({ ...gap, rev: record.revision, at: record.updatedAt, status: "closed", firstAt: gap.firstAt ?? gap.at, lastAt: gap.lastAt ?? gap.at, resolution: { by, at: record.updatedAt, note } }), false);
        change.evict.push({ section: "gaps", id });
      }
      for (const group of plan.groups) await this.mergeGap(change, group, { by });
      if (plan.note) await this.append(change, "notes", { kind: "other", text: plan.note }, { by, sourceId: `${gapMigration.operationId}:note` });
    });
    return { stored, replayed: !!result.replayed, ...(plan ? { plan } : {}) };
  }
  private markers: Promise<unknown> = Promise.resolve();
  private marker<T>(work: (path: string, marker: Record<string, unknown> | null) => Promise<T>): Promise<T> {
    const path = join(this.root, gapMigration.marker);
    const result = this.markers.then(async () => work(path, await this.optional<Record<string, unknown>>(path).catch(() => null)));
    this.markers = result.catch(() => undefined);
    return result;
  }
  /**
   * Plugin start (§21.17): the cards the one-time gap migration visits. Until its marker is recorded, every card; then only
   * the cards it could not migrate and cards whose restore was cut off (a restore migrates its card itself).
   */
  gapMigrationCards(): Promise<{ recorded: boolean; cards: string[] }> {
    return this.marker(async (_path, marker) => {
      const names = await readdir(this.root).catch((error) => { if (absent(error)) return [] as string[]; throw error; });
      const card = (name: string, suffix: string) => name.endsWith(suffix) ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.exec(name.slice(0, -suffix.length))?.[0] : undefined;
      const restores = names.flatMap((name) => card(name, ".restore.json") ?? []);
      if (marker?.version === gapMigration.version) {
        const failed = Array.isArray(marker.failed) ? marker.failed.filter((id): id is string => typeof id === "string" && !!card(`${id}.json`, ".json")) : [];
        return { recorded: true, cards: [...new Set([...failed, ...restores])].sort() };
      }
      return { recorded: false, cards: [...new Set([...names.flatMap((name) => name.endsWith(".restore.json") ? [] : card(name, ".json") ?? []), ...restores])].sort() };
    });
  }
  /** Records a finished run: the cards it could not migrate, and those a restore could not migrate meanwhile, are retried at the next start. */
  recordGapMigration(run: { visited: readonly string[]; migrated: number; failed: readonly string[] }) {
    return this.marker(async (path, marker) => {
      const earlier = marker?.version === gapMigration.version && Array.isArray(marker.failed) ? marker.failed.filter((id): id is string => typeof id === "string" && !run.visited.includes(id)) : [];
      await this.atomic(path, JSON.stringify({ version: gapMigration.version, rules: gapRules, at: this.now(), cards: run.visited.length, migrated: run.migrated, failed: [...new Set([...earlier, ...run.failed])].sort() }));
    });
  }
  /** A restored card whose migration failed: once the marker is recorded, the next start retries it. */
  gapMigrationFailed(taskId: string) {
    return this.marker(async (path, marker) => {
      if (marker?.version !== gapMigration.version) return;
      const failed = Array.isArray(marker.failed) ? marker.failed.filter((id): id is string => typeof id === "string") : [];
      if (!failed.includes(taskId)) await this.atomic(path, JSON.stringify({ ...marker, failed: [...failed, taskId].sort() }));
    });
  }
  /** Writes `value` unless the file already holds exactly these bytes (a replayed unfinished write). */
  private async ensure(path: string, value: string) {
    const previous = await readFile(path).catch((error) => { if (absent(error)) return undefined; throw error; });
    if (!previous?.equals(Buffer.from(value))) await this.atomic(path, value);
  }
  private async finish(taskId: string) {
    const path = this.paths(taskId), intent = await this.optional<Intent>(path.intent);
    if (!intent) return;
    const parsed = cardHandoffSchema.safeParse(intent.after);
    const inPlace = intent.inPlace === true;
    if (intent.version !== 1 || !parsed.success || parsed.data.taskId !== taskId || bytes(intent.after) > handoffLimits.currentBytes || !Number.isSafeInteger(intent.archiveOffset) || intent.archiveOffset < 0 || typeof intent.archiveData !== "string" || !Array.isArray(intent.pointers) || (!intent.receipt && !inPlace) || (inPlace && intent.archiveData !== ""))
      throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff recovery data is invalid; preserved at ${path.intent}.`);
    this.identities(parsed.data, "HANDOFF_UNAVAILABLE");
    const current = await this.current(taskId);
    // An in-place write keeps the revision: the current file is the one before it or already the one it writes.
    const conflicting = inPlace ? intent.after.revision !== intent.before || !current || current.projectId !== intent.after.projectId || current.revision !== intent.before
      : intent.after.revision !== intent.before + 1 || (current ? current.projectId !== intent.after.projectId || ![intent.before, intent.after.revision].includes(current.revision) || (current.revision === intent.after.revision && !isDeepStrictEqual(current, parsed.data)) : intent.before !== 0);
    if (conflicting) throw new HandoffError("HANDOFF_UNAVAILABLE", "The current handoff conflicts with its unfinished write; both files are preserved.");
    if (intent.pointers.some((p) => !handoffEntrySections.includes(p.section) || !/^[a-f0-9]{64}$/.test(p.ref) || typeof p.id !== "string") || (intent.receipt && (typeof intent.receipt.operationId !== "string" || !/^[a-f0-9]{64}$/.test(intent.receipt.digest)))) throw new HandoffError("HANDOFF_UNAVAILABLE", "The unfinished handoff has invalid content references; preserved for recovery.");
    if (!inPlace) {
      const content = Buffer.from(intent.archiveData);
      await mkdir(path.folder, { recursive: true, mode: 0o700 });
      const archive = await open(path.archive, "a+", 0o600);
      try {
        const size = (await archive.stat()).size;
        if (size < intent.archiveOffset || size > intent.archiveOffset + content.length) throw new HandoffError("HANDOFF_UNAVAILABLE", "The handoff archive conflicts with its pending write; preserved for recovery.");
        const tail = Buffer.alloc(size - intent.archiveOffset); if (tail.length) await archive.read(tail, 0, tail.length, intent.archiveOffset);
        if (!tail.equals(content.subarray(0, tail.length))) throw new HandoffError("HANDOFF_UNAVAILABLE", "The handoff archive contains unexpected bytes; preserved for recovery.");
        if (tail.length < content.length) await archive.writeFile(content.subarray(tail.length));
        await archive.sync();
      } finally { await archive.close(); }
    }
    await this.options.fault?.("archive-synced");
    // A replay after a crash finds some files already written: they are not written again.
    const replay = !!current && isDeepStrictEqual(current, parsed.data), write = (file: string, value: string) => replay ? this.ensure(file, value) : this.atomic(file, value);
    if (!replay) await this.atomic(path.current, JSON.stringify(intent.after));
    // The card file holds the observation state now; a crash before the intent is removed replays this.
    await this.unobserve(taskId);
    await this.options.fault?.("current-synced");
    for (const pointer of intent.pointers) {
      await write(join(path.folder, "latest", `${hash(pointer.id)}.json`), JSON.stringify(pointer));
      if (pointer.sourceId) await write(join(path.folder, "sources", `${hash(pointer.sourceId)}.json`), JSON.stringify(pointer));
    }
    if (intent.receipt) await write(join(path.folder, "ops", `${hash(intent.receipt.operationId)}.json`), JSON.stringify(intent.receipt));
    await this.options.fault?.("sources-synced");
    // The write is durable: the bodies it superseded go now, before the intent that would replay this step after a crash.
    if (!inPlace) { await this.collect(taskId, parsed.data, false).catch(this.collectFailed); await this.options.fault?.("collected"); }
    await unlink(path.intent); await this.syncDirectory(path.folder); await this.options.fault?.("intent-removed");
  }
  /**
   * Removes the entry bodies nothing references (§5.1). Only inside the card's queue with no unfinished write, so no
   * transaction's new bodies are in flight. Kept: every body the current record (entries and overflow) names, every archive
   * line, every seal, the latest-version and source pointers of the body's own entry and the source pointer of every
   * pending operation. Receipts hold results (revision, counts, ids), never a body. A reader pages only bodies its revision
   * names (in place, an entry keeps the body of its last revision) and a newer revision ends its view before it reads a
   * body, so no reader can page a body this removes; an older version's reader at this revision could page what that
   * version left of an entry at its current revision, which `grace` keeps. A body that cannot be read or fails its
   * checksum is preserved for inspection; the temporary file of an atomic write that never completed is removed.
   */
  private async collect(taskId: string, record: CardHandoff, grace: boolean) {
    const path = this.paths(taskId), folder = join(path.folder, "entries");
    const names = await readdir(folder).catch((error) => { if (absent(error)) return [] as string[]; throw error; });
    const live = tokens(JSON.stringify(record));
    const candidates = names.flatMap((name) => { const match = /^([a-f0-9]{64})\.json(\.[0-9a-f-]{36}\.tmp)?$/.exec(name); return match && (match[2] || !live.has(match[1])) ? [{ name, ref: match[1], temporary: !!match[2] }] : []; });
    if (!candidates.length) return;
    const archived = await this.archived(taskId), sealed = await this.sealed(taskId);
    for (const operation of record.pendingOperations) { const pointer = await this.source(taskId, operation.sourceId).catch(() => null); if (pointer) live.add(pointer.ref); }
    const revisions = new Map(handoffEntrySections.flatMap((section) => list(record, section).map((entry) => [entry.id, entry.rev] as const)));
    const latest = (id: string) => join(path.folder, "latest", `${hash(id)}.json`), sources = (id: string) => join(path.folder, "sources", `${hash(id)}.json`);
    let removed = 0;
    for (const { name, ref, temporary } of candidates) {
      const file = join(folder, name);
      if (!temporary) {
        if (live.has(ref) || archived.has(ref) || sealed.has(ref)) continue;
        const body = await readFile(file, "utf8").catch(() => undefined);
        if (body === undefined || hash(body) !== ref) continue;
        let entry: { id?: unknown; rev?: unknown; sourceId?: unknown }; try { entry = JSON.parse(body); } catch { continue; }
        // A body of a revision past the record's is a write in flight that this queue cannot see (another process on the
        // same data directory): the bodies an unfinished write creates carry the next revision, or the id and rev of an
        // entry of the record it started from (what `grace` keeps). Its own next revision collects one that stays unnamed.
        if (typeof entry.id !== "string" || !Number.isSafeInteger(entry.rev) || (entry.rev as number) > record.revision || (grace && revisions.get(entry.id) === entry.rev)) continue;
        const pointers = [latest(entry.id), ...(typeof entry.sourceId === "string" ? [sources(entry.sourceId)] : [])];
        if ((await Promise.all(pointers.map((pointer) => this.optional<Pointer>(pointer).catch(() => ({ ref }))))).some((pointer) => pointer?.ref === ref)) continue;
      }
      await unlink(file).catch((error) => { if (!absent(error)) throw error; }); removed++;
    }
    if (removed) await this.syncDirectory(folder);
  }
  /** The body names archive.jsonl references (append-only: read once, then only what was appended; a partial last line counts too). */
  private async archived(taskId: string) {
    const path = this.paths(taskId).archive;
    const info = await stat(path).catch((error) => { if (absent(error)) return undefined; throw error; });
    if (!info) { this.archiveRefs.delete(taskId); return new Set<string>(); }
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`, cached = this.archiveRefs.get(taskId);
    const index = evict(this.archiveRefs, taskId, cached && cached.identity === identity && info.size >= cached.scanned ? cached : { identity, scanned: 0, refs: new Set<string>() });
    let tail = Buffer.alloc(0);
    if (index.scanned < info.size) {
      const file = await open(path, "r");
      try {
        const chunk = Buffer.alloc(1 << 20); let position = index.scanned;
        while (position < info.size) {
          const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
          if (!bytesRead) break;
          position += bytesRead;
          const data = Buffer.concat([tail, chunk.subarray(0, bytesRead)]), end = data.lastIndexOf(10) + 1;
          tokens(data.subarray(0, end).toString("utf8"), index.refs); index.scanned += end; tail = data.subarray(end);
        }
      } finally { await file.close(); }
    }
    return tail.length ? tokens(tail.toString("utf8"), new Set(index.refs)) : index.refs;
  }
  /** The body names the sealed snapshots reference (each written once at its rotation). */
  private async sealed(taskId: string) {
    const folder = join(this.paths(taskId).folder, "sealed"), refs = new Set<string>();
    const names = await readdir(folder).catch((error) => { if (absent(error)) return [] as string[]; throw error; });
    const previous = this.sealRefs.get(taskId), cache = evict(this.sealRefs, taskId, new Map<string, { stamp: string; refs: Set<string> }>());
    for (const name of names) {
      const info = await stat(join(folder, name)), stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      let entry = previous?.get(name);
      if (entry?.stamp !== stamp) entry = { stamp, refs: tokens(await readFile(join(folder, name), "utf8")) };
      cache.set(name, entry); for (const ref of entry.refs) refs.add(ref);
    }
    return refs;
  }
  read(taskId: string, projectId: string): Promise<CardHandoff>;
  read(taskId: string): Promise<CardHandoff | null>;
  read(taskId: string, projectId?: string) { return this.serial(taskId, async () => { await this.recover(taskId); return this.current(taskId, projectId); }); }
  private async object(taskId: string, ref: string): Promise<HandoffEntry> {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new HandoffError("HANDOFF_UNAVAILABLE", "Invalid handoff content reference.");
    const path = join(this.paths(taskId).folder, "entries", `${ref}.json`);
    let raw: string; try { if ((await stat(path)).size > handoffLimits.currentBytes) throw new Error("oversize"); raw = await readFile(path, "utf8"); } catch { throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff content is unavailable; preserved references at ${path}.`); }
    if (hash(raw) !== ref) throw new HandoffError("HANDOFF_UNAVAILABLE", `Handoff content failed its checksum; preserved at ${path}.`);
    return { ...JSON.parse(raw), contentRef: ref } as HandoffEntry;
  }
  private async entry(record: CardHandoff, section: HandoffEntrySection, id: string) {
    const current = list(record, section).find((e) => e.id === id); if (current) return current;
    const overflow = record.overflow.find((e) => e.section === section && e.id === id);
    if (overflow) return this.object(record.taskId, overflow.contentRef);
    const pointer = await this.optional<Pointer>(join(this.paths(record.taskId).folder, "latest", `${hash(id)}.json`));
    return pointer?.section === section ? this.object(record.taskId, pointer.ref) : null;
  }
  private async immutable(path: string, body: string) {
    try { const previous = await readFile(path, "utf8"); if (previous !== body) throw new HandoffError("HANDOFF_UNAVAILABLE", `Immutable handoff content differs; preserved at ${path}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.atomic(path, body); }
  }
  private pointer(section: HandoffEntrySection, entry: HandoffEntry): Pointer { return { section, id: entry.id, ref: entry.contentRef!, rev: entry.rev, at: entry.at, ...(entry.sourceId ? { sourceId: entry.sourceId } : {}) }; }
  /** `inPlace`: an observation-only write keeps each entry's body of its last revision; the next revision writes the version then in the record. */
  private async normalize(record: CardHandoff, history: History[], inPlace = false, evict: Mutation["evict"] = []) {
    const pointers: Pointer[] = [], path = this.paths(record.taskId);
    for (const section of handoffEntrySections) for (const entry of list(record, section)) {
      if (inPlace && entry.contentRef) continue;
      if (section === "inputs") {
        const input = entry as HandoffInput;
        if (input.text !== undefined && Buffer.byteLength(input.text) > handoffLimits.inlineBytes) {
          input.firstLine = input.text.split("\n")[0].slice(0, 160); input.textRef = hash(input.text); await this.immutable(join(path.folder, "inputs", `${input.textRef}.txt`), input.text); delete input.text;
        }
      }
      const plain = { ...entry }; delete plain.contentRef;
      const body = JSON.stringify(plain), ref = hash(body);
      if (entry.contentRef !== ref) { await this.immutable(join(path.folder, "entries", `${ref}.json`), body); entry.contentRef = ref; pointers.push(this.pointer(section, entry)); }
    }
    const archive = (section: HandoffEntrySection, index: number) => {
      const [entry] = list(record, section).splice(index, 1); history.push(this.pointer(section, entry));
      if (entry.unconfirmed || entryOpenIds(section, entry).length || (section === "inputs" && (entry as HandoffInput).standing)) {
        const e = entry as unknown as Record<string, unknown>;
        record.overflow.push({ section, id: entry.id, rev: entry.rev, at: entry.at, status: String(e.status ?? "open"), firstLine: String(e.text ?? e.what ?? e.summary ?? "").split("\n")[0].slice(0, 160), contentRef: entry.contentRef!, requirementsHash: handoffRequirementsHash(section, entry), openIds: entryOpenIds(section, entry.unconfirmed ? { ...entry, unconfirmed: false } : entry), ...(entry.sourceId ? { sourceId: entry.sourceId } : {}), ...(entry.unconfirmed ? { unconfirmed: true } : {}), ...(entry.operationId ? { operationId: entry.operationId } : {}), ...(section === "reviews" ? { cycle: (entry as HandoffReview).cycle, round: (entry as HandoffReview).round, verdict: (entry as HandoffReview).verdict } : {}) });
      }
    };
    // Settled entries a migration moves out of the current record: their new version is written above, so its latest and
    // source pointers name it and its archive line carries it.
    for (const { section, id } of evict) { const index = list(record, section).findIndex((entry) => entry.id === id); if (index >= 0) archive(section, index); }
    for (const section of handoffEntrySections) {
      if ((handoffSections as readonly string[]).includes(section) && list(record, section).length > caps[section]) throw new HandoffError("HANDOFF_TOO_LARGE", `Too many handoff ${section} entries; remove or resolve an older entry first.`);
      while (list(record, section).length > caps[section]) {
        const closed = list(record, section).findIndex((e) => !e.unconfirmed && !entryOpenIds(section, e).length && !(section === "inputs" && (e as HandoffInput).standing));
        archive(section, closed < 0 ? 0 : closed);
      }
    }
    const reviews = [...record.reviews, ...record.overflow.filter((e) => e.section === "reviews")].filter((e) => !e.unconfirmed);
    const cycle = Math.max(-1, ...reviews.map((r) => r.cycle ?? -1)), round = Math.max(-1, ...reviews.filter((r) => r.cycle === cycle).map((r) => r.round ?? -1));
    record.overflow = record.overflow.filter((e) => e.section !== "reviews" || e.unconfirmed || (e.cycle === cycle && e.round === round));
    record.tombstones = record.tombstones.slice(-300);
    // Metadata alone can eventually fill 1 MiB. Reject the NEW operation rather than erase existing unresolved ids.
    while (bytes(record) > handoffLimits.currentBytes) {
      const section = (["inputs", "reviews", "notes", "ledger", "questions", "gaps"] as const).find((s) => list(record, s).length);
      if (!section) throw new HandoffError("HANDOFF_TOO_LARGE", "Unresolved handoff indexes fill the 1 MiB budget. Existing content is preserved; resolve pending items before retrying.");
      archive(section, 0);
    }
    return pointers;
  }
  /** Pointers for what a transaction archives; a version as it was in the record gets its body (the one it names, when that holds the same entry). */
  private async archivedPointers(taskId: string, history: History[]) {
    const pointers: Pointer[] = [];
    for (const item of history) {
      if (!("entry" in item)) { pointers.push(item); continue; }
      const { contentRef: named, ...plain } = item.entry, body = JSON.stringify(plain);
      let ref = hash(body);
      if (ref !== named) {
        const same = named && await this.object(taskId, named).then(({ contentRef: _, ...stored }) => isDeepStrictEqual(stored, JSON.parse(body)), () => false);
        if (same) ref = named; else await this.immutable(join(this.paths(taskId).folder, "entries", `${ref}.json`), body);
      }
      pointers.push({ ...this.pointer(item.section, { ...item.entry, contentRef: ref }), ...(item.removal ? { removal: item.removal } : {}) });
    }
    return pointers;
  }
  private result(record: CardHandoff, ackMissing?: string[]): HandoffWriteResult {
    const open = { inputs: 0, questions: 0, findings: 0, running: 0, gaps: 0 };
    for (const section of ["inputs", "questions", "reviews", "running", "gaps"] as const) {
      const count = list(record, section).flatMap((entry) => entryOpenIds(section, entry)).length + record.overflow.filter((e) => e.section === section && !e.unconfirmed).reduce((sum, e) => sum + e.openIds.length, 0);
      open[section === "reviews" ? "findings" : section] = count;
    }
    return { ok: true, handoffRevision: record.revision, at: record.updatedAt, budget: agentCharacters(record), open, handoffDue: !record.state || !record.next.length ? "Write the card state and next step before delivery." : null, ...(ackMissing?.length ? { ackMissing } : {}) };
  }
  private transaction(taskId: string, projectId: string, payload: unknown, context: HandoffContext, mutate: (change: Mutation) => Promise<void> | void): Promise<HandoffWriteResult> {
    return this.write(taskId, projectId, payload, context, mutate).then(({ result }) => result);
  }
  private write(taskId: string, projectId: string, payload: unknown, context: HandoffContext, mutate: (change: Mutation) => Promise<void> | void): Promise<{ result: HandoffWriteResult; stored: HandoffStored }> {
    return this.serial(taskId, async () => {
      await this.recover(taskId);
      const operationId = context.operationId ?? randomUUID(), digest = hash(JSON.stringify(payload)), path = this.paths(taskId);
      const receipt = await this.optional<Receipt>(join(path.folder, "ops", `${hash(operationId)}.json`));
      if (receipt) { if (receipt.digest !== digest) throw new HandoffError("OPERATION_REUSED", "That handoff operation id was already used for different content."); return { result: { ...receipt.result, replayed: true }, stored: "none" }; }
      const stored = await this.stored(taskId, projectId), current = stored?.record ?? emptyHandoff(taskId, projectId), record = clone(current);
      record.revision++; record.updatedAt = this.now(); record.updatedBy = context.by;
      const mutation: Mutation = { record, history: [], changed: new Set() }; await mutate(mutation);
      await this.archiveLedger(mutation, current);
      if (context.unconfirmed && context.sourceId && [...handoffEntrySections.flatMap((section) => list(record, section)), ...record.overflow].some((e) => e.sourceId === context.sourceId && e.unconfirmed) && !record.pendingOperations.some((o) => o.id === operationId)) record.pendingOperations.push({ id: operationId, sourceId: context.sourceId, at: record.updatedAt });
      // No semantic change: no revision, no receipt, no bytes. An idle poll re-capturing what is already stored must not
      // move the revision (a prepared ACK would fail with ACK_MISMATCH) or rewrite the file.
      if (semantic(record) === semantic(current)) return { result: this.result(current, mutation.ackMissing), stored: "none" };
      // Observation state only (§5.1): written in place under the same revision, write time and writer; each changed entry
      // keeps the rev, time and body of its last pinned change. Archiving (a superseded version, or an entry the 1 MiB
      // budget moves into the archive) is history, so it takes a revision after all.
      let inPlace = pinned(record) === pinned(current) && !mutation.history.length;
      if (inPlace) {
        this.restamp(record, current);
        if (bytes(record) > handoffLimits.currentBytes) { inPlace = false; record.revision = current.revision + 1; record.updatedAt = this.now(); record.updatedBy = context.by; }
      }
      if (!inPlace) this.settleCounts(record);
      await this.preserveIdentities(current, record);
      const budget = agentCharacters(record); if (budget.used > budget.max) throw new HandoffError("HANDOFF_TOO_LARGE", "Agent handoff sections exceed 16000 characters.", budget);
      const pointers = await this.normalize(record, mutation.history, inPlace, mutation.evict), history = await this.archivedPointers(taskId, mutation.history);
      await this.options.fault?.("bodies-synced");
      if (!inPlace) record.ops = [...record.ops.filter((id) => id !== operationId), operationId].slice(-50);
      cardHandoffSchema.parse(record); this.identities(record);
      const result = this.result(record, mutation.ackMissing);
      const seen = new Set<string>();
      const lines = history.filter((p) => { const key = `${p.section}:${p.id}:${p.ref}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((p, i) => JSON.stringify({ eventId: `${operationId}:${i}`, ...p }) + "\n").join("");
      const archiveOffset = await stat(path.archive).then((s) => s.size, (e) => { if (e.code === "ENOENT") return 0; throw e; });
      record.archivedCount += lines.split("\n").length - 1;
      if (bytes(record) > handoffLimits.currentBytes) throw new HandoffError("HANDOFF_TOO_LARGE", "Unresolved handoff indexes fill the 1 MiB budget; existing data is preserved.");
      // An in-place write keeps a receipt only for an explicit operation id (a replay must still be recognized); Flowly's
      // own observation passes use fresh ids and would only fill ops/. Then it changes the observation file alone (unless
      // an entry from before bodies existed gets its first), and one atomic replacement needs no unfinished-write record.
      const keep = !inPlace || context.operationId !== undefined;
      if (!keep && !pointers.length) { await this.observe(taskId, stored, record); await this.options.fault?.("observation-synced"); return { result, stored: "observation" }; }
      const intent: Intent = { version: 1, before: current.revision, after: record, archiveOffset, archiveData: lines, pointers, ...(keep ? { receipt: { operationId, digest, result } } : {}), ...(inPlace ? { inPlace: true as const } : {}) };
      await this.atomic(path.intent, JSON.stringify(intent)); await this.options.fault?.("intent-synced");
      await this.recover(taskId);
      return { result, stored: inPlace ? "observation" : "revision" };
    });
  }
  /**
   * An in-place write: the record and every entry it changed keep the revision, time and writer of their last pinned change,
   * and the body of that revision (a reader of this revision pages only bodies it names; the next revision writes the body).
   */
  private restamp(record: CardHandoff, current: CardHandoff) {
    record.revision = current.revision; record.updatedAt = current.updatedAt; record.updatedBy = current.updatedBy;
    for (const section of handoffEntrySections) {
      const before = new Map(list(current, section).map((entry) => [entry.id, entry]));
      for (const entry of list(record, section)) {
        const old = before.get(entry.id); if (!old) continue;
        entry.rev = old.rev; entry.at = old.at; if (old.contentRef) entry.contentRef = old.contentRef; else delete entry.contentRef;
      }
    }
    if (record.state && current.state) { record.state.rev = current.state.rev; record.state.at = current.state.at; }
    // Occurrences counted in place are not in the revision a reader holds: keep the count that revision had.
    for (const gap of record.gaps) {
      const old = current.gaps.find((value) => value.id === gap.id), counted = old && (old.countAtRevision ?? old.count);
      if (gap.count !== undefined && counted !== undefined && gap.count > counted) gap.countAtRevision = counted; else delete gap.countAtRevision;
    }
  }
  /** A new revision holds every occurrence counted so far. */
  private settleCounts(record: CardHandoff) { for (const gap of record.gaps) delete gap.countAtRevision; }
  /**
   * Closing a gap (an ACK's done / obsolete, or an explicit close) settles the occurrences counted at the revision its reader
   * named; ones counted in place since then keep it open, with that count acknowledged (§7.5). Returns the gap and whether it stays open.
   */
  private closeGap(gap: HandoffGap, record: CardHandoff, by: HandoffActor, note: string): [HandoffGap, boolean] {
    const counted = gap.countAtRevision ?? gap.count, later = gap.countAtRevision !== undefined;
    return [{ ...gap, rev: record.revision, at: record.updatedAt, status: later ? "open" : "closed", resolution: { by, at: record.updatedAt, note, ...(counted ? { count: counted } : {}) } }, later];
  }
  /**
   * `archive: false` supersedes an entry without keeping its previous version in archive.jsonl (routine observation state,
   * growing counts). Ledger versions are archived once per transaction, against the version it started from (archiveLedger).
   */
  private replace(change: Mutation, section: HandoffEntrySection, value: HandoffEntry, archive = true) {
    const entries = list(change.record, section), index = entries.findIndex((e) => e.id === value.id);
    if (index >= 0) {
      const previous = entries[index]; if (previous.contentRef && archive && section !== "ledger") change.history.push({ section, entry: previous });
      entries[index] = value;
    } else {
      const overflow = change.record.overflow.findIndex((e) => e.section === section && e.id === value.id);
      if (overflow >= 0) change.record.overflow.splice(overflow, 1);
      entries.push(value);
    }
    change.changed.add(value.id);
  }
  private async source(taskId: string, sourceId: string) { return this.optional<Pointer>(join(this.paths(taskId).folder, "sources", `${hash(sourceId)}.json`)); }
  /** Dispatch reads an immutable original, not a clipped preview or a board event that can age out. */
  async inputText(taskId: string, sourceId: string, maxCharacters = 20000): Promise<string | undefined> {
    const entry = await this.inputRecord(taskId, sourceId);
    if (!entry) return undefined;
    if (entry.characters > maxCharacters) throw new HandoffError("HANDOFF_TOO_LARGE", "This original exceeds the dispatch text budget; it remains available through full handoff reading.");
    let text = entry.text;
    if (text === undefined && entry.textRef) {
      const path = join(this.paths(taskId).folder, "inputs", `${entry.textRef}.txt`);
      if ((await stat(path)).size > maxCharacters * 4) throw new HandoffError("HANDOFF_UNAVAILABLE", "The original text exceeds its declared bound; preserved for inspection.");
      text = await readFile(path, "utf8");
      if (hash(text) !== entry.textRef) throw new HandoffError("HANDOFF_UNAVAILABLE", "The original text failed its checksum; preserved for inspection.");
    }
    if (text === undefined || text.length !== entry.characters || text.length > maxCharacters || (entry.sourceHash && hash(text) !== entry.sourceHash)) throw new HandoffError("HANDOFF_UNAVAILABLE", "The complete original is unavailable or changed; dispatch was refused.");
    return text;
  }
  async inputRecord(taskId: string, sourceId: string): Promise<HandoffInput | null> {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const pointer = await this.source(taskId, sourceId); if (!pointer) return null;
      if (pointer.section !== "inputs") throw new HandoffError("HANDOFF_CONFLICT", "That source belongs to a different handoff entry kind.");
      const parsed = handoffEntrySchemas.inputs.safeParse(await this.object(taskId, pointer.ref));
      if (!parsed.success || parsed.data.sourceId !== sourceId) throw new HandoffError("HANDOFF_UNAVAILABLE", "The original input's identity record is invalid; preserved for inspection.");
      return parsed.data;
    });
  }
  async sessionRecord(taskId: string, agentId: string): Promise<HandoffSession | null> {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const record = await this.current(taskId); if (!record) return null;
      const current = record.ledger.find((session) => session.agentId === agentId), entry = current ?? await this.entry(record, "ledger", `s:${hash(agentId).slice(0, 32)}`);
      if (!entry) return null;
      const parsed = handoffEntrySchemas.ledger.safeParse(entry);
      if (!parsed.success || parsed.data.agentId !== agentId) throw new HandoffError("HANDOFF_UNAVAILABLE", "A managed session's authority record is invalid; preserved for inspection.");
      return parsed.data;
    });
  }
  runningRecord(taskId: string, id: string): Promise<CardHandoff["running"][number] | null> {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const record = await this.current(taskId); if (!record) return null;
      const entry = await this.entry(record, "running", id);
      return entry ? handoffEntrySchemas.running.parse(entry) : null;
    });
  }
  private async mergeInput(change: Mutation, existing: HandoffInput, draft: Record<string, unknown>, context: HandoffContext, sourceId: string, sourceHash: string) {
    const typedUpgrade = existing.atSource === "captured" && draft.atSource === "typed" && !!existing.messageId && existing.messageId === draft.messageId;
    if (existing.sourceHash !== sourceHash) {
      const conflict = hash(`${sourceId}:${existing.sourceHash}:${sourceHash}`);
      await this.append(change, "gaps", { id: `g:${conflict}`, kind: "flowly", text: `Original input source ${hash(sourceId).slice(0, 16)} has different captured and typed bodies. Both are retained; check the original and its archived variants before relying on the disputed wording.`, status: "open" }, { by: { kind: "flowly" }, sourceId: `input-conflict:${conflict}` });
      if (!typedUpgrade) await this.append(change, "inputs", { ...draft, id: `d:${conflict}`, status: draft.status === "received" ? "received" : "open" }, { ...context, sourceId: `input-variant:${conflict}`, unconfirmed: false });
    }
    const status = existing.status === "open" && draft.status === "received" ? "received" : existing.status;
    if (typedUpgrade) {
      const next = handoffEntrySchemas.inputs.parse({ ...existing, ...draft, id: existing.id, rev: change.record.revision, at: draft.at ?? existing.at, by: context.by, sourceId, sourceHash, status });
      if (typeof draft.text === "string") { delete next.textRef; delete next.firstLine; }
      this.replace(change, "inputs", next); return next;
    }
    // Codex's copy of a message, captured before the turn-end timeline delivered it, learns Paseo's message id once.
    const link = !existing.messageId && typeof draft.messageId === "string" && !!existing.sourceId?.startsWith("provider-user:");
    if (status !== existing.status || link) { const next = { ...existing, status, ...(link ? { messageId: draft.messageId as string } : {}), rev: change.record.revision }; this.replace(change, "inputs", next); return next; }
    return existing;
  }
  private async append(change: Mutation, section: HandoffEntrySection, draft: Record<string, unknown>, context: HandoffContext) {
    const { record } = change, sourceId = context.sourceId ?? draft.sourceId as string | undefined;
    const sourceHash = section === "inputs" ? (typeof draft.text === "string" ? hash(draft.text) : typeof draft.textRef === "string" ? draft.textRef : hash("")) : hash(JSON.stringify(draft));
    if (sourceId) {
      const pointer = await this.source(record.taskId, sourceId);
      const existing = handoffEntrySections.flatMap((s) => list(record, s)).find((e) => e.sourceId === sourceId) ?? (pointer ? await this.object(record.taskId, pointer.ref) : undefined);
      if (existing) {
        if (section === "inputs") return this.mergeInput(change, existing as HandoffInput, draft, context, sourceId, sourceHash);
        // Flowly's notes are copies of one notice read on several paths (SESSION-HANDOFF-SPEC §5.7): another copy (another
        // time, or rebuilt from a timeline row) is no conflict and keeps the note, except that the notice's own text
        // replaces a note rebuilt from row metadata, also one already archived. A conflict here refused the whole capture.
        if (section === "notes" && context.by.kind === "flowly" && existing.sourceHash !== sourceHash) {
          if (!(existing as HandoffNote).metadataOnly || draft.metadataOnly) return existing;
          const { metadataOnly: _rebuilt, contentRef: _ref, ...kept } = existing as HandoffNote;
          const upgraded = handoffEntrySchemas.notes.parse({ ...kept, kind: draft.kind, text: draft.text, rev: record.revision, by: context.by, sourceId, sourceHash });
          this.replace(change, "notes", upgraded, false); return upgraded;
        }
        if (existing.sourceHash && existing.sourceHash !== sourceHash) throw new HandoffError("HANDOFF_CONFLICT", "The source id already refers to different original content.", { sourceId });
        return existing;
      }
    }
    const entryId = typeof draft.id === "string" ? draft.id : `${prefix[section]}:${sourceId ? hash(sourceId).slice(0, 32) : randomUUID()}`;
    const previous = await this.entry(record, section, entryId);
    if (previous) throw new HandoffError("HANDOFF_CONFLICT", "That handoff entry id is already present.", { id: entryId });
    const entry = handoffEntrySchemas[section].parse({ ...draft, id: entryId, rev: record.revision, at: draft.at ?? record.updatedAt, by: context.by, ...(sourceId ? { sourceId, sourceHash } : {}), ...(context.operationId ? { operationId: context.operationId } : {}), ...(context.unconfirmed ? { unconfirmed: true } : {}) }) as HandoffEntry;
    this.replace(change, section, entry); return entry;
  }
  /** Grouped capture gaps keep one identity: the count only grows, times widen, and a closed gap reopens once it grows past the acknowledged count. */
  private async mergeGap(change: Mutation, draft: HandoffCaptureGap, context: HandoffContext) {
    const old = await this.entry(change.record, "gaps", draft.id) as HandoffGap | null;
    if (!old) { await this.append(change, "gaps", { ...draft, kind: "flowly", status: "open" }, { ...context, sourceId: draft.sourceId }); return; }
    if (old.sourceId !== draft.sourceId) throw new HandoffError("HANDOFF_CONFLICT", "A grouped capture gap id belongs to a different source.", { id: draft.id });
    const count = Math.max(old.count ?? 1, draft.count);
    const firstAt = [old.firstAt, draft.firstAt].filter((at): at is string => !!at).sort()[0], lastAt = [old.lastAt, draft.lastAt].filter((at): at is string => !!at).sort().at(-1);
    if (count === (old.count ?? 1) && firstAt === old.firstAt && lastAt === old.lastAt) return;
    const reopen = old.status === "closed" && count > (old.resolution?.count ?? old.count ?? 1);
    const { rev: _rev, contentRef: _ref, ...kept } = old;
    // Count and time growth of the same open gap is not history worth a full-read item; a reopen is.
    this.replace(change, "gaps", handoffEntrySchemas.gaps.parse({ ...kept, rev: change.record.revision, count, ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}), ...(reopen ? { status: "open", at: change.record.updatedAt } : {}) }), reopen);
  }
  private input(draft: HandoffInputDraft) { return { status: "open", atSource: "typed", ...draft, characters: draft.characters ?? draft.text?.length ?? 0 }; }
  private review(draft: HandoffReviewDraft) {
    const identity = draft.id ?? draft.sourceId ?? `${draft.reviewerId}:${draft.cycle}:${draft.round}`;
    return { risks: [], gaps: [], ...draft, findings: draft.findings.map((finding, index) => typeof finding === "string" ? { id: `f:${hash(`${identity}:${index}`).slice(0, 32)}`, text: finding, status: "open" } : finding) };
  }
  appendInput(taskId: string, projectId: string, draft: HandoffInputDraft, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "input", draft, sourceId: context.sourceId }, context, (change) => this.append(change, "inputs", this.input(draft), context).then(() => undefined)); }
  appendQuestion(taskId: string, projectId: string, draft: HandoffQuestionDraft, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "question", draft, sourceId: context.sourceId }, context, (change) => this.append(change, "questions", { status: "open", ...draft }, context).then(() => undefined)); }
  appendReview(taskId: string, projectId: string, draft: HandoffReviewDraft, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "review", draft, sourceId: context.sourceId }, context, (change) => this.append(change, "reviews", this.review(draft), context).then(() => undefined)); }
  appendNote(taskId: string, projectId: string, draft: Draft<HandoffNote>, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "note", draft, sourceId: context.sourceId }, context, (change) => this.append(change, "notes", draft, context).then(() => undefined)); }
  appendGap(taskId: string, projectId: string, draft: Draft<HandoffGap>, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "gap", draft, sourceId: context.sourceId }, context, (change) => this.append(change, "gaps", draft, context).then(() => undefined)); }
  private async session(change: Mutation, draft: Draft<HandoffSession>, context: HandoffContext) {
    const record = change.record, id = draft.id ?? `s:${hash(draft.agentId).slice(0, 32)}`;
    const old = await this.entry(record, "ledger", id) as HandoffSession | null;
    this.replace(change, "ledger", handoffEntrySchemas.ledger.parse({ ...(old ?? {}), ...draft, id, rev: record.revision, at: record.updatedAt, by: context.by }));
  }
  /**
   * The previous version of a changed ledger entry is archived when its history other than turns changed (role, end,
   * background, ACK), or when a turn that no archived version holds yet leaves the 10-turn window. An archived version is
   * history only: the turns no earlier archived version holds, and none of the observation state that is superseded in
   * place (cursor, measurements, narration preview, coverage text, calls in flight). The full read then returns each
   * finished turn once in the archive instead of a full copy of the window and its preview at every turn end (about one
   * page per 3-4 turns, one final up to 15 times).
   */
  private async archiveLedger(change: Mutation, current: CardHandoff) {
    const besides = (session: HandoffSession) => ({ ...ledgerHistory(session), turns: [] });
    for (const entry of change.record.ledger) {
      if (!change.changed.has(entry.id)) continue;
      const before = current.ledger.find((value) => value.id === entry.id);
      if (!before) continue; // new here, or back from the overflow index: its earlier versions are archived already
      const archived = before.turnsArchived ?? 0;
      const evicted = before.turns.some((turn) => turn.n > archived && !entry.turns.some((kept) => kept.n === turn.n));
      if (!evicted && isDeepStrictEqual(besides(before), besides(entry))) { if (before.turnsArchived === undefined) delete entry.turnsArchived; else entry.turnsArchived = before.turnsArchived; continue; }
      const turns = before.turns.filter((turn) => turn.n > archived), highest = Math.max(archived, ...before.turns.map((turn) => turn.n));
      if (highest) entry.turnsArchived = highest; else delete entry.turnsArchived;
      if (!before.contentRef) continue;
      const { contentRef: _ref, through: _through, capturedThrough: _captured, measured: _measured, growth: _growth, live: _live, skeleton: _skeleton, scriptCalls: _scripts, ...kept } = before;
      const plain = { ...kept, turns, background: historyBackground(before) }, body = JSON.stringify(plain), ref = hash(body);
      await this.immutable(join(this.paths(current.taskId).folder, "entries", `${ref}.json`), body);
      change.history.push(this.pointer("ledger", { ...plain, contentRef: ref } as HandoffEntry));
    }
  }
  setSession(taskId: string, projectId: string, draft: Draft<HandoffSession>, context: HandoffContext) { return this.transaction(taskId, projectId, { action: "session", draft }, context, (change) => this.session(change, draft, context)); }
  /** `stored`: whether anything was written, and whether it took a new revision (observation state is written in place). */
  capture(taskId: string, projectId: string, capture: HandoffCapture, context: HandoffContext): Promise<HandoffWriteResult & { stored: HandoffStored }> {
    return this.write(taskId, projectId, { action: "capture", capture }, context, async (change) => {
      for (const { section, value } of capture.entries ?? []) await this.append(change, section, value, { ...context, sourceId: typeof value.sourceId === "string" ? value.sourceId : undefined });
      for (const gap of capture.gaps ?? []) await this.mergeGap(change, gap, context);
      if (capture.session) await this.session(change, capture.session, context);
      if (capture.cursor) {
        const entry = await this.entry(change.record, "ledger", `s:${hash(capture.cursor.agentId).slice(0, 32)}`) as HandoffSession | null;
        if (!entry) throw new HandoffError("HANDOFF_CONFLICT", "Register the managed session before capturing its cursor.");
        if (entry.through && entry.through.identity === capture.cursor.through.identity && entry.through.offset > capture.cursor.through.offset) throw new HandoffError("HANDOFF_CONFLICT", "Capture cursor cannot move backwards for the same file.");
        this.replace(change, "ledger", { ...entry, rev: change.record.revision, at: change.record.updatedAt, through: capture.cursor.through, capturedThrough: capture.cursor.capturedThrough ?? Date.parse(capture.cursor.through.at) }, false);
      }
      if (capture.git) change.record.git = capture.git;
      if (capture.lastWords) change.record.lastWords = capture.lastWords;
      if (capture.checkpoint) change.record.checkpoint = capture.checkpoint;
      for (const id of capture.forgetSeen ?? []) delete change.record.seen[id];
    }).then(({ result, stored }) => ({ ...result, stored }));
  }
  confirmSource(taskId: string, projectId: string, sourceId: string, context: HandoffContext) {
    return this.transaction(taskId, projectId, { action: "confirm", sourceId }, context, async (change) => {
      const pointer = await this.source(taskId, sourceId);
      if (!pointer) throw new HandoffError("HANDOFF_CONFLICT", "The source has not been durably captured yet.", { sourceId });
      const current = await this.entry(change.record, pointer.section, pointer.id) ?? await this.object(taskId, pointer.ref);
      const confirmed = { ...current, rev: change.record.revision, at: change.record.updatedAt }; delete confirmed.unconfirmed;
      this.replace(change, pointer.section, confirmed);
      change.record.pendingOperations = change.record.pendingOperations.filter((o) => o.sourceId !== sourceId);
    });
  }
  private conflict(record: CardHandoff, revision: number, entry: { id: string; rev: number } | null) {
    if (revision > record.revision - 1 || (entry && entry.rev > revision)) throw new HandoffError("HANDOFF_CONFLICT", "The handoff entry changed after the revision you read. Read it again before updating.", { id: entry?.id, handoffRevision: record.revision - 1, entryRevision: entry?.rev });
  }
  /**
   * `git`: the repositories as Flowly read them for this write. They are stored in the same revision, so Flowly's own refresh
   * never moves the revision an ACK names (an idle card's Git is read only at turn ends, rotations and handoff writes).
   */
  update(taskId: string, projectId: string, input: HandoffUpdate, context: HandoffContext, options: { agentId?: string; actualHeads?: HandoffAck["heads"]; dirtyHash?: string; turnStartedAt?: string; git?: CardHandoff["git"] } = {}) {
    const update = handoffUpdateSchema.parse(input), ctx = { ...context, operationId: update.operationId ?? context.operationId };
    return this.transaction(taskId, projectId, { action: "update", update, agentId: options.agentId }, ctx, async (change) => {
      const record = change.record, revision = update.handoffRevision;
      if (options.git) record.git = options.git;
      if (revision > record.revision - 1) this.conflict(record, revision, null);
      if (update.state !== undefined) {
        this.conflict(record, revision, record.state ?? null);
        record.state = { id: "state", rev: record.revision, at: record.updatedAt, by: context.by, text: update.state };
      }
      for (const { section, id: requested, ...fields } of update.set ?? []) {
        const id = requested ?? `${prefix[section]}:${randomUUID()}`, old = await this.entry(record, section, id);
        this.conflict(record, revision, old);
        if (record.tombstones.some((t) => t.item === id)) throw new HandoffError("HANDOFF_CONFLICT", "A removed entry cannot be silently recreated; add a new entry with a new id.", { id });
        const entry = handoffEntrySchemas[section].parse({ ...fields, id, rev: record.revision, at: record.updatedAt, by: context.by }) as HandoffEntry;
        this.replace(change, section, entry);
      }
      for (const remove of update.remove ?? []) {
        const old = await this.entry(record, remove.section, remove.id); this.conflict(record, revision, old);
        if (!old) throw new HandoffError("HANDOFF_CONFLICT", "The entry to remove no longer exists.", { id: remove.id });
        if (old.contentRef) change.history.push({ section: remove.section, entry: old, removal: { reason: remove.reason, by: context.by, at: record.updatedAt, rev: record.revision } });
        const entries = list(record, remove.section), index = entries.findIndex((e) => e.id === remove.id); if (index >= 0) entries.splice(index, 1);
        record.tombstones.push({ section: remove.section, item: remove.id, removedBy: context.by, reason: remove.reason, at: record.updatedAt, rev: record.revision });
      }
      if (update.order) {
        if (record.next.some((e) => e.rev > revision) || update.order.next.length !== record.next.length || new Set(update.order.next).size !== record.next.length || update.order.next.some((id) => !record.next.some((e) => e.id === id))) throw new HandoffError("HANDOFF_CONFLICT", "Next-step order changed; supply the complete current id list.");
        record.next = update.order.next.map((id) => ({ ...record.next.find((e) => e.id === id)!, rev: record.revision }));
      }
      if (update.note) await this.append(change, "notes", update.note, context);
      for (const disposition of update.inputs ?? []) {
        const old = await this.entry(record, "inputs", disposition.id) as HandoffInput | null; this.conflict(record, revision, old);
        if (!old) throw new HandoffError("HANDOFF_CONFLICT", "That original input is unavailable.", { id: disposition.id });
        const next = { ...old, status: disposition.status ?? old.status, rev: record.revision, at: record.updatedAt, handled: { by: context.by, at: record.updatedAt, ...(disposition.note ? { note: disposition.note } : {}) } };
        if (disposition.standing === true) next.standing = { by: context.by, at: record.updatedAt }; if (disposition.standing === false) delete next.standing;
        this.replace(change, "inputs", next);
      }
      for (const answer of update.questions ?? []) {
        const old = await this.entry(record, "questions", answer.id) as HandoffQuestion | null; this.conflict(record, revision, old);
        if (!old) throw new HandoffError("HANDOFF_CONFLICT", "That question is unavailable.", { id: answer.id });
        const answers = answer.answerInputIds ?? [];
        if (answer.status === "answered" && !answers.length) throw new HandoffError("HANDOFF_CONFLICT", "An answered question must identify at least one saved original answer input.");
        for (const id of answers) {
          const original = await this.entry(record, "inputs", id) as HandoffInput | null;
          if (!original || original.unconfirmed) throw new HandoffError("HANDOFF_CONFLICT", "Question answers must refer to confirmed original inputs.", { id });
          this.replace(change, "inputs", { ...original, rev: record.revision, at: record.updatedAt, answers: [...new Set([...(original.answers ?? []), old.id])] });
        }
        this.replace(change, "questions", { ...old, rev: record.revision, at: record.updatedAt, status: answer.status, answeredBy: answers, ...(answer.note ? { note: answer.note } : {}) });
      }
      for (const disposition of update.gaps ?? []) {
        if (!("id" in disposition)) {
          await this.append(change, "gaps", { kind: "successor", agentId: context.by.agentId, text: disposition.text, status: "open" }, context);
          continue;
        }
        const old = await this.entry(record, "gaps", disposition.id) as HandoffGap | null; this.conflict(record, revision, old);
        if (!old) throw new HandoffError("HANDOFF_CONFLICT", "That information gap is unavailable.", { id: disposition.id });
        this.replace(change, "gaps", disposition.status === "closed" ? this.closeGap(old, record, context.by, disposition.note)[0] : { ...old, rev: record.revision, at: record.updatedAt, status: disposition.status, resolution: { by: context.by, at: record.updatedAt, note: disposition.note } });
      }
      if (context.by.kind === "agent" && (update.state !== undefined || update.set?.length || update.remove?.length || update.order)) {
        record.checkpoint = { agentId: context.by.agentId ?? options.agentId ?? "unknown", at: record.updatedAt, ...(options.actualHeads ? { heads: options.actualHeads.map(({ repo, sha }) => ({ repo, sha })) } : {}), ...(options.dirtyHash ? { dirtyHash: options.dirtyHash } : {}), ...(options.turnStartedAt ? { turnStartedAt: options.turnStartedAt } : {}) };
      }
      if (update.ack) {
        const ack = update.ack;
        if (ack.handoffRevision !== revision || revision !== record.revision - 1 || !options.actualHeads) throw new HandoffError("ACK_MISMATCH", "ACK requires the exact current handoff revision and independently observed repository heads.");
        const actual = options.actualHeads, proposed = ack.heads;
        if (actual.filter((head) => head.sha !== null).some((head) => !proposed.some((p) => p.repo === head.repo && p.sha === head.sha && p.dirty === head.dirty))) throw new HandoffError("ACK_MISMATCH", "Repository heads changed; reread the handoff and acknowledge the observed heads.");
        if (new Set(ack.items.map((item) => item.id)).size !== ack.items.length || ack.items.some((item) => ["done", "obsolete"].includes(item.disposition) && !item.note?.trim())) throw new HandoffError("ACK_MISMATCH", "Done or obsolete ACK dispositions need a reason; each pending id must occur once.");
        const required = handoffOpenIds(record);
        const agentId = options.agentId ?? context.by.agentId, session = record.ledger.find((s) => s.agentId === agentId);
        if (!session) throw new HandoffError("ACK_MISMATCH", "ACK must belong to a registered managed session.");
        const prior = session.ack, observed = actual.filter((head) => head.sha !== null), priorHeads = prior?.heads.filter((head) => head.sha !== null) ?? [];
        const continuation = prior?.recordRevision === record.revision - 1 && observed.length === priorHeads.length && observed.every((head) => priorHeads.some((p) => p.repo === head.repo && p.sha === head.sha && p.dirty === head.dirty));
        let items = [...new Map([...(continuation ? prior!.items : []), ...ack.items].map((item) => [item.id, item])).values()].filter((item) => required.includes(item.id));
        // Acknowledging a gap as done/obsolete settles every occurrence counted at the revision acknowledged (§7.5): ones counted
        // in place after it keep the gap open and its id pending; later growth past the settled count reopens a closed gap.
        // A background entry acknowledged done/obsolete (verified ended or irrelevant, with a note) is closed for every later reader.
        const unread = new Set<string>();
        for (const item of ack.items) {
          if (!["done", "obsolete"].includes(item.disposition) || !required.includes(item.id)) continue;
          const gap = await this.entry(record, "gaps", item.id) as HandoffGap | null;
          if (gap?.status === "open") { const [settled, later] = this.closeGap(gap, record, context.by, item.note!); this.replace(change, "gaps", settled); if (later) unread.add(item.id); continue; }
          const holder = record.ledger.find((entry) => entry.background.some((b) => b.id === item.id && b.status !== "closed"))
            ?? await (async () => { const index = record.overflow.find((entry) => entry.section === "ledger" && entry.openIds.includes(item.id)); return index ? await this.object(record.taskId, index.contentRef) as HandoffSession : undefined; })();
          if (holder) this.replace(change, "ledger", handoffEntrySchemas.ledger.parse({ ...holder, rev: record.revision, at: record.updatedAt, background: holder.background.map((b) => b.id === item.id ? { ...b, status: "closed", outcome: `settled by ACK (${item.disposition}): ${item.note!}`.slice(0, 120) } : b) }));
        }
        items = items.filter((item) => !unread.has(item.id));
        change.ackMissing = required.filter((id) => !items.some((item) => item.id === id));
        const acknowledging = record.ledger.find((s) => s.agentId === agentId)!;
        this.replace(change, "ledger", { ...acknowledging, rev: record.revision, at: record.updatedAt, ack: { ...ack, items, at: record.updatedAt, recordRevision: record.revision, complete: !change.ackMissing.length }, understanding: ack.understanding });
      }
    });
  }
  markSeen(taskId: string, projectId: string, agentId: string, revision: number, _context: HandoffContext) {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const stored = await this.stored(taskId, projectId), record = clone(stored?.record ?? emptyHandoff(taskId, projectId));
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > record.revision) throw new HandoffError("HANDOFF_CONFLICT", "Cannot mark an unseen future handoff revision as read.");
      if ((record.seen[agentId] ?? -1) >= revision) return this.result(record);
      record.seen[agentId] = revision;
      const ids = Object.keys(record.seen); for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete record.seen[id];
      while (bytes(record) > handoffLimits.currentBytes && Object.keys(record.seen).length) delete record.seen[Object.keys(record.seen)[0]];
      // This is a read cache, not a semantic update: changing revision here makes every subsequent read look new. It is
      // observation state, written in place.
      await this.observe(taskId, stored, record); return this.result(record);
    });
  }
  async openIds(taskId: string) { const record = await this.read(taskId); return record ? handoffOpenIds(record) : []; }
  private encodeCursor(cursor: PageCursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
  private decodeCursor(taskId: string, encoded: string): PageCursor {
    try {
      if (encoded.length > 4096) throw new Error();
      const c = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PageCursor;
      if (c.taskId !== taskId || !Number.isSafeInteger(c.revision) || c.revision < 0 || !["current", "archive", "all"].includes(c.scope) || ![c.index, c.offset, c.openIndex].every((n) => Number.isSafeInteger(n) && n >= 0) || [c.archived, c.superseded].some((n) => n !== undefined && !(Number.isSafeInteger(n) && n >= 0)) || (c.body && (!/^[a-f0-9]{64}$/.test(c.body.ref) || !["json", "text"].includes(c.body.kind) || !Number.isSafeInteger(c.body.offset) || c.body.offset < 0 || (c.body.textRef && !/^[a-f0-9]{64}$/.test(c.body.textRef)) || !handoffEntrySections.includes(c.body.section) || !["current", "archive"].includes(c.body.origin) || typeof c.body.id !== "string" || (c.body.identity !== undefined && typeof c.body.identity !== "string")))) throw new Error();
      return c;
    } catch { throw new HandoffError("HANDOFF_CONFLICT", "Invalid handoff page cursor; start from the current card view."); }
  }
  private async archivePointer(taskId: string, offset: number): Promise<{ pointer: Pointer; next: number } | null> {
    let file; try { file = await open(this.paths(taskId).archive, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const buffer = Buffer.alloc(4096), { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) return null;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end < 0) throw new HandoffError("HANDOFF_UNAVAILABLE", "An archive pointer is incomplete or too large; its file is preserved.");
      let pointer: Pointer; try { pointer = JSON.parse(buffer.subarray(0, end).toString("utf8")) as Pointer; } catch { throw new HandoffError("HANDOFF_UNAVAILABLE", "The handoff archive is malformed; preserved for inspection."); }
      if (!handoffEntrySections.includes(pointer.section) || !/^[a-f0-9]{64}$/.test(pointer.ref) || typeof pointer.id !== "string") throw new HandoffError("HANDOFF_UNAVAILABLE", "An archive pointer is invalid; its file is preserved.");
      return { pointer, next: offset + end + 1 };
    } finally { await file.close(); }
  }
  private async bodyChunk(taskId: string, body: NonNullable<PageCursor["body"]>) {
    const path = join(this.paths(taskId).folder, body.kind === "text" ? "inputs" : "entries", `${body.ref}.${body.kind === "text" ? "txt" : "json"}`);
    let file; try { file = await open(path, "r"); } catch { throw new HandoffError("HANDOFF_UNAVAILABLE", "The referenced handoff body is missing; its index is preserved."); }
    try {
      const stamp = (info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const info = await file.stat(), identity = stamp(info), cacheKey = `${taskId}:${body.kind}:${body.ref}`;
      if (body.identity && body.identity !== identity) throw new HandoffError("HANDOFF_UNAVAILABLE", "The original handoff body changed between pages; its files are preserved.");
      if (this.verifiedBodies.get(cacheKey) !== identity) {
        const checksum = createHash("sha256"), chunk = Buffer.alloc(65536); let position = 0;
        for (;;) { const { bytesRead } = await file.read(chunk, 0, chunk.length, position); if (!bytesRead) break; checksum.update(chunk.subarray(0, bytesRead)); position += bytesRead; }
        if (checksum.digest("hex") !== body.ref || stamp(await file.stat()) !== identity) throw new HandoffError("HANDOFF_UNAVAILABLE", "The original handoff body failed its checksum; preserved for inspection.");
        this.verifiedBodies.set(cacheKey, identity); if (this.verifiedBodies.size > 32) this.verifiedBodies.delete(this.verifiedBodies.keys().next().value!);
      }
      body.identity = identity;
      const size = info.size, buffer = Buffer.alloc(8196); let bytesRead = 0;
      while (bytesRead < buffer.length) { const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, body.offset + bytesRead); if (!result.bytesRead) break; bytesRead += result.bytesRead; }
      let end = Math.min(8192, bytesRead);
      if (body.offset + end < size) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      const text = buffer.subarray(0, end).toString("utf8"), next = body.offset + end;
      return { text, next, complete: next >= size };
    } finally { await file.close(); }
  }
  /**
   * Scans the archive once (then only what was appended): an archived ledger version whose history (ledgerHistory) equals
   * the next archived version's is a Flowly observation snapshot. 786d9cd archived one on every poll; the next version holds
   * the same history, so the required full read need not page through them. Their bodies stay on disk and by id.
   */
  private async runs(taskId: string): Promise<LedgerRuns | undefined> {
    const path = this.paths(taskId).archive;
    const info = await stat(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!info) return undefined;
    let runs = this.ledgerRuns.get(taskId);
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (!runs || runs.identity !== identity || info.size < runs.scanned) { runs = { identity, scanned: 0, last: new Map(), superseded: new Set() }; this.ledgerRuns.set(taskId, runs); }
    if (this.ledgerRuns.size > 16) this.ledgerRuns.delete(this.ledgerRuns.keys().next().value!);
    if (runs.scanned >= info.size) return runs;
    const file = await open(path, "r");
    try {
      const chunk = Buffer.alloc(65536); let position = runs.scanned, rest = Buffer.alloc(0);
      while (position < info.size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
        if (!bytesRead) break;
        const data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]), base = position - rest.length; let start = 0;
        position += bytesRead;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
          const offset = base + start, line = data.subarray(start, end).toString("utf8"); start = end + 1;
          let pointer: Pointer; try { pointer = JSON.parse(line) as Pointer; } catch { runs.scanned = offset; return runs; } // page() reports a malformed pointer itself
          if (pointer.section !== "ledger" || pointer.removal || !/^[a-f0-9]{64}$/.test(pointer.ref) || typeof pointer.id !== "string") continue;
          // An unreadable body is never superseded: page() reaches it and reports it.
          const history = await this.object(taskId, pointer.ref).then((body) => historyHash(body as HandoffSession), () => `unreadable:${offset}`), previous = runs.last.get(pointer.id);
          if (previous?.history === history) runs.superseded.add(previous.offset);
          runs.last.set(pointer.id, { offset, history });
        }
        rest = data.subarray(start);
      }
      runs.scanned = position - rest.length;
    } finally { await file.close(); }
    return runs;
  }
  /** The newest archived version of an entry is superseded when the current version (in the record or its overflow index) has the same history. */
  private async superseded(record: CardHandoff, pointer: Pointer, offset: number) {
    if (pointer.section !== "ledger" || pointer.removal) return false;
    const runs = await this.runs(record.taskId);
    if (!runs) return false;
    if (runs.superseded.has(offset)) return true;
    if (runs.last.get(pointer.id)?.offset !== offset) return false;
    const overflow = record.overflow.find((entry) => entry.section === "ledger" && entry.id === pointer.id);
    const current = record.ledger.find((entry) => entry.id === pointer.id) ?? (overflow ? await this.object(record.taskId, overflow.contentRef) as HandoffSession : undefined);
    return !!current && historyHash(current) === runs.last.get(pointer.id)!.history;
  }
  /** Each response is <=96 KiB. Full external input text is requested with entryId and continued by cursor. */
  page(taskId: string, options: { cursor?: string; entryId?: string; scope?: "current" | "archive" | "all" } = {}): Promise<HandoffPage> {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const record = await this.current(taskId);
      const c: PageCursor = options.cursor ? this.decodeCursor(taskId, options.cursor) : { taskId, revision: record?.revision ?? 0, scope: options.scope ?? "current", index: 0, offset: 0, openIndex: 0, ...(options.entryId ? { entryId: options.entryId } : {}) };
      if (!record) return { taskId, revision: 0, items: [], openIds: [], openIdsTotal: 0, total: 0, omitted: 0, complete: true, ...(c.revision !== 0 ? { viewChanged: true } : {}) };
      if (c.revision !== record.revision) return { taskId, revision: record.revision, items: [], openIds: [], openIdsTotal: handoffOpenIds(record).length, total: 0, omitted: 0, complete: false, viewChanged: true };
      const allOpen = handoffOpenIds(record), current = handoffEntrySections.flatMap((section) => list(record, section).map((entry) => ({ section, entry }))), overflow = record.overflow;
      const selected = c.entryId ? current.find(({ entry }) => entry.id === c.entryId) : undefined;
      const total = c.entryId ? 1 : (c.scope === "archive" ? 0 : current.length + overflow.length) + (c.scope === "current" ? 0 : record.archivedCount);
      const page: HandoffPage = { taskId, revision: record.revision, items: [], openIds: [], openIdsTotal: allOpen.length, total, omitted: total, complete: false };
      while (c.openIndex < allOpen.length && bytes(page.openIds) + bytes(allOpen[c.openIndex]) < 24000) page.openIds.push(allOpen[c.openIndex++]);
      if (c.openIndex < allOpen.length) { page.nextCursor = this.encodeCursor(c); return page; }
      if (c.body) {
        const chunk = await this.bodyChunk(taskId, c.body);
        page.items.push({ section: c.body.section, id: c.body.id, origin: c.body.origin, text: chunk.text, field: c.body.kind, offset: c.body.offset, complete: chunk.complete });
        if (!chunk.complete) c.body.offset = chunk.next; else if (c.body.kind === "json" && c.body.textRef) c.body = { ...c.body, ref: c.body.textRef, kind: "text", offset: 0, textRef: undefined, identity: undefined }; else { delete c.body; if (c.entryId) c.finished = true; }
      } else if (c.entryId) {
        let entry = selected?.entry, section = selected?.section;
        if (!entry) {
          const pointer = overflow.find((e) => e.id === c.entryId) ?? await this.optional<Pointer>(join(this.paths(taskId).folder, "latest", `${hash(c.entryId)}.json`));
          if (pointer) { section = pointer.section; entry = await this.object(taskId, "contentRef" in pointer ? pointer.contentRef : pointer.ref); }
        }
        if (!entry || !section) throw new HandoffError("HANDOFF_CONFLICT", "That handoff entry is unavailable.");
        await this.pageItem(taskId, page, c, section, entry, selected ? "current" : "archive");
        if (!c.body && section === "inputs" && (entry as HandoffInput).textRef) c.body = { ref: (entry as HandoffInput).textRef!, kind: "text", section, id: entry.id, origin: selected ? "current" : "archive", offset: 0 };
        if (!c.body) c.finished = true;
      } else {
        const entries = [...current, ...overflow.map((e) => ({ section: e.section, entry: e }))];
        if (c.scope === "archive") c.index = entries.length;
        while (c.index < entries.length) {
          const selected = entries[c.index], entry = "openIds" in selected.entry ? await this.object(taskId, selected.entry.contentRef) : selected.entry;
          if (page.items.length && bytes(page) + bytes(entry) > 70000) break;
          c.index++; await this.pageItem(taskId, page, c, selected.section, entry, current.some((i) => i.entry.id === entry.id) ? "current" : "archive");
          if (c.body) break;
        }
        if (c.index >= entries.length && c.scope !== "current" && !c.body) {
          for (;;) {
            const next = await this.archivePointer(taskId, c.offset); if (!next) { c.finished = true; break; }
            if (await this.superseded(record, next.pointer, c.offset)) { c.offset = next.next; c.archived = (c.archived ?? 0) + 1; c.superseded = (c.superseded ?? 0) + 1; continue; }
            const original = await this.object(taskId, next.pointer.ref), entry = next.pointer.removal ? { ...original, removal: next.pointer.removal } : original;
            if (page.items.length && bytes(page) + bytes(entry) > 70000) break;
            c.offset = next.next; c.archived = (c.archived ?? 0) + 1;
            await this.pageItem(taskId, page, c, next.pointer.section, entry, "archive"); if (c.body) break;
          }
        } else if (c.index >= entries.length && c.scope === "current" && !c.body) c.finished = true;
      }
      page.omitted = c.entryId ? c.finished ? 0 : 1 : Math.max(0, total - (c.scope === "archive" ? 0 : c.index) - (c.archived ?? 0));
      if (c.superseded) page.supersededSnapshots = c.superseded;
      page.complete = Boolean(c.finished) && c.openIndex === allOpen.length && !c.body;
      if (!page.complete) page.nextCursor = this.encodeCursor(c);
      if (bytes(page) > handoffLimits.pageBytes) throw new HandoffError("HANDOFF_TOO_LARGE", "A handoff page exceeds its 96 KiB transport budget.");
      return page;
    });
  }
  private async pageItem(taskId: string, page: HandoffPage, cursor: PageCursor, section: HandoffEntrySection, entry: HandoffEntry, origin: "current" | "archive") {
    const textRef = section === "inputs" ? (entry as HandoffInput).textRef : undefined;
    if (bytes(page) + bytes(entry) < 70000) {
      page.items.push({ section, id: entry.id, origin, value: entry, complete: true });
      if (textRef) cursor.body = { ref: textRef, kind: "text", section, id: entry.id, origin, offset: 0 };
    } else {
      cursor.body = { ref: entry.contentRef!, kind: "json", section, id: entry.id, origin, offset: 0, ...(textRef ? { textRef } : {}) };
      const chunk = await this.bodyChunk(taskId, cursor.body);
      page.items.push({ section, id: entry.id, origin, field: "json", text: chunk.text, offset: 0, complete: chunk.complete });
      if (chunk.complete) delete cursor.body; else cursor.body.offset = chunk.next;
    }
  }
  seal(taskId: string, rotationId: string, projectId?: string) {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const record = await this.current(taskId, projectId); if (!record) throw new HandoffError("HANDOFF_UNAVAILABLE", "No handoff exists for this card.");
      const file = join(this.paths(taskId).folder, "sealed", `${hash(rotationId)}.json`), prior = await this.optional<CardHandoff>(file);
      if (prior) {
        const parsed = cardHandoffSchema.safeParse(prior); if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.projectId !== record.projectId) throw new HandoffError("HANDOFF_UNAVAILABLE", "The sealed handoff is invalid; it has been preserved.");
        return { handoffId: rotationId, revision: parsed.data.revision, record: parsed.data, replayed: true };
      }
      await this.atomic(file, JSON.stringify(record)); return { handoffId: rotationId, revision: record.revision, record, replayed: false };
    });
  }
  /** Directory exports stream via fs; they never assemble long history or original inputs in memory. */
  exportCard(taskId: string, destination: string) {
    return this.serial(taskId, async () => {
      await this.recover(taskId); const record = await this.current(taskId); if (!record) return { exists: false as const };
      const previous = await this.optional<{ version: number; taskId: string; projectId: string; revision: number }>(join(destination, "complete.json"));
      if (previous) {
        if (previous.version !== 1 || previous.taskId !== taskId || previous.projectId !== record.projectId || previous.revision !== record.revision) throw new HandoffError("HANDOFF_CONFLICT", "The backup destination already holds a different card revision.");
        return { exists: true as const, taskId, projectId: record.projectId, revision: record.revision };
      }
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await mkdir(this.paths(taskId).folder, { recursive: true, mode: 0o700 });
      // current.json holds the record with its observation state; the observation file names this card file's bytes only.
      const observation = this.paths(taskId).observation;
      await cp(this.paths(taskId).folder, join(destination, "data"), { recursive: true, force: true, filter: (source) => source !== observation });
      await this.syncTree(join(destination, "data"));
      await this.atomic(join(destination, "current.json"), JSON.stringify(record)); await this.atomic(join(destination, "complete.json"), JSON.stringify({ version: 1, taskId, projectId: record.projectId, revision: record.revision }));
      return { exists: true as const, taskId, projectId: record.projectId, revision: record.revision };
    });
  }
  private async syncTree(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new HandoffError("HANDOFF_UNAVAILABLE", "A handoff backup contains an unexpected symbolic link; source data is preserved.");
    if (info.isDirectory()) { for (const name of await readdir(path)) await this.syncTree(join(path, name)); await this.syncDirectory(path); }
    else { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
  }
  private async recoverRestore(taskId: string) {
    const path = this.paths(taskId), restore = await this.optional<{ version: number; record: CardHandoff; source: string; stage: string; key: string }>(path.restore);
    if (!restore) return;
    const parsed = cardHandoffSchema.safeParse(restore.record);
    if (restore.version !== 1 || !parsed.success || parsed.data.taskId !== taskId || bytes(restore.record) > handoffLimits.currentBytes || typeof restore.source !== "string" || !restore.stage.startsWith(path.folder + ".restore-") || restore.stage.includes("/", path.folder.length + 1) || restore.key !== hash(JSON.stringify(restore.record))) throw new HandoffError("HANDOFF_UNAVAILABLE", "The unfinished restore is invalid; all files are preserved.");
    this.identities(parsed.data, "HANDOFF_UNAVAILABLE");
    const current = await this.current(taskId);
    if (current && !isDeepStrictEqual(current, parsed.data)) throw new HandoffError("HANDOFF_UNAVAILABLE", "The unfinished restore conflicts with the current handoff; both are preserved.");
    if (!current) {
      const owner = await this.optional<{ key: string }>(join(path.folder, ".restore-owner.json"));
      if (owner?.key !== restore.key) {
        if (await stat(path.folder).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; })) throw new HandoffError("HANDOFF_UNAVAILABLE", "An existing data directory conflicts with the unfinished restore; preserved for inspection.");
        await cp(join(restore.source, "data"), restore.stage, { recursive: true, force: true });
        await this.atomic(join(restore.stage, ".restore-owner.json"), JSON.stringify({ key: restore.key })); await this.syncTree(restore.stage); await this.options.fault?.("restore-staged");
        await rename(restore.stage, path.folder); await this.syncDirectory(this.root); await this.options.fault?.("restore-data");
      }
      await this.atomic(path.current, JSON.stringify(parsed.data)); await this.options.fault?.("restore-current");
    }
    await rm(join(path.folder, ".restore-owner.json"), { force: true }); await rm(restore.stage, { recursive: true, force: true });
    await unlink(path.restore); await this.syncDirectory(this.root);
  }
  restoreCard(taskId: string, source: string) {
    return this.serial(taskId, async () => {
      await this.recover(taskId);
      const manifest = await this.optional<{ version: number; taskId: string }>(join(source, "complete.json")), raw = await this.optional<unknown>(join(source, "current.json"));
      const parsed = cardHandoffSchema.safeParse(raw);
      if (!manifest || manifest.version !== 1 || manifest.taskId !== taskId || !parsed.success || parsed.data.taskId !== taskId || bytes(raw) > handoffLimits.currentBytes) throw new HandoffError("HANDOFF_UNAVAILABLE", "The card handoff backup is incomplete or invalid; preserved for inspection.");
      this.identities(parsed.data, "HANDOFF_UNAVAILABLE");
      const existing = await this.current(taskId);
      if (existing) {
        if (!isDeepStrictEqual({ ...existing, seen: {} }, { ...parsed.data, seen: {} })) throw new HandoffError("HANDOFF_CONFLICT", "A different current handoff already exists; restore cannot overwrite it.");
        return existing;
      }
      const path = this.paths(taskId), stage = path.folder + ".restore-" + randomUUID();
      this.forget(taskId);
      await this.atomic(path.restore, JSON.stringify({ version: 1, record: parsed.data, source, stage, key: hash(JSON.stringify(parsed.data)) })); await this.options.fault?.("restore-intent");
      await this.recoverRestore(taskId); return parsed.data;
    });
  }
  /** Restored data is collected at its next touch like data an older version left (a backup copies what its card held). */
  private forget(taskId: string) { this.ledgerRuns.delete(taskId); this.archiveRefs.delete(taskId); this.sealRefs.delete(taskId); this.collected.delete(taskId); }
  removeCard(taskId: string) { return this.serial(taskId, async () => { await this.recover(taskId); this.forget(taskId); await rm(this.paths(taskId).current, { force: true }); await rm(this.paths(taskId).folder, { recursive: true, force: true }); await stat(this.root).then(() => this.syncDirectory(this.root), (e) => { if (e.code !== "ENOENT") throw e; }); }); }
  storageBytes(taskId: string) {
    return this.serial(taskId, async () => {
      const walk = async (path: string): Promise<number> => {
        try { const info = await stat(path); if (info.isFile()) return info.size; let size = 0; for (const file of await readdir(path)) size += await walk(join(path, file)); return size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
      };
      const size = await walk(this.paths(taskId).folder) + await walk(this.paths(taskId).current); return { bytes: size, warning: size >= handoffLimits.warningBytes };
    });
  }
}
type PageCursor = { taskId: string; revision: number; scope: "current" | "archive" | "all"; index: number; offset: number; openIndex: number; entryId?: string; archived?: number; superseded?: number; finished?: boolean; body?: { ref: string; kind: "text" | "json"; section: HandoffEntrySection; id: string; origin: "current" | "archive"; offset: number; textRef?: string; identity?: string } };
