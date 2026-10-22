import { useState } from "react";
import { View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Project, Task } from "../shared/model";
import { automationOf, isLive, type AutomationCode, type AutomationJob, type AutomationSettings } from "../shared/automation";
import type { AgentModel } from "../shared/agent-defaults";
import { boardKey, useBoardQuery } from "./queries";
import { PulseDot } from "./motion";
import { ModelDefaultGroup } from "./model-default";
import { Button, Choices, Label, Toggle, font, message, space, toneColor, useTheme, type Tone } from "./ui";
import { localizedLabels, msg, t } from "../shared/i18n";

/** How a job reads on the card (AUTOMATION-SPEC §6.1). */
export type AutomationSignal = { text: string; icon?: string; tone: Tone | "active" };

const reasons: Record<AutomationCode, string> = localizedLabels({
  question: msg("The agent asked a question"),
  blocked: msg("The agent reported a blocker"),
  permission: msg("The agent is waiting for a permission"),
  interrupted: msg("The turn was interrupted"),
  stopped: msg("Stopped by you"),
  card_moved: msg("The card was moved"),
  card_finished: msg("The card was finished"),
  no_delivery: msg("The agent kept ending turns without a delivery"),
  failed: msg("Turns kept failing"),
  start_failed: msg("The agent session could not be started"),
  session_unavailable: msg("The agent's session is no longer available"),
  review_rounds: msg("All review rounds were used"),
  review_incomplete: msg("The reviewer gave no verdict"),
  sub_cards: msg("It handed its work to sub-cards and waits for them"),
});

/** The card's automation in a few words; null when the lane already says it (stopped, delivered without a review, or the card is finished). */
export function automationSignal(job: AutomationJob | undefined, task: Pick<Task, "status">): AutomationSignal | null {
  if (!job || (isFinished(task) && !isLive(job))) return null;
  switch (job.state) {
    case "queued":
      return { text: t("Queued for agent"), icon: "Clock", tone: "info" };
    case "starting":
      return { text: t("Starting agent…"), tone: "active" };
    case "working":
      return { text: t("Agent working"), tone: "active" };
    case "reviewing":
      return { text: t("Agent reviewing"), tone: "active" };
    case "retry_wait":
      return { text: t("Agent retrying"), icon: "RotateCw", tone: "warning" };
    case "needs_human":
      return { text: job.code === "permission" ? t("Agent needs permission") : t("Agent waiting for you"), icon: "Hand", tone: "warning" };
    case "waiting":
      return { text: t("Waiting on sub-cards"), icon: "ListTree", tone: "info" };
    case "delivered":
      if (job.verdict === "approved") return { text: t("Agent review passed"), icon: "BadgeCheck", tone: "success" };
      return job.verdict ? { text: t("Review needs you"), icon: "TriangleAlert", tone: "warning" } : null;
    case "failed":
      return { text: t("Automation stopped"), icon: "OctagonX", tone: "danger" };
    case "stopped":
      return null;
  }
}

const isFinished = (task: Pick<Task, "status">) => task.status === "done" || task.status === "cancelled";

export function SignalMark({ signal }: { signal: AutomationSignal }) {
  const { colors } = useTheme();
  const color = signal.tone === "active" ? colors.accent : toneColor(colors, signal.tone);
  return signal.icon ? <Icon name={signal.icon} size={13} color={color} /> : <PulseDot color={color} size={7} active={signal.tone === "active"} />;
}

/** Queue / stop with a toast; the board refreshes after either. */
export function useAutomationActions() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const queue = useRpc(rpc.queueAutomation),
    stop = useRpc(rpc.stopAutomation);
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setPending(true);
    try {
      await action();
      toast.show(done, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setPending(false);
    }
  };
  return {
    pending,
    queue: (taskId: string) => run(() => queue({ taskId }), t("Queued for the agent")),
    stop: (taskId: string) => run(() => stop({ taskId }), t("Automation stopped")),
  };
}

/** The card's menu entries: Run with agent while the project has automation on, Stop while a job is live. */
export function automationMenu(project: Project | undefined, task: Task, job: AutomationJob | undefined, locked: boolean, actions: ReturnType<typeof useAutomationActions>) {
  if (isLive(job)) return [{ id: "automation-stop", label: t("Stop automation"), icon: "CircleStop", disabled: locked || actions.pending, onPress: () => void actions.stop(task.id) }];
  if (!automationOf(project) || isFinished(task)) return [];
  return [{ id: "automation-run", label: t("Run with agent"), icon: "Bot", disabled: locked || actions.pending, onPress: () => void actions.queue(task.id) }];
}

/**
 * The drawer's automation row (AUTOMATION-SPEC §6.2): what the agent is doing
 * or why it stopped, the counters behind it, and Run / Stop.
 */
