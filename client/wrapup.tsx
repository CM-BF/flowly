import { useEffect, useState } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "../shared/model";
import * as rpc from "../shared/rpc";
import { Actions, Button, Label, Notice, Theme, font, message, space, useTheme } from "./ui";

export function CheckRow({ tone, text }: { tone: "ok" | "warn" | "block"; text: string }) {
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

/**
 * Explicit wrap-up of a finished card: preflight, then archive sessions/worktree
 * and the card. `prompt` is the question asked right after a move into
 * Done/Cancelled: it archives the resources but keeps the card on the board.
 */
export function WrapupModal({
  task,
  open,
  prompt = false,
  onClose,
  onDone,
}: {
  task: Task;
  open: boolean;
  prompt?: boolean;
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
  // Nothing of this card is left to archive: don't ask.
  const empty = !!data && (!data.workspace || (!data.archiveWorkspace && !data.sessions));
  useEffect(() => {
    if (open && prompt && empty) onClose();
  }, [open, prompt, empty]);
  async function confirm() {
    if (!data || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await runWrapup({
        id: task.id,
        revision: data.revision,
        acknowledgeWarnings: warned,
        ...(prompt ? { keepCard: true } : {}),
      });
      onDone(
        result.archivedWorkspace
          ? `Wrapped up: workspace and sessions archived`
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
      title={prompt ? "Wrap up this card?" : "Wrap up"}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <Label size={font.base}>
            {(data?.archiveWorkspace && data.workspace?.kind === "worktree"
              ? "Archive this card's worktree workspace and its sessions. Paseo may remove the worktree directory; the branch is kept."
              : data?.archiveWorkspace
                ? "Archive this card's workspace and its sessions. The directory stays on disk."
                : "Archive this card's sessions. The workspace directory stays as it is.") +
              (prompt ? " The card stays on the board." : " Then archive the card.")}
          </Label>
          {prompt && (
            <Label muted size={font.sm}>
              To skip this question, turn on Auto wrap up in Ultra Kanban settings.
            </Label>
          )}
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
              {prompt ? "Not now" : "Cancel"}
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
