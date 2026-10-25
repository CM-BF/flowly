import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { HandoffContextView } from "../shared/handoff-api";
import type { CardHandoff, HandoffInput, HandoffQuestion, HandoffReview, HandoffSession } from "../shared/handoff";
import { msg, t, tn } from "../shared/i18n";
import { boardKey, createChangedReader } from "./queries";
import { Disclosure, Section, type SectionState } from "./disclosure";
import { newMessageId } from "./sent-images";
import { useShortcutBlock } from "./shortcuts";
import { Badge, Button, Label, Notice, TextBox, font, message, radius, relativeTime, space, useTheme } from "./ui";

const changed = createChangedReader();
export const handoffKey = (taskId: string) => ["flowly", "handoff", taskId] as const;
export type HandoffIndex = { taskId: string; fresh: boolean; staleSince?: string; open: number; sessions: number };

const statusLabels: Record<HandoffInput["status"], string> = {
  open: msg("Open"), received: msg("Received"), done: msg("Done"), answered: msg("Answered"), superseded: msg("Superseded"), declined: msg("Declined"),
};
const roleLabels: Record<HandoffSession["role"], string> = { implementer: msg("Implementer"), reviewer: msg("Reviewer"), manual: msg("Manual session"), other: msg("Other session") };
const sectionLabels: Record<string, string> = {
  state: msg("Current state"), done: msg("Completed work"), next: msg("Next steps"), decisions: msg("Decisions and reasons"), ruledOut: msg("Ruled-out approaches"),
  problems: msg("Open problems"), pitfalls: msg("Pitfalls"), running: msg("Still running"), where: msg("Evidence and locations"), env: msg("Environment"),
  notes: msg("Handoff notes"), gaps: msg("Information gaps"), inputs: msg("Original instructions"), questions: msg("Questions and answers"), reviews: msg("Review rounds"), ledger: msg("Session handoffs"),
};

