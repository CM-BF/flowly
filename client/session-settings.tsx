import type { ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PaseoAgent } from "@getpaseo/client";
import * as rpc from "../shared/rpc";
import { Label, font, message, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { useMotionPresence, lerp } from "./motion";

type Feature = NonNullable<PaseoAgent["features"]>[number];
export type ChipMenuId = "model" | "thinking" | "mode";

const featureValue = (f: Feature) =>
  f.type === "toggle"
    ? f.value
      ? "On"
      : "Off"
    : f.options.find((o) => o.id === f.value)?.label || f.value || "Default";

/**
 * Session configuration for the composer chips. Reasoning / permissions / stop
 * go through the plugin daemon (official CLI); model and provider features are
 * read-only because the plugin SDK has no API to change them.
 */
export function useSessionConfig(taskId: string, agent: PaseoAgent | undefined, enabled: boolean, onChanged: () => void) {
  const paseo = usePaseo(),
    configure = useRpc(rpc.configureSession),
    toast = useToast();
  const models = useQuery({
    queryKey: ["ultra", "models", agent?.provider, agent?.cwd],
    queryFn: async () => {
      const result = await paseo.providers.listModels(agent!.provider, { cwd: agent!.cwd });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: enabled && !!agent,
    staleTime: 60000,
  });
  const model = models.data?.models?.find((m) => m.id === agent?.model);
  const thinking = model?.thinkingOptions || [];
  const currentThinking = agent?.thinkingOptionId || model?.defaultThinkingOptionId || "";
  async function apply(change: { thinkingOptionId?: string; modeId?: string; stop?: boolean }, done: string) {
    if (!agent) return;
    try {
      await configure({ taskId, agentId: agent.id, ...change });
      toast.show(done, { variant: "success" });
      onChanged();
    } catch (e) {
      toast.error(message(e));
    }
  }
  return {
    modelLabel: model?.label || agent?.model || "Default model",
    features: agent?.features || [],
    thinking,
    currentThinking,
    thinkingLabel: thinking.find((t) => t.id === currentThinking)?.label || "",
    modes: agent?.availableModes || [],
    modeLabel: agent?.availableModes?.find((m) => m.id === agent.currentModeId)?.label || "",
    currentMode: agent?.currentModeId || "",
    defaultThinking: model?.defaultThinkingOptionId,
    apply,
  };
}
export type SessionConfig = ReturnType<typeof useSessionConfig>;

function Chip({ icon, text, open, disabled, onPress, label }: {
  icon: string;
  text: string;
  open: boolean;
  disabled?: boolean;
  onPress(): void;
  label: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: touch ? 32 : 26,
          maxWidth: 180,
          paddingHorizontal: space[2],
          borderRadius: radius.md,
          backgroundColor: open || hover || focused || pressed ? colors.surface2 : "transparent",
          opacity: disabled ? 0.5 : 1,
        };
      }}
    >
      <Icon name={icon} size={13} color={colors.foregroundMuted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label size={font.sm} medium lines={1} selectable={false}>
          {text}
        </Label>
      </View>
      <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
    </Pressable>
  );
}

type MenuItem = { id: string; label: string; detail?: string; badge?: string; selected?: boolean; disabled?: boolean; onPress?(): void };

/** Floating (desktop) or inline (sheet) menu with a short fade/rise. */
export function ChipMenu({ open, items, inline, footer }: { open: boolean; items: MenuItem[]; inline: boolean; footer?: ReactNode }) {
  const { colors } = useTheme();
  const presence = useMotionPresence(open ? true : undefined, open ? "menu" : "");
  if (!presence.item) return null;
  return (
    <Animated.View
      pointerEvents={presence.active ? "auto" : "none"}
      style={[
        inline
          ? { marginTop: space[1] }
          : { position: "absolute", left: 0, bottom: "100%", marginBottom: 6, minWidth: 240, maxWidth: 320, zIndex: 30 },
        {
          padding: 4,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          shadowColor: "#000",
          shadowOpacity: inline ? 0 : 0.12,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          opacity: presence.progress,
          transform: [{ translateY: lerp(presence.progress, [6, 0]) }],
        },
      ]}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: !!item.selected, disabled: !!item.disabled }}
          disabled={item.disabled || !item.onPress}
          onPress={item.onPress}
          style={(state) => {
            const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
            return {
              ...noFocusRing,
              flexDirection: "row",
              alignItems: "center",
              gap: space[2],
              minHeight: touch ? 44 : item.detail ? 40 : 30,
              paddingHorizontal: space[2] + 2,
              paddingVertical: 4,
              borderRadius: radius.md,
              backgroundColor: item.selected ? tint(colors.accent, 0.08) : hover || focused || pressed ? colors.surface1 : "transparent",
              opacity: item.disabled ? 0.5 : 1,
            };
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
              <Label size={font.md} medium={item.selected} lines={1} selectable={false}>{item.label}</Label>
              {!!item.badge && <Label muted size={font.xs} selectable={false}>{item.badge}</Label>}
            </View>
            {!!item.detail && <Label muted size={font.xs} lines={2} selectable={false}>{item.detail}</Label>}
          </View>
          {item.selected && <Icon name="Check" size={14} color={colors.accent} />}
        </Pressable>
      ))}
      {footer}
    </Animated.View>
  );
}

