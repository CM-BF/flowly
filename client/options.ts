export type PickerOption = {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  disabled?: boolean;
};

/** Case-insensitive match on label, detail and value. */
export function filterOptions(options: readonly PickerOption[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((o) =>
    [o.label, o.detail || "", o.value].some((text) => text.toLowerCase().includes(q)),
  );
}

/** Model rows: label, description, a Default tag; unselectable models are dropped. */
export function modelOptions(
  models: readonly { id: string; label: string; description?: string; isDefault?: boolean; isSelectable?: boolean }[],
): PickerOption[] {
  return models
    .filter((m) => m.isSelectable !== false)
    .map((m) => {
      const label = m.label || m.id;
      // Catalog descriptions often repeat the name ("Opus 5.5 · Latest release").
      const description = m.description?.startsWith(`${label} · `)
        ? m.description.slice(label.length + 3)
        : m.description;
      return {
      value: m.id,
      label,
      detail: description && description !== label ? description : m.id !== label ? m.id : undefined,
      badge: m.isDefault ? "Default" : undefined,
      };
    });
}

/** Provider rows: available providers only, labelled from the snapshot when present. */
export function providerOptions(
  available: readonly { provider: string; available: boolean }[],
  snapshot: readonly { provider: string; label?: string; description?: string }[] = [],
): PickerOption[] {
  return available
    .filter((p) => p.available)
    .map((p) => {
      const info = snapshot.find((s) => s.provider === p.provider);
      const label = info?.label || p.provider;
      return {
        value: p.provider,
        label,
        detail: info?.description || (label !== p.provider ? p.provider : undefined),
      };
    });
}
