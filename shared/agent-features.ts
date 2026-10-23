/** Only provider-advertised speed controls are exposed by Flowly. */
export type SpeedFeature =
  | { type: "toggle"; id: string; label: string; value: boolean; description?: string }
  | { type: "select"; id: string; label: string; value: string | null; description?: string; options: { id: string; label: string; description?: string }[] };
export type FeatureValues = Record<string, boolean | string>;
export function speedFeatures(features: readonly SpeedFeature[]): SpeedFeature[] {
  return features.filter((f) => f.id === "fast_mode" || f.id === "service_tier");
}
export function supportedFeatures(values: FeatureValues | undefined, features: readonly SpeedFeature[]): FeatureValues {
  const result: FeatureValues = {};
  for (const f of speedFeatures(features)) {
    const value = values?.[f.id];
    if (f.type === "toggle" ? typeof value === "boolean" : typeof value === "string" && f.options.some((o) => o.id === value)) result[f.id] = value!;
  }
  return result;
}
