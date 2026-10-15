import { View } from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { statusLabels, type Lane, type Status } from "../shared/model";
import { IconButton, Label, Switch, font, radius, space, touch, useTheme } from "./ui";
import { StatusIcon } from "./status";
import { SortableList } from "./sortable-list";

/**
 * A project's lanes: order (drag the grip on desktop, arrows on touch), on/off
 * and an optional name. A lane holding live cards cannot be turned off here;
 * the server enforces the same rule.
 */
export function LaneEditor({
  lanes,
  counts,
  disabled,
  onChange,
}: {
  lanes: Lane[];
  /** Live (unarchived) cards per lane. */
  counts: Partial<Record<Status, number>>;
  disabled: boolean;
  onChange(lanes: Lane[]): void;
}) {
  const { colors } = useTheme();
  const enabledCount = lanes.filter((l) => l.enabled).length;
  const items = lanes.map((l) => ({ ...l, id: l.status }));
  const update = (status: Status, change: Partial<Lane>) =>
    onChange(lanes.map((l) => (l.status === status ? { ...l, ...change } : l)));
  const move = (status: Status, to: number) => {
    const next = lanes.filter((l) => l.status !== status);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, lanes.find((l) => l.status === status)!);
    onChange(next);
  };
  return (
    <View style={{ gap: space[1.5] }}>
      <Label medium size={font.sm} muted>
        Lanes
      </Label>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 4 }}>
        <SortableList
          items={items}
          handle
          disabled={disabled || touch}
          onMove={(id, to) => move(id as Status, to)}
          renderItem={(lane, index, _pressable, handleProps) => {
            const count = counts[lane.status] || 0;
            const locked = lane.enabled && (count > 0 || enabledCount === 1);
            return (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  minHeight: touch ? 48 : 38,
                  paddingHorizontal: space[1.5],
                  borderRadius: radius.md,
                  opacity: lane.enabled ? 1 : 0.6,
                }}
              >
                {touch ? (
                  <View style={{ flexDirection: "row" }}>
                    <IconButton icon="ChevronUp" size={32} label={`Move ${statusLabels[lane.status]} up`} disabled={disabled || index === 0} onPress={() => move(lane.status, index - 1)} />
                    <IconButton icon="ChevronDown" size={32} label={`Move ${statusLabels[lane.status]} down`} disabled={disabled || index === lanes.length - 1} onPress={() => move(lane.status, index + 1)} />
                  </View>
                ) : (
                  <View
                    {...handleProps}
                    accessibilityLabel={`Drag to reorder ${statusLabels[lane.status]}`}
                    style={{ width: 16, alignItems: "center", ...({ cursor: "grab" } as object) }}
                  >
                    <Icon name="GripVertical" size={14} color={colors.foregroundMuted} />
                  </View>
                )}
                <StatusIcon status={lane.status} size={15} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <TextInput
                    accessibilityLabel={`${statusLabels[lane.status]} lane name`}
                    value={lane.name ?? ""}
                    onChangeText={(name) => update(lane.status, { name })}
                    placeholder={statusLabels[lane.status]}
                    placeholderTextColor={colors.foreground}
                    editable={!disabled}
                    maxLength={40}
                    style={{
                      height: touch ? 36 : 28,
                      paddingHorizontal: space[1.5],
                      borderRadius: radius.sm,
                      fontSize: font.md,
                      color: colors.foreground,
                      outlineStyle: "none",
                    } as never}
                  />
                </View>
                {count > 0 && (
                  <Label muted size={font.xs} selectable={false}>
                    {count} {count === 1 ? "card" : "cards"}
                  </Label>
                )}
                <Switch
                  value={lane.enabled}
                  label={`${lane.name?.trim() || statusLabels[lane.status]} lane ${lane.enabled ? "on" : "off"}`}
                  disabled={disabled || locked}
                  onChange={(enabled) => update(lane.status, { enabled })}
                />
              </View>
            );
          }}
        />
      </View>
      <Label muted size={font.xs}>
        Lanes are this project's workflow: cards, automatic status and agents only use lanes that are on. Rename a lane by typing over its name. A lane with cards can't be turned off until they move.
      </Label>
    </View>
  );
}
