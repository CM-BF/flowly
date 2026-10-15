import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Status } from "../shared/model";
import { Dot, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { StatusIcon } from "./status";
import { Enter, PulseDot } from "./motion";
import type { BoardOverview } from "./overview";

/**
 * Board header summary: how many cards, how many have agents working, and
 * what is waiting on you. Attention items open the Attention list.
 */
export function OverviewBar({
  overview,
  nameOf,
  onAttention,
  onLane,
  onInsights,
  insightsShortcut,
}: {
  overview: BoardOverview;
  nameOf(status: Status): string;
  onAttention(): void;
  /** Open project Insights (PROJECT-INSIGHTS-SPEC §9). */
  onInsights(): void;
  insightsShortcut: string;
  /** Jump to a lane (compact: switch tabs; desktop: expand it if collapsed). */
  onLane(status: Status): void;
}) {
  const { colors } = useTheme();
  const o = overview;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return (
    <View style={{ borderBottomWidth: 1, borderColor: colors.border }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          paddingHorizontal: space[3],
          height: touch ? 40 : 34,
        }}
      >
        <View accessibilityLabel={`${plural(o.total, "task")}${o.done !== null ? `, ${o.done} done` : ""}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 4, paddingRight: space[1.5] }}>
          <Label bold size={font.md} selectable={false}>{String(o.total)}</Label>
          <Label muted size={font.sm} selectable={false}>{o.total === 1 ? "task" : "tasks"}</Label>
          {o.done !== null && o.total > 0 && (
            <Label muted size={font.sm} selectable={false}>· {o.done} {nameOf("done").toLowerCase()}</Label>
          )}
        </View>
        <Divider />
        <Chip
          label={o.runningTasks ? `${plural(o.runningTasks, "task")} running${o.runningSessions > o.runningTasks ? ` (${plural(o.runningSessions, "session")})` : ""}` : "Nothing running"}
          icon={o.runningTasks ? <PulseDot color={colors.statusSuccess} size={7} /> : <Dot size={7} color={colors.border} />}
          muted={!o.runningTasks}
        >
          {o.runningTasks ? `${o.runningTasks} running` : "Idle"}
        </Chip>
        {o.needsYou > 0 && (
          <Chip label={`${plural(o.needsYou, "task")} waiting on you. Open Attention`} icon={<Dot size={7} color={colors.statusWarning} />} onPress={onAttention} strong>
            {o.needsYou} need{o.needsYou === 1 ? "s" : ""} you
          </Chip>
        )}
        {o.unread > 0 && (
          <Chip label={`${plural(o.unread, "task")} with unread results. Open Attention`} icon={<Dot size={7} color={colors.accent} />} onPress={onAttention}>
            {o.unread} unread
          </Chip>
        )}
        {o.errors > 0 && (
          <Chip label={`${plural(o.errors, "task")} with session errors. Open Attention`} icon={<Dot size={7} color={colors.statusDanger} />} onPress={onAttention}>
            {plural(o.errors, "error")}
          </Chip>
        )}
        {(o.inReview || o.blocked) ? <Divider /> : null}
        {!!o.inReview && (
          <Chip label={`${nameOf("in_review")}: ${o.inReview}`} icon={<StatusIcon status="in_review" size={13} />} onPress={() => onLane("in_review")}>
            {nameOf("in_review")} {o.inReview}
          </Chip>
        )}
        {!!o.blocked && (
          <Chip label={`${nameOf("blocked")}: ${o.blocked}`} icon={<StatusIcon status="blocked" size={13} />} onPress={() => onLane("blocked")}>
            {nameOf("blocked")} {o.blocked}
          </Chip>
        )}
        <Divider />
        <Chip label={`Project insights${insightsShortcut ? ` (${insightsShortcut})` : ""}`} icon={<Icon name="Activity" size={13} color={colors.foregroundMuted} />} onPress={onInsights}>
          Insights
        </Chip>
      </ScrollView>
    </View>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={{ width: 1, height: 14, marginHorizontal: space[1], backgroundColor: colors.border }} />;
}

function Chip({
  icon,
  label,
  onPress,
  muted,
  strong,
  children,
}: {
  icon: ReactNode;
  label: string;
  onPress?(): void;
  muted?: boolean;
  strong?: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {icon}
      <Label size={font.sm} medium={strong} muted={muted} selectable={false}>
        {children}
      </Label>
    </>
  );
  const base = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    height: touch ? 30 : 24,
    paddingHorizontal: space[1.5] + 2,
    borderRadius: radius.md,
  };
  return (
    <Enter distance={3}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          style={(state) => {
            const { hovered, pressed, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
            return { ...noFocusRing, ...base, backgroundColor: hovered || pressed || focused ? colors.surface2 : "transparent" };
          }}
        >
          {content}
        </Pressable>
      ) : (
        <View accessibilityLabel={label} style={base}>
          {content}
        </View>
      )}
    </Enter>
  );
}