/** No detail fetch while folded. Background reads never seed or replace a person's draft. */
export function TaskHandoff({ taskId, active, disabled, section, index, onStartSession, onOpenSession }: {
  taskId: string; active: boolean; disabled: boolean; section: SectionState; index?: HandoffIndex;
  onStartSession(): void; onOpenSession(agentId: string): boolean | void;
}) {
  const read = useRpc(rpc.readHandoff), note = useRpc(rpc.noteHandoff), mark = useRpc(rpc.markHandoffInput), resume = useRpc(rpc.continueHandoff);
  const { colors } = useTheme();
  const cache = useQueryClient();
  const key = useMemo(() => handoffKey(taskId), [taskId]);
  const query = useQuery({ queryKey: key, queryFn: () => changed<HandoffContextView>(cache, key, etag => read({ taskId, ...(etag ? { etag } : {}) })), enabled: active && section.open, refetchInterval: active && section.open ? 5000 : false });
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  useEffect(() => () => { visible.current = false; }, []);
  const pendingNote = useRef<{ text: string; id: string } | null>(null);
  const pendingMarks = useRef(new Map<string, { id: string; revision: number }>());
  const [full, setFull] = useState(false);
  const context = query.data;
  const refresh = async () => { await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: boardKey })]); };
  const perform = async (action: () => Promise<void>) => {
    if (disabled || !active || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(message(e)); } finally { locked.current = false; setBusy(false); }
  };
  const post = () => perform(async () => {
    const text = draft.trim(); if (!text) return;
    // A lost response retries the same operation; a changed draft is a different note.
    const operation = pendingNote.current?.text === text ? pendingNote.current : { text, id: newMessageId() };
    pendingNote.current = operation;
    await note({ taskId, operationId: operation.id, kind: "direction", text });
    pendingNote.current = null; setDraft("");
    await refresh();
  });
  const markInput = (input: HandoffInput, patch: { status?: "done" | "superseded"; standing?: boolean }) => perform(async () => {
    if (!context) return;
    const key = JSON.stringify([input.id, patch]);
    const operation = pendingMarks.current.get(key) ?? { id: newMessageId(), revision: context.revision };
    pendingMarks.current.set(key, operation);
    await mark({ taskId, id: input.id, operationId: operation.id, handoffRevision: operation.revision, ...patch });
    pendingMarks.current.delete(key);
    await refresh();
  });
  const continueSession = (fresh: boolean, agentId?: string) => perform(async () => {
    const result = await resume({ taskId, fresh, ...(agentId ? { agentId } : {}) });
    await refresh();
    if (!visible.current) return;
    if (fresh) { if (!result.automation) onStartSession(); }
    else if (agentId && onOpenSession(agentId) === false) setError(t("The session list changed. Refresh the card before opening that session."));
  });
  const summary = index ? [index.fresh ? t("Handoff recorded") : t("Handoff needs checking"), tn(index.open, "{n} unresolved item", "{n} unresolved items"), tn(index.sessions, "{n} session", "{n} sessions")].join(" · ") : t("The next agent continues from this card.");
  return <Section id={taskId} title={t("Handoff")} open={section.open} onToggle={section.onToggle} summary={summary} count={index?.open}>
    <Label muted size={font.sm}>{t("The next agent reads this record and checks it against the workspace. Missing or outdated information is shown here.")}</Label>
    {query.isPending ? <Label muted>{t("Loading…")}</Label> : query.error ? <Notice>{message(query.error)}</Notice> : context ? <>
      {!!context.unavailable && <Notice tone="warning">{context.unavailable}</Notice>}
      {!!context.currentAgentId && <Label muted size={font.sm}>{t("Current session")} · {context.currentAgentId.slice(0, 8)}</Label>}
      {!context.fresh && <Notice tone="warning">{t("Handoff needs checking")}{context.staleSince ? ` · ${relativeTime(context.staleSince)}` : ""}</Notice>}
      {!!context.ackRequired && <Notice tone="warning">{t("The new agent has not acknowledged this handoff yet.")}</Notice>}
      {!!context.due.length && <Group title={t("Needs checking")} count={context.due.length}>{context.due.map((text, i) => <Label key={i} size={font.sm}>{text}</Label>)}</Group>}
      {context.view ? <>
        <HandoffRecord record={context.view.record} currentAgentId={context.currentAgentId} disabled={disabled || busy} truncated={context.view.truncatedIds} onMark={markInput} onReadFull={() => setFull(true)} onContinue={(agentId) => void continueSession(false, agentId)} />
        {(!context.view.complete || !!context.view.omitted || !!context.view.truncatedIds.length) && <Notice tone="warning">{t("Preview only: {omitted} entries omitted; {truncated} entries shortened. Read every page for the full record.", { omitted: context.view.omitted, truncated: context.view.truncatedIds.length })}</Notice>}
        <Button small quiet icon="BookOpen" onPress={() => setFull(v => !v)}>{full ? t("Hide full record") : t("Read full record")}</Button>
        {full && <FullHandoff key={taskId} taskId={taskId} active={active && section.open} preview={context.view.record} />}
      </> : !context.unavailable ? <Label muted>{t("No handoff has been recorded yet.")}</Label> : null}
      <View style={{ gap: space[2] }}>
        <Label medium>{t("Add a handoff note")}</Label>
        <TextBox accessibilityLabel={t("Handoff note")} value={draft} onChangeText={setDraft} editable={!disabled && !busy} multiline maxLength={2000} placeholder={t("Clarify a decision, constraint or missing information…")} placeholderTextColor={colors.foregroundMuted} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ minHeight: 72, maxHeight: 160, borderWidth: 1, borderColor: focused ? colors.foregroundMuted : colors.border, borderRadius: radius.md, padding: space[2], color: colors.foreground, backgroundColor: colors.surface0, fontSize: font.md, textAlignVertical: "top" }} />
        <View style={{ alignItems: "flex-start" }}><Button small label={t("Save handoff note")} disabled={disabled || busy || !draft.trim()} onPress={() => void post()}>{busy ? t("Saving…") : t("Save note")}</Button></View>
      </View>
      <Button small icon="ArrowRight" disabled={disabled || busy} onPress={() => void continueSession(true)}>{t("Continue in a fresh session")}</Button>
      <Label muted size={font.sm}>{t("A running turn is never interrupted. Continuing in an existing session ends automation supervision.")}</Label>
    </> : null}
    {!!error && <Notice tone="warning">{error}</Notice>}
  </Section>;
}

