import { useState } from "react";
import { View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import * as rpc from "../shared/rpc";
import { Button, IconButton, Label, Notice, Row, font, message, radius, space, useTheme } from "./ui";
import { t, msg } from "../shared/i18n";

type DirectoryPage = z.infer<typeof rpc.listDirectories.output>;
const nativeLabels = {
  finder: msg("Choose in Finder…"),
  explorer: msg("Choose in Explorer…"),
  zenity: msg("System dialog…"),
  kdialog: msg("System dialog…"),
} as const;

/**
 * Folder choosers for the project form (PROJECT-PICKER-SPEC §1): an inline
 * daemon-side browser that works on every client, plus the host's system
 * dialog, which opens on the computer running Paseo.
 */
export function DirectoryChooser({
  multiple = false,
  disabled = false,
  onPick,
}: {
  multiple?: boolean;
  disabled?: boolean;
  onPick(paths: string[]): void;
}) {
  const list = useRpc(rpc.listDirectories),
    native = useRpc(rpc.pickNativeDirectory);
  const [browsing, setBrowsing] = useState(false),
    [path, setPath] = useState<string | undefined>(undefined),
    [picking, setPicking] = useState(false),
    [error, setError] = useState("");
  const dirs = useQuery({
    queryKey: ["ultra", "directories", path ?? ""],
    queryFn: () => list({ path }),
    // The first page also tells whether a system dialog exists.
    staleTime: 10_000,
  });
  const nativeKind = dirs.data?.native;
  async function openNative() {
    setPicking(true);
    setError("");
    try {
      const picked = await native({ multiple });
      if (picked.paths.length) {
        onPick(picked.paths);
        setBrowsing(false);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPicking(false);
    }
  }
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
        <Button icon="FolderOpen" disabled={disabled} onPress={() => setBrowsing((b) => !b)}>
          {browsing ? t("Hide folders") : multiple ? t("Browse to add…") : t("Browse…")}
        </Button>
        {nativeKind && (
          <Button icon="AppWindow" disabled={disabled || picking} onPress={() => void openNative()}>
            {picking ? t("Waiting for dialog…") : t(nativeLabels[nativeKind])}
          </Button>
        )}
      </View>
      {nativeKind && picking && (
        <Label muted size={font.sm}>
          {t("The dialog opens on the computer running Paseo.")}</Label>
      )}
      {error && <Notice>{error}</Notice>}
      {browsing && (
        <Browser
          data={dirs.data}
          loading={dirs.isLoading}
          error={dirs.error ? message(dirs.error) : ""}
          multiple={multiple}
          onOpen={setPath}
          onPick={(p) => {
            onPick([p]);
            if (!multiple) setBrowsing(false);
          }}
        />
      )}
    </View>
  );
}

function Browser({
  data,
  loading,
  error,
  multiple,
  onOpen,
  onPick,
}: {
  data?: DirectoryPage;
  loading: boolean;
  error: string;
  multiple: boolean;
  onOpen(path: string): void;
  onPick(path: string): void;
}) {
  const { colors } = useTheme();
    return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        padding: space[2],
        gap: space[2],
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
        <IconButton
          icon="ArrowUp"
          label={t("Parent folder")}
          disabled={!data?.parent}
          onPress={() => data?.parent && onOpen(data.parent)}
        />
        <IconButton icon="House" label={t("Home folder")} disabled={!data} onPress={() => data && onOpen(data.home)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted mono lines={1} size={font.sm}>
            {data?.path ?? "…"}
          </Label>
        </View>
      </View>
      {error ? (
        <Notice>{error}</Notice>
      ) : (
        <ScrollView
          style={{ maxHeight: 264 }}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 1 }}
        >
          {loading && <Label muted size={font.sm}>{t("Loading…")}</Label>}
          {data && !data.entries.length && (
            <Label muted size={font.sm}>{t("No subfolders.")}</Label>
          )}
          {data?.entries.map((entry) => (
            <Row
              key={entry.path}
              title={entry.name}
              detail={entry.git ? t("Git repository") : undefined}
              icon={entry.git ? "FolderGit2" : "Folder"}
              label={t("Open {name}", { name: entry.name })}
              onPress={() => onOpen(entry.path)}
              trailing={
                <IconButton
                  icon={multiple ? "Plus" : "Check"}
                  label={multiple ? t("Add {name}", { name: entry.name }) : t("Use {name}", { name: entry.name })}
                  onPress={() => onPick(entry.path)}
                />
              }
            />
          ))}
          {data?.truncated && (
            <Label muted size={font.sm}>{t("Showing the first 500 folders.")}</Label>
          )}
        </ScrollView>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button disabled={!data} onPress={() => data && onPick(data.path)}>
          {multiple ? t("Add this folder") : t("Use this folder")}
        </Button>
      </View>
    </View>
  );
}
