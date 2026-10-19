import { memo, useMemo, useState } from "react";
import { Linking, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Artifact } from "../shared/model";
import { classifyQuery, keyFromUrl, type Connection, type TicketProvider, type TicketSummary } from "../shared/tickets";
import { boardViewSettings, boardViewValues } from "../shared/settings";
import { Modal } from "./modal";
import { SessionMarkdown } from "./session-content";
import { boardKey, useBoardQuery } from "./queries";
import { SettingRow, SettingsGroup, SettingsPage } from "./settings-ui";
import { Actions, Badge, Button, Choices, Field, IconButton, Label, Notice, Row, Theme, font, message, radius, relativeTime, space, useTheme } from "./ui";
import { msg, t, tn } from "../shared/i18n";

/**
 * Jira tickets as read-only card inputs (EXTERNAL-TRACKER-SPEC): the
 * connections settings page, the ticket picker used by New task and by the
 * drawer, and the ticket preview. Nothing here writes to Jira.
 */

export const connectionsKey = ["ultra", "ticket-connections"] as const;

export function useConnections() {
  const list = useRpc(rpc.listConnections);
  return useQuery({ queryKey: connectionsKey, queryFn: () => list({}), staleTime: 60_000, retry: false });
}

const providerLabels: Record<TicketProvider, string> = { "jira-dc": msg("Jira (self-hosted)"), "jira-cloud": msg("Jira Cloud") };

/** "SHOPSR-123" chip with an optional remove button (New task form). */
export function TicketChip({ ticket, onRemove }: { ticket: TicketSummary; onRemove?(): void }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[1.5],
        paddingLeft: space[2],
        paddingRight: onRemove ? 0 : space[2],
        minHeight: 32,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Icon name="Ticket" size={14} color={colors.foregroundMuted} />
      <Label medium size={font.sm} selectable={false}>{ticket.key}</Label>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>{ticket.summary}</Label>
      </View>
      {!!ticket.status && <Badge>{ticket.status}</Badge>}
      {onRemove && <IconButton icon="X" size={28} label={t("Remove ticket {key}", { key: ticket.key })} onPress={onRemove} />}
    </View>
  );
}

const TicketResult = memo(function TicketResult({
  ticket,
  usedBy,
  picked,
  onPick,
}: {
  ticket: TicketSummary;
  usedBy?: string;
  picked: boolean;
  onPick(ticket: TicketSummary): void;
}) {
  const detail = [ticket.status, ticket.type, ticket.updated ? relativeTime(ticket.updated) : ""].filter(Boolean).join(" · ");
  return (
    <Row
      title={`${ticket.key}  ${ticket.summary}`}
      detail={usedBy ? `${detail} · ${t("On card {title}", { title: usedBy })}` : detail}
      icon="Ticket"
      selected={picked}
      disabled={picked}
      label={t("Choose ticket {key}: {summary}", { key: ticket.key, summary: ticket.summary })}
      onPress={() => onPick(ticket)}
    />
  );
});

/**
 * Inline ticket picker (EXTERNAL-TRACKER-SPEC §5.2): my recent unresolved
 * tickets, or a search by key, link, number or text. Choosing a ticket only
 * reports it; the caller decides what to do with it.
 */
