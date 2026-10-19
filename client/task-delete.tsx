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
import { t, tn } from "../shared/i18n";

export type DeleteResult = z.infer<typeof rpc.deleteTask.output>;
type Scope = "keep" | "archive";

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
    queryKey: ["flowly", "delete-check", task.id],
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
      ? tn(data.sessions, "its worktree workspace and {n} session. Paseo may remove the worktree directory; the branch is kept.", "its worktree workspace and {n} sessions. Paseo may remove the worktree directory; the branch is kept.")
      : tn(data.sessions, "its workspace and {n} session. The directory stays on disk.", "its workspace and {n} sessions. The directory stays on disk.")
    : tn(data?.sessions ?? 0, "its {n} session. The workspace is shared and stays.", "its {n} sessions. The workspace is shared and stays.");
  return (
    <Modal
      open
      title={t("Delete “{title}” permanently?", { title: task.title })}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Label>
              {t("The card, its activity and progress summaries leave Flowly and cannot be restored from the board. A copy of the removed records is kept in the plugin's data folder.")}</Label>
            {check.isPending ? (
              <Label muted>{t("Checking its Paseo sessions…")}</Label>
            ) : check.error ? (
              <Notice>{t("Could not check Paseo: {message}. The card can still be deleted; Paseo keeps its sessions.", { message: message(check.error) })}</Notice>
            ) : nothing ? (
              <Label muted size={font.sm}>{t("Its workspace is already archived or gone in Paseo; nothing else to archive.")}</Label>
            ) : ask ? (
              <>
                <Choices
                  title={t("Paseo sessions and workspace")}
                  value={scope}
                  options={[
                    { value: "keep", label: t("Keep") },
                    { value: "archive", label: t("Archive"), disabled: !archivable },
                  ]}
                  onChange={setScope}
                />
                <Label muted size={font.sm}>
                  {archive
                    ? t("Archives {what}", { what })
                    : t("Paseo keeps the card's workspace, sessions and files. Running sessions keep running, but their Kanban tools stop working for this card.")}
                </Label>
                <View style={{ gap: space[2] }}>
                  {data!.blockers.map((text) => (
                    <CheckRow key={text} tone="block" text={t("{text} Archiving is unavailable.", { text })} />
                  ))}
                  {archive && data!.warnings.map((text) => <CheckRow key={text} tone="warn" text={text} />)}
                </View>
                {!auto && (
                  <Label muted size={font.sm}>
                    {t("To archive without asking, turn on Auto archive on delete in Flowly settings.")}</Label>
                )}
              </>
            ) : (
              <Label muted size={font.sm}>{t("Auto archive on delete: also archives {what}", { what })}</Label>
            )}
            {error && <Notice>{error}</Notice>}
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                {t("Cancel")}</Button>
              <Button
                danger
                icon="Trash2"
                disabled={pending || check.isPending}
                onPress={() => void confirm()}
              >
                {pending ? t("Deleting…") : archive ? t("Archive and delete") : t("Delete permanently")}
              </Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
