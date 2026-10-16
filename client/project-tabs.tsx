import { useEffect, useRef } from "react";
import { Pressable, View, type ScrollView as RNScrollView } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Project } from "../shared/model";
import { IconButton, Label, font, noFocusRing, radius, space, useTheme } from "./ui";
import { t } from "../shared/i18n";

/**
 * Desktop project tabs (PROJECT-TABS-SPEC): one click switches project; the
 * trailing buttons create a project or open the full chooser (reorder, edit, archive).
 */
export function ProjectTabs({
  projects,
  activeId,
  shortcut,
  onSelect,
  onManage,
  onCreate,
}: {
  projects: readonly Project[];
  activeId: string;
  shortcut: string;
  onSelect(id: string): void;
  onManage(): void;
  onCreate(): void;
}) {
  const scroll = useRef<RNScrollView>(null);
  const offsets = useRef(new Map<string, { x: number; width: number }>());
  const viewport = useRef({ x: 0, width: 0 });
  // Keep the active tab in view when it changes from elsewhere (chooser, linked session).
  const reveal = (id: string) => {
    const tab = offsets.current.get(id),
      view = viewport.current;
    if (!tab || !view.width) return;
    if (tab.x < view.x) scroll.current?.scrollTo({ x: tab.x, animated: true });
    else if (tab.x + tab.width > view.x + view.width)
      scroll.current?.scrollTo({ x: tab.x + tab.width - view.width, animated: true });
  };
  useEffect(() => reveal(activeId), [activeId]);
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <ScrollView
        ref={scroll as never}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{ alignItems: "center", gap: 2 }}
        scrollEventThrottle={64}
        onScroll={(e) => (viewport.current.x = e.nativeEvent.contentOffset.x)}
        onLayout={(e) => (viewport.current.width = e.nativeEvent.layout.width)}
      >
        {projects.map((p) => (
          <Tab
            key={p.id}
            project={p}
            active={p.id === activeId}
            onPress={() => onSelect(p.id)}
            onLayout={(x, width) => {
              offsets.current.set(p.id, { x, width });
              if (p.id === activeId) reveal(p.id);
            }}
          />
        ))}
      </ScrollView>
      <IconButton icon="Plus" label={t("New project")} onPress={onCreate} />
      <IconButton
        icon="ChevronsUpDown"
        label={`${t("All projects")}${shortcut ? ` (${shortcut})` : ""}`}
        onPress={onManage}
      />
    </View>
  );
}

function Tab({
  project,
  active,
  onPress,
  onLayout,
}: {
  project: Project;
  active: boolean;
  onPress(): void;
  onLayout(x: number, width: number): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={t("Project {title}", { title: project.title })}
      accessibilityState={{ selected: active }}
      {...({ "aria-selected": active } as object)}
      onPress={onPress}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: 30,
          maxWidth: 220,
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          // Same weight for every tab so switching never shifts its neighbours.
          backgroundColor: active ? colors.surface2 : hovered || pressed ? colors.surface1 : "transparent",
        };
      }}
    >
      {!!project.archivedAt && <Icon name="Archive" size={13} color={colors.foregroundMuted} />}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label
          lines={1}
          selectable={false}
          size={font.md}
          medium
          color={active ? colors.foreground : colors.foregroundMuted}
        >
          {project.title}
        </Label>
      </View>
    </Pressable>
  );
}