/** A grouped capture gap: how many occurrences, from when to when. Numbers and times only, so no catalog strings. */
function gapSpan(gap: CardHandoff["gaps"][number]) {
  if ((gap.count ?? 1) < 2) return "";
  const span = gap.firstAt && gap.lastAt ? ` · ${relativeTime(gap.firstAt)} – ${relativeTime(gap.lastAt)}` : "";
  return ` · ×${gap.count}${span}`;
}
function Group({ title, count, initial = false, children }: { title: string; count?: number; initial?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return <Disclosure title={title} summary={count === undefined ? undefined : String(count)} open={open} onChange={setOpen} flush>{children}</Disclosure>;
}
function Box({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space[2], gap: space[1.5] }}>{children}</View>;
}
function TextRows({ title, rows }: { title: string; rows: readonly { id: string; text: string; detail?: string }[] }) {
  return rows.length ? <Group title={title} count={rows.length}>{rows.map(row => <View key={row.id} style={{ gap: 2 }}><Label>{row.text}</Label>{!!row.detail && <Label muted size={font.sm}>{row.detail}</Label>}</View>)}</Group> : null;
}

function HandoffRecord({ record: r, currentAgentId, disabled, truncated, onMark, onReadFull, onContinue }: {
  record: CardHandoff; currentAgentId?: string; disabled: boolean; truncated: readonly string[];
  onMark(input: HandoffInput, patch: { status?: "done" | "superseded"; standing?: boolean }): void;
  onReadFull(): void; onContinue(agentId: string): void;
}) {
  return <View style={{ gap: space[2] }}>
    {!!r.state && <Box><Label medium>{t("Current state")}</Label><Label>{r.state.text}</Label><Label muted size={font.sm}>{t("Recorded {time}; verify against the workspace.", { time: relativeTime(r.state.at) })}</Label></Box>}
    {!!r.next.length && <Group title={t("Next steps")} count={r.next.length} initial>{r.next.map((step, i) => <Label key={step.id}>{i + 1}. {step.text}{step.gate ? ` · ${step.gate}` : ""}</Label>)}</Group>}
    {!!r.gaps.length && <Group title={t("Information gaps")} count={r.gaps.length} initial>{r.gaps.map(g => <Notice key={g.id} tone={g.status === "open" ? "warning" : undefined}>{g.text}{gapSpan(g)}{g.resolution ? ` · ${g.resolution.note}` : ""}</Notice>)}</Group>}
    {!!r.ledger.length && <Group title={t("Session handoffs")} count={r.ledger.length} initial>{r.ledger.map(s => <SessionRow key={s.id} session={s} current={s.agentId === currentAgentId} disabled={disabled} onContinue={onContinue} />)}</Group>}
    <TextRows title={t("Completed work")} rows={r.done.map(e => ({ ...e, detail: e.ref }))} />
    <TextRows title={t("Decisions and reasons")} rows={r.decisions.map(e => ({ ...e, detail: e.why }))} />
    <TextRows title={t("Ruled-out approaches")} rows={r.ruledOut.map(e => ({ ...e, detail: e.why }))} />
    <TextRows title={t("Open problems")} rows={r.problems.map(e => ({ ...e, detail: e.note }))} />
    <TextRows title={t("Pitfalls")} rows={r.pitfalls} />
    {!!r.running.length && <Group title={t("Still running")} count={r.running.length}>{r.running.map(e => <Box key={e.id}><Label medium>{e.what}</Label><Label>{e.how}</Label><Label muted size={font.sm}>{t("How to check: {check}", { check: e.check })}</Label><Label muted size={font.sm}>{t("Owner: {owner}", { owner: e.owner })} · {e.status}{e.result ? ` · ${e.result}` : ""}</Label></Box>)}</Group>}
    <TextRows title={t("Evidence and locations")} rows={r.where.map(e => ({ id: e.id, text: e.what, detail: e.ref }))} />
    <TextRows title={t("Environment")} rows={r.env} />
    <TextRows title={t("Handoff notes")} rows={r.notes} />
    {!!r.inputs.length && <Group title={t("Original instructions")} count={r.inputs.length}>{r.inputs.map(input => <InputRow key={input.id} input={input} disabled={disabled} onMark={onMark} onReadFull={onReadFull} />)}</Group>}
    {!!r.questions.length && <Group title={t("Questions and answers")} count={r.questions.length}>{r.questions.map(q => <QuestionRow key={q.id} question={q} inputs={r.inputs} onReadFull={onReadFull} />)}</Group>}
    {!!r.reviews.length && <Group title={t("Review rounds")} count={r.reviews.length}>{r.reviews.map(review => <View key={review.id}><ReviewRow review={review} />{truncated.includes(review.id) && <Button small quiet onPress={onReadFull}>{t("Read original in full record")}</Button>}</View>)}</Group>}
    {!!r.git.length && <Group title={t("Workspace checks")} count={r.git.length}>{r.git.map(repo => <Box key={repo.repo}><Label>{repo.repo}</Label><Label muted size={font.sm}>{repo.sha ?? t("Unknown")} · {repo.error ? t("Unknown") : repo.dirty ? t("Uncommitted changes") : t("Clean")}</Label>{!!repo.error && <Notice tone="warning">{repo.error}</Notice>}</Box>)}</Group>}
    {!!r.lastWords && <Box><Label medium>{t("Previous agent's last words (unverified)")}</Label><Label>{r.lastWords.text}</Label></Box>}
  </View>;
}