export function TaskAutomation({ task, project, active }: { task: Task; project: Project; active: boolean }) {
  const { colors } = useTheme();
  const board = useBoardQuery();
  const actions = useAutomationActions();
  const job = board.data?.automation.find((j) => j.taskId === task.id);
  const settings = automationOf(project);
  if (!settings && !job) return null;
  const signal = automationSignal(job, task);
  const live = isLive(job);
  const locked = !active || !!task.archivedAt || !!project.archivedAt;
  const finished = isFinished(task);
  // A delivery someone accepted (or a parent's agent, for a sub-card) is no longer waiting for a review.
  const status =
    signal?.text ?? (job?.state === "stopped" || job?.state === "failed" ? t("Automation stopped") : job?.state === "delivered" ? (finished ? t("Finished") : t("Delivered; your review")) : t("Not running"));
  const counters = [
    job?.reviewRounds && settings?.reviewer ? t("Review round {n} of {max}", { n: job.reviewRounds, max: settings.maxReviewRounds }) : "",
    job?.nudges && settings ? t("Reminder {n} of {max}", { n: job.nudges, max: settings.nudgeLimit }) : "",
    job?.failures && settings ? t("Failed turns: {n} of {max}", { n: job.failures, max: settings.failureLimit }) : "",
  ].filter(Boolean);
  return (
    <View
      testID="task-automation"
      style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingVertical: space[2], paddingHorizontal: space[3], borderRadius: 8, borderWidth: 1, borderColor: colors.border }}
    >
      <View style={{ paddingTop: 3 }}>{signal ? <SignalMark signal={signal} /> : <Icon name="Bot" size={13} color={colors.foregroundMuted} />}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size={font.md}>
          <Label medium size={font.md}>{t("Agent automation")}</Label>
          {` · ${status}`}
        </Label>
        {!!job?.code && (job.state !== "needs_human" || job.code !== "permission") && (
          <Label muted size={font.sm}>{reasons[job.code]}</Label>
        )}
        {!!job?.detail && (
          <Label muted size={font.sm} lines={3}>
            {job.detail}
          </Label>
        )}
        {!!counters.length && <Label muted size={font.sm}>{counters.join(" · ")}</Label>}
        {!settings && <Label muted size={font.sm}>{t("Agent automation is off for this project.")}</Label>}
      </View>
      {live ? (
        <Button small quiet icon="CircleStop" disabled={locked || actions.pending} onPress={() => void actions.stop(task.id)}>
          {t("Stop")}
        </Button>
      ) : settings && !finished ? (
        <Button small icon="Bot" disabled={locked || actions.pending} onPress={() => void actions.queue(task.id)}>
          {job ? t("Run again") : t("Run with agent")}
        </Button>
      ) : null}
    </View>
  );
}

const defaults = { enabled: true, maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 } satisfies AutomationSettings;

/** Edit project → Agent automation (AUTOMATION-SPEC §2). Turning it off keeps the other choices. */
export function AutomationSettingsGroup({
  value,
  onChange,
}: {
  value: AutomationSettings | null;
  onChange(next: AutomationSettings): void;
}) {
  const current = value ?? { ...defaults, enabled: false };
  const set = (patch: Partial<AutomationSettings>) => onChange({ ...current, ...patch });
  const model = (key: "implementer" | "reviewer", next: AgentModel | null) => {
    const { [key]: _drop, ...rest } = current;
    onChange(next ? { ...rest, [key]: next } : rest);
  };
  return (
    <View style={{ gap: space[3] }}>
      <Toggle
        title={t("Agent automation")}
        detail={t("Run with agent queues a card. Flowly starts an agent when its blockers are Done and a slot is free, reminds it when a turn ends without a delivery, retries failed turns and can have a second agent review the delivery. Done stays your decision.")}
        value={current.enabled}
        onChange={(enabled) => set({ enabled })}
      />
      {current.enabled && (
        <>
          <Choices
            title={t("Cards at once")}
            value={String(current.maxRunning)}
            options={["1", "2", "3", "5"].map((n) => ({ value: n, label: n }))}
            onChange={(n) => set({ maxRunning: Number(n) })}
          />
          <ModelDefaultGroup
            title={t("Implementer")}
            description={t("The model that works on queued cards.")}
            value={current.implementer ?? null}
            noneLabel={t("Project default model")}
            onChange={(next) => model("implementer", next)}
          />
          <ModelDefaultGroup
            title={t("Reviewer")}
            description={t("A second agent reviews each delivery and can send it back with requested changes.")}
            value={current.reviewer ?? null}
            noneLabel={t("No agent review")}
            onChange={(next) => model("reviewer", next)}
          />
          {!!current.reviewer && (
            <Choices
              title={t("Review rounds")}
              value={String(current.maxReviewRounds)}
              options={["1", "2", "3"].map((n) => ({ value: n, label: n }))}
              onChange={(n) => set({ maxReviewRounds: Number(n) })}
            />
          )}
          <Toggle
            title={t("Full access")}
            detail={t("Agents run without asking for permissions (Claude bypass, Codex full access). Off: they may stop to ask, and the card shows it.")}
            value={current.fullAccess}
            onChange={(fullAccess) => set({ fullAccess })}
          />
        </>
      )}
    </View>
  );
}
