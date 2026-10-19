import { useMemo } from "react";
import { View } from "react-native";
import type { Task } from "../shared/model";
import type { SessionAttentionSummary } from "../shared/session-attention";
import { cardActivityModes, cardDisplay, cardFields, defaultCardDisplay, withCardField, type CardActivity, type CardField } from "../shared/card-display";
import { msg, t } from "../shared/i18n";
import { useBoardView } from "./board-view";
import { TaskCard } from "./card";
import { SettingRow, SettingSelect, SettingSwitch, SettingsGroup, SettingsPage } from "./settings-ui";
import { Label, font, space } from "./ui";

const activityText: Record<CardActivity, { label: string; detail: string }> = {
  auto: { label: msg("Summary, else output"), detail: msg("The progress summary; the latest output until there is one") },
  progress: { label: msg("Progress summary"), detail: msg("What the summary model wrote after the last turn") },
  output: { label: msg("Latest output"), detail: msg("The newest agent message, as it arrives") },
  both: { label: msg("Both"), detail: msg("Two lines: summary, then output") },
  none: { label: msg("None"), detail: msg("Title and signals only") },
};

const fieldText: Record<CardField, { title: string; detail: string }> = {
  priority: { title: msg("Priority"), detail: msg("Urgent, High and Low, and the coloured edge of Urgent and High cards.") },
  type: { title: msg("Type"), detail: msg("Feature, Bug fix, Research and the other card types.") },
  ticket: { title: msg("Jira ticket"), detail: msg("The key of the ticket the card works from.") },
  tags: { title: msg("Tags"), detail: msg("The first two tags, then how many more.") },
  sessions: { title: msg("Session activity"), detail: msg("Running and unread sessions. Approvals and errors always show.") },
  workpad: { title: msg("Workpad checks"), detail: msg("How many of the agent's checks passed.") },
  ideas: { title: msg("Ideas"), detail: msg("How many ideas agents proposed on the card.") },
};

const noop = () => {};

/** Settings → Cards: what a board card shows, with a live preview (CARD-DISPLAY-SPEC §3). */
export function CardsPage() {
  const view = useBoardView();
  const display = cardDisplay(view.values);
  const hidden = view.values?.cardHidden || [];
  const busy = !view.values;
  const isDefault = display.activity === "auto" && cardFields.every((field) => display[field]);
  return (
    <SettingsPage title={t("Cards")} description={t("Choose what board cards show. Anything that needs you, such as questions, approvals, errors and blocked-by cards, always shows.")}>
      <CardPreview display={display} />
      <SettingsGroup title={t("Activity line")} description={t("One line under the title about what the agent did.")}>
        <SettingSelect
          title={t("Show")}
          value={display.activity}
          placeholder={t(activityText[display.activity].label)}
          disabled={busy}
          options={cardActivityModes.map((mode) => ({ value: mode, label: t(activityText[mode].label), detail: t(activityText[mode].detail) }))}
          onChange={(next) => void view.update({ cardActivity: next as CardActivity })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("Details")} description={t("Priority, type, ticket and tags sit in one quiet row above the title; the rest in the row below.")}>
        {cardFields.map((field) => (
          <SettingSwitch
            key={field}
            title={t(fieldText[field].title)}
            detail={t(fieldText[field].detail)}
            value={display[field]}
            disabled={busy}
            onChange={(shown) => void view.update({ cardHidden: withCardField(hidden, field, shown) })}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        <SettingRow
          title={t("Reset to defaults")}
          detail={isDefault ? t("Cards show the default details") : undefined}
          disabled={busy || isDefault}
          onPress={() => void view.update({ cardActivity: defaultCardDisplay.activity, cardHidden: hidden.filter((id) => !(cardFields as readonly string[]).includes(id)) })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** A sample card drawn by the real TaskCard with the current choices. Not interactive. */
function CardPreview({ display }: { display: ReturnType<typeof cardDisplay> }) {
  const sample = useMemo(() => {
    const now = Date.now();
    const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
    const task: Task = {
      id: "preview",
      projectId: "preview",
      workspaceId: "preview",
      sourcePath: "",
      repoPaths: [],
      title: t("Fix rounding in coupon totals"),
      description: "",
      status: "development",
      priority: "high",
      type: "bugfix",
      tags: ["checkout", "mobile", "payments"].map((tag) => ({ tag, by: "human" as const, at: ago(60) })),
      position: 0,
      revision: 1,
      operationId: "preview",
      createdAt: ago(120),
      updatedAt: ago(5),
      archivedAt: null,
    };
    const summary: SessionAttentionSummary = { total: 2, running: 1, starting: 0, finished: 1, unread: 1, attention: 0, permissions: 0, questions: 0, errors: 0, unknownRead: 0 };
    return {
      task,
      summary,
      progress: { state: t("Rounding fixed; adding tests for split payments"), at: ago(4) },
      output: { text: t("All 42 cart tests pass. Next I'll cover refunds."), at: ago(1) },
    };
  }, []);
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ paddingHorizontal: space[1] }}>
        <Label bold size={font.base} selectable={false}>
          {t("Preview")}
        </Label>
      </View>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 300, maxWidth: "100%" }}>
        <TaskCard
          task={sample.task}
          selected={false}
          legacy={false}
          available
          running={1}
          sessions={2}
          summary={sample.summary}
          output={sample.output}
          progress={sample.progress}
          ideas={1}
          ticketKey="SHOP-142"
          workpad={{ kind: "checks", done: 2, total: 3, count: 0 }}
          display={display}
          onOpen={noop}
          onActions={noop}
        />
      </View>
    </View>
  );
}