function InputRow({ input, disabled, onMark, onReadFull }: { input: HandoffInput; disabled: boolean; onMark(input: HandoffInput, patch: { status?: "done" | "superseded"; standing?: boolean }): void; onReadFull(): void }) {
  return <Box><View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}><Badge>{t(statusLabels[input.status])}</Badge>{!!input.standing && <Badge>{t("Standing instruction")}</Badge>}{!!input.redacted && <Badge>{t("Redacted")}</Badge>}</View>
    <Label>{input.text ?? input.firstLine ?? ""}</Label>
    <Label muted size={font.sm}>{relativeTime(input.at)} · {input.from?.title ?? input.from?.agentId?.slice(0, 8) ?? input.by.kind}{input.handled?.note ? ` · ${input.handled.note}` : ""}</Label>
    {(!!input.textRef || input.characters > (input.text?.length ?? 0)) && <Button small quiet onPress={onReadFull}>{t("Read original in full record")}</Button>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
      <Button small quiet disabled={disabled || input.status === "done"} onPress={() => onMark(input, { status: "done" })}>{t("Mark done")}</Button>
      <Button small quiet disabled={disabled || input.status === "superseded"} onPress={() => onMark(input, { status: "superseded" })}>{t("Mark superseded")}</Button>
      <Button small quiet disabled={disabled} onPress={() => onMark(input, { standing: !input.standing })}>{input.standing ? t("Remove standing flag") : t("Keep as standing instruction")}</Button>
    </View>
  </Box>;
}
function QuestionRow({ question: q, inputs, onReadFull }: { question: HandoffQuestion; inputs: readonly HandoffInput[]; onReadFull?(): void }) {
  const answers = q.answeredBy ?? [];
  return <Box><Label medium>{q.text}</Label><Label muted size={font.sm}>{q.status === "answered" ? t("Answered") : q.status === "withdrawn" ? t("Withdrawn") : t("Open")}</Label>
    {answers.map(id => { const answer = inputs.find(i => i.id === id); const short = answer && (!!answer.textRef || answer.characters > (answer.text?.length ?? 0)); return <View key={id} style={{ gap: 2 }}><Label muted size={font.sm}>{t("Linked answer")}</Label>{answer ? <Label>{answer.text ?? answer.firstLine}</Label> : <Label muted size={font.sm}>{id}</Label>}{onReadFull && (!answer || short) && <Button small quiet onPress={onReadFull}>{t("Read linked answer in full record")}</Button>}</View>; })}
    {!!q.note && <Label muted size={font.sm}>{q.note}</Label>}
  </Box>;
}
function ReviewRow({ review: r }: { review: HandoffReview }) {
  return <Box><Label medium>{t("Cycle {cycle}, round {round}", { cycle: r.cycle, round: r.round })} · {r.verdict === "approve" ? t("Approved") : r.verdict === "changes" ? t("Changes requested") : t("Incomplete")}</Label>
    <Label>{r.summary}</Label>{!!r.delivery && <><Label medium>{t("Delivery under review")}</Label><Label>{r.delivery.text}</Label></>}
    {r.findings.map(f => <Label key={f.id}>{f.status === "open" ? "○" : "✓"} {f.text}</Label>)}
    {!!r.risks.length && <><Label medium>{t("Risks beyond acceptance criteria")}</Label>{r.risks.map((risk, i) => <Label key={i}>{risk}</Label>)}</>}
    {r.gaps.map((gap, i) => <Notice key={i} tone="warning">{gap}</Notice>)}
  </Box>;
}
function SessionRow({ session: s, current, disabled, onContinue }: { session: HandoffSession; current: boolean; disabled: boolean; onContinue(agentId: string): void }) {
  return <Box><Label medium>{t("Session #{n} · {id}", { n: s.n, id: s.agentId.slice(0, 8) })} · {t(roleLabels[s.role])}{current ? ` · ${t("Current session")}` : s.endedAt ? ` · ${t("Previous session")}` : ""}</Label>
    <Label muted size={font.sm}>{[s.provider, s.model].filter(Boolean).join("/")} · {s.endReason ?? s.reason}</Label>
    <Label muted size={font.sm}>{s.ack?.complete ? t("Handoff acknowledged") : t("Handoff not acknowledged")}{s.endedAt ? ` · ${relativeTime(s.endedAt)}` : ""}</Label>
    {!!s.understanding && <Label>{s.understanding}</Label>}
    {!!s.skeleton && <Label muted size={font.sm}>{s.skeleton}</Label>}
    {s.background.filter(b => b.status !== "closed").map(b => <Label key={b.id} size={font.sm}>{b.label} · {b.ref}</Label>)}
    <Button small quiet disabled={disabled} onPress={() => onContinue(s.agentId)}>{t("Continue in this session")}</Button>
  </Box>;
}