/** Model · Reasoning · Permissions chips under the composer (Paseo layout). */
export function ComposerChips({
  config,
  menu,
  setMenu,
  inline,
  disabled,
  onOpenInPaseo,
}: {
  config: SessionConfig;
  menu: ChipMenuId | null;
  setMenu(menu: ChipMenuId | null): void;
  inline: boolean;
  disabled: boolean;
  onOpenInPaseo?: () => void;
}) {
  const { colors } = useTheme();
  const toggle = (id: ChipMenuId) => setMenu(menu === id ? null : id);
  const fast = config.features.filter((f) => f.type === "toggle" && f.value);
  const menuFor = (id: ChipMenuId) =>
    id === "model" ? (
      <ChipMenu
        open={menu === "model"}
        inline={inline}
        items={[
          { id: "current", label: config.modelLabel, detail: "Current model", selected: true },
          ...config.features.map((f) => ({ id: f.id, label: f.label, detail: featureValue(f) })),
        ]}
        footer={
          <View style={{ padding: space[2], gap: space[1.5], borderTopWidth: 1, borderColor: colors.border, marginTop: 4 }}>
            <Label muted size={font.xs}>Plugins cannot switch the model or features like Fast mode yet.</Label>
            {onOpenInPaseo && (
              <Pressable accessibilityRole="button" onPress={onOpenInPaseo} style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="ArrowUpRight" size={13} color={colors.accent} />
                <Label size={font.sm} medium color={colors.accent} selectable={false}>Change in Paseo</Label>
              </Pressable>
            )}
          </View>
        }
      />
    ) : id === "thinking" ? (
      <ChipMenu
        open={menu === "thinking"}
        inline={inline}
        items={config.thinking.map((t) => ({
          id: t.id,
          label: t.label,
          detail: t.description,
          badge: t.id === config.defaultThinking ? "Default" : undefined,
          selected: t.id === config.currentThinking,
          onPress: () => {
            setMenu(null);
            if (t.id !== config.currentThinking) void config.apply({ thinkingOptionId: t.id }, `Reasoning: ${t.label}`);
          },
        }))}
      />
    ) : (
      <ChipMenu
        open={menu === "mode"}
        inline={inline}
        items={config.modes.map((m) => ({
          id: m.id,
          label: m.label,
          detail: m.description,
          selected: m.id === config.currentMode,
          onPress: () => {
            setMenu(null);
            if (m.id !== config.currentMode) void config.apply({ modeId: m.id }, `Permissions: ${m.label}`);
          },
        }))}
      />
    );
  const chip = (id: ChipMenuId, node: ReactNode) => (
    <View key={id} style={{ position: "relative" }}>
      {!inline && menuFor(id)}
      {node}
    </View>
  );
  return (
    <View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
        {chip("model", (
          <Chip icon="Cpu" text={`${config.modelLabel}${fast.length ? ` · ${fast.map((f) => f.label).join(", ")}` : ""}`} label={`Model: ${config.modelLabel}`} open={menu === "model"} disabled={disabled} onPress={() => toggle("model")} />
        ))}
        {config.thinking.length > 0 &&
          chip("thinking", (
            <Chip icon="Brain" text={config.thinkingLabel || "Reasoning"} label={`Reasoning: ${config.thinkingLabel || "default"}`} open={menu === "thinking"} disabled={disabled} onPress={() => toggle("thinking")} />
          ))}
        {config.modes.length > 0 &&
          chip("mode", (
            <Chip icon="ShieldCheck" text={config.modeLabel || "Permissions"} label={`Permissions: ${config.modeLabel || "default"}`} open={menu === "mode"} disabled={disabled} onPress={() => toggle("mode")} />
          ))}
      </View>
      {inline && menu && menuFor(menu)}
    </View>
  );
}
