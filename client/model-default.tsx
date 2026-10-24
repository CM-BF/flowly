import { useEffect, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { AgentModel } from "../shared/agent-defaults";
import { modelOptions, providerOptions } from "./options";
import { SettingSelect, SettingsGroup } from "./settings-ui";
import { AgentSpeed, useAgentFeatures } from "./agent-speed";
import { supportedFeatures } from "../shared/agent-features";
import { t } from "../shared/i18n";

/**
 * Provider, model and reasoning effort of a default model, as one card of rows.
 * "None" (first provider choice) clears it: `noneLabel` says what then applies.
 * `execution` adds Permissions (inherit / provider default / a mode) and Speed;
 * `permissions` adds only Permissions (inherit / a mode).
 */
export function ModelDefaultGroup({
  title,
  description,
  value,
  onChange,
  noneLabel,
  noneDetail,
  disabled = false,
  execution = false,
  permissions = false,
  cwd,
}: {
  title?: string;
  description?: string;
  value: AgentModel | null;
  onChange(next: AgentModel | null): void;
  noneLabel: string;
  noneDetail?: string;
  disabled?: boolean;
  execution?: boolean;
  /** Permissions row only, for a flat setting that cannot store "explicit provider default" or speed (Settings → Models). */
  permissions?: boolean;
  cwd?: string;
}) {
  const paseo = usePaseo();
  // A provider can be picked before its model is: the model row follows it.
  const [provider, setProvider] = useState(value?.provider ?? "");
  useEffect(() => setProvider(value?.provider ?? ""), [value?.provider]);
  const providers = useQuery({ queryKey: ["flowly", "providers"], queryFn: () => paseo.providers.listAvailable() });
  const providerInfo = useQuery({ queryKey: ["flowly", "providerSnapshot"], queryFn: () => paseo.providers.snapshot(), staleTime: 60000 });
  const models = useQuery({
    queryKey: ["flowly", "default-models", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: !!provider,
  });
  const selectable = (models.data?.models || []).filter((m) => m.isSelectable !== false);
  const sameProvider = !!value && value.provider === provider;
  const model = sameProvider ? value!.model : "";
  // Choosing a provider also chooses its default model, so the default is always complete.
  useEffect(() => {
    if (!provider || model || !models.isSuccess || !selectable.length) return;
    const pick = selectable.find((m) => m.isDefault) || selectable[0];
    onChange({ provider, model: pick.id });
  }, [provider, model, models.isSuccess, selectable.length]);
  const thinkingOptions = selectable.find((m) => m.id === model)?.thinkingOptions || [];
  const thinking = sameProvider && value!.thinking && thinkingOptions.some((o) => o.id === value!.thinking) ? value!.thinking! : "";
  const modes = useQuery({
    queryKey: ["flowly", "modes", provider, cwd],
    queryFn: async () => {
      const result = await paseo.providers.listModes(provider, { cwd });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: (execution || permissions) && !!provider,
  });
  const features = useAgentFeatures(provider, model, cwd, execution);
  // Model changes drop unsupported capabilities once discovery completes.
  useEffect(() => {
    if (!execution || !value?.featureValues || !features.isSuccess) return;
    const clean = supportedFeatures(value.featureValues, features.data);
    if (JSON.stringify(clean) !== JSON.stringify(value.featureValues)) onChange({ ...value, featureValues: clean });
  }, [model, features.data, execution, value?.featureValues]);
  const defaultThinking = selectable.find((m) => m.id === model)?.defaultThinkingOptionId;
  const defaultThinkingLabel = thinkingOptions.find((o) => o.id === defaultThinking)?.label;
  const modelDefault = defaultThinkingLabel ? t("Model default ({defaultLabel})", { defaultLabel: defaultThinkingLabel }) : t("Model default");
  return (
    <SettingsGroup title={title} description={description}>
      <SettingSelect
        title={t("Provider")}
        value={provider}
        placeholder={noneLabel}
        disabled={disabled}
        loading={providers.isPending}
        options={[{ value: "", label: noneLabel, detail: noneDetail }, ...providerOptions(providers.data?.providers || [], providerInfo.data?.entries || [])]}
        onChange={(next) => {
          setProvider(next);
          if (!next) onChange(null);
        }}
      />
      {!!provider && (
        <SettingSelect
          title={t("Model")}
          value={model}
          placeholder={t("Choose a model")}
          disabled={disabled}
          loading={models.isPending}
          options={modelOptions(models.data?.models || [])}
          onChange={(next) => onChange({ ...(sameProvider ? value : {}), provider, model: next, thinking: undefined })}
        />
      )}
      {!!provider && !!model && thinkingOptions.length > 0 && (
        <SettingSelect
          title={t("Reasoning")}
          value={thinking}
          placeholder={modelDefault}
          disabled={disabled}
          options={[
            { value: "", label: modelDefault, detail: t("Use the model's default reasoning effort") },
            ...thinkingOptions.map((o) => ({ value: o.id, label: o.label, detail: o.description })),
          ]}
          onChange={(next) => onChange({ ...value, provider, model, thinking: next || undefined })}
        />
      )}
      {permissions && !execution && !!value && !!model && (modes.data?.modes ?? []).length > 0 && (
        <SettingSelect title={t("Permissions")} value={value.modeId ?? ""}
          placeholder={t("Same as latest session")}
          disabled={disabled} loading={modes.isPending}
          options={[
            { value: "", label: t("Same as latest session"), detail: t("Use the latest session's permission mode when it uses this provider, else the provider's own") },
            ...(modes.data?.modes ?? []).map((m) => ({ value: m.id, label: m.label, detail: m.description })),
          ]}
          onChange={(modeId) => {
            const { modeId: _old, ...rest } = value;
            onChange(modeId ? { ...rest, modeId } : rest);
          }} />
      )}
      {execution && !!value && !!model && <>
        <SettingSelect title={t("Permissions")} value={value.modeId ?? "__inherit"}
          placeholder={t("Follow existing defaults")}
          disabled={disabled} loading={modes.isPending}
          options={[
            { value: "__inherit", label: t("Follow existing defaults") },
            { value: "", label: t("Provider default"), detail: t("Use the provider's configured permission mode") },
            ...(modes.data?.modes ?? []).map((m) => ({ value: m.id, label: m.label, detail: m.description })),
          ]}
          onChange={(modeId) => onChange({ ...value, modeId: modeId === "__inherit" ? undefined : modeId })} />
        <AgentSpeed features={features.data ?? []} values={value.featureValues} disabled={disabled}
          onChange={(featureValues) => onChange({ ...value, featureValues })} />
      </>}
    </SettingsGroup>
  );
}