/** User-driven pages, never an automatic sweep. Chunks are joined only for the entry the person is reading. */
export function FullHandoff({ taskId, active, preview }: { taskId: string; active: boolean; preview: CardHandoff }) {
  const read = useRpc(rpc.readHandoff);
  const [pages, setPages] = useState<NonNullable<HandoffContextView["page"]>[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const last = pages.at(-1);
  const stale = !!last && last.revision !== preview.revision;
  const load = async (restart = false) => {
    if (!active || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await read({ taskId, full: true, ...(!restart && last?.nextCursor ? { cursor: last.nextCursor } : {}) });
      if (!response.value?.page) throw new Error(t("The full handoff page is unavailable."));
      const page = response.value.page;
      if (page.viewChanged || (!restart && last && page.revision !== last.revision)) { setPages([]); setError(t("The handoff changed while reading. Start again to read a consistent record.")); return; }
      setPages(previous => restart ? [page] : [...previous, page]);
    } catch (e) { setError(message(e)); } finally { lock.current = false; setBusy(false); }
  };
  // Opening the full view is the explicit first-page action; subsequent pages always need a tap.
  useEffect(() => { if (active && !pages.length) void load(); }, [taskId, active]);
  const entries = useMemo(() => {
    const result = new Map<string, { section: string; id: string; value?: unknown; text: string; json: string; complete: boolean; invalid?: boolean }>();
    for (const page of pages) for (const item of page.items) {
      const key = `${item.section}:${item.id}`;
      const value = result.get(key) ?? { section: item.section, id: item.id, text: "", json: "", complete: false };
      if (item.value !== undefined) value.value = item.value;
      if (item.text !== undefined) {
        if (item.field === "json") { value.json += item.text; if (item.complete) { try { value.value = JSON.parse(value.json); } catch { value.invalid = true; } } }
        else value.text += item.text;
      }
      value.complete = item.complete;
      result.set(key, value);
    }
    return [...result.values()];
  }, [pages]);
  const inputs = useMemo(() => {
    const byId = new Map(preview.inputs.map(input => [input.id, input]));
    for (const entry of entries) if (entry.section === "inputs" && entry.value) {
      const input = entry.value as HandoffInput;
      byId.set(input.id, { ...input, ...(entry.text ? { text: entry.text, textRef: entry.complete ? undefined : input.textRef } : {}) });
    }
    return [...byId.values()];
  }, [entries, preview.inputs]);
  return <Box><Label medium>{t("Full handoff record")}</Label><Label muted size={font.sm}>{t("This view loads one page at a time. Keep reading until the end; the preview and first page are not the complete record.")}</Label>
    {entries.map(entry => <Box key={`${entry.section}:${entry.id}`}><Label medium>{sectionLabels[entry.section] ? t(sectionLabels[entry.section]) : t("Handoff entry")}</Label>
      {entry.invalid && <Notice tone="warning">{t("This entry could not be decoded; its contents are not verified.")}</Notice>}
      {entry.value !== undefined ? <FullEntry section={entry.section} value={entry.value} inputs={inputs} /> : entry.json && !entry.complete ? <Label muted>{t("This entry continues on the next page.")}</Label> : null}
      {!!entry.text && <Label>{entry.text}</Label>}
      {!entry.complete && !entry.json && <Label muted>{t("This entry continues on the next page.")}</Label>}
    </Box>)}
    {!!last && <Label muted size={font.sm}>{last.complete ? t("End of the full record") : t("More pages remain: {n} entries not yet read.", { n: last.omitted })}</Label>}
    {stale && <Notice tone="warning">{t("The handoff changed while reading. Start again to read a consistent record.")}</Notice>}
    {!!error && <Notice tone="warning">{error}</Notice>}
    {(!last || !last.complete) && <Button small disabled={!active || busy || stale} onPress={() => void load()}>{busy ? t("Loading…") : last ? t("Read next page") : t("Start reading full record")}</Button>}
    {!!pages.length && <Button small quiet disabled={!active || busy} onPress={() => void load(true)}>{t("Start again from the latest record")}</Button>}
  </Box>;
}

function FullEntry({ section, value, inputs }: { section: string; value: unknown; inputs: readonly HandoffInput[] }) {
  const entry = value as Record<string, unknown>;
  if (section === "reviews") return <ReviewRow review={value as HandoffReview} />;
  if (section === "questions") return <QuestionRow question={value as HandoffQuestion} inputs={inputs} />;
  if (section === "ledger") { const s = value as HandoffSession; return <><Label>{t("Session #{n} · {id}", { n: s.n, id: s.agentId.slice(0, 8) })} · {t(roleLabels[s.role])}</Label><Label>{s.endReason ?? s.reason}</Label>{!!s.ack && <Label>{s.ack.understanding}</Label>}</>; }
  return <>{["text", "firstLine", "what", "why", "how", "check", "ref", "note", "result"].map(field => typeof entry[field] === "string" && entry[field] ? <Label key={field}>{String(entry[field])}</Label> : null)}</>;
}
