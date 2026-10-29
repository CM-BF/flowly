import { laneName } from "../shared/lanes";
import { useState, type Dispatch, type SetStateAction } from "react";
import { View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Project, Task } from "../shared/model";
import {
  activeAgent,
  automationOf,
  deepPanelSize,
  isLive,
  levelChoice,
  levelRounds,
  panelChoice,
  panelDefaults,
  readiness,
  resolveReviewLevel,
  reviewersFor,
  type AutomationJob,
  type AutomationSettings,
} from "../shared/automation";
import { automationReason, automationSignal, deepPanelNone, levelLines, panelFields, reviewRoundText, risksHeading, type AutomationActions, type AutomationSignal } from "./automation-view";
import { Disclosure } from "./disclosure";
import type { AgentModel } from "../shared/agent-defaults";
import { invalidateCardViews, useTaskDetail } from "./card-detail-query";
import { useOverviewQuery } from "./queries";
import { PulseDot } from "./motion";
import { ModelDefaultGroup } from "./model-default";
import { Button, Choices, Label, TextBox, Toggle, font, message, radius, space, toneColor, useTheme, type Tone } from "./ui";
import { t } from "../shared/i18n";

const isFinished = (task: Pick<Task, "status">) => task.status === "done" || task.status === "cancelled";

export function SignalMark({ signal }: { signal: AutomationSignal }) {
  const { colors } = useTheme();
  const color = signal.tone === "active" ? colors.accent : toneColor(colors, signal.tone);
  return signal.icon ? <Icon name={signal.icon} size={13} color={color} /> : <PulseDot color={color} size={7} active={signal.tone === "active"} />;
}

