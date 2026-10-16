import { useState } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import * as rpc from "../shared/rpc";
import type { Project } from "../shared/model";
import { Modal } from "./modal";
import { Actions, Button, Choices, Label, Notice, Theme, font, message } from "./ui";
import { t, tn } from "../shared/i18n";

export type RemoveResult = z.infer<typeof rpc.removeProject.output>;
type Scope = "board" | "paseo";

/**
 * The single project removal entry (PROJECT-REMOVE-SPEC): always removes the
 * board project; optionally also removes the native Paseo project, which keeps
 * every folder, worktree and branch on disk.
 */
export function RemoveProjectDialog({
  project,
  theme,
  onClose,
  onRemoved,
}: {
  project: Project;
  theme: PluginTheme;
  onClose(): void;
  onRemoved(result: RemoveResult, scope: Scope): void;
}) {
  const remove = useRpc(rpc.removeProject),
    checkRemove = useRpc(rpc.removeProjectCheck);
  const check = useQuery({
    queryKey: ["ultra", "remove-check", project.id],
    queryFn: () => checkRemove({ id: project.id }),
    staleTime: 0,
  });
  const [scope, setScope] = useState<Scope>("board"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const info = check.data;
  const running = info?.runningSessions ?? 0;
  async function confirm() {
    setPending(true);
    setError("");
    try {
      onRemoved(await remove({ id: project.id, revision: project.revision, alsoPaseo: scope === "paseo" }), scope);
    } catch (e) {
      setError(message(e));
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={t("Remove “{title}”?", { title: project.title })}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Label>
              {info?.cards
                ? tn(info.cards, "The project and its {n} card (including archived) leave Flowly. A copy of the removed board records is kept in the plugin's data folder.", "The project and its {n} cards (including archived) leave Flowly. A copy of the removed board records is kept in the plugin's data folder.")
                : t("The project leaves Flowly. A copy of the removed board record is kept in the plugin's data folder.")}
            </Label>
            {info?.paseoExists !== false && (
              <Choices
                title={t("Paseo project")}
                value={scope}
                options={[
                  { value: "board", label: t("Keep in Paseo") },
                  { value: "paseo", label: t("Also remove from Paseo"), disabled: !info || running > 0 },
                ]}
                onChange={setScope}
              />
            )}
            <Label muted size={font.sm}>
              {info?.paseoExists === false
                ? t("The Paseo project is already gone; only the board record is removed.")
                : scope === "board"
                  ? t("Paseo keeps the project at {primaryPath}, its workspaces and sessions. Running sessions keep running, but their Kanban tools stop working for these cards. You can add the project to the board again later.", { primaryPath: project.primaryPath })
                  : info?.workspaces
                    ? tn(info.workspaces, "Paseo forgets the project and its {n} workspace, as when you remove it in Paseo. Nothing is deleted from disk: {path}, worktrees and branches stay. Add the folder in Paseo again to bring it back.", "Paseo forgets the project and its {n} workspaces, as when you remove it in Paseo. Nothing is deleted from disk: {path}, worktrees and branches stay. Add the folder in Paseo again to bring it back.", { path: project.primaryPath })
                    : t("Paseo forgets the project, as when you remove it in Paseo. Nothing is deleted from disk: {path}, worktrees and branches stay. Add the folder in Paseo again to bring it back.", { path: project.primaryPath })}
            </Label>
            {running > 0 && (
              <Notice tone="info">
                {tn(running, "{n} session is still running in this Paseo project, so it can only be kept in Paseo. Stop it to remove it from Paseo too.", "{n} sessions are still running in this Paseo project, so it can only be kept in Paseo. Stop them to remove it from Paseo too.")}
              </Notice>
            )}
            {check.error && <Notice>{t("Could not check Paseo: {message}", { message: message(check.error) })}</Notice>}
            {error && <Notice>{error}</Notice>}
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                {t("Cancel")}</Button>
              <Button danger disabled={pending || (scope === "paseo" && (!info || running > 0))} onPress={() => void confirm()}>
                {pending ? t("Removing…") : scope === "board" ? t("Remove from board") : t("Remove from board and Paseo")}
              </Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
