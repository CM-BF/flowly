import { useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { modelLabel, targetText, type SummaryEntry, type SummaryOverview } from "../shared/summary";
import { Disclosure } from "./disclosure";
import { summariesKey, useSummariesQuery } from "./queries";
import { useMotionHeight, useMotionValue } from "./motion";
import { Button, Label, SectionHeader, font, message, radius, relativeTime, space, tint, useTheme } from "./ui";
import { formatLocale, t, tn } from "../shared/i18n";

export { summariesKey };

/** Latest summary per card, runs in flight and errors (TASK-SUMMARY-SPEC §6). Shared by board and drawer. */
export const useSummaries = useSummariesQuery;

export function cardProgress(overview: SummaryOverview | undefined, taskId: string) {
  return overview?.latest.find((e) => e.taskId === taskId) || null;
}

/** Drawer "Progress": state, recap and next step, with refresh and version history. */
export function TaskProgress({ taskId, active }: { taskId: string; active: boolean }) {
  const { colors } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const overview = useSummaries(active);
  const refreshRpc = useRpc(rpc.refreshSummary);
  const historyRpc = useRpc(rpc.summaryHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const latest = cardProgress(overview.data, taskId);
  const running = !!overview.data?.running.includes(taskId);
  const error = overview.data?.errors.find((e) => e.taskId === taskId);
  const history = useQuery({
    queryKey: ["ultra", "summary-history", taskId, latest?.id],
    queryFn: () => historyRpc({ taskId }),
    enabled: active && historyOpen,
  });
  const refresh = async () => {
    setRequesting(true);
    try {
      await refreshRpc({ taskId });
      await queryClient.invalidateQueries({ queryKey: summariesKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRequesting(false);
    }
  };
  const older = (history.data || []).filter((e) => e.id !== latest?.id);
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t("Progress")} ai>
        <Button quiet icon="RefreshCw" disabled={!active || running || requesting} onPress={() => void refresh()}>
          {running ? t("Updating…") : t("Refresh")}
        </Button>
      </SectionHeader>
      {latest ? (
        <View
          style={{
            gap: space[2],
            padding: space[3],
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Clamped
            background={colors.surface1}
            footer={
              <Label muted size={font.xs} selectable={false}>
                {t("Updated {time}", { time: relativeTime(latest.at) })} · {modelLabel(latest.model)}
              </Label>
            }
          >
            <SummaryBody entry={latest} />
          </Clamped>
        </View>
      ) : (
        <Label muted size={font.sm}>
          {running
            ? t("Writing the first summary…")
            : overview.data && !overview.data.enabled
              ? t("Auto summary is off. Turn it on with the settings button at the bottom left of the board, or press Refresh.")
              : t("Updates after each agent turn.")}
        </Label>
      )}
      {!!error && (
        <Label muted size={font.sm}>
          {t("Last update failed {time}: {error}", { time: relativeTime(error.at), error: error.message })}
        </Label>
      )}
      {!!latest && (
        <Disclosure
          title={t("History")}
          summary={history.data ? tn(history.data.length, "{n} version", "{n} versions") : undefined}
          open={historyOpen}
          onChange={setHistoryOpen}
          disabled={!active}
        >
          {history.isPending ? (
            <Label muted size={font.sm}>{t("Loading…")}</Label>
          ) : history.error ? (
            <Label muted size={font.sm}>{message(history.error)}</Label>
          ) : !older.length ? (
            <Label muted size={font.sm}>{t("No earlier versions.")}</Label>
          ) : (
            <View style={{ gap: space[1] }}>
              {older.map((entry) => (
                <HistoryItem key={entry.id} entry={entry} />
              ))}
            </View>
          )}
        </Disclosure>
      )}
    </View>
  );
}

/** About five lines of the summary block; longer content collapses as a whole to this height. */
const CLAMP_HEIGHT = 104;

/**
 * Clamps its children as one block to CLAMP_HEIGHT with a fade, and offers
 * Show more / Show less with an animated height (TASK-SUMMARY-SPEC §7).
 * Content that fits shows in full without a toggle.
 */
function Clamped({ background, footer, children }: { background: string; footer: ReactNode; children: ReactNode }) {
  const [natural, setNatural] = useState(0);
  const [open, setOpen] = useState(false);
  const overflows = natural > CLAMP_HEIGHT + 8;
  const target = natural ? (open || !overflows ? natural : CLAMP_HEIGHT) : null;
  const height = useMotionHeight(target);
  const fade = useMotionValue(overflows && !open ? 1 : 0);
  return (
    <View style={{ gap: space[2] }}>
      <Animated.View
        style={{
          overflow: "hidden",
          // Until measured, cap without animating so a long summary never flashes open.
          ...(target === null ? { maxHeight: CLAMP_HEIGHT } : { height }),
        }}
      >
        <View onLayout={(e) => setNatural(Math.ceil(e.nativeEvent.layout.height))}>{children}</View>
        {overflows && (
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 32, opacity: fade }}>
            {[0.15, 0.45, 0.75, 0.95].map((alpha) => (
              <View key={alpha} style={{ flex: 1, backgroundColor: tint(background, alpha) }} />
            ))}
          </Animated.View>
        )}
      </Animated.View>
      {/* Footer row: meta on the left, the toggle in the bottom-right corner. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 24 }}>
        <View style={{ flex: 1, minWidth: 0 }}>{footer}</View>
        {overflows && (
          <Button quiet icon={open ? "ChevronUp" : "ChevronDown"} onPress={() => setOpen(!open)}>
            {open ? t("Show less") : t("Show more")}
          </Button>
        )}
      </View>
    </View>
  );
}

/** Each field in full: brevity comes from the prompt, never from cutting text (TASK-SUMMARY-SPEC §3, §7). */
function SummaryBody({ entry }: { entry: Pick<SummaryEntry, "state" | "target" | "recap" | "next"> }) {
  return (
    <View style={{ gap: space[2] }}>
      {!!entry.state && (
        <Label medium size={font.base} selectable>
          {entry.state}
        </Label>
      )}
      {!!entry.target && <Field title={t("Target")} text={targetText(entry.target)} />}
      {!!entry.recap && <Field title={t("Recap")} text={entry.recap} />}
      {!!entry.next && <Field title={t("Next")} text={entry.next} />}
    </View>
  );
}

function Field({ title, text }: { title: string; text: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Label muted size={font.xs} selectable={false}>
        {title}
      </Label>
      <Label size={font.md} selectable>
        {text}
      </Label>
    </View>
  );
}

function HistoryItem({ entry }: { entry: SummaryEntry }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${relativeTime(entry.at)}: ${entry.state}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          padding: space[2],
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label size={font.sm} selectable={false}>
            {entry.state}
          </Label>
        </View>
        <Label muted size={font.xs} selectable={false}>
          {new Date(entry.at).toLocaleString(formatLocale())}
        </Label>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: space[3], paddingBottom: space[3] }}>
          <SummaryBody entry={{ state: "", target: entry.target, recap: entry.recap, next: entry.next }} />
        </View>
      )}
    </View>
  );
}
