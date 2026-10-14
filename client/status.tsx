import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { Status, Task } from "../shared/model";
import { tint, useTheme } from "./ui";

type Colors = PluginTheme["colors"];

const statusGlyph: Record<Status, { icon: string; color(c: Colors): string }> = {
  backlog: { icon: "CircleDashed", color: (c) => c.foregroundMuted },
  todo: { icon: "Circle", color: (c) => c.foregroundMuted },
  in_progress: { icon: "CircleDot", color: (c) => c.statusWarning },
  in_review: { icon: "CircleDotDashed", color: (c) => c.accent },
  blocked: { icon: "CircleSlash", color: (c) => c.statusDanger },
  done: { icon: "CircleCheck", color: (c) => c.statusSuccess },
  cancelled: { icon: "CircleX", color: (c) => c.foregroundMuted },
};

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const { colors } = useTheme();
  const glyph = statusGlyph[status];
  return <Icon name={glyph.icon} size={size} color={glyph.color(colors)} />;
}

type Priority = Task["priority"];
const priorityGlyph: Record<Priority, { icon: string; color(c: Colors): string } | null> = {
  urgent: { icon: "TriangleAlert", color: (c) => c.statusDanger },
  high: { icon: "SignalHigh", color: (c) => c.foreground },
  normal: null,
  low: { icon: "SignalLow", color: (c) => c.foregroundMuted },
};
export const priorityLabels: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** Renders nothing for Normal priority: the default carries no signal. */
export function PriorityIcon({ priority, size = 14, always = false }: { priority: Priority; size?: number; always?: boolean }) {
  const { colors } = useTheme();
  const glyph = priorityGlyph[priority] || (always ? { icon: "SignalMedium", color: (c: Colors) => c.foregroundMuted } : null);
  if (!glyph) return null;
  return <Icon name={glyph.icon} size={size} color={glyph.color(colors)} />;
}

/** Session visual tone derived from the shared sessionState label set. */
export function sessionTone(
  colors: Colors,
  state: { label: string; active: boolean },
  unread = false,
) {
  if (state.label === "Waiting for approval") return colors.statusWarning;
  if (state.label === "Error") return colors.statusDanger;
  if (state.active) return colors.accent;
  if (unread) return colors.statusSuccess;
  if (state.label === "Archived" || state.label === "Closed") return colors.border;
  return tint(colors.foregroundMuted, 0.55);
}
