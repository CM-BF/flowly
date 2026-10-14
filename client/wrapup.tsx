import { useState } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "../shared/model";
import * as rpc from "../shared/rpc";
import { Actions, Button, Label, Notice, Theme, font, message, space, useTheme } from "./ui";

function CheckRow({ tone, text }: { tone: "ok" | "warn" | "block"; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}>
        <Icon
          name={tone === "ok" ? "CircleCheck" : tone === "warn" ? "TriangleAlert" : "CircleX"}
          size={14}
          color={tone === "ok" ? colors.statusSuccess : tone === "warn" ? colors.statusWarning : colors.statusDanger}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{text}</Label>
      </View>
    </View>
  );
}

/** Explicit wrap-up of a finished card: preflight, then archive sessions/worktree and the card. */
export function WrapupModal({
  task,
  open,
  onClose,
  onDone,
}: {
  task: Task;
  open: boolean;
  onClose(): void;
  onDone(summary: string): void;
}) {
  const theme = useTheme();
  const checkRead = useRpc(rpc.wrapupCheck),
    runWrapup = useRpc(rpc.wrapup);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const check = useQuery({
    queryKey: ["ultra", "wrapup", task.id, task.revision],
    queryFn: () => checkRead({ id: task.id }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });
  const data = check.data;
  const blocked = !data || data.blockers.length > 0;
  const warned = !!data?.warnings.length;
  async function confirm() {
    if (!data || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await runWrapup({
        id: task.id,
        revision: data.revision,
        acknowledgeWarnings: warned,
      });
      onDone(
        result.archivedWorkspace
          ? "Wrapped up: worktree and sessions archived"
          : `Wrapped up: ${result.archivedSessions} session${result.archivedSessions === 1 ? "" : "s"} archived`,
      );
    } catch (e) {
      setError(message(e));
      void check.refetch();
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open={open}
      title="Wrap up"
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <Label size={font.base}>
            {data?.archiveWorkspace
              ? "Archive this card's worktree workspace and its sessions, then archive the card. Paseo may remove the worktree directory; the branch is kept."
              : "Archive this card's sessions, then archive the card. The workspace directory stays as it is."}
          </Label>
          {check.isPending ? (
            <Label muted>Checking…</Label>
          ) : check.error ? (
            <Notice>{message(check.error)}</Notice>
          ) : data ? (
            <View style={{ gap: space[2] }}>
              {data.blockers.map((text) => (
                <CheckRow key={text} tone="block" text={text} />
              ))}
              {data.warnings.map((text) => (
                <CheckRow key={text} tone="warn" text={text} />
              ))}
              {!data.workspace && (
                <CheckRow tone="warn" text="Workspace is unavailable; only the card will be archived." />
              )}
              {!data.blockers.length && (
                <CheckRow
                  tone="ok"
                  text={`${data.sessions} session${data.sessions === 1 ? "" : "s"} idle${data.git ? ` · branch ${data.git.branch}` : ""}`}
                />
              )}
              {data.git && !data.git.uncommitted && !data.git.unpushed && (
                <CheckRow tone="ok" text="No uncommitted changes or local-only commits" />
              )}
            </View>
          ) : null}
          {!!error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              primary={!warned}
              danger={warned}
              icon="Archive"
              disabled={blocked || pending || check.isFetching}
              onPress={() => void confirm()}
            >
              {pending ? "Wrapping up…" : warned ? "Wrap up anyway" : "Wrap up"}
            </Button>
          </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
