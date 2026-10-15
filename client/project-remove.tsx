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

export type RemoveResult = z.infer<typeof rpc.removeProject.output>;
type Scope = "board" | "paseo";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
      title={`Remove “${project.title}”?`}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Label>
              {info?.cards
                ? `The project and its ${plural(info.cards, "card")} (including archived) leave Ultra Kanban. A copy of the removed board records is kept in the plugin's data folder.`
                : "The project leaves Ultra Kanban. A copy of the removed board record is kept in the plugin's data folder."}
            </Label>
            {info?.paseoExists !== false && (
              <Choices
                title="Paseo project"
                value={scope}
                options={[
                  { value: "board", label: "Keep in Paseo" },
                  { value: "paseo", label: "Also remove from Paseo", disabled: !info || running > 0 },
                ]}
                onChange={setScope}
              />
            )}
            <Label muted size={font.sm}>
              {info?.paseoExists === false
                ? "The Paseo project is already gone; only the board record is removed."
                : scope === "board"
                  ? `Paseo keeps the project at ${project.primaryPath}, its workspaces and sessions. Running sessions keep running, but their Kanban tools stop working for these cards. You can add the project to the board again later.`
                  : `Paseo forgets the project${info?.workspaces ? ` and its ${plural(info.workspaces, "workspace")}` : ""}, as when you remove it in Paseo. Nothing is deleted from disk: ${project.primaryPath}, worktrees and branches stay. Add the folder in Paseo again to bring it back.`}
            </Label>
            {running > 0 && (
              <Notice tone="info">
                {`${plural(running, "session")} still running in this Paseo project, so it can only be kept in Paseo. Stop ${running === 1 ? "it" : "them"} to remove it from Paseo too.`}
              </Notice>
            )}
            {check.error && <Notice>{`Could not check Paseo: ${message(check.error)}`}</Notice>}
            {error && <Notice>{error}</Notice>}
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                Cancel
              </Button>
              <Button danger disabled={pending || (scope === "paseo" && (!info || running > 0))} onPress={() => void confirm()}>
                {pending ? "Removing…" : scope === "board" ? "Remove from board" : "Remove from board and Paseo"}
              </Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
