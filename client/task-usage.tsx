import { useState } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { cacheHitRate, compactDuration, compactNumber, percent, totalTokens, type SessionUsage, type TokenUsage } from "../shared/usage";
import { Disclosure } from "./disclosure";
import { Label, font, message, radius, space, useTheme } from "./ui";

/** Drawer "Usage": token use read from local Claude Code / Codex logs (USAGE-STATS-SPEC). Collapsed by default. */
export function TaskUsage({ taskId, active }: { taskId: string; active: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const read = useRpc(rpc.taskUsage);
  const usage = useQuery({
    queryKey: ["ultra", "usage", taskId],
    queryFn: () => read({ taskId }),
    enabled: active,
    staleTime: 30_000,
    refetchInterval: open ? 30_000 : 120_000,
    placeholderData: (previous) => previous,
  });
  const data = usage.data;
  const total = data ? totalTokens(data.total) : 0;
  const summary = data
    ? total
      ? `${compactNumber(total)} tokens${cacheHitRate(data.total) !== null ? ` · ${percent(cacheHitRate(data.total)!)} cached` : ""}${data.turns ? ` · ${data.turns} turn${data.turns === 1 ? "" : "s"}` : ""}`
      : "No token data"
    : usage.isPending
      ? "Counting…"
      : "";
  const work = data?.sessions.filter((s) => !s.summarizer) || [];
  const summarizers = data?.sessions.filter((s) => s.summarizer) || [];
  return (
    <Disclosure title="Usage" summary={summary} open={open} onChange={setOpen} disabled={!active}>
      {usage.error && !data ? (
        <Label muted size={font.sm}>{message(usage.error)}</Label>
      ) : !data ? (
        <Label muted size={font.sm}>Counting…</Label>
      ) : (
        <View style={{ gap: space[3] }}>
          <View style={{ padding: space[3], gap: space[1], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
            <Breakdown tokens={data.total} />
            {(data.turns > 0 || data.activeMs > 0) && (
              <Label muted size={font.xs} selectable={false}>
                {data.turns} turn{data.turns === 1 ? "" : "s"} · {compactDuration(data.activeMs)} running
              </Label>
            )}
          </View>
          {work.length > 0 && (
            <View style={{ gap: space[1] }}>
              <Label muted size={font.xs} selectable={false}>Sessions</Label>
              {work.map((s) => (
                <SessionLine key={s.agentId} session={s} />
              ))}
            </View>
          )}
          {summarizers.length > 0 && (
            <Line
              title={`Progress summaries · ${summarizers.length} run${summarizers.length === 1 ? "" : "s"}`}
              value={compactNumber(totalTokens(data.summarizer))}
            />
          )}
          <Label muted size={font.xs} selectable={false}>
            From local Claude Code / Codex logs; tokens only. Output includes reasoning.
          </Label>
        </View>
      )}
    </Disclosure>
  );
}

function Breakdown({ tokens }: { tokens: TokenUsage }) {
  return (
    <View style={{ gap: 2 }}>
      <Line title="Input" value={compactNumber(tokens.input)} />
      <Line title="Cache read" value={compactNumber(tokens.cacheRead)} />
      <Line title="Cache write" value={compactNumber(tokens.cacheWrite)} />
      <Line
        title="Output"
        value={`${compactNumber(tokens.output)}${tokens.reasoning ? ` (${compactNumber(tokens.reasoning)} reasoning)` : ""}`}
      />
      <Line title="Total" value={compactNumber(totalTokens(tokens))} strong />
      <Line title="Cache hit rate" value={hitText(tokens)} hint="cache read ÷ all input" />
    </View>
  );
}

const hitText = (tokens: TokenUsage) => {
  const rate = cacheHitRate(tokens);
  return rate === null ? "—" : percent(rate);
};

function SessionLine({ session }: { session: SessionUsage }) {
  const rate = session.tokens ? cacheHitRate(session.tokens) : null;
  const detail = session.tokens
    ? `${compactNumber(totalTokens(session.tokens))}${rate === null ? "" : ` · ${percent(rate)} cached`}`
    : session.note || "—";
  return (
    <Line
      title={`${session.title} · ${session.provider}`}
      value={detail}
      muted={!session.tokens}
    />
  );
}

function Line({ title, value, hint, strong = false, muted = false }: { title: string; value: string; hint?: string; strong?: boolean; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} muted={!strong} medium={strong} lines={1} selectable={false}>
          {title}
          {!!hint && <Label size={font.xs} muted selectable={false}>{`  ${hint}`}</Label>}
        </Label>
      </View>
      <View style={{ flexShrink: 1, maxWidth: "60%" }}>
        <Label size={font.sm} muted={muted} medium={strong} lines={2} selectable>
          {value}
        </Label>
      </View>
    </View>
  );
}
