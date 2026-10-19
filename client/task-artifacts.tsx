import { memo, useMemo, useState } from "react";
import { Image, Linking, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Artifact, ArtifactRole, Task } from "../shared/model";
import { artifactGroups, artifactsOf, baseName } from "../shared/artifacts";
import { Modal } from "./modal";
import { IdeaRow, useExitList } from "./task-ideas";
import { boardKey, useBoardQuery } from "./queries";
import { SessionMarkdown } from "./session-content";
import { Disclosure } from "./disclosure";
import { AiMark, Actions, Button, Choices, Field, IconButton, Label, Notice, SectionHeader, Theme, font, message, space, touch, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";
import { LinkTicket, TicketPreview, useConnections } from "./tickets";

const shown = 5;

/**
 * Drawer "Artifacts" (CARD-ARTIFACTS-SPEC §5.2): the card's inputs and outputs,
 * each marked as added by you or by an agent. Files open a read-only preview,
 * links open in the browser. Removing is optimistic and never touches the file.
 */
export function TaskArtifacts({ task, disabled }: { task: Task; disabled: boolean }) {
  const board = useBoardQuery();
  const toast = useToast();
  const queryClient = useQueryClient();
  const deleteArtifact = useRpc(rpc.deleteArtifact);
  const readStatus = useRpc(rpc.artifactStatus);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<Artifact | "new" | null>(null);
  const [previewing, setPreviewing] = useState<Artifact | null>(null);
  const [linking, setLinking] = useState(false);
  const connections = useConnections();
  const ticketConnections = connections.data?.connections || [];
  const readTickets = useRpc(rpc.cardTickets);
  const [expanded, setExpanded] = useState<ReadonlySet<ArtifactRole>>(() => new Set());
  const list = useMemo(
    () => (board.data ? artifactsOf(board.data.artifacts, task.id).filter((a) => !removing.has(a.id)) : []),
    [board.data, task.id, removing],
  );
  const fileKey = list.filter((a) => a.kind === "file").map((a) => `${a.id}:${a.target}`).join("|");
  // One batched check when the drawer shows the card or its files change (CARD-ARTIFACTS-SPEC §9).
  const status = useQuery({
    queryKey: ["ultra", "artifact-status", task.id, fileKey],
    queryFn: () => readStatus({ taskId: task.id }),
    enabled: !!fileKey,
    staleTime: 30_000,
    retry: false,
  });
  const missing = useMemo(() => new Set(status.data?.missing || []), [status.data]);
  // Ticket statuses for the rows, cached by the daemon (EXTERNAL-TRACKER-SPEC §3.3).
  const ticketKey = list.filter((a) => a.ticket).map((a) => a.id).join("|");
  const ticketStatus = useQuery({
    queryKey: ["ultra", "card-tickets", task.id, ticketKey],
    queryFn: () => readTickets({ taskId: task.id }),
    enabled: !!ticketKey,
    staleTime: 60_000,
    retry: false,
  });
  const statuses = useMemo(() => {
    const map = new Map((ticketStatus.data?.tickets || []).map((x) => [x.artifactId, x.summary.status]));
    // A removed connection reads as such instead of a status (EXTERNAL-TRACKER-SPEC §2).
    for (const id of ticketStatus.data?.removed || []) map.set(id, t("Connection removed"));
    return map;
  }, [ticketStatus.data]);
  const linkedKeys = useMemo(() => new Set(list.flatMap((a) => (a.ticket ? [a.ticket.key] : []))), [list]);
  const rows = useExitList(list);
  const remove = async (artifact: Artifact) => {
    setRemoving((current) => new Set(current).add(artifact.id));
    try {
      await deleteArtifact({ id: artifact.id });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.show(t("Artifact removed. The file was not changed."), { variant: "success" });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(artifact.id);
        return next;
      });
    }
  };
  const open = (artifact: Artifact) => {
    if (artifact.ticket) return setPreviewing(artifact);
    if (artifact.kind === "url")
      return void Linking.openURL(artifact.target).catch(() => toast.show(t("Could not open the link."), { variant: "error" }));
    setPreviewing(artifact);
  };
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t("Artifacts")} count={list.length}>
        {ticketConnections.length > 0 && (
          <IconButton icon="Ticket" label={t("Link Jira ticket")} disabled={disabled} onPress={() => setLinking(true)} />
        )}
        <IconButton icon="Plus" label={t("Add an artifact: a file or link")} disabled={disabled} onPress={() => setEditing("new")} />
      </SectionHeader>
      {artifactGroups.map((group) => {
        const own = rows.filter((r) => r.item.role === group.role);
        if (!own.length) return null;
        const render = (row: (typeof own)[number]) => (
          <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={0}>
            <ArtifactRow
              artifact={row.item}
              missing={missing.has(row.item.id)}
              ticketStatus={statuses.get(row.item.id)}
              disabled={disabled || row.leaving}
              onOpen={open}
              onEdit={setEditing}
              onRemove={remove}
            />
          </IdeaRow>
        );
        return (
          <View key={group.role} style={{ gap: 2 }}>
            <Label muted size={font.xs} bold selectable={false}>{t(group.title)}</Label>
            {own.slice(0, shown).map(render)}
            {own.length > shown && (
              <Disclosure
                title={tn(own.length - shown, "Show {n} more", "Show {n} more")}
                open={expanded.has(group.role)}
                onChange={(next) =>
                  setExpanded((current) => {
                    const copy = new Set(current);
                    if (next) copy.add(group.role);
                    else copy.delete(group.role);
                    return copy;
                  })
                }
              >
                <View style={{ gap: 2 }}>{own.slice(shown).map(render)}</View>
              </Disclosure>
            )}
          </View>
        );
      })}
      {editing && <ArtifactForm task={task} artifact={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {previewing &&
        (previewing.ticket ? (
          <TicketPreview artifact={previewing} onClose={() => setPreviewing(null)} />
        ) : (
          <ArtifactPreview artifact={previewing} onClose={() => setPreviewing(null)} />
        ))}
      {linking && <LinkTicket taskId={task.id} linked={linkedKeys} connections={ticketConnections} onClose={() => setLinking(false)} />}
    </View>
  );
}

