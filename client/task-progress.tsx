import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { modelLabel, targetText, type SummaryEntry, type SummaryOverview } from "../shared/summary";
import { CardBody, CardField, CardFootnote, CardHeadline, ContentCard } from "./content-card";
import { Disclosure } from "./disclosure";
import { summariesKey, useSummariesQuery } from "./queries";
import { Button, Label, SectionHeader, font, message, radius, relativeTime, space, useTheme } from "./ui";
import { formatLocale, t, tn } from "../shared/i18n";

export { summariesKey };

/** Latest summary per card, runs in flight and errors (TASK-SUMMARY-SPEC §6). Shared by board and drawer. */
export const useSummaries = useSummariesQuery;

export function cardProgress(overview: SummaryOverview | undefined, taskId: string) {
  return overview?.latest.find((e) => e.taskId === taskId) || null;
}

/** Drawer "Progress": state, recap and next step, with refresh and version history. */
export function TaskProgress({ taskId, active }: { taskId: string; active: boolean }) {
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
        <ContentCard footer={<CardFootnote>{t("Updated {time}", { time: relativeTime(latest.at) })} · {modelLabel(latest.model)}</CardFootnote>}>
          <SummaryBody entry={latest} />
        </ContentCard>
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

/** Each field in full: brevity comes from the prompt, never from cutting text (TASK-SUMMARY-SPEC §3, §7). */
function SummaryBody({ entry }: { entry: Pick<SummaryEntry, "state" | "target" | "recap" | "next"> }) {
  return (
    <CardBody>
      {!!entry.state && <CardHeadline>{entry.state}</CardHeadline>}
      {!!entry.target && <CardField title={t("Target")} text={targetText(entry.target)} />}
      {!!entry.recap && <CardField title={t("Recap")} text={entry.recap} />}
      {!!entry.next && <CardField title={t("Next")} text={entry.next} />}
    </CardBody>
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
