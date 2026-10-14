import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "@getpaseo/client";
import type { BoardEvent } from "../shared/model";
import { Dot, Label, font, relativeTime, space, tint, touch, useTheme } from "./ui";
import { sessionState } from "./session-state";
import { sessionTone } from "./status";
import type { sessionAttention } from "../shared/session-attention";

/** One row of the drawer's session list group. */
export function SessionCard({
  agent,
  events,
  highlighted,
  attention,
  readStateUnavailable,
  first = true,
  onPress,
}: {
  agent: PaseoAgent;
  events: BoardEvent[];
  highlighted?: boolean;
  attention?: ReturnType<typeof sessionAttention>;
  readStateUnavailable?: boolean;
  first?: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const state = sessionState(agent, events);
  const unread = !readStateUnavailable && !!attention?.unread && !agent.archivedAt;
  const tone = sessionTone(colors, state, unread);
  const readText = readStateUnavailable
    ? ""
    : !attention?.readKnown
      ? "Read state unknown"
      : "";
  const model = [agent.provider, agent.model].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ${agent.title || agent.id}: ${state.label}${unread ? ", unread" : ""}${!readStateUnavailable && attention?.needsAttention ? ", needs attention" : ""}`}
      onPress={onPress}
      style={(pressState) => {
        const { pressed, hovered } = pressState as typeof pressState & { hovered?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          minHeight: touch ? 64 : 56,
          paddingVertical: space[2] + 2,
          paddingLeft: space[3],
          paddingRight: space[2],
          borderTopWidth: first ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: highlighted
            ? tint(colors.accent, 0.08)
            : hovered || pressed
              ? colors.surface1
              : colors.surface0,
          opacity: agent.archivedAt ? 0.6 : 1,
        };
      }}
    >
      <View style={{ width: 10, alignItems: "center" }}>
        <Dot color={tone} size={8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label size={font.base} medium bold={unread} lines={1} selectable={false}>
              {agent.title || "Untitled session"}
            </Label>
          </View>
          <Label muted size={font.xs} selectable={false}>
            {relativeTime(agent.updatedAt)}
          </Label>
        </View>
        <Label muted size={font.sm} lines={1} selectable={false}>
          <Label
            size={font.sm}
            medium
            color={state.label === "Idle" || state.label === "Ready" || state.label === "Archived" || state.label === "Closed" ? colors.foregroundMuted : tone}
            selectable={false}
          >
            {unread && !state.active && state.label !== "Error" && state.label !== "Waiting for approval" ? `${state.label} · Unread` : state.label}
          </Label>
          {model ? ` · ${model}` : ""}
          {readText ? ` · ${readText}` : ""}
          {agent.providerUnavailable ? " · Provider unavailable" : ""}
        </Label>
      </View>
      <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
    </Pressable>
  );
}
