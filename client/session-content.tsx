import { memo, useMemo, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { parseSessionInline, parseSessionMarkdown } from "./session-markdown";
import { Label, useTheme } from "./ui";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

// Memoized by its text: a transcript re-render must not re-parse unchanged messages.
const Inline = memo(function Inline({
  text,
  size = 14,
  bold = false,
}: {
  text: string;
  size?: number;
  bold?: boolean;
}) {
  const { colors } = useTheme();
  const [linkError, setLinkError] = useState(false);
  const parts = useMemo(() => parseSessionInline(text), [text]);
  return (
    <View style={{ minWidth: 0, flexShrink: 1 }}>
      <Text
        style={{
          color: colors.foreground,
          fontSize: size,
          lineHeight: size * 1.55,
          fontWeight: bold ? "600" : "400",
          flexShrink: 1,
        }}
      >
        {parts.map((part, index) => {
          const link =
            part.kind === "link" && /^https?:\/\//i.test(part.url || "");
          return (
            <Text
              key={index}
              accessibilityRole={link ? "link" : undefined}
              onPress={
                link
                  ? () => {
                      void Linking.openURL(part.url!).catch(() =>
                        setLinkError(true),
                      );
                    }
                  : undefined
              }
              style={{
                color: link ? colors.accent : colors.foreground,
                fontWeight: part.kind === "bold" ? "600" : undefined,
                fontStyle: part.kind === "italic" ? "italic" : undefined,
                fontFamily: part.kind === "code" ? mono : undefined,
                fontSize: part.kind === "code" ? size - 1 : undefined,
                backgroundColor:
                  part.kind === "code" ? colors.surface2 : undefined,
                textDecorationLine: link ? "underline" : undefined,
              }}
            >
              {part.text}
              {part.kind === "link" && !link ? ` (${part.url})` : ""}
            </Text>
          );
        })}
      </Text>
      {linkError && <Label muted>Unable to open this link.</Label>}
    </View>
  );
});

export const SessionMarkdown = memo(function SessionMarkdown({ text }: { text: string }) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseSessionMarkdown(text), [text]);
  return (
    <View style={{ gap: 10, minWidth: 0, maxWidth: "100%" }}>
      {blocks.map((block, index) => {
        if (block.kind === "rule")
          return (
            <View
              key={index}
              style={{
                height: 1,
                backgroundColor: colors.border,
                marginVertical: 4,
              }}
            />
          );
        if (block.kind === "code")
          return (
            <View
              key={index}
              style={{
                gap: 6,
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                minWidth: 0,
              }}
            >
              {!!block.language && (
                <Label muted size={11} lines={1}>
                  {block.language}
                </Label>
              )}
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 12,
                  lineHeight: 19,
                  fontFamily: mono,
                }}
              >
                {block.text}
              </Text>
            </View>
          );
        if (block.kind === "table")
          return (
            <View key={index} style={{ gap: 12, minWidth: 0 }}>
              {(block.rows.length
                ? block.rows
                : [block.headers.map(() => "")]
              ).map((row, rowIndex) => (
                <View
                  key={rowIndex}
                  style={{
                    gap: 8,
                    paddingVertical: 10,
                    borderTopWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  {Array.from(
                    { length: Math.max(row.length, block.headers.length) },
                    (_, cellIndex) => (
                      <View key={cellIndex} style={{ gap: 2, minWidth: 0 }}>
                        <Inline
                          text={
                            block.headers[cellIndex] ||
                            `Column ${cellIndex + 1}`
                          }
                          size={12}
                          bold
                        />
                        <Inline text={row[cellIndex] || "—"} />
                      </View>
                    ),
                  )}
                </View>
              ))}
            </View>
          );
        if (block.kind === "heading")
          return (
            <View key={index} style={{ paddingTop: 6 }}>
              <Inline
                text={block.text}
                bold
                size={block.level <= 2 ? 17 : 15}
              />
            </View>
          );
        if (block.kind === "quote")
          return (
            <View
              key={index}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: colors.surface1,
                borderRadius: 8,
              }}
            >
              <Inline text={block.text} />
            </View>
          );
        if (block.kind === "list")
          return (
            <View
              key={index}
              style={{
                flexDirection: "row",
                gap: 8,
                paddingLeft: block.indent * 2,
                minWidth: 0,
              }}
            >
              {block.checked !== undefined ? (
                <Icon
                  name={block.checked ? "SquareCheck" : "Square"}
                  size={16}
                  color={colors.foregroundMuted}
                />
              ) : (
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 22,
                  }}
                >
                  {/\d/.test(block.marker) ? block.marker : "•"}
                </Text>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Inline text={block.text} />
              </View>
            </View>
          );
        return <Inline key={index} text={block.text} />;
      })}
    </View>
  );
});