export function TicketPicker({
  connections,
  picked,
  usedBy,
  onPick,
  onClose,
}: {
  connections: readonly Connection[];
  /** Keys already chosen (or already on this card): shown as chosen and not choosable. */
  picked: ReadonlySet<string>;
  /** Key → title of another card that already references it. */
  usedBy?: ReadonlyMap<string, string>;
  onPick(ticket: TicketSummary): void;
  onClose(): void;
}) {
  const { colors } = useTheme();
  const search = useRpc(rpc.searchTickets);
  const view = useSettings(boardViewSettings);
  const remembered = view.status === "ready" ? boardViewValues(view.values).lastTicketConnection : "";
  const [chosen, setChosen] = useState("");
  const connection = connections.find((c) => c.id === (chosen || remembered)) || connections[0];
  const [query, setQuery] = useState("");
  const kind = connection ? classifyQuery(query, connection.baseUrl).kind : "recent";
  // Text needs two characters; keys, links and numbers search at once.
  const ready = !!connection && (kind !== "text" || query.trim().length >= 2);
  const results = useQuery({
    queryKey: ["ultra", "ticket-search", connection?.id ?? "", kind === "recent" ? "" : query.trim()],
    queryFn: () => search({ connectionId: connection!.id, query: kind === "recent" ? "" : query.trim() }),
    enabled: ready,
    staleTime: 30_000,
    retry: false,
  });
  const pick = (ticket: TicketSummary) => {
    if (view.status === "ready" && ticket.connectionId !== remembered)
      void (view.save as (v: unknown, r: unknown) => Promise<unknown>)({ ...boardViewValues(view.values), lastTicketConnection: ticket.connectionId }, view.revision);
    onPick(ticket);
  };
  if (!connection) return null;
  const list = results.data?.results || [];
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: space[2], gap: space[2] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.sm} selectable={false}>
            {kind === "recent" ? t("My recent tickets") : t("Search results")}
          </Label>
        </View>
        <IconButton icon="X" label={t("Close ticket picker")} onPress={onClose} />
      </View>
      {connections.length > 1 && (
        <Choices
          title={t("Connection")}
          hideTitle
          value={connection.id}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setChosen}
        />
      )}
      <Field
        title={t("Search Jira")}
        value={query}
        onChange={setQuery}
        commitDelay={300}
        placeholder={t("Ticket number, link or words from the title")}
      />
      {results.error ? (
        <View style={{ gap: space[2] }}>
          <Notice tone="warning">{ticketError(results.error)}</Notice>
          <Actions>
            <Button small onPress={() => void results.refetch()}>{t("Retry")}</Button>
          </Actions>
        </View>
      ) : !ready ? (
        <Label muted size={font.sm}>{t("Type at least 2 characters.")}</Label>
      ) : results.isPending ? (
        <Label muted size={font.sm}>{t("Loading…")}</Label>
      ) : !list.length ? (
        <Label muted size={font.sm}>{kind === "recent" ? t("No open tickets are assigned to you.") : t("No matching tickets")}</Label>
      ) : (
        <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 1 }}>
          {list.map((ticket) => (
            <TicketResult key={ticket.key} ticket={ticket} usedBy={usedBy?.get(ticket.key)} picked={picked.has(ticket.key)} onPick={pick} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** A readable reason for a failed ticket request. */
export function ticketError(error: unknown) {
  const text = message(error);
  if (/refused the token|login page/i.test(text)) return t("Jira refused the connection's token. Update it in Flowly settings → Connections.");
  if (/unreachable|busy or unavailable|asked Flowly to wait/i.test(text)) return t("Jira is unreachable right now. Try again shortly.");
  if (/connection was removed/i.test(text)) return t("This Jira connection was removed. Add it again in Settings → Connections to read the ticket here; Open in Jira still works.");
  return text;
}

/** Drawer action: choose a ticket and add it to the card as an input (EXTERNAL-TRACKER-SPEC §5.1). */
export function LinkTicket({ taskId, linked, connections, onClose }: { taskId: string; linked: ReadonlySet<string>; connections: readonly Connection[]; onClose(): void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const create = useRpc(rpc.createArtifact);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const pick = async (ticket: TicketSummary) => {
    setPending(true);
    setError("");
    try {
      await create({ taskId, role: "input", target: ticket.url });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.show(t("Linked {key}", { key: ticket.key }), { variant: "success" });
      onClose();
    } catch (e) {
      setError(ticketError(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open title={t("Link Jira ticket")} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Label muted size={font.sm}>{t("The ticket becomes an input of this card. Agents read it every turn; Flowly never changes the ticket.")}</Label>
            {!!error && <Notice>{error}</Notice>}
            <TicketPicker connections={connections} picked={linked} onPick={(ticket) => void pick(ticket)} onClose={onClose} />
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Read-only view of a ticket input (EXTERNAL-TRACKER-SPEC §6). */
export function TicketPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const theme = useTheme();
  const toast = useToast();
  const read = useRpc(rpc.readTicket);
  const [refresh, setRefresh] = useState(0);
  const preview = useQuery({
    queryKey: ["ultra", "ticket-preview", artifact.id, refresh],
    queryFn: () => read({ artifactId: artifact.id, refresh: refresh > 0 }),
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
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              <Button small icon="ExternalLink" onPress={() => void Linking.openURL(artifact.target).catch(() => toast.show(t("Could not open the link."), { variant: "error" }))}>
                {t("Open in Jira")}
              </Button>
              <Button small icon="RefreshCw" disabled={preview.isFetching} onPress={() => setRefresh((n) => n + 1)}>
                {t("Refresh")}
              </Button>
            </View>
            {!!artifact.note && <Label size={font.sm} selectable>{artifact.note}</Label>}
            {preview.isPending ? (
              <Label muted>{t("Loading…")}</Label>
            ) : preview.error ? (
              <Notice tone="warning">{ticketError(preview.error)}</Notice>
            ) : data ? (
              <View style={{ gap: space[2] }}>
                {data.stale && <Notice tone="warning">{t("Jira is unreachable; showing the copy from {time}.", { time: relativeTime(data.fetchedAt) })}</Notice>}
                <SessionMarkdown text={data.markdown} />
              </View>
            ) : null}
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/**
 * Settings → Connections (EXTERNAL-TRACKER-SPEC §2). The token is write-only: it is never shown again.
 * Adding or editing replaces the list in place: the settings window is itself a modal, and a host
 * Modal opened on top of it fights it for focus and locks the app.
 */
export function ConnectionsPage() {
  const { colors } = useTheme();
  const connections = useConnections();
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const list = connections.data?.connections || [];
  if (editing) return <ConnectionEditor connection={editing === "new" ? null : editing} onClose={() => setEditing(null)} />;
  return (
    <SettingsPage
      title={t("Connections")}
      description={t("Connect Jira to attach tickets to cards as inputs. Flowly only reads tickets; it never changes them.")}
    >
      {connections.error && <Notice>{message(connections.error)}</Notice>}
      <SettingsGroup title={t("Jira")} description={t("Self-hosted Jira uses a personal access token. Jira Cloud uses your account email and an API token. Tokens stay on the computer running Paseo.")}>
        {list.map((c) => (
          <SettingRow
            key={c.id}
            title={c.name}
            detail={
              c.authFailed
                ? t("Token refused. Edit to replace it.")
                : `${t(providerLabels[c.provider])} · ${c.account ? t("Connected as {name}", { name: c.account }) : c.baseUrl}`
            }
            onPress={() => setEditing(c)}
            trailing={<Icon name={c.authFailed ? "TriangleAlert" : "ChevronRight"} size={16} color={colors.foregroundMuted} />}
          />
        ))}
        <SettingRow title={t("Add a Jira connection")} onPress={() => setEditing("new")} trailing={<Icon name="Plus" size={16} color={colors.foregroundMuted} />} />
      </SettingsGroup>
    </SettingsPage>
  );
}

function ConnectionEditor({ connection, onClose }: { connection: Connection | null; onClose(): void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const save = useRpc(rpc.saveConnection);
  const remove = useRpc(rpc.deleteConnection);
  const check = useRpc(rpc.testConnection);
  const board = useBoardQuery();
  // Cards whose ticket inputs read through this connection (or its Jira), for the removal warning.
  const linkedCards = useMemo(() => {
    if (!connection) return 0;
    const cards = new Set<string>();
    for (const a of board.data?.artifacts || [])
      if (a.ticket && (a.ticket.connectionId === connection.id || keyFromUrl(a.target, connection.baseUrl) === a.ticket.key)) cards.add(a.taskId);
    return cards.size;
  }, [board.data?.artifacts, connection]);
  const [provider, setProvider] = useState<TicketProvider>(connection?.provider ?? "jira-dc");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [name, setName] = useState(connection?.name ?? "");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  // The last Test connection result; it only describes the values it was run with.
  const [tested, setTested] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const cloud = provider === "jira-cloud";
  const ready = !pending && !testing && !!baseUrl.trim() && (!!connection || (!!secret.trim() && (!cloud || !!email.trim())));
  const values = { ...(connection ? { id: connection.id } : {}), provider, baseUrl, name, email, secret };
  const valuesKey = JSON.stringify([provider, baseUrl.trim(), email.trim(), secret.trim()]);
  const result = tested?.key === valuesKey ? tested : null;
  const test = async () => {
    if (!ready) return;
    setTesting(true);
    setError("");
    try {
      const ok = await check(values);
      setTested({ key: valuesKey, ok: true, text: t("Connection works. Connected as {name}.", { name: ok.account || ok.baseUrl }) });
    } catch (e) {
      setTested({ key: valuesKey, ok: false, text: message(e) });
    } finally {
      setTesting(false);
    }
  };
  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError("");
    try {
      const saved = await save(values);
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
      toast.show(t("Connected as {name}", { name: saved.account || saved.name }), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const drop = async () => {
    if (!connection) return;
    setPending(true);
    setError("");
    try {
      await remove({ id: connection.id });
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
      toast.show(t("Connection removed. Tickets already on cards stay as links."), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const providers = useMemo(() => (Object.keys(providerLabels) as TicketProvider[]).map((value) => ({ value, label: t(providerLabels[value]) })), []);
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <IconButton icon="ArrowLeft" label={t("Back to connections")} disabled={pending} onPress={onClose} />
        <Label bold size={font.xl} selectable={false}>
          {connection ? t("Edit Jira connection") : t("Add a Jira connection")}
        </Label>
      </View>
      {!!error && <Notice>{error}</Notice>}
      <Choices title={t("Jira type")} value={provider} options={providers} onChange={setProvider} />
      <Field title={t("Jira address")} value={baseUrl} onChange={setBaseUrl} placeholder={cloud ? "https://your-team.atlassian.net" : "https://jira.example.com"} />
      <Field title={t("Name")} value={name} onChange={setName} placeholder={t("Defaults to the address")} />
      {cloud && <Field title={t("Account email")} value={email} onChange={setEmail} placeholder={connection ? t("Unchanged") : "you@example.com"} />}
      <Field
        title={cloud ? t("API token") : t("Personal access token")}
        value={secret}
        onChange={setSecret}
        placeholder={connection ? t("Unchanged") : ""}
        secure
        hint={cloud ? t("Create one at id.atlassian.com → Security → API tokens.") : t("Create one in Jira under your profile → Personal access tokens. Read access is enough.")}
        onSubmit={ready ? () => void submit() : undefined}
      />
      {result && <Notice tone={result.ok ? "success" : "danger"}>{result.text}</Notice>}
      {confirming && (
        <Notice tone="warning">
          {linkedCards
            ? tn(
                linkedCards,
                "{n} card has tickets from this Jira. They keep the ticket link and key, but Flowly and agents can't read them until you add this Jira again; then they work as before.",
                "{n} cards have tickets from this Jira. They keep the ticket link and key, but Flowly and agents can't read them until you add this Jira again; then they work as before.",
              )
            : t("No card has tickets from this Jira.")}
        </Notice>
      )}
      <Label muted size={font.xs}>{t("Saving checks the token with Jira first. It is stored only on the computer running Paseo and never shown again.")}</Label>
      <Actions>
        {connection &&
          (confirming ? (
            <Button danger onPress={() => void drop()} disabled={pending}>{t("Remove connection")}</Button>
          ) : (
            <Button quiet onPress={() => setConfirming(true)} disabled={pending}>{t("Remove…")}</Button>
          ))}
        <Button quiet onPress={onClose} disabled={pending}>{t("Cancel")}</Button>
        <Button icon="PlugZap" onPress={() => void test()} disabled={!ready}>{testing ? t("Testing…") : t("Test connection")}</Button>
        <Button primary onPress={() => void submit()} disabled={!ready}>{pending ? t("Checking…") : t("Save")}</Button>
      </Actions>
    </View>
  );
}
