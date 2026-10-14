import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Platform,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";

/** Host Paseo scale (0.11.2): 4pt grid, 12–18 type, 4–12 radii. */
export const space = { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 } as const;
export const radius = { sm: 4, md: 6, lg: 8, xl: 12, full: 999 } as const;
export const font = { xs: 11, sm: 12, md: 13, base: 14, lg: 16, xl: 18 } as const;
export const touch = Platform.OS !== "web";
const control = touch ? 44 : 32;

/**
 * Vertical-only scrolling. iOS (Fabric) adds child overflow/transforms to the
 * content size, so any sub-pixel overflow would let a list drift sideways.
 */
export const verticalScroll = {
  horizontal: false,
  alwaysBounceHorizontal: false,
  showsHorizontalScrollIndicator: false,
  directionalLockEnabled: true,
} as const;
export const verticalContent: ViewStyle = { overflow: "hidden", maxWidth: "100%" };

export const Theme = createContext<PluginTheme | null>(null);
export function useTheme() {
  const theme = useContext(Theme);
  if (!theme) throw new Error("Theme missing");
  return theme;
}

/** Alpha tint of a theme color; falls back to the color itself for non-hex values. */
export function tint(color: string, alpha: number) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${full}${a}`;
}

type Hoverable = PressableStateCallbackType & { hovered?: boolean };

export function Label({
  children,
  muted = false,
  size = font.md,
  bold = false,
  medium = false,
  lines,
  selectable,
  color,
  mono = false,
  italic = false,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  bold?: boolean;
  medium?: boolean;
  lines?: number;
  selectable?: boolean;
  color?: string;
  mono?: boolean;
  italic?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={lines}
      selectable={selectable}
      style={{
        userSelect: selectable === false ? "none" : undefined,
        color: color || (muted ? colors.foregroundMuted : colors.foreground),
        fontSize: size,
        lineHeight: Math.round(size * 1.45),
        fontWeight: bold ? "600" : medium ? "500" : "400",
        fontStyle: italic ? "italic" : undefined,
        fontFamily: mono ? monoFont : undefined,
      }}
    >
      {children}
    </Text>
  );
}
export const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

export function Button({
  children,
  onPress,
  primary = false,
  disabled = false,
  label,
  icon,
  quiet = false,
  danger = false,
  grow = false,
}: {
  children: ReactNode;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  label?: string;
  icon?: string;
  quiet?: boolean;
  danger?: boolean;
  grow?: boolean;
}) {
  const { colors } = useTheme();
  const fg = primary
    ? colors.accentForeground
    : danger
      ? colors.statusDanger
      : colors.foreground;
  const hasText = !(typeof children === "string" && !children);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        label || (typeof children === "string" ? children : undefined)
      }
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as Hoverable;
        return {
          paddingHorizontal: hasText ? space[3] : 0,
          height: control,
          minWidth: control,
          borderRadius: radius.md,
          flexDirection: "row",
          flexGrow: grow ? 1 : 0,
          flexShrink: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: space[1.5],
          borderWidth: primary || quiet ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: primary
            ? colors.accent
            : hovered || pressed
              ? colors.surface2
              : quiet
                ? "transparent"
                : colors.surface0,
          opacity: disabled ? 0.45 : pressed && primary ? 0.85 : 1,
        };
      }}
    >
      {icon && <Icon name={icon} size={15} color={fg} />}
      {hasText && (
        <Text
          numberOfLines={1}
          selectable={false}
          style={{
            userSelect: "none",
            flexShrink: 1,
            color: fg,
            fontSize: font.md,
            fontWeight: "500",
          }}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}

/** Square ghost icon button with a required accessible name. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  active = false,
  color,
  size = control,
}: {
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  active?: boolean;
  color?: string;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={touch ? undefined : 4}
      style={(state) => {
        const { pressed, hovered } = state as Hoverable;
        return {
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            active || hovered || pressed ? colors.surface2 : "transparent",
          opacity: disabled ? 0.4 : 1,
        };
      }}
    >
      <Icon
        name={icon}
        size={16}
        color={color || (active ? colors.foreground : colors.foregroundMuted)}
      />
    </Pressable>
  );
}

export function Field({
  title,
  value,
  onChange,
  multiline = false,
  placeholder = "",
  editable = true,
  hint,
}: {
  title: string;
  value: string;
  onChange: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
  editable?: boolean;
  hint?: string;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space[1.5] }}>
      <Label medium size={font.sm} muted>
        {title}
      </Label>
      <TextInput
        accessibilityLabel={title}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          borderWidth: 1,
          borderColor: focused ? colors.foregroundMuted : colors.border,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: multiline ? space[2] + 2 : 0,
          color: editable ? colors.foreground : colors.foregroundMuted,
          backgroundColor: editable ? colors.surface0 : colors.surface1,
          fontSize: font.base,
          height: multiline ? undefined : touch ? 44 : 36,
          minHeight: multiline ? 96 : undefined,
          textAlignVertical: multiline ? "top" : "center",
          outlineStyle: "none",
        } as never}
      />
      {!!hint && (
        <Label muted size={font.sm}>
          {hint}
        </Label>
      )}
    </View>
  );
}

/** Segmented choice; wraps rather than scrolling horizontally. */
export function Choices<T extends string>({
  title,
  value,
  options,
  onChange,
  hideTitle = false,
}: {
  title: string;
  hideTitle?: boolean;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[1.5] }}>
      {!!title && !hideTitle && (
        <Label medium size={font.sm} muted>
          {title}
        </Label>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignSelf: "flex-start",
          maxWidth: "100%",
          gap: 2,
          padding: 2,
          borderRadius: radius.lg,
          backgroundColor: colors.surface2,
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${option.label}`}
              accessibilityState={{ selected, disabled: option.disabled }}
              disabled={option.disabled}
              onPress={() => onChange(option.value)}
              style={(state) => {
                const { hovered } = state as Hoverable;
                return {
                  paddingHorizontal: space[3],
                  height: touch ? 40 : 28,
                  justifyContent: "center",
                  borderRadius: radius.md,
                  backgroundColor: selected
                    ? colors.surface0
                    : hovered
                      ? tint(colors.surface0, 0.5)
                      : "transparent",
                  borderWidth: 1,
                  borderColor: selected ? colors.border : "transparent",
                  opacity: option.disabled ? 0.4 : 1,
                };
              }}
            >
              <Text
                selectable={false}
                numberOfLines={1}
                style={{
                  userSelect: "none",
                  fontSize: font.md,
                  fontWeight: selected ? "500" : "400",
                  color: selected ? colors.foreground : colors.foregroundMuted,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export type Tone = "danger" | "warning" | "info" | "success";
export function Notice({
  children,
  tone = "danger",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  const { colors } = useTheme();
  const color = toneColor(colors, tone);
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[2] + 2,
        borderWidth: 1,
        borderColor: tint(color, 0.35),
        backgroundColor: tint(color, 0.08),
        borderRadius: radius.lg,
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={toneIcon[tone]} size={14} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{children}</Label>
      </View>
    </View>
  );
}
const toneIcon: Record<Tone, string> = {
  danger: "CircleAlert",
  warning: "TriangleAlert",
  info: "Info",
  success: "CircleCheck",
};
export function toneColor(colors: PluginTheme["colors"], tone: Tone) {
  return tone === "danger"
    ? colors.statusDanger
    : tone === "warning"
      ? colors.statusWarning
      : tone === "success"
        ? colors.statusSuccess
        : colors.foregroundMuted;
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

export function Badge({ children, color }: { children: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: space[1.5],
        height: 18,
        justifyContent: "center",
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: color ? tint(color, 0.4) : colors.border,
      }}
    >
      <Text
        selectable={false}
        style={{
          userSelect: "none",
          fontSize: font.xs,
          fontWeight: "500",
          color: color || colors.foregroundMuted,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/** Host-style list row for menus and pickers. */
export function Row({
  title,
  detail,
  icon,
  iconColor,
  leading,
  trailing,
  selected = false,
  disabled = false,
  onPress,
  label,
}: {
  title: string;
  detail?: string;
  icon?: string;
  iconColor?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  label?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label || title}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as Hoverable;
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          minHeight: touch ? 52 : detail ? 48 : 36,
          paddingHorizontal: space[3],
          paddingVertical: space[1.5],
          borderRadius: radius.lg,
          backgroundColor: selected
            ? colors.surface2
            : hovered || pressed
              ? colors.surface1
              : "transparent",
          opacity: disabled ? 0.45 : 1,
        };
      }}
    >
      {leading}
      {icon && (
        <Icon name={icon} size={16} color={iconColor || colors.foregroundMuted} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label medium={selected} lines={1} selectable={false} size={font.base}>
          {title}
        </Label>
        {!!detail && (
          <Label muted size={font.sm} lines={1} selectable={false}>
            {detail}
          </Label>
        )}
      </View>
      {trailing}
      {selected && <Icon name="Check" size={16} color={colors.foreground} />}
    </Pressable>
  );
}

export function SectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: control,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: space[1.5] }}>
        <Label bold size={font.md} selectable={false}>
          {title}
        </Label>
        {count !== undefined && (
          <Label muted size={font.md} selectable={false}>
            {count}
          </Label>
        )}
      </View>
      {children}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ height: 1, backgroundColor: colors.border }, style]} />;
}

/** Right-aligned modal footer: secondary actions first, primary last. */
export function Actions({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: space[2],
        paddingTop: space[1],
      }}
    >
      {children}
    </View>
  );
}

export function relativeTime(iso: string | null | undefined, now = Date.now()) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}

export const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() || path;
