import { useEffect, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { motionDuration, useMotionValue } from "./motion";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { AUTO_MODELS, modelLabel, summarySettings, summarySettingsValues, type SummarySettings } from "../shared/summary";
import { Modal } from "./modal";
import { statusSettings, statusSettingsValues, wrapupSettings, wrapupSettingsValues } from "../shared/settings";
import { PickerGroup, PickerRow } from "./picker";
import { modelOptions, providerOptions } from "./options";
import { Label, Notice, Theme, Toggle, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";

const AUTO = "";

/**
 * Floating bottom-left settings button: a rounded square that rises in on mount,
 * lifts on hover, presses in, and stays highlighted while its modal is open.
 */
export function SettingsFab({ open = false, onPress }: { open?: boolean; onPress(): void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false),
    [pressed, setPressed] = useState(false),
    [focused, setFocused] = useState(false);
  const lit = open || hovered || focused;
  const shown = useMotionValue(1, motionDuration.forward, 0);
  const lift = useMotionValue(pressed ? 0.94 : lit ? 1.04 : 1);
  const turn = useMotionValue(open ? 1 : hovered ? 0.5 : 0, motionDuration.forward);
  const size = touch ? 44 : 36;
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: space[3],
        bottom: space[3],
        opacity: shown,
        transform: [
          { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          { scale: lift },
        ],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ultra Kanban settings"
        accessibilityState={{ expanded: open }}
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...noFocusRing,
          width: size,
          height: size,
          borderRadius: radius.lg,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: open || focused ? colors.accent : hovered ? tint(colors.foregroundMuted, 0.45) : colors.border,
          backgroundColor: lit ? colors.surface2 : colors.surface1,
          shadowColor: "#000",
          shadowOpacity: lit ? 0.16 : 0.08,
          shadowRadius: lit ? 10 : 6,
          shadowOffset: { width: 0, height: lit ? 4 : 2 },
          elevation: lit ? 4 : 2,
        }}
      >
        <Animated.View style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
          <Icon name="Settings" size={17} color={lit ? colors.foreground : colors.foregroundMuted} />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

/** Ultra Kanban settings: per-turn progress summary (TASK-SUMMARY-SPEC §4), automatic status rules and wrap-up on finish. */
export function SettingsModal({ open, theme, onClose }: { open: boolean; theme: PluginTheme; onClose(): void }) {
  return (
    <Modal
      open={open}
      title="Ultra Kanban settings"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: space[4], gap: space[3] }}>
        <Theme.Provider value={theme}>
          <SummarySettingsBody active={open} />
          <StatusSettingsBody />
          <WrapupSettingsBody />
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function SummarySettingsBody({ active }: { active: boolean }) {
  const settings = useSettings(summarySettings);
  const paseo = usePaseo();
  const values = settings.status === "ready" ? summarySettingsValues(settings.values) : null;
  const stored = values?.summaryModel || AUTO;
  const storedProvider = stored ? stored.slice(0, stored.indexOf("/")) : AUTO;
  // The provider shown can run ahead of the stored model until a model is picked.
  const [provider, setProvider] = useState(storedProvider);
  const [picker, setPicker] = useState<"provider" | "model" | null>(null);
  useEffect(() => setProvider(storedProvider), [storedProvider]);
  const providers = useQuery({
    queryKey: ["ultra", "providers"],
    queryFn: () => paseo.providers.listAvailable(),
    enabled: active,
  });
  const providerInfo = useQuery({
    queryKey: ["ultra", "providerSnapshot"],
    queryFn: () => paseo.providers.snapshot(),
    enabled: active,
    staleTime: 60000,
  });
  const models = useQuery({
    queryKey: ["ultra", "summary-models", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: active && provider !== AUTO,
  });
  const save = (patch: Partial<SummarySettings>) => {
    if (settings.status !== "ready" || !values) return;
    void settings.save({ ...values, ...patch }, settings.revision).then((saved) => {
      if (!saved) void settings.reload();
    });
  };
  const autoLabel = `Auto (${AUTO_MODELS.map(modelLabel).join(", then ")})`;
  const storedModel = stored && provider === storedProvider ? stored.slice(stored.indexOf("/") + 1) : "";
  const modelChoices = modelOptions(models.data?.models || []);
  const busy = !values || settings.saving;
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[1] }}>
        <Label bold size={font.md} selectable={false}>
          Task progress summary
        </Label>
        <Label muted size={font.sm}>
          After each agent turn on a card, a cheap model updates the card's state, recap and next step. It runs as a short child session that is archived right after.
        </Label>
      </View>
      {(settings.status === "error" || settings.status === "invalid") && <Notice>{settings.error}</Notice>}
      {!!settings.saveError && <Notice>{settings.saveError}</Notice>}
      <Toggle
        title="Auto summary"
        detail="Update after every completed turn. Refresh on a card always works."
        value={values?.summaryEnabled ?? true}
        onChange={(summaryEnabled) => !busy && save({ summaryEnabled })}
      />
      <PickerGroup>
        <PickerRow
          first
          title="Provider"
          icon="Bot"
          open={picker === "provider"}
          disabled={busy}
          loading={providers.isPending}
          value={provider}
          placeholder={autoLabel}
          options={[
            { value: AUTO, label: autoLabel, detail: "Uses Claude when available, otherwise Codex" },
            ...providerOptions(providers.data?.providers || [], providerInfo.data?.entries || []),
          ]}
          onToggle={() => setPicker(picker === "provider" ? null : "provider")}
          onChange={(next) => {
            setPicker(next === AUTO ? null : "model");
            setProvider(next);
            if (next === AUTO) save({ summaryModel: "" });
          }}
        />
        {provider !== AUTO && (
          <PickerRow
            title="Model"
            icon="Cpu"
            open={picker === "model"}
            disabled={busy}
            loading={models.isPending}
            value={storedModel}
            placeholder="Choose a model"
            options={modelChoices}
            onToggle={() => setPicker(picker === "model" ? null : "model")}
            onChange={(model) => {
              setPicker(null);
              save({ summaryModel: `${provider}/${model}` });
            }}
          />
        )}
      </PickerGroup>
      {provider !== AUTO && !storedModel && (
        <Label muted size={font.sm}>
          Pick a model to use this provider. Until then the stored choice stays: {stored ? stored : autoLabel}.
        </Label>
      )}
      {models.error && <Notice tone="warning">Could not list models: {String((models.error as Error).message || models.error)}</Notice>}
    </View>
  );
}

