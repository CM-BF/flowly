import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { baseOf, type HabitCounts, type HabitFlag, type Habits } from "../shared/agent-habits";
import { modelLabel } from "../shared/summary";
import { formatLocale, t } from "../shared/i18n";
import { Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";

/** Agent habits on the Insights page (WORKFLOW-INSIGHTS-SPEC §12.6): next-move and idea use by day and model. */

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
const modelName = (model: string) => (model ? modelLabel(model) : t("Unknown model"));

/** "Next moves 54/69 · Ideas 13" for the section header; empty when nothing was delivered. */
export function habitsSummary(habits: Habits) {
  const base = baseOf(habits.total);
  return base ? t("Next moves {moves}/{base} · Ideas {ideas}", { moves: habits.total.moves, base, ideas: habits.total.ideas }) : "";
}

const LABEL_WIDTH = 88;

export function AgentHabits({
  habits,
  today,
  compact,
  titleOf,
  onOpenTask,
}: {
  habits: Habits;
  today: string;
  compact: boolean;
  titleOf(id: string): string;
  onOpenTask(id: string): void;
}) {
  const { colors } = useTheme();
  const total = habits.total;
  const base = baseOf(total);
  if (!base && !total.questions && !total.movesAny && !total.ideas)
    return (
      <Label muted size={font.sm} selectable={false}>
        {t("No deliveries in these 7 days.")}
      </Label>
    );
  const windowRate = base ? total.moves / base : 0;
  const label = (width?: number) => ({ width, justifyContent: "center" as const, minHeight: touch ? 32 : 26 });
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
      {habits.flags.map((flag, i) => (
        <FlagRow key={`${flag.kind}-${flag.miss}-${flag.agentId ?? flag.model}-${i}`} flag={flag} first={i === 0} titleOf={titleOf} onOpenTask={onOpenTask} />
      ))}
      <View style={{ padding: space[3], gap: space[1], borderTopWidth: habits.flags.length ? 1 : 0, borderColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={label(LABEL_WIDTH)} />
          {habits.days.map((d) => (
            <View key={d.day} style={{ flex: 1, alignItems: "center" }}>
              <Label muted size={font.xs} selectable={false}>
                {d.day === today ? t("Today") : new Date(`${d.day}T12:00:00Z`).toLocaleDateString(formatLocale(), { weekday: "short", timeZone: "UTC" })}
              </Label>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={label(LABEL_WIDTH)}>
            <Label size={font.sm} selectable={false}>
              {t("Next moves")}
            </Label>
          </View>
          {habits.days.map((d) => (
            <DayCell key={d.day} counts={d} day={d.day} windowRate={windowRate} />
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={label(LABEL_WIDTH)}>
            <Label size={font.sm} selectable={false}>
              {t("Ideas")}
            </Label>
          </View>
          {habits.days.map((d) => (
            <View key={d.day} style={{ flex: 1, alignItems: "center", minHeight: touch ? 32 : 26, justifyContent: "center" }}>
              <Label size={font.sm} color={d.ideas ? undefined : colors.foregroundMuted} selectable={false}>
                {d.ideas}
              </Label>
            </View>
          ))}
        </View>
      </View>
      {habits.models.length > 0 && (
        <View style={{ padding: space[3], gap: space[2], borderTopWidth: 1, borderColor: colors.border }}>
          {habits.models.slice(0, compact ? 4 : 6).map((m) => (
            <View key={m.model || "unknown"} style={{ gap: 1 }}>
              <Label size={font.sm} medium lines={1} selectable={false}>
                {modelName(m.model)}
              </Label>
              <Label muted size={font.xs} selectable={false}>
                {[
                  `${t("Next moves")} ${m.moves}/${baseOf(m)}`,
                  m.none ? t("None needed {n}", { n: m.none }) : "",
                  `${t("Ideas")} ${m.ideas}`,
                  m.offered ? t("Picked {picked} of {offered}", { picked: m.picked, offered: m.offered }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            </View>
          ))}
          <Label muted size={font.xs} selectable={false}>
            {t("Picked counts a reply that matches a suggestion, or the card moved to Done while its Move to Done suggestion was open.")}
          </Label>
        </View>
      )}
    </View>
  );
}

function DayCell({ counts, day, windowRate }: { counts: HabitCounts; day: string; windowRate: number }) {
  const { colors } = useTheme();
  const base = baseOf(counts);
  // A day well under the window's own rate is the regression this row exists to show.
  const low = base >= 5 && counts.moves / base < windowRate / 2;
  return (
    <View
      accessibilityLabel={t("{day}: next moves on {moves} of {base} deliveries, {ideas} ideas", { day, moves: counts.moves, base, ideas: counts.ideas })}
      style={{ flex: 1, alignItems: "center", minHeight: touch ? 32 : 26, justifyContent: "center" }}
    >
      <Label size={font.sm} medium={low} color={low ? colors.statusWarning : base ? undefined : colors.foregroundMuted} selectable={false}>
        {percent(counts.moves, base)}
      </Label>
    </View>
  );
}

function FlagRow({ flag, first, titleOf, onOpenTask }: { flag: HabitFlag; first: boolean; titleOf(id: string): string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  const who = [flag.taskId ? titleOf(flag.taskId) : "", modelName(flag.model)].filter(Boolean).join(" · ");
  const reason = flag.miss === "moves" ? t("No next moves in {n} deliveries", { n: flag.n }) : t("No ideas in {n} deliveries", { n: flag.n });
  const taskId = flag.taskId;
  return (
    <Pressable
      accessibilityRole={taskId ? "button" : "text"}
      accessibilityLabel={taskId ? t("{who}: {reason}. Open card", { who, reason }) : `${who}: ${reason}`}
      disabled={!taskId}
      onPress={() => taskId && onOpenTask(taskId)}
      style={(state) => {
        const { hovered, pressed } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          paddingHorizontal: space[3],
          minHeight: touch ? 48 : 36,
          borderTopWidth: first ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: taskId && (hovered || pressed) ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="TriangleAlert" size={15} color={colors.statusWarning} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>
          {who}
        </Label>
      </View>
      <Label muted size={font.sm} selectable={false}>
        {reason}
      </Label>
    </Pressable>
  );
}