const ArtifactRow = memo(function ArtifactRow({
  artifact,
  missing,
  ticketStatus,
  disabled,
  onOpen,
  onEdit,
  onRemove,
}: {
  artifact: Artifact;
  missing: boolean;
  /** The ticket's current status (reference only), for ticket inputs. */
  ticketStatus?: string;
  disabled: boolean;
  onOpen(artifact: Artifact): void;
  onEdit(artifact: Artifact): void;
  onRemove(artifact: Artifact): void;
}) {
  const { colors } = useTheme();
  const agent = artifact.createdBy === "agent";
  const source = agent ? t("Added by an agent") : t("Added by you");
  const role = artifact.role === "input" ? t("Input") : t("Output");
  const detail = artifact.ticket
    ? [t("Jira ticket"), ticketStatus, artifact.note].filter(Boolean).join(" · ")
    : artifact.note || (artifact.kind === "url" ? hostOf(artifact.target) : artifact.target);
  const icon = artifact.ticket ? "Ticket" : artifact.kind === "url" ? "Link" : /\/$|^\.\/$/.test(artifact.target) || !/\.[^/]+$/.test(baseName(artifact.target)) ? "Folder" : "FileText";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 44 : 34 }}>
      <Pressable
        accessibilityRole={artifact.kind === "url" && !artifact.ticket ? "link" : "button"}
        accessibilityLabel={`${role}: ${artifact.title}, ${source}${missing ? `, ${t("missing")}` : ""}`}
        onPress={() => onOpen(artifact)}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5], opacity: pressed ? 0.7 : 1 })}
      >
        <Icon name={icon} size={14} color={missing ? colors.foregroundMuted : colors.foreground} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label size={font.sm} muted={missing} lines={1} selectable={false}>{artifact.title}</Label>
          <Label size={font.xs} muted lines={1} selectable={false}>{missing ? `${t("Missing")} · ${detail}` : detail}</Label>
        </View>
        {agent ? <AiMark size={12} /> : <Icon name="User" size={12} color={colors.foregroundMuted} />}
      </Pressable>
      <IconButton icon="Pencil" size={touch ? 36 : 24} label={t("Edit artifact: {title}", { title: artifact.title })} disabled={disabled} onPress={() => onEdit(artifact)} />
      <IconButton icon="X" size={touch ? 36 : 24} label={t("Remove artifact: {title}", { title: artifact.title })} disabled={disabled} onPress={() => onRemove(artifact)} />
    </View>
  );
});

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const roleChoices = (): { value: ArtifactRole; label: string }[] => [
  { value: "input", label: t("Input") },
  { value: "output", label: t("Output") },
];

