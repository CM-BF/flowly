import { useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMotionPresence, lerp } from "./motion";
import { Label, font, touch, useTheme } from "./ui";
import { t } from "../shared/i18n";

export function Disclosure({ title, summary, open, disabled, onChange, children }: {
  title: string;
  summary?: string;
  open: boolean;
  disabled?: boolean;
  onChange(open: boolean): void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const [height, setHeight] = useState(0);
  // Height shares this value with opacity/chevron, so use the JS driver on all platforms.
  const presence = useMotionPresence(open ? true : undefined, open ? title : "", false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => onChange(!open)}
        style={({ pressed }) => ({
          minHeight: touch ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 6,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        })}
      >
        <Animated.View style={{ transform: [{ rotate: lerp(presence.progress, ["0deg", "90deg"]) }] }}>
          <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label bold size={font.md} selectable={false}>{title}</Label>
        </View>
        {!!summary && <View style={{ flexShrink: 1, maxWidth: "50%" }}><Label muted size={font.sm} lines={1} selectable={false}>{summary}</Label></View>}
      </Pressable>
      {presence.item && (
        <Animated.View
          testID="disclosure-body"
          pointerEvents={presence.active ? "auto" : "none"}
          accessibilityElementsHidden={!presence.active}
          importantForAccessibility={presence.active ? "auto" : "no-hide-descendants"}
          style={{
            overflow: "hidden",
            height: lerp(presence.progress, [0, height]),
            opacity: presence.progress,
          }}
        >
          <View
            onLayout={(event) => setHeight(Math.max(0, event.nativeEvent.layout.height))}
            style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: 8, paddingBottom: 4, paddingLeft: 22, gap: 10 }}
          >{children}</View>
        </Animated.View>
      )}
    </View>
  );
}
