import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import * as rpc from "../shared/rpc";
import type { Task } from "../shared/model";
import { wrapupSettings, wrapupSettingsValues } from "../shared/settings";
import { Modal } from "./modal";
import { Actions, Button, Choices, Label, Notice, Theme, font, message, space } from "./ui";
import { CheckRow } from "./wrapup";

export type DeleteResult = z.infer<typeof rpc.deleteTask.output>;
type Scope = "keep" | "archive";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Permanently deletes a card from the board (TASK-DELETE-SPEC), optionally
 * archiving its Paseo sessions/workspace first. With *Auto archive on delete*
 * a clean preflight archives without asking. A backup stays in the data folder.
 */
export function DeleteTaskDialog({
  task,
  theme,
  onClose,
  onDeleted,
}: {
  task: Task;
  theme: PluginTheme;
  onClose(): void;
  onDeleted(result: DeleteResult): void;
}) {
  const remove = useRpc(rpc.deleteTask),
    checkDelete = useRpc(rpc.deleteCheck);
  const prefs = useSettings(wrapupSettings);
  const auto = prefs.status === "ready" && wrapupSettingsValues(prefs.values).archiveOnDelete;
  const check = useQuery({
    queryKey: ["ultra", "delete-check", task.id],
    queryFn: () => checkDelete({ id: task.id }),
    staleTime: 0,
  });
  const data = check.data;
  // Nothing left to archive: the workspace is gone (e.g. an old wrap-up removed it) and no session is live.
  const nothing = !!data && !data.workspace;
  const archivable = !!data && !nothing && !data.blockers.length;
  const clean = archivable && !data.warnings.length;
  const [scope, setScope] = useState<Scope>("keep"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (prefs.status === "ready" && data) setScope(auto && archivable ? "archive" : "keep");
  }, [prefs.status, auto, !!data, archivable]);
  const archive = scope === "archive" && archivable;
  const ask = !!data && !nothing && !(auto && clean);
  async function confirm() {
    setPending(true);
    setError("");
    try {
      onDeleted(
        await remove({
          id: task.id,
          revision: task.revision,
          archive,
          acknowledgeWarnings: archive && !!data?.warnings.length,
        }),
      );
    } catch (e) {
      setError(message(e));
      setPending(false);
    }
  }
  const what = data?.archiveWorkspace
    ? data.workspace?.kind === "worktree"
      ? `its worktree workspace and ${plural(data.sessions, "session")}. Paseo may remove the worktree directory; the branch is kept.`
      : `its workspace and ${plural(data.sessions, "session")}. The directory stays on disk.`
    : `its ${plural(data?.sessions ?? 0, "session")}. The workspace is shared and stays.`;
  return (
    <Modal
      open
      title={`Delete “${task.title}” permanently?`}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Label>
              The card, its activity and progress summaries leave Ultra Kanban and cannot be restored from the board. A copy of the removed records is kept in the plugin's data folder.
            </Label>
            {check.isPending ? (
              <Label muted>Checking its Paseo sessions…</Label>
            ) : check.error ? (
              <Notice>{`Could not check Paseo: ${message(check.error)}. The card can still be deleted; Paseo keeps its sessions.`}</Notice>
            ) : nothing ? (
              <Label muted size={font.sm}>Its workspace is already archived or gone in Paseo; nothing else to archive.</Label>
            ) : ask ? (
              <>
                <Choices
                  title="Paseo sessions and workspace"
                  value={scope}
                  options={[
                    { value: "keep", label: "Keep" },
                    { value: "archive", label: "Archive", disabled: !archivable },
                  ]}
                  onChange={setScope}
                />
                <Label muted size={font.sm}>
                  {archive
                    ? `Archives ${what}`
                    : "Paseo keeps the card's workspace, sessions and files. Running sessions keep running, but their Kanban tools stop working for this card."}
                </Label>
                <View style={{ gap: space[2] }}>
                  {data!.blockers.map((text) => (
                    <CheckRow key={text} tone="block" text={`${text} Archiving is unavailable.`} />
                  ))}
                  {archive && data!.warnings.map((text) => <CheckRow key={text} tone="warn" text={text} />)}
                </View>
                {!auto && (
                  <Label muted size={font.sm}>
                    To archive without asking, turn on Auto archive on delete in Ultra Kanban settings.
                  </Label>
                )}
              </>
            ) : (
              <Label muted size={font.sm}>{`Auto archive on delete: also archives ${what}`}</Label>
            )}
            {error && <Notice>{error}</Notice>}
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                Cancel
              </Button>
              <Button
                danger
                icon="Trash2"
                disabled={pending || check.isPending}
                onPress={() => void confirm()}
              >
                {pending ? "Deleting…" : archive ? "Archive and delete" : "Delete permanently"}
              </Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
