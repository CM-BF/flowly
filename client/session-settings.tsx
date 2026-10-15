import { useState } from "react";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PaseoAgent } from "@getpaseo/client";
import * as rpc from "../shared/rpc";
import { Modal } from "./modal";
import { Actions, Button, Label, Notice, Theme, font, message, radius, space, useTheme } from "./ui";
import { PickerGroup, PickerRow } from "./picker";

type Feature = NonNullable<PaseoAgent["features"]>[number];
const featureValue = (f: Feature) =>
  f.type === "toggle"
    ? f.value
      ? "On"
      : "Off"
    : f.options.find((o) => o.id === f.value)?.label || f.value || "Default";

/**
 * Reasoning and permissions apply immediately (official CLI via the plugin
 * daemon). Model and provider features (e.g. Fast mode) are shown read-only:
 * the plugin SDK has no API to change them, so they link to Paseo.
 */
export function SessionSettings({
  open,
  onClose,
  taskId,
  agent,
  onChanged,
  onOpenInPaseo,
}: {
  open: boolean;
  onClose(): void;
  taskId: string;
  agent: PaseoAgent;
  onChanged(): void;
  onOpenInPaseo?: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const paseo = usePaseo(),
    configure = useRpc(rpc.configureSession),
    toast = useToast();
  const [picker, setPicker] = useState<"thinking" | "mode" | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const models = useQuery({
    queryKey: ["ultra", "models", agent.provider, agent.cwd],
    queryFn: async () => {
      const result = await paseo.providers.listModels(agent.provider, { cwd: agent.cwd });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: open,
  });
  const model = models.data?.models?.find((m) => m.id === agent.model);
  const thinking = model?.thinkingOptions || [];
  const currentThinking = agent.thinkingOptionId || model?.defaultThinkingOptionId || "";
  const running = agent.status === "running" || agent.status === "initializing";
  async function apply(change: { thinkingOptionId?: string; modeId?: string; stop?: boolean }, done: string) {
    if (pending) return;
    setPending(true);
    setError("");
    setPicker(null);
    try {
      await configure({ taskId, agentId: agent.id, ...change });
      toast.show(done, { variant: "success" });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  const features = agent.features || [];
  return (
    <Modal
      open={open}
      title="Session settings"
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <PickerGroup>
            <PickerRow
              first
              title="Reasoning"
              icon="Brain"
              open={picker === "thinking"}
              disabled={pending || !thinking.length}
              loading={models.isPending}
              value={currentThinking}
              placeholder={thinking.length ? "Default" : "Not adjustable for this model"}
              options={thinking.map((t) => ({
                value: t.id,
                label: t.label,
                detail: t.description,
                badge: t.id === model?.defaultThinkingOptionId ? "Default" : undefined,
              }))}
              onToggle={() => setPicker(picker === "thinking" ? null : "thinking")}
              onChange={(id) => {
                if (id !== currentThinking) void apply({ thinkingOptionId: id }, "Reasoning updated");
                else setPicker(null);
              }}
            />
            <PickerRow
              title="Permissions"
              icon="ShieldCheck"
              open={picker === "mode"}
              disabled={pending || !agent.availableModes?.length}
              value={agent.currentModeId || ""}
              placeholder="Provider default"
              options={(agent.availableModes || []).map((m) => ({ value: m.id, label: m.label, detail: m.description }))}
              onToggle={() => setPicker(picker === "mode" ? null : "mode")}
              onChange={(id) => {
                if (id !== agent.currentModeId) void apply({ modeId: id }, "Permissions updated");
                else setPicker(null);
              }}
            />
          </PickerGroup>
          <View
            style={{
              gap: space[2],
              padding: space[3],
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <Row label="Model" value={model?.label || agent.model || "Provider default"} />
            {features.map((f) => (
              <Row key={f.id} label={f.label} value={featureValue(f)} />
            ))}
            <Label muted size={font.sm}>
              Paseo plugins cannot change the model or provider features (such as Fast mode) yet. Change them in Paseo; the board picks them up automatically.
            </Label>
            {onOpenInPaseo && (
              <View style={{ flexDirection: "row" }}>
                <Button icon="ArrowUpRight" disabled={pending} onPress={onOpenInPaseo}>
                  Change in Paseo
                </Button>
              </View>
            )}
          </View>
          {!!error && <Notice>{error}</Notice>}
          <Actions>
            {running && (
              <Button danger icon="Square" disabled={pending} onPress={() => void apply({ stop: true }, "Session stopped")}>
                Stop
              </Button>
            )}
            <Button primary disabled={pending} onPress={onClose}>
              Done
            </Button>
          </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space[3], alignItems: "center" }}>
      <View style={{ width: 96 }}>
        <Label muted size={font.sm}>{label}</Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label medium size={font.md} lines={1}>{value}</Label>
      </View>
    </View>
  );
}
