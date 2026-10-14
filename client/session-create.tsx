import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "../shared/model";
import type { ToolPreparation } from "../shared/tools";
import * as rpc from "../shared/rpc";
import { createPreparedSession } from "./session";
import { Theme, useTheme, Button, Label, Field, Choices, Notice, Actions, message, font, radius, space } from "./ui";
import { PickerGroup, PickerRow } from "./picker";
import { modelOptions, providerOptions } from "./options";
import { Pressable } from "react-native";

export function SessionCreate({
  task,
  open,
  workspaceDirectory,
  unavailable,
  onClose,
  onCreated,
  refresh,
  defaults,
}: {
  task: Task;
  open: boolean;
  /** Provider/model/mode of the latest session, reused as this form's starting point. */
  defaults?: { provider: string; model: string; mode: string } | null;
  workspaceDirectory?: string;
  unavailable: boolean;
  onClose(): void;
  onCreated(id: string, feedback: string): void;
  refresh(): void;
}) {
  const theme = useTheme();
  const paseo = usePaseo(),
    contextRead = useRpc(rpc.taskContext),
    prepare = useRpc(rpc.prepareSession),
    healthRead = useRpc(rpc.toolsHealth);
  const [provider, setProvider] = useState("codex"),
    [model, setModel] = useState(""),
    [mode, setMode] = useState(""),
    [newTitle, setTitle] = useState(""),
    [newPrompt, setPrompt] = useState(""),
    [picker, setPicker] = useState<"provider" | "model" | "mode" | null>(null),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [creationPending, setCreationPending] = useState(false);
  // Prefill each time the form opens; the user can still change everything.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setProvider(defaults?.provider || "codex");
      setModel(defaults?.model || "");
      setMode(defaults?.mode || "");
      setPrompt([task.title, task.description.trim()].filter(Boolean).join("\n\n"));
      setTitle("");
      setError("");
      setPicker(null);
    }
    wasOpen.current = open;
  }, [open]);
  const attempt = useRef<
    | { operationId: string; fingerprint: string; prepared?: ToolPreparation }
    | undefined
  >(undefined);
  const lock = useRef(false);
  const tools = useQuery({
    queryKey: ["ultra", "tools"],
    queryFn: () => healthRead({}),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const providers = useQuery({
    queryKey: ["ultra", "providers"],
    queryFn: () => paseo.providers.listAvailable(),
    enabled: open,
  });
  const providerInfo = useQuery({
    queryKey: ["ultra", "providerSnapshot"],
    queryFn: () => paseo.providers.snapshot(),
    enabled: open,
    staleTime: 60000,
  });
  const models = useQuery({
    queryKey: ["ultra", "models", provider, workspaceDirectory],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider, {
        cwd: workspaceDirectory,
      });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: open && !!workspaceDirectory,
  });
  const modes = useQuery({
    queryKey: ["ultra", "modes", provider, workspaceDirectory],
    queryFn: async () => {
      const result = await paseo.providers.listModes(provider, {
        cwd: workspaceDirectory,
      });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: open && !!workspaceDirectory,
  });
  // A remembered model/mode that this provider no longer offers falls back to the provider default.
  const rememberedModel = models.data?.models?.some(
    (m) => m.id === model && m.isSelectable !== false,
  )
    ? model
    : "";
  const chosenMode =
    mode && (!modes.isSuccess || modes.data?.modes?.some((m) => m.id === mode))
      ? mode
      : "";
  useEffect(() => {
    const available = providers.data?.providers.filter((p) => p.available) || [];
    if (!providers.isSuccess || !available.length) return;
    if (!available.some((p) => p.provider === provider)) {
      setProvider(
        available.find((p) => p.provider === "codex")?.provider || available[0].provider,
      );
      setModel("");
      setMode("");
    }
  }, [providers.data, provider]);
  const chosenModel =
    rememberedModel ||
    models.data?.models?.find((m) => m.isDefault && m.isSelectable !== false)
      ?.id ||
    models.data?.models?.find((m) => m.isSelectable !== false)?.id ||
    "";
  const canCreate =
    !sending &&
    !unavailable &&
    models.isSuccess &&
    !!models.data?.models?.some(
      (m) => m.id === chosenModel && m.isSelectable !== false,
    ) &&
    (!chosenMode || !modes.isError) &&
    !!providers.data?.providers.some(
      (p) => p.available && p.provider === provider,
    );
  async function perform(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  async function createSession(ordinary = false) {
    await perform(async () => {
      const chosen = chosenModel;
      if (!chosen) throw new Error("Choose an available model.");
      const latestScope = await contextRead({ id: task.id });
      if (!latestScope.available) throw new Error(latestScope.reason);
      const fingerprint = JSON.stringify([
        provider,
        chosen,
        chosenMode,
        newTitle,
        newPrompt,
        ordinary,
      ]);
      if (attempt.current?.prepared) {
        const existing = await paseo.agents
          .ref(attempt.current.prepared.agentId)
          .refresh();
        if (existing?.agent) {
          if (
            existing.agent.workspaceId !== task.workspaceId ||
            existing.agent.archivedAt
          )
            throw new Error(
              "Prepared session is unavailable or belongs to a different workspace.",
            );
          onCreated(
            existing.agent.id,
            "Recovered the existing session. Its initial instruction was not sent again; check its output before continuing.",
          );
          onClose();
          attempt.current = undefined;
          setCreationPending(false);
          refresh();
          return;
        }
      }
      if (!attempt.current || attempt.current.fingerprint !== fingerprint)
        attempt.current = {
          operationId: `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          fingerprint,
        };
      const preparation = ordinary
        ? undefined
        : await prepare({
            id: task.id,
            operationId: attempt.current.operationId,
          });
      if (preparation) {
        attempt.current.prepared = preparation;
        setCreationPending(true);
      }
      const options = {
        config: {
          provider: `${provider}/${chosen}`,
          systemPrompt: preparation?.instructions || latestScope.context,
          ...(preparation
            ? { mcpServers: { "ultra-kanban": preparation.mcp } }
            : {}),
          ...(chosenMode ? { modeId: chosenMode } : {}),
        },
        ...(preparation
          ? {
              agentId: preparation.agentId,
              idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
              env: {
                ULTRA_KANBAN_CONTEXT_FILE: preparation.contextFile,
                ULTRA_KANBAN_CLI: preparation.cliPath,
                ULTRA_KANBAN_SKILL: preparation.skillPath,
              },
            }
          : { idempotencyKey: attempt.current.operationId }),
        title: newTitle.trim() || task.title,
        labels: { "ultra-kanban-task": task.id },
        prompt: newPrompt.trim() || undefined,
      };
      const created = preparation
        ? await createPreparedSession(paseo, task.workspaceId, {
            ...options,
            agentId: preparation.agentId,
          })
        : await paseo.workspaces.ref(task.workspaceId).agents.create(options);
      onCreated(
        created.id,
        "recovered" in created && created.recovered
          ? "Session exists after a partial creation response. Check its output before sending more instructions."
          : ordinary
            ? "Ordinary session created. Select it to send Kanban instructions later."
            : "Kanban configuration provided. Successful tool calls will be shown separately.",
      );
      attempt.current = undefined;
      setCreationPending(false);
      onClose();
      setPrompt("");
      setTitle("");
      refresh();
    });
  }
  return (
    <Modal
      open={open}
      title="New session"
      onOpenChange={(next) => {
        if (!next && !lock.current) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <Field
          title="Session title (optional)"
          value={newTitle}
          onChange={setTitle}
          placeholder={task.title}
          editable={!sending}
        />
        <Field
          title="Initial instruction (optional)"
          value={newPrompt}
          onChange={setPrompt}
          multiline
          placeholder="What should this session work on?"
          editable={!sending}
        />
        <View style={{ gap: space[1.5] }}>
          <Label medium size={font.sm} muted>
            Agent
          </Label>
          <PickerGroup>
            <PickerRow
              first
              title="Provider"
              icon="Bot"
              open={picker === "provider"}
              disabled={sending}
              loading={providers.isPending}
              value={provider}
              placeholder="Choose a provider"
              options={providerOptions(providers.data?.providers || [], providerInfo.data?.entries || [])}
              onToggle={() => setPicker(picker === "provider" ? null : "provider")}
              onChange={(p) => {
                if (p !== provider) {
                  setProvider(p);
                  setModel("");
                  setMode("");
                }
                setPicker(null);
              }}
            />
            <PickerRow
              title="Model"
              icon="Cpu"
              open={picker === "model"}
              disabled={sending}
              loading={models.isPending}
              value={chosenModel}
              placeholder="Choose a model"
              options={modelOptions(models.data?.models || [])}
              onToggle={() => setPicker(picker === "model" ? null : "model")}
              onChange={(m) => {
                setModel(m);
                setPicker(null);
              }}
            />
            <PickerRow
              title="Permissions"
              icon="ShieldCheck"
              open={picker === "mode"}
              disabled={sending}
              loading={modes.isPending}
              value={chosenMode}
              placeholder="Provider default"
              options={[
                { value: "", label: "Provider default", detail: "Use the provider's configured permission mode" },
                ...(modes.data?.modes || []).map((m) => ({
                  value: m.id,
                  label: m.label,
                  detail: m.description,
                })),
              ]}
              onToggle={() => setPicker(picker === "mode" ? null : "mode")}
              onChange={(m) => {
                setMode(m);
                setPicker(null);
              }}
            />
          </PickerGroup>
        </View>
        <Label muted size={font.sm}>
          Includes Kanban tools and the current task's work instructions.
        </Label>
        {providers.isSuccess &&
          !providers.data?.providers.some((p) => p.available) && (
            <Notice>
              No providers are available. Configure a provider in Paseo to
              create a session.
            </Notice>
          )}
        {providers.isSuccess &&
          providers.data?.providers.some((p) => p.available) &&
          !providers.data?.providers.some(
            (p) => p.available && p.provider === provider,
          ) && (
            <Notice>Choose an available provider.</Notice>
          )}
        {models.isSuccess &&
          !(models.data?.models || []).some(
            (m) => m.isSelectable !== false,
          ) && (
            <Notice>
              No selectable models are available for this provider.
            </Notice>
          )}
        {(models.error || modes.error || providers.error) && (
          <Notice>
            {message(models.error || modes.error || providers.error)}
          </Notice>
        )}
        {(!tools.data?.ready || tools.error) && (
          <Notice tone={tools.error ? "danger" : "warning"}>
            {tools.error
              ? message(tools.error)
              : tools.data?.reason || "Checking Kanban tools…"}
          </Notice>
        )}
        {creationPending && (
          <Notice tone="info">
            A session ID is prepared. Retry checks for an existing session
            before creating it.
          </Notice>
        )}
        {error && <Notice>{error}</Notice>}
        <Actions>
          {!tools.data?.ready && (
            <Button
              disabled={!canCreate}
              onPress={() => void createSession(true)}
            >
              Create ordinary session
            </Button>
          )}
          <Button quiet disabled={sending} onPress={onClose}>
            Cancel
          </Button>
          <Button
            primary
            disabled={!canCreate || !tools.data?.ready}
            onPress={() => void createSession()}
          >
            {sending ? "Creating…" : "Create session"}
          </Button>
        </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
