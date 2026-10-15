import { memo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { enabledStatuses } from "../shared/lanes";
import { isWorkStatus, type Project, type Status, type Task } from "../shared/model";
import { addDays, waited, type Insight, type ProjectInsights } from "../shared/insights";
import type { DigestItem, DigestView } from "../shared/digest";
import { compactDuration } from "../shared/usage";
import { modelLabel } from "../shared/summary";
import type { AttentionItem } from "./attention";
import { Disclosure } from "./disclosure";
import { Enter } from "./motion";
import { localZone, useDigestQuery, useInsightsQuery } from "./queries";
import { StatusIcon } from "./status";
import { Button, Dot, IconButton, Label, Notice, font, message, noFocusRing, radius, relativeTime, space, touch, useTheme, verticalContent, verticalScroll } from "./ui";

/** Project Insights page (PROJECT-INSIGHTS-SPEC §9): replaces the board area while open. */
export const InsightsPage = memo(function InsightsPage({
  project,
  tasks,
  attention,
  revision,
  compact,
  active,
  nameOf,
  onOpenTask,
  onBack,
}: {
  project: Project;
  tasks: readonly Task[];
  attention: readonly AttentionItem[];
  revision: number;
  compact: boolean;
  active: boolean;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
  onBack(): void;
}) {
  const { colors } = useTheme();
  const [day, setDay] = useState<string | null>(null);
  const insights = useInsightsQuery(project.id, day, revision, active);
  const data = insights.data;
  const shownDay = data?.day || day;
  const isToday = !!data && data.day === data.today;
  const digest = useDigestQuery(project.id, shownDay, active && !!data);
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title || "Removed card";
  const lanes = enabledStatuses(project);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          paddingHorizontal: space[3],
          height: touch ? 48 : 40,
          borderBottomWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Button quiet icon="ChevronLeft" label="Back to board (Esc)" onPress={onBack}>
          Board
        </Button>
        <View style={{ flex: 1 }} />
        <IconButton icon="ChevronLeft" label="Previous day" onPress={() => data && setDay(addDays(data.day, -1))} disabled={!data} />
        <View style={{ minWidth: compact ? 88 : 120, alignItems: "center" }}>
          <Label bold size={font.md} selectable={false}>
            {data ? dayLabel(data.day, data.today) : "…"}
          </Label>
        </View>
        <IconButton
          icon="ChevronRight"
          label="Next day"
          onPress={() => data && setDay(addDays(data.day, 1) >= data.today ? null : addDays(data.day, 1))}
          disabled={!data || isToday}
        />
        {!isToday && !!data && (
          <Button quiet small onPress={() => setDay(null)}>
            Today
          </Button>
        )}
      </View>
      <ScrollView
        {...verticalScroll}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}
      >
        <View style={{ width: "100%", maxWidth: 760, gap: space[5] }}>
          {insights.error && !data ? (
            <Notice>{message(insights.error)}</Notice>
          ) : !data ? (
            <Label muted>Loading insights…</Label>
          ) : (
            <>
              <Numbers data={data} compact={compact} />
              {isToday && <Waiting data={data} attention={attention} titleOf={titleOf} nameOf={nameOf} onOpenTask={onOpenTask} />}
              {isToday && <Suggestions insights={data.insights} titleOf={titleOf} onOpenTask={onOpenTask} />}
              <Digest projectId={project.id} day={data.day} isToday={isToday} view={digest.data} error={digest.error} titleOf={titleOf} onOpenTask={onOpenTask} />
              <Trend data={data} lanes={lanes} nameOf={nameOf} compact={compact} />
              {data.incomplete > 0 && (
                <Label muted size={font.xs}>
                  {data.incomplete} card{data.incomplete === 1 ? "" : "s"} started before the full history was kept, so older numbers may be low.
                </Label>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
});

export function dayLabel(day: string, today: string) {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function Section({ title, detail, trailing, children }: { title: string; detail?: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <Enter distance={4}>
      <View style={{ gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 28 }}>
          <Label bold size={font.md} selectable={false}>
            {title}
          </Label>
          {!!detail && (
            <Label muted size={font.sm} selectable={false}>
              {detail}
            </Label>
          )}
          <View style={{ flex: 1 }} />
          {trailing}
        </View>
        {children}
      </View>
    </Enter>
  );
}

function Panel({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>{children}</View>
  );
}

const fmt = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1));

function Numbers({ data, compact }: { data: ProjectInsights; compact: boolean }) {
  const { colors } = useTheme();
  const s = data.stats,
    a = data.average;
  const turns = s.turns.completed + s.turns.failed + s.turns.canceled;
  const tiles: { label: string; value: string; avg: string; hint?: string }[] = [
    { label: "Done", value: String(s.done), avg: fmt(a.done) },
    { label: "New", value: String(s.created), avg: fmt(a.created) },
    { label: "Rework", value: String(s.rework), avg: fmt(a.rework) },
    { label: "Turns", value: String(turns), avg: fmt(a.turns), hint: s.turns.failed ? `${s.turns.failed} failed` : undefined },
    { label: "Agent time", value: s.agentMs ? compactDuration(s.agentMs) : "0", avg: a.agentMs ? compactDuration(a.agentMs) : "0", hint: s.peakSessions > 1 ? `up to ${s.peakSessions} at once` : undefined },
    { label: "Commits", value: data.git.repos ? String(s.commits) : "—", avg: data.git.repos ? fmt(a.commits) : "", hint: s.commits ? `+${s.added} −${s.deleted}` : undefined },
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
      {tiles.map((t) => (
        <View
          key={t.label}
          accessibilityLabel={`${t.label}: ${t.value}${t.avg ? `, 7-day average ${t.avg}` : ""}`}
          style={{
            flexGrow: 1,
            flexBasis: compact ? "30%" : 0,
            minWidth: compact ? 96 : 100,
            padding: space[3],
            gap: 2,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Label muted size={font.xs} selectable={false}>
            {t.label}
          </Label>
          <Label bold size={font.xl} selectable={false}>
            {t.value}
          </Label>
          <Label muted size={font.xs} lines={1} selectable={false}>
            {[t.hint, t.avg ? `avg ${t.avg}/day` : ""].filter(Boolean).join(" · ") || " "}
          </Label>
        </View>
      ))}
    </View>
  );
}

type WaitingRowData = { key: string; taskId: string; kind: string; tone: "warning" | "danger" | "info" | "muted"; status?: Status; since: string };

function Waiting({
  data,
  attention,
  titleOf,
  nameOf,
  onOpenTask,
}: {
  data: ProjectInsights;
  attention: readonly AttentionItem[];
  titleOf(id: string): string;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
}) {
  const rows: WaitingRowData[] = [
    ...attention.filter((i) => i.permissions).map((i) => ({ key: `p${i.task.id}`, taskId: i.task.id, kind: "Permission", tone: "warning" as const, since: i.updatedAt })),
    ...attention.filter((i) => i.questions).map((i) => ({ key: `q${i.task.id}`, taskId: i.task.id, kind: "Question", tone: "warning" as const, since: i.updatedAt })),
    ...attention.filter((i) => i.errors).map((i) => ({ key: `e${i.task.id}`, taskId: i.task.id, kind: "Error", tone: "danger" as const, since: i.updatedAt })),
    ...data.review.map((r) => ({ key: `r${r.taskId}`, taskId: r.taskId, kind: nameOf("in_review"), tone: "info" as const, status: "in_review" as Status, since: r.since })),
    ...data.blocked.map((r) => ({ key: `b${r.taskId}`, taskId: r.taskId, kind: nameOf("blocked"), tone: "muted" as const, status: "blocked" as Status, since: r.since })),
  ];
  return (
    <Section title="Waiting on you" detail={rows.length ? String(rows.length) : undefined}>
      {rows.length ? (
        <Panel>
          {rows.map((row, i) => (
            <WaitingRow key={row.key} row={row} first={i === 0} title={titleOf(row.taskId)} onOpenTask={onOpenTask} />
          ))}
        </Panel>
      ) : (
        <Label muted size={font.sm}>
          Nothing is waiting on you.
        </Label>
      )}
    </Section>
  );
}

function WaitingRow({ row, first, title, onOpenTask }: { row: WaitingRowData; first: boolean; title: string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  const color =
    row.tone === "warning" ? colors.statusWarning : row.tone === "danger" ? colors.statusDanger : row.tone === "info" ? colors.accent : colors.foregroundMuted;
  const age = waited(Math.max(0, Date.now() - Date.parse(row.since)));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.kind}: ${title}, waiting ${age}. Open card`}
      onPress={() => onOpenTask(row.taskId)}
      style={(state) => {
        const { hovered, pressed } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          paddingHorizontal: space[3],
          minHeight: touch ? 48 : 40,
          borderTopWidth: first ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      {row.status ? <StatusIcon status={row.status} size={14} /> : <Dot size={8} color={color} />}
      <View style={{ width: touch ? 78 : 88 }}>
        <Label size={font.sm} color={color} medium lines={1} selectable={false}>
          {row.kind}
        </Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md} lines={1} selectable={false}>
          {title}
        </Label>
      </View>
      <Label muted size={font.sm} selectable={false}>
        {age}
      </Label>
    </Pressable>
  );
}

function Suggestions({ insights, titleOf, onOpenTask }: { insights: readonly Insight[]; titleOf(id: string): string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  if (!insights.length)
    return (
      <Section title="Suggestions">
        <Label muted size={font.sm}>
          No suggestions right now.
        </Label>
      </Section>
    );
  return (
    <Section title="Suggestions">
      <View style={{ gap: space[2] }}>
        {insights.map((item, index) => (
          <View
            key={`${item.rule}-${index}`}
            style={{
              flexDirection: "row",
              gap: space[2],
              padding: space[3],
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <View style={{ paddingTop: 2 }}>
              <Icon name={item.severity === "warning" ? "TriangleAlert" : "Lightbulb"} size={15} color={item.severity === "warning" ? colors.statusWarning : colors.foregroundMuted} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: space[1.5] }}>
              <Label size={font.md}>{item.text}</Label>
              {item.taskIds.length > 1 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
                  {item.taskIds.slice(0, 6).map((id) => (
                    <TaskChip key={id} title={titleOf(id)} onPress={() => onOpenTask(id)} />
                  ))}
                  {item.taskIds.length > 6 && (
                    <Label muted size={font.sm} selectable={false}>
                      +{item.taskIds.length - 6}
                    </Label>
                  )}
                </View>
              )}
            </View>
            {item.taskIds.length === 1 && <Button quiet small icon="ArrowUpRight" label={`Open ${titleOf(item.taskIds[0])}`} onPress={() => onOpenTask(item.taskIds[0])}>Open</Button>}
          </View>
        ))}
      </View>
    </Section>
  );
}

function TaskChip({ title, onPress }: { title: string; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      onPress={onPress}
      hitSlop={touch ? 6 : 0}
      style={(state) => {
        const { hovered, pressed } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          maxWidth: 220,
          paddingHorizontal: space[2],
          height: touch ? 28 : 22,
          justifyContent: "center",
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : colors.surface0,
        };
      }}
    >
      <Label size={font.sm} lines={1} selectable={false}>
        {title}
      </Label>
    </Pressable>
  );
}

function Digest({
  projectId,
  day,
  isToday,
  view,
  error,
  titleOf,
  onOpenTask,
}: {
  projectId: string;
  day: string;
  isToday: boolean;
  view: DigestView | undefined;
  error: unknown;
  titleOf(id: string): string;
  onOpenTask(id: string): void;
}) {
  const refresh = useRpc(rpc.refreshDigest);
  const client = useQueryClient();
  const [failed, setFailed] = useState("");
  const running = !!view?.running;
  const run = async () => {
    setFailed("");
    try {
      await refresh({ projectId, tz: localZone(), day });
      await client.invalidateQueries({ queryKey: ["ultra", "digest", projectId, day] });
    } catch (e) {
      setFailed(message(e));
    }
  };
  const entry = view?.entry;
  const groups: { title: string; items: DigestItem[] }[] = entry
    ? [
        { title: "Done", items: entry.done },
        { title: "Progressed", items: entry.progressed },
        { title: "Issues", items: entry.issues },
        { title: "Next", items: entry.next },
      ].filter((g) => g.items.length)
    : [];
  return (
    <Section
      title="Summary"
      trailing={
        view && !view.empty ? (
          <Button quiet small icon="RefreshCw" disabled={running} label="Regenerate the summary" onPress={() => void run()}>
            {running ? "Generating…" : entry ? "Refresh" : "Generate"}
          </Button>
        ) : null
      }
    >
      {!view ? (
        <Label muted size={font.sm}>
          {error ? message(error) : "Loading…"}
        </Label>
      ) : view.empty ? (
        <Label muted size={font.sm}>
          No activity on this day.
        </Label>
      ) : entry ? (
        <Panel>
          <View style={{ padding: space[3], gap: space[3] }}>
            <Label bold size={font.base}>
              {entry.headline}
            </Label>
            {groups.map((g) => (
              <View key={g.title} style={{ gap: space[1] }}>
                <Label muted size={font.xs} selectable={false}>
                  {g.title}
                </Label>
                {g.items.map((item, i) => (
                  <DigestLine key={i} item={item} title={item.taskId ? titleOf(item.taskId) : ""} onOpenTask={onOpenTask} />
                ))}
              </View>
            ))}
            <Label muted size={font.xs} selectable={false}>
              Updated {relativeTime(entry.at)} · {modelLabel(entry.model)}
            </Label>
          </View>
        </Panel>
      ) : running ? (
        <Label muted size={font.sm}>
          Writing the summary…
        </Label>
      ) : (
        <Label muted size={font.sm}>
          {isToday
            ? "Generate a summary of today so far."
            : view.enabled
              ? "No summary for this day yet."
              : "Daily digest is off in settings. Generate one here."}
        </Label>
      )}
      {!!(failed || (view?.error && !running)) && (
        <Label muted size={font.sm}>
          {failed || `Last attempt failed: ${view?.error?.message}`}
        </Label>
      )}
    </Section>
  );
}

function DigestLine({ item, title, onOpenTask }: { item: DigestItem; title: string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}>
      <Label muted size={font.md} selectable={false}>
        •
      </Label>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[1.5] }}>
        <Label size={font.md}>{item.text}</Label>
        {!!item.taskId && (
          <Pressable accessibilityRole="link" accessibilityLabel={`Open ${title}`} onPress={() => onOpenTask(item.taskId!)} hitSlop={touch ? 6 : 0} style={noFocusRing}>
            <Label size={font.sm} color={colors.accent} lines={1} selectable={false}>
              {title.length > 40 ? title.slice(0, 39) + "…" : title}
            </Label>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Trend({ data, lanes, nameOf, compact }: { data: ProjectInsights; lanes: readonly Status[]; nameOf(status: Status): string; compact: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(!compact);
  const max = Math.max(1, ...data.trend.flatMap((d) => [d.created, d.done]));
  const total = data.trend.reduce((s, d) => s + d.done, 0);
  const dwell = lanes.filter((s) => data.dwell[s] !== undefined && s !== "done" && s !== "cancelled");
  const barHeight = 72;
  return (
    <Disclosure title="Last 7 days" summary={`${total} done`} open={open} onChange={setOpen}>
      <View style={{ gap: space[4], paddingTop: space[1] }}>
        <View style={{ gap: space[2] }}>
          <View style={{ flexDirection: "row", gap: space[3] }}>
            <Legend color={colors.foregroundMuted} label="New" />
            <Legend color={colors.accent} label="Done" />
            <Label muted size={font.xs} selectable={false}>
              In progress at end of day below
            </Label>
          </View>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
            {data.trend.map((d) => (
              <View key={d.day} accessibilityLabel={`${d.day}: ${d.created} new, ${d.done} done, ${d.work} in progress`} style={{ flex: 1, alignItems: "center", gap: space[1] }}>
                <View style={{ height: barHeight, flexDirection: "row", alignItems: "flex-end", gap: 3 }}>
                  <Bar value={d.created} max={max} height={barHeight} color={colors.foregroundMuted} />
                  <Bar value={d.done} max={max} height={barHeight} color={colors.accent} />
                </View>
                <Label muted size={font.xs} selectable={false}>
                  {d.day === data.today ? "Today" : new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
                </Label>
                <Label size={font.xs} selectable={false}>
                  {d.work}
                </Label>
              </View>
            ))}
          </View>
        </View>
        {dwell.length > 0 && (
          <View style={{ gap: space[1] }}>
            <Label muted size={font.xs} selectable={false}>
              Median time in each lane (cards that left it in these 7 days)
            </Label>
            {dwell.map((s) => (
              <View key={s} style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 22 }}>
                <StatusIcon status={s} size={13} />
                <View style={{ flex: 1 }}>
                  <Label size={font.sm} selectable={false}>
                    {nameOf(s)}
                  </Label>
                </View>
                <Label size={font.sm} color={isWorkStatus(s) || s === "in_review" ? undefined : colors.foregroundMuted} selectable={false}>
                  {waited(data.dwell[s])}
                </Label>
              </View>
            ))}
          </View>
        )}
        {(data.git.topFiles.length > 0 || data.git.error) && (
          <View style={{ gap: space[1] }}>
            <Label muted size={font.xs} selectable={false}>
              Most changed files
            </Label>
            {data.git.topFiles.map((f) => (
              <View key={f.path} style={{ flexDirection: "row", gap: space[2], minHeight: 20 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label size={font.sm} mono lines={1}>
                    {f.path}
                  </Label>
                </View>
                <Label muted size={font.sm} selectable={false}>
                  {f.commits} commit{f.commits === 1 ? "" : "s"}
                </Label>
              </View>
            ))}
            {!!data.git.error && (
              <Label muted size={font.xs}>
                Git: {data.git.error}
              </Label>
            )}
          </View>
        )}
      </View>
    </Disclosure>
  );
}

function Bar({ value, max, height, color }: { value: number; max: number; height: number; color: string }) {
  return <View style={{ width: 8, height: Math.max(value ? 3 : 1, Math.round((value / max) * height)), borderRadius: 2, backgroundColor: color, opacity: value ? 1 : 0.3 }} />;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Label muted size={font.xs} selectable={false}>
        {label}
      </Label>
    </View>
  );
}
