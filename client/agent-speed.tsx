import { useQuery } from "@tanstack/react-query";
import { usePaseo } from "@getpaseo/plugin/client";
import { SettingSelect } from "./settings-ui";
import { speedFeatures, supportedFeatures, type FeatureValues, type SpeedFeature } from "../shared/agent-features";
import { t } from "../shared/i18n";

export function useAgentFeatures(provider: string, model: string, cwd: string | undefined, enabled: boolean) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["flowly", "agent-features", provider, model, cwd],
    queryFn: async () => {
      const result = await paseo.providers.listFeatures({ provider: `${provider}/${model}`, cwd: cwd! });
      if (result.error) throw new Error(result.error);
      return speedFeatures(result.features ?? []);
    },
    enabled: enabled && !!provider && !!model && !!cwd,
  });
}
export function AgentSpeed({ features, values, onChange, disabled }: {
  features: SpeedFeature[]; values?: FeatureValues; onChange(values: FeatureValues): void; disabled?: boolean;
}) {
  return <>{features.map((f) => <SettingSelect key={f.id}
    title={t("Speed")}
    value={values?.[f.id] === undefined ? "" : String(values[f.id])}
    placeholder={t("Inherited speed")}
    disabled={disabled}
    options={[{ value: "", label: t("Inherited speed") }, ...(f.type === "toggle"
      ? [{ value: "false", label: t("Standard") }, { value: "true", label: t("Fast") }]
      : f.options.map((o) => ({ value: o.id, label: o.label, detail: o.description })))]}
    onChange={(next) => {
      const result = supportedFeatures(values, features);
      if (!next) delete result[f.id];
      else result[f.id] = f.type === "toggle" ? next === "true" : next;
      onChange(result);
    }}
  />)}</>;
}
