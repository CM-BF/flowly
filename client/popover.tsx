import type { ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Label, font, noFocusRing, radius, space, useTheme, verticalContent, verticalScroll } from "./ui";
import { lerp, useMotionPresence } from "./motion";
import { t } from "../shared/i18n";

export type WindowRect = { x: number; y: number; width: number; height: number };
/** The trigger and the surface the popover is drawn in, both in window coordinates. */
export type PopoverPlace = { anchor: WindowRect; container: WindowRect };

/**
 * Desktop dropdown under a trigger, right-aligned to it and kept inside the
 * container. Render it as the last child of the container it was measured
 * against. Only an open popover catches outside clicks.
 */
export function Popover({
  place,
  title,
  trailing,
  width = 380,
  onClose,
  children,
}: {
  /** null: closed. */
  place: PopoverPlace | null;
  title: string;
  trailing?: ReactNode;
  width?: number;
  onClose(): void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const presence = useMotionPresence(place, place ? `${place.anchor.x},${place.anchor.y}` : "");
  const shown = presence.item;
  if (!shown) return null;
  const { anchor, container } = shown;
  const top = Math.max(4, anchor.y + anchor.height + 4 - container.y);
  const left = Math.max(4, Math.min(anchor.x + anchor.width - width - container.x, container.width - width - 4));
  const maxHeight = Math.max(160, Math.min(520, container.height - top - space[3]));
  return (
    <>
      {presence.active && (
        <Pressable
          accessibilityLabel={t("Close menu")}
          onPress={onClose}
          style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 }}
        />
      )}
      <Animated.View
        accessibilityViewIsModal
        pointerEvents={presence.active ? "auto" : "none"}
        style={{
          position: "absolute",
          zIndex: 201,
          top,
          left,
          width,
          maxHeight,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          shadowColor: "#000",
          shadowOpacity: 0.14,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          overflow: "hidden",
          opacity: presence.progress,
          transform: [{ translateY: lerp(presence.progress, [-4, 0]) }],
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            paddingHorizontal: space[3],
            height: 40,
            borderBottomWidth: 1,
            borderColor: colors.border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label medium size={font.md} lines={1} selectable={false}>{title}</Label>
          </View>
          {trailing}
        </View>
        <ScrollView
          {...verticalScroll}
          style={{ flexShrink: 1, minHeight: 0 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ ...verticalContent, padding: space[1.5], gap: 2 }}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </>
  );
}