function StatusSettingsBody() {
  const settings = useSettings(statusSettings);
  const values = settings.status === "ready" ? statusSettingsValues(settings.values) : null;
  return (
    <View style={{ gap: space[3], paddingTop: space[2] }}>
      <View style={{ gap: space[1] }}>
        <Label bold size={font.md} selectable={false}>
          Moving cards
        </Label>
        <Label muted size={font.sm}>
          Agents always set their own work stage and deliver to review. These rules react to session activity on top of that.
        </Label>
      </View>
      {(settings.status === "error" || settings.status === "invalid") && <Notice>{settings.error}</Notice>}
      {!!settings.saveError && <Notice>{settings.saveError}</Notice>}
      <Toggle
        title="Auto-update status from sessions"
        detail="A Kanban session resuming after review moves the card to Development, after a blocker back to its previous stage; a turn that ends without a report puts a reviewed card back. A project can still turn this off in its settings."
        value={values?.autoStatus ?? true}
        onChange={(autoStatus) => {
          if (settings.status !== "ready" || !values || settings.saving) return;
          void settings.save({ ...values, autoStatus }, settings.revision).then((saved) => {
            if (!saved) void settings.reload();
          });
        }}
      />
    </View>
  );
}

function WrapupSettingsBody() {
  const settings = useSettings(wrapupSettings);
  const values = settings.status === "ready" ? wrapupSettingsValues(settings.values) : null;
  return (
    <View style={{ gap: space[3], paddingTop: space[2] }}>
      <View style={{ gap: space[1] }}>
        <Label bold size={font.md} selectable={false}>
          Finishing cards
        </Label>
        <Label muted size={font.sm}>
          When a card moves to Done or Cancelled, you are asked whether to wrap it up: archive its workspace and sessions. The card stays on the board.
        </Label>
      </View>
      {(settings.status === "error" || settings.status === "invalid") && <Notice>{settings.error}</Notice>}
      {!!settings.saveError && <Notice>{settings.saveError}</Notice>}
      <Toggle
        title="Auto wrap up"
        detail="Archive without asking when nothing blocks it: no running session, no uncommitted or unpushed work. Otherwise the card is left for manual Wrap up."
        value={values?.autoWrapup ?? false}
        onChange={(autoWrapup) => {
          if (settings.status !== "ready" || !values || settings.saving) return;
          void settings.save({ ...values, autoWrapup }, settings.revision).then((saved) => {
            if (!saved) void settings.reload();
          });
        }}
      />
      <Toggle
        title="Auto archive on delete"
        detail="When you delete a card, also archive its sessions (and its own workspace) without asking, when nothing blocks it. Otherwise the delete dialog asks."
        value={values?.archiveOnDelete ?? false}
        onChange={(archiveOnDelete) => {
          if (settings.status !== "ready" || !values || settings.saving) return;
          void settings.save({ ...values, archiveOnDelete }, settings.revision).then((saved) => {
            if (!saved) void settings.reload();
          });
        }}
      />
    </View>
  );
}