/** Add or edit an artifact (CARD-ARTIFACTS-SPEC §5.3). The target is fixed once added. */
function ArtifactForm({ task, artifact, onClose }: { task: Task; artifact: Artifact | null; onClose(): void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const create = useRpc(rpc.createArtifact);
  const update = useRpc(rpc.updateArtifact);
  const [role, setRole] = useState<ArtifactRole>(artifact?.role ?? "input");
  const [target, setTarget] = useState(artifact?.target ?? "");
  const [title, setTitle] = useState(artifact?.title ?? "");
  const [note, setNote] = useState(artifact?.note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const ready = !pending && !!target.trim();
  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError("");
    try {
      if (artifact) await update({ id: artifact.id, updatedAt: artifact.updatedAt, role, title, note });
      else await create({ taskId: task.id, role, target, title, note });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.show(artifact ? t("Artifact saved") : t("Artifact added"), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open title={artifact ? t("Edit artifact") : t("Add artifact")} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            {!!error && <Notice tone="danger">{error}</Notice>}
            <Choices title={t("Role")} value={role} options={roleChoices()} onChange={setRole} />
            <Field
              title={t("Path or link")}
              value={target}
              onChange={setTarget}
              editable={!artifact}
              autoFocus={!artifact && !touch}
              placeholder={t("docs/spec.md or https://…")}
              hint={artifact ? undefined : t("A file or folder in this card's directories (relative to its workspace), or an http(s) link. Only the reference is stored.")}
              onSubmit={ready ? () => void submit() : undefined}
            />
            <Field title={t("Title")} value={title} onChange={setTitle} placeholder={t("Defaults to the file name or link")} />
            <Field title={t("Note")} value={note} onChange={setNote} multiline placeholder={t("What it is for")} />
            <Actions>
              <Button quiet onPress={onClose} disabled={pending}>{t("Cancel")}</Button>
              <Button primary onPress={() => void submit()} disabled={!ready}>{artifact ? t("Save") : t("Add")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Read-only view of a file artifact (CARD-ARTIFACTS-SPEC §6.2), loaded once per opening. */
function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const theme = useTheme();
  const read = useRpc(rpc.previewArtifact);
  const preview = useQuery({
    queryKey: ["ultra", "artifact-preview", artifact.id, artifact.updatedAt],
    queryFn: () => read({ id: artifact.id }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const data = preview.data;
  return (
    <Modal open title={artifact.title} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[2] }}>
            <Label muted size={font.xs} selectable lines={2}>{artifact.target}</Label>
            {!!artifact.note && <Label size={font.sm} selectable>{artifact.note}</Label>}
            {preview.isPending ? (
              <Label muted>{t("Loading…")}</Label>
            ) : preview.error ? (
              <Notice tone="warning">{message(preview.error)}</Notice>
            ) : data?.type === "image" ? (
              <Image source={{ uri: data.dataUri }} resizeMode="contain" accessibilityLabel={artifact.title} style={{ width: "100%", height: 480 }} />
            ) : data?.type === "text" ? (
              // The host modal body is the only scroll view: a nested one fights it for the pan on phones.
              data.markdown ? (
                <SessionMarkdown text={data.text} />
              ) : (
                <Label size={font.sm} selectable mono>{data.text}</Label>
              )
            ) : data?.type === "directory" ? (
              <View style={{ gap: 2 }}>
                {data.entries.map((e) => (
                  <View key={e.name} style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                    <Icon name={e.directory ? "Folder" : "File"} size={13} color={theme.colors.foregroundMuted} />
                    <Label size={font.sm} lines={1}>{e.name}</Label>
                  </View>
                ))}
                {!data.entries.length && <Label muted size={font.sm}>{t("This folder is empty.")}</Label>}
                {data.more && <Label muted size={font.xs}>{t("Only the first 200 entries are shown.")}</Label>}
              </View>
            ) : (
              <Label muted size={font.sm}>
                {t("No preview for this file ({size}). Open it from the workspace.", { size: formatSize(data?.size ?? 0) })}
              </Label>
            )}
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
