import { memo, useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { t } from "../shared/i18n";
import { normalizeTag, splitTagInput } from "../shared/tags";
import { tagLimits } from "../shared/model";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Label, TextBox, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { useShortcutBlock } from "./shortcuts";

/** A removable `#tag` chip; `agent` marks tags an agent added (CARD-TAGS-SPEC §6.3). */
export function TagPill({
  tag,
  agent = false,
  onPress,
  onRemove,
}: {
  tag: string;
  agent?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        height: touch ? 30 : 24,
        paddingLeft: space[2],
        paddingRight: onRemove ? 2 : space[2],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        maxWidth: "100%",
      }}
    >
      <Pressable
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityLabel={agent ? t("{tag}, added by an agent", { tag }) : tag}
        accessibilityHint={onPress ? t("Filter the board by this tag") : undefined}
        disabled={!onPress}
        onPress={onPress}
        style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0 }}
      >
        {agent && <Icon name="Bot" size={12} color={colors.foregroundMuted} />}
        <Label size={font.sm} lines={1} selectable={false}>{`#${tag}`}</Label>
      </Pressable>
      {!!onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Remove tag {tag}", { tag })}
          onPress={onRemove}
          hitSlop={6}
          style={{ ...noFocusRing, padding: 3, borderRadius: radius.sm }}
        >
          <Icon name="X" size={12} color={colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}

/**
 * Tag entry with suggestions from the project's vocabulary. Enter, comma or a
 * suggestion adds; Backspace in an empty input removes the last tag. `tags` are
 * normalized values; `onAdd` receives normalized values too.
 */
export const TagEditor = memo(function TagEditor({
  tags,
  agentTags,
  suggestions,
  onAdd,
  onRemove,
  autoFocus,
  disabled,
}: {
  tags: readonly string[];
  /** Tags an agent added, marked with an icon. */
  agentTags?: ReadonlySet<string>;
  suggestions: readonly string[];
  onAdd: (tags: string[]) => void;
  onRemove: (tag: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const full = tags.length >= tagLimits.perTask;
  const add = (text: string) => {
    const parts = splitTagInput(text);
    if (!parts.length) return;
    try {
      const values = [...new Set(parts.map(normalizeTag))].filter((v) => !tags.includes(v));
      if (tags.length + values.length > tagLimits.perTask)
        throw new Error(t("A card can have at most {n} tags.", { n: tagLimits.perTask }));
      setError("");
      setDraft("");
      if (values.length) onAdd(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const typedKey = useMemo(() => {
    try {
      return draft.trim() ? normalizeTag(draft) : "";
    } catch {
      return draft.trim().toLowerCase();
    }
  }, [draft]);
  // Computed only while typing (or focused with an empty input): prefix matches first.
  const shown = useMemo(() => {
    if (!focused && !typedKey) return [];
    const free = suggestions.filter((s) => !tags.includes(s));
    if (!typedKey) return free.slice(0, 6);
    const starts = free.filter((s) => s.startsWith(typedKey)),
      contains = free.filter((s) => !s.startsWith(typedKey) && s.includes(typedKey));
    return [...starts, ...contains].slice(0, 6);
  }, [focused, typedKey, suggestions, tags]);
  return (
    <View style={{ gap: space[1.5] }}>
      {!!tags.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
          {tags.map((tag) => (
            <TagPill key={tag} tag={tag} agent={agentTags?.has(tag)} onRemove={disabled ? undefined : () => onRemove(tag)} />
          ))}
        </View>
      )}
      {!full && !disabled && (
        <TextBox
          accessibilityLabel={t("Add a tag")}
          value={draft}
          onChangeText={(text) => {
            setError("");
            // A typed comma ends a tag.
            if (/[,，、]/u.test(text)) add(text);
            else setDraft(text);
          }}
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={tags.length ? t("Add another tag") : t("e.g. drawer, performance")}
          placeholderTextColor={colors.foregroundMuted}
          onSubmitEditing={() => add(draft)}
          blurOnSubmit={false}
          returnKeyType="done"
          {...(Platform.OS === "web"
            ? {
                onKeyPress: (event: { nativeEvent: { key?: string }; preventDefault(): void }) => {
                  if (event.nativeEvent.key === "Backspace" && !draft && tags.length) onRemove(tags[tags.length - 1]);
                },
              }
            : {})}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            borderWidth: 1,
            borderColor: focused ? colors.foregroundMuted : colors.border,
            borderRadius: radius.md,
            paddingHorizontal: space[3],
            color: colors.foreground,
            backgroundColor: colors.surface0,
            fontSize: font.base,
            height: touch ? 44 : 36,
            outlineStyle: "none",
          } as never}
        />
      )}
      {!!shown.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
          {shown.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityLabel={t("Add tag {tag}", { tag: s })}
              onPress={() => add(s)}
              style={(state) => ({
                ...noFocusRing,
                height: touch ? 30 : 24,
                paddingHorizontal: space[2],
                justifyContent: "center",
                borderRadius: radius.md,
                backgroundColor: (state as { hovered?: boolean }).hovered ? colors.surface2 : "transparent",
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: colors.border,
              })}
            >
              <Label size={font.sm} muted selectable={false}>{`+ #${s}`}</Label>
            </Pressable>
          ))}
        </View>
      )}
      {!!error && (
        <Label size={font.sm} color={colors.statusDanger}>
          {error}
        </Label>
      )}
      {full && !disabled && (
        <Label size={font.sm} muted>
          {t("A card can have at most {n} tags.", { n: tagLimits.perTask })}
        </Label>
      )}
    </View>
  );
});