/** Queue / stop with a toast; the card views (overview, card detail) refresh after either. */
export function useAutomationActions(): AutomationActions {
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
      await invalidateCardViews(queryClient);
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

/**
 * The drawer's automation row (AUTOMATION-SPEC §6.2): what the agent is doing
 * or why it stopped, the counters behind it, and Run / Stop.
 */
export function TaskAutomation({ task, project, active, unavailable = false }: { task: Task; project: Project; active: boolean; unavailable?: boolean }) {
  const { colors } = useTheme();
  // The card's job rides on its detail (polled while the drawer is open); blockers and the review level's ancestors
  // come from the overview (on phones, read once while the board pauses under an open card). Never the whole board.
  const { hostId, detail } = useTaskDetail();
  const overview = useOverviewQuery(hostId, { enabled: active });
  const actions = useAutomationActions();
  const job = detail?.automation.find((j) => j.taskId === task.id) ?? overview.data?.automation.find((j) => j.taskId === task.id);
  // Classification input includes the card's acceptance criteria, so its own workpad keeps the fingerprint the daemon's.
  const levelBoard = overview.data ? { tasks: overview.data.tasks, links: overview.data.links, workpads: detail?.workpad ? [detail.workpad] : [] } : null;
  const settings = automationOf(project);
  if (!settings && !job) return null;
  const signal = automationSignal(job, task);
  const live = isLive(job);
  const locked = !active || unavailable || !!task.archivedAt || !!project.archivedAt;
  const ready = overview.data && job?.state === "queued" ? readiness(overview.data, task.id) : null;
  const held = ready && !ready.ready && ready.reason === "blockers" ? [...ready.waiting, ...ready.cancelled] : [];
  const finished = isFinished(task);
  const reason = automationReason(job);
  // A delivery someone accepted (or a parent's agent, for a sub-card) is no longer waiting for a review.
  const status =
    signal?.text ?? (job?.state === "stopped" || job?.state === "failed" ? t("Automation stopped") : job?.state === "delivered" ? (finished ? t("Finished") : task.status === "in_review" ? t("Delivered; your review") : t("Not running")) : t("Not running"));
  const plan = job?.review;
  // The level the card resolves to now, for the drawer's "Next review round" line; none once the card is finished.
  const levels = job && levelBoard ? levelLines(job, finished ? null : resolveReviewLevel(levelBoard, task)) : [];
  const counters = [
    // A round with a recorded plan says its level (AUTOMATION-SPEC §5.2.5); while it runs, the status line already does.
    job?.reviewRounds && settings?.reviewer
      ? plan
        ? job.state === "reviewing" ? "" : reviewRoundText(job.reviewRounds, plan)
        : reviewersFor(settings, job.reviewRounds) > 1
          ? t("Panel review round {n} of {max}", { n: job.reviewRounds, max: settings.maxReviewRounds })
          : t("Review round {n} of {max}", { n: job.reviewRounds, max: settings.maxReviewRounds })
      : "",
    job?.nudges && settings ? t("Reminder {n} of {max}", { n: job.nudges, max: settings.nudgeLimit }) : "",
    job?.historyWarning && live && job.historyWarning.agentId === activeAgent(job) ? job.historyWarning.level === "critical" || job.historyWarning.bytes >= 300 * 2 ** 20
      ? t("Session history {n} MB, still growing: inspect it and stop this session in Paseo", { n: Math.round(job.historyWarning.bytes / 2 ** 20) })
      : t("Session history {n} MB: the next instruction goes to a fresh session", { n: Math.round(job.historyWarning.bytes / 2 ** 20) }) : "",
    job?.silentSince && live ? t("Agent has not updated the card for {n} min", { n: Math.max(0, Math.floor((Date.now() - Date.parse(job.silentSince)) / 60000)) }) : "",
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
        {!!held.length && <Label muted size={font.sm}>{t("Waiting for blockers to be Done: {cards}", { cards: held.map((card) => `${card.title} (${laneName(project, card.status)})`).join(", ") })}</Label>}
        {!!reason && <Label muted size={font.sm}>{reason}</Label>}
        {!!job?.rotation?.policy?.reason && <Label muted size={font.sm}>{job.rotation.policy.reason}</Label>}
        {live && !!job?.fallback?.[job.role] && <Label muted size={font.sm}>{t("On the fallback model after a provider limit")}</Label>}
        {!!job?.detail && !["working", "reviewing", "starting"].includes(job.state) && (
          <Label muted size={font.sm} lines={3}>
            {job.detail}
          </Label>
        )}
        {!!counters.length && <Label muted size={font.sm}>{counters.join(" · ")}</Label>}
        {levels.map((line) => (
          <Label key={line} muted size={font.sm}>{line}</Label>
        ))}
        {!!job?.risks?.length && (
          <View testID="task-automation-risks" style={{ gap: 2, paddingTop: space[1] }}>
            <Label medium size={font.sm} color={colors.statusWarning}>{risksHeading(job)}</Label>
            {job.risks.map((risk, index) => (
              <Label key={index} size={font.sm} selectable>{`• ${risk}`}</Label>
            ))}
          </View>
        )}
        {!settings && <Label muted size={font.sm}>{t("Agent automation is off for this project.")}</Label>}
      </View>
      {live ? (
        <Button small quiet icon="CircleStop" label={t("Stop automation")} disabled={!active || actions.pending} onPress={() => void actions.stop(task.id)}>
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

// A project turning automation on for the first time starts adaptive (AUTOMATION-SPEC §5.6); settings saved before the
// mode existed carry no mode and stay managed.
const defaults = { enabled: true, mode: "adaptive", maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 } satisfies AutomationSettings;

/** Panel review (AUTOMATION-SPEC §5.1): when serial review rounds escalate to several reviewers at once. */
function PanelSettings({
  current,
  set,
  model,
  cwd,
}: {
  current: AutomationSettings;
  set: (patch: Partial<AutomationSettings>) => void;
  model: (key: "panelReviewer", next: AgentModel | null) => void;
  cwd?: string;
}) {
  const after = current.panelAfter === undefined ? panelDefaults.after : current.panelAfter;
  const fields = panelFields(current);
  return (
    <>
      <Choices
        title={t("Panel review")}
        value={after === null ? "off" : String(after)}
        options={[
          { value: "off", label: t("Off") },
          { value: "0", label: t("Every round") },
          { value: "1", label: t("After 1 round with changes") },
          ...["2", "3"].map((n) => ({ value: n, label: t("After {n} rounds with changes", { n }) })),
        ]}
        onChange={(v) => {
          const patch = panelChoice(current, "panelAfter", v === "off" ? null : Number(v));
          if (patch) set(patch);
        }}
      />
      <Label muted size={font.sm}>
        {t("When serial reviews keep requesting changes, the next round is checked by several reviewers in parallel, each from its own focus, and every confirmed problem goes to the implementer at once.")}
      </Label>
      {fields.outOfReach && (
        <Label muted size={font.sm}>
          {t("With {n} review rounds a Standard card never reaches a panel round: allow more Review rounds or start the panel earlier. Deep cards still get a panel every round.", { n: current.maxReviewRounds })}
        </Label>
      )}
      {/* Shown even when Standard cards never panel: Deep cards run every round as a panel on this model (§5.2.3). */}
      {fields.panelReviewer && (
        <ModelDefaultGroup execution cwd={cwd}
          title={t("Panel reviewer")}
          description={t("The model panel rounds run on, Deep cards' panels too unless Review levels gives them their own; best one that can start subagents (such as Claude). None: the reviewer's model.")}
          value={current.panelReviewer ?? null}
          noneLabel={t("Same as reviewer")}
          onChange={(next) => model("panelReviewer", next)}
        />
      )}
      {fields.panelSize && (
        <Choices
          title={t("Reviewers in a panel")}
          value={String(current.panelSize ?? panelDefaults.size)}
          options={["2", "3", "4", "5"].map((n) => ({ value: n, label: n }))}
          onChange={(n) => {
            const patch = panelChoice(current, "panelSize", Number(n));
            if (patch) set(patch);
          }}
        />
      )}
    </>
  );
}

/**
 * Review levels (AUTOMATION-SPEC §5.2.5): the models, panel size and rounds of Light and Deep cards, folded under one
 * line. Every choice goes through `levelChoice`, so only what a person changed is stored.
 */
function LevelSettingsGroup({ current, set, cwd }: { current: AutomationSettings; set: (patch: Partial<AutomationSettings>) => void; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const choose = (level: "light" | "deep", key: "reviewer" | "maxReviewRounds" | "panelReviewer" | "panelSize", value: number | AgentModel | null) => {
    const patch = levelChoice(current, level, key, value);
    if (patch) set(patch);
  };
  const rounds = ["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n }));
  const summary = t("Rounds: Light {light} · Deep {deep}, panel of {size}", { light: levelRounds(current, "light"), size: deepPanelSize(current), deep: levelRounds(current, "deep") });
  return (
    <Disclosure title={t("Review levels")} summary={summary} open={open} onChange={setOpen}>
      <View style={{ gap: space[3] }}>
        <Label muted size={font.sm}>
          {t("Each card is reviewed at its level. Auto follows explicit levels and review tags, then asks the Summary models what this card changes. The result is reused until the card changes; keywords are only a fallback. Set a card's level in Edit task.")}
        </Label>
        <ModelDefaultGroup execution cwd={cwd}
          title={t("Light reviewer")}
          description={t("Light cards get one reviewer, never a panel.")}
          value={current.levels?.light?.reviewer ?? null}
          noneLabel={t("Same as reviewer")}
          onChange={(next) => choose("light", "reviewer", next)}
        />
        <Choices title={t("Light rounds")} value={String(levelRounds(current, "light"))} options={rounds} onChange={(n) => choose("light", "maxReviewRounds", Number(n))} />
        <ModelDefaultGroup execution cwd={cwd}
          title={t("Deep panel reviewer")}
          description={t("Deep cards get a panel from the first round: contract and correctness, design and scale, failure, data safety and security, then execution and integration.")}
          value={current.levels?.deep?.panelReviewer ?? null}
          noneLabel={deepPanelNone(current)}
          onChange={(next) => choose("deep", "panelReviewer", next)}
        />
        <Choices
          title={t("Deep reviewers")}
          value={String(deepPanelSize(current))}
          options={["2", "3", "4", "5"].map((n) => ({ value: n, label: n }))}
          onChange={(n) => choose("deep", "panelSize", Number(n))}
        />
        <Choices title={t("Deep rounds")} value={String(levelRounds(current, "deep"))} options={rounds} onChange={(n) => choose("deep", "maxReviewRounds", Number(n))} />
      </View>
    </Disclosure>
  );
}

/** Edit project → Agent automation (AUTOMATION-SPEC §2). Turning it off keeps the other choices. */
export function AutomationSettingsGroup({
  value,
  onChange,
  cwd,
}: {
  value: AutomationSettings | null;
  cwd?: string;
  onChange: Dispatch<SetStateAction<AutomationSettings | null>>;
}) {
  const current = value ?? { ...defaults, enabled: false };
  const set = (patch: Partial<AutomationSettings>) => onChange((previous) => ({ ...(previous ?? { ...defaults, enabled: false }), ...patch }));
  const model = (key: "implementer" | "reviewer" | "implementerFallback" | "reviewerFallback" | "panelReviewer", next: AgentModel | null) => {
    onChange((previous) => {
      const { [key]: _drop, ...rest } = previous ?? { ...defaults, enabled: false };
      return next ? { ...rest, [key]: next } : rest;
    });
  };
  // Stored only while on (AUTOMATION-SPEC §5.3.4): builds without it refuse a board whose project settings carry the key.
  // Acceptance-test review (AUTOMATION-SPEC §5.4): stored only while on; the author model only while one is chosen.
  const acceptance = (next: { author?: AgentModel } | null) =>
    onChange((previous) => {
      const { acceptance: _drop, ...rest } = previous ?? { ...defaults, enabled: false };
      return next ? { ...rest, acceptance: next } : rest;
    });
  // Tournament mode (AUTOMATION-SPEC §5.5): stored only while on.
  const tournament = (size: number | null) =>
    onChange((previous) => {
      const { tournament: _drop, ...rest } = previous ?? { ...defaults, enabled: false };
      return size ? { ...rest, tournament: { ...(previous?.tournament ?? {}), size } } : rest;
    });
  const tournamentPlans = (plans: "none" | "approaches") =>
    onChange((previous) => {
      if (!previous?.tournament) return previous ?? { ...defaults, enabled: false };
      const { plans: _drop, ...tournament } = previous.tournament;
      return { ...previous, tournament: plans === "approaches" ? { ...tournament, plans } : tournament };
    });
  const adaptive = current.mode === "adaptive";
  const check = (command: string) =>
    onChange((previous) => {
      const { check: _drop, ...rest } = previous ?? { ...defaults, enabled: false };
      return command.trim() ? { ...rest, check: { ...(previous?.check ?? {}), command: command.trim() } } : rest;
    });
  const unattended = (on: boolean) =>
    onChange((previous) => {
      const { unattended: _drop, ...rest } = previous ?? { ...defaults, enabled: false };
      return on ? { ...rest, unattended: true } : rest;
    });
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
          <Label muted size={font.sm}>{t("Agent automation requires the In review lane.")}</Label>
          <Choices
            title={t("Cards at once")}
            value={String(current.maxRunning)}
            options={["1", "2", "3", "5"].map((n) => ({ value: n, label: n }))}
            onChange={(n) => set({ maxRunning: Number(n) })}
          />
          <Choices
            title={t("Mode")}
            value={adaptive ? "adaptive" : "managed"}
            options={[{ value: "adaptive", label: t("Adaptive") }, { value: "managed", label: t("Managed") }]}
            onChange={(mode) => set({ mode })}
          />
          <Label muted size={font.sm}>
            {adaptive
              ? t("Adaptive: one agent gets the card as its task, like a session you start yourself, with no review. When its context fills up, Flowly has it write down what is done and decided, and fresh sessions finish the rest.")
              : t("Managed: a reviewer checks each delivery and can send it back; acceptance tests and tournaments are available.")}
          </Label>
          <ModelDefaultGroup execution cwd={cwd}
            title={t("Implementer")}
            description={t("The model that works on queued cards.")}
            value={current.implementer ?? null}
            noneLabel={t("Project default model")}
            onChange={(next) => model("implementer", next)}
          />
          <ModelDefaultGroup execution cwd={cwd}
            title={t("Implementer fallback")}
            description={t("Used when the implementer's model reports a rate or usage limit: a new session continues the card on this model. None: the card waits for the limit to reset.")}
            value={current.implementerFallback ?? null}
            noneLabel={t("No fallback")}
            onChange={(next) => model("implementerFallback", next)}
          />
          {adaptive && <CheckCommand value={current.check?.command ?? ""} onChange={check} />}
          {!adaptive && (
            <>
          <ModelDefaultGroup execution cwd={cwd}
            title={t("Reviewer")}
            description={t("A second agent reviews each delivery and can send it back with requested changes.")}
            value={current.reviewer ?? null}
            noneLabel={t("No agent review")}
            onChange={(next) => model("reviewer", next)}
          />
          {!!current.reviewer && (
            <ModelDefaultGroup execution cwd={cwd}
              title={t("Reviewer fallback")}
              description={t("Used when the reviewer's model reports a rate or usage limit: the review round runs again on this model. None: the review waits for the limit to reset.")}
              value={current.reviewerFallback ?? null}
              noneLabel={t("No fallback")}
              onChange={(next) => model("reviewerFallback", next)}
            />
          )}
          {!!current.reviewer && (
            <Choices
              title={t("Review rounds")}
              value={String(current.maxReviewRounds)}
              options={["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n }))}
              onChange={(n) => set({ maxReviewRounds: Number(n) })}
            />
          )}
          {!!current.reviewer && <PanelSettings current={current} set={set} model={model} cwd={cwd} />}
          {!!current.reviewer && <LevelSettingsGroup current={current} set={set} cwd={cwd} />}
          {!!current.reviewer && (
            <Toggle
              title={t("Acceptance tests")}
              detail={t("When work starts, a separate session writes tests from the card alone; part of them is hidden from the implementer. Reviewers run them and request changes only for a failing check or a violated requirement; rework that does not improve the tests is undone.")}
              value={!!current.acceptance}
              onChange={(on) => acceptance(on ? {} : null)}
            />
          )}
          {!!current.reviewer && !!current.acceptance && (
            <ModelDefaultGroup execution cwd={cwd}
              title={t("Acceptance author")}
              description={t("The model that writes the acceptance tests. None: the reviewer's model.")}
              value={current.acceptance.author ?? null}
              noneLabel={t("Same as reviewer")}
              onChange={(next) => acceptance(next ? { author: next } : {})}
            />
          )}
          {!!current.reviewer && (
            <>
              <Choices
                title={t("Tournament")}
                value={current.tournament ? String(current.tournament.size) : "off"}
                options={[{ value: "off", label: t("Off") }, ...["2", "3"].map((n) => ({ value: n, label: t("{n} candidates", { n }) }))]}
                onChange={(v) => tournament(v === "off" ? null : Number(v))}
              />
              <Label muted size={font.sm}>
                {t("Several implementers each build the card on their own, in separate copies. Candidates with failing acceptance tests drop out; a judge compares the rest where they differ, and only the winner reaches the workspace. No review rounds. Costs about one extra implementation per candidate.")}
              </Label>
              {!!current.tournament && (
                <>
                  <Choices
                    title={t("Candidates")}
                    value={current.tournament.plans ?? "none"}
                    options={[{ value: "none", label: t("Independent") }, { value: "approaches", label: t("Different approaches") }]}
                    onChange={tournamentPlans}
                  />
                  <Label muted size={font.sm}>
                    {t("Independent: each candidate gets the card like a single implementer. Different approaches: a planner first fixes one reading of the card's open points for everyone and gives each candidate another way to build it.")}
                  </Label>
                </>
              )}
            </>
          )}
            </>
          )}
          <Toggle
            title={t("Full access")}
            detail={t("Agents run without asking for permissions (Claude bypass, Codex full access), whatever Permissions the implementer, the reviewer or the project default model chose. Off: those Permissions apply, agents may stop to ask, and the card shows it.")}
            value={current.fullAccess}
            onChange={(fullAccess) => set({ fullAccess })}
          />
          <Toggle
            title={t("Unattended")}
            detail={t("Nobody answers questions in this project (benchmarks, overnight runs). Agents decide open questions themselves, write down their assumptions and deliver; a question or blocker from an automated session is refused.")}
            value={!!current.unattended}
            onChange={unattended}
          />
        </>
      )}
    </View>
  );
}

/** Adaptive mode's only gate (AUTOMATION-SPEC §5.6.4): a command Flowly runs in the workspace after each delivery. */
function CheckCommand({ value, onChange }: { value: string; onChange: (command: string) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <Label size={font.md}>{t("Check command")}</Label>
      <TextBox
        accessibilityLabel={t("Check command")}
        value={value}
        onChangeText={onChange}
        commitDelay={400}
        placeholder={t("For example: npm test")}
        placeholderTextColor={colors.foregroundMuted}
        style={{ minHeight: 34, paddingHorizontal: space[2], borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, fontSize: font.md, color: colors.foreground, outlineStyle: "none" } as never}
      />
      <Label muted size={font.sm}>{t("Optional. Flowly runs it in the card's workspace after each delivery; if it fails, the agent gets its output and fixes the cause. Empty: no check.")}</Label>
    </View>
  );
}
