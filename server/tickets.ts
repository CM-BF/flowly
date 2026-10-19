import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  browseUrl,
  classifyQuery,
  connectionInput,
  issueKey,
  jqlKeys,
  keyFromUrl,
  normalizeBaseUrl,
  numberCandidates,
  recentJql,
  textJql,
  ticketLimits,
  ticketProviderSchema,
  ticketTarget,
  ticketTitle,
  wikiToMarkdown,
  type Connection,
  type ConnectionInput,
  type TicketRef,
  type TicketSummary,
} from "../shared/tickets";

/**
 * External tickets as read-only card inputs (EXTERNAL-TRACKER-SPEC). The
 * daemon is the only place that holds credentials or talks to the tracker,
 * and it only ever reads: every request goes through `JiraClient.get`, which
 * refuses anything outside a fixed list of read endpoints.
 */

export type TicketErrorCode = "TICKET_AUTH" | "TICKET_NOT_FOUND" | "TICKET_UNAVAILABLE" | "TICKET_INVALID";
export class TicketError extends Error {
  constructor(
    readonly code: TicketErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const storedConnection = z.object({
  id: z.string(),
  provider: ticketProviderSchema,
  name: z.string(),
  baseUrl: z.string(),
  email: z.string(),
  secret: z.string(),
  account: z.string(),
  verifiedAt: z.string(),
  authFailed: z.boolean(),
});
type StoredConnection = z.infer<typeof storedConnection>;
const connectionsFile = z.object({ version: z.literal(1), connections: z.array(storedConnection) });

const publicConnection = ({ secret: _secret, email: _email, ...c }: StoredConnection): Connection => c;

async function atomicWrite(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Connections with their credentials, in `<data>/tickets/connections.json` (0600, never sent to clients). */
export class ConnectionStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "connections.json");
  }
  private async load(): Promise<StoredConnection[]> {
    try {
      return connectionsFile.parse(JSON.parse(await readFile(this.path, "utf8"))).connections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Ticket connections are invalid; preserved at ${this.path}.`);
    }
  }
  async all() {
    await this.tail;
    return this.load();
  }
  async get(id: string) {
    const found = (await this.all()).find((c) => c.id === id);
    if (!found) throw new TicketError("TICKET_INVALID", "This ticket connection no longer exists.");
    return found;
  }
  /** Serialized read-modify-write; a corrupt file is preserved, never reset. */
  update<T>(change: (list: StoredConnection[]) => T): Promise<T> {
    const job = this.tail.then(async () => {
      const list = await this.load();
      const value = change(list);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await copyFile(this.path, `${this.path}.bak`);
        await chmod(`${this.path}.bak`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWrite(this.path, JSON.stringify({ version: 1, connections: list }, null, 2));
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

type Fetch = typeof fetch;

/** The only endpoints the client may call, all GET (EXTERNAL-TRACKER-SPEC §9). */
const readEndpoints = [
  /^\/rest\/api\/2\/myself$/,
  /^\/rest\/api\/2\/search$/,
  /^\/rest\/api\/3\/search\/jql$/,
  /^\/rest\/api\/2\/issue\/picker$/,
  /^\/rest\/api\/2\/issue\/[A-Z][A-Z0-9_]*-\d+$/,
];

const summaryFields = "summary,status,issuetype,priority,assignee,updated";
const fullFields = `${summaryFields},reporter,created,description,components,fixVersions,labels,subtasks,issuelinks,attachment,parent,comment`;

type JiraFields = {
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string } };
  issuetype?: { name?: string };
  priority?: { name?: string } | null;
  assignee?: { displayName?: string } | null;
  reporter?: { displayName?: string } | null;
  updated?: string;
  created?: string;
  description?: string | null;
  components?: { name?: string }[];
  fixVersions?: { name?: string }[];
  labels?: string[];
  subtasks?: JiraIssue[];
  parent?: JiraIssue;
  issuelinks?: { type?: { inward?: string; outward?: string }; inwardIssue?: JiraIssue; outwardIssue?: JiraIssue }[];
  attachment?: { filename?: string; size?: number }[];
  comment?: { comments?: { id?: string; author?: { displayName?: string }; body?: string; created?: string; updated?: string }[]; total?: number };
};
type JiraIssue = { id?: string; key?: string; fields?: JiraFields };

/** Read-only Jira REST client for one connection. */
export class JiraClient {
  constructor(
    readonly connection: StoredConnection,
    readonly fetchImpl: Fetch = fetch,
    readonly timeoutMs = 15000,
  ) {}
  private headers() {
    const auth =
      this.connection.provider === "jira-cloud"
        ? `Basic ${Buffer.from(`${this.connection.email}:${this.connection.secret}`).toString("base64")}`
        : `Bearer ${this.connection.secret}`;
    return { Authorization: auth, Accept: "application/json" };
  }
  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    if (!readEndpoints.some((pattern) => pattern.test(path))) throw new TicketError("TICKET_INVALID", `Refused a request outside the read-only endpoints: ${path}`);
    const url = new URL(this.connection.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let response: Response;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: this.headers(), redirect: "error", signal: abort.signal });
    } catch (error) {
      throw new TicketError("TICKET_UNAVAILABLE", `Jira is unreachable (${error instanceof Error ? error.name : "network error"}).`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403)
      throw new TicketError("TICKET_AUTH", "Jira refused the token. Update the connection in Flowly settings.");
    if (response.status === 404) throw new TicketError("TICKET_NOT_FOUND", "Ticket not found, or this account can't see it.");
    if (response.status === 429 || response.status >= 500) {
      const retry = Number(response.headers.get("retry-after"));
      const error = new TicketError("TICKET_UNAVAILABLE", `Jira is busy or unavailable (HTTP ${response.status}).`);
      (error as TicketError & { retryAfter?: number }).retryAfter = Number.isFinite(retry) && retry > 0 ? retry : undefined;
      throw error;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new TicketError("TICKET_INVALID", `Jira rejected the request (HTTP ${response.status})${messageOf(detail)}.`);
    }
    // A login page instead of JSON means the token was not accepted.
    if (!(response.headers.get("content-type") || "").includes("json"))
      throw new TicketError("TICKET_AUTH", "Jira answered with a login page. Check the URL and token.");
    return (await response.json()) as T;
  }
  myself() {
    return this.get<{ displayName?: string; name?: string; emailAddress?: string }>("/rest/api/2/myself");
  }
  async search(jql: string, max: number): Promise<JiraIssue[]> {
    const params = { jql, maxResults: max, fields: summaryFields };
    const result =
      this.connection.provider === "jira-cloud"
        ? await this.get<{ issues?: JiraIssue[] }>("/rest/api/3/search/jql", params)
        : await this.get<{ issues?: JiraIssue[] }>("/rest/api/2/search", params);
    return result.issues || [];
  }
  async picker(query: string): Promise<string[]> {
    const result = await this.get<{ sections?: { issues?: { key?: string }[] }[] }>("/rest/api/2/issue/picker", {
      query,
      showSubTasks: "true",
      showSubTaskParent: "true",
    });
    const keys: string[] = [];
    for (const section of result.sections || [])
      for (const issue of section.issues || []) if (issue.key && !keys.includes(issue.key)) keys.push(issue.key);
    return keys;
  }
  issue(key: string, full = false) {
    return this.get<JiraIssue>(`/rest/api/2/issue/${key}`, { fields: full ? fullFields : summaryFields });
  }
}

function messageOf(body: string) {
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[] };
    const first = parsed.errorMessages?.[0];
    return first ? `: ${first.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

function summaryOf(connection: StoredConnection, issue: JiraIssue): TicketSummary {
  const f = issue.fields || {};
  const key = issue.key || "";
  return {
    connectionId: connection.id,
    key,
    remoteId: issue.id || "",
    url: browseUrl(connection.baseUrl, key),
    summary: f.summary || "",
    status: f.status?.name || "",
    statusCategory: f.status?.statusCategory?.key || "",
    type: f.issuetype?.name || "",
    priority: f.priority?.name || "",
    assignee: f.assignee?.displayName || "",
    updated: f.updated || "",
  };
}

/** What makes a ticket's content change for an agent: not its status or assignee (spec §4.1). */
export function contentFingerprint(issue: JiraIssue) {
  const f = issue.fields || {};
  const comments = (f.comment?.comments || []).map((c) => `${c.id}:${c.updated || c.created}`);
  const subtasks = (f.subtasks || []).map((s) => `${s.key}:${s.fields?.summary || ""}`);
  return createHash("sha256")
    .update(JSON.stringify([f.summary || "", f.description || "", comments, subtasks]))
    .digest("hex")
    .slice(0, 16);
}

/** The ticket as Markdown for agents and the preview (spec §4.2), cut at `limit` bytes. */
export function ticketMarkdown(summary: TicketSummary, issue: JiraIssue, limit: number = ticketLimits.readBytes) {
  const f = issue.fields || {};
  const names = (list?: { name?: string }[]) => (list || []).map((x) => x.name).filter(Boolean).join(", ");
  const meta = [
    ["Status", summary.status],
    ["Type", summary.type],
    ["Priority", summary.priority],
    ["Assignee", summary.assignee || "Unassigned"],
    ["Reporter", f.reporter?.displayName || ""],
    ["Components", names(f.components)],
    ["Fix versions", names(f.fixVersions)],
    ["Labels", (f.labels || []).join(", ")],
    ["Parent", f.parent?.key ? `${f.parent.key} ${f.parent.fields?.summary || ""}`.trim() : ""],
    ["Updated", summary.updated],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}: ${value}`);
  const sections = [`# ${summary.key} ${summary.summary}`, summary.url, "", ...meta, "", "## Description", "", wikiToMarkdown(f.description || "") || "(empty)"];
  const subtasks = f.subtasks || [];
  if (subtasks.length)
    sections.push("", "## Subtasks", "", ...subtasks.map((s) => `- ${s.key} ${s.fields?.summary || ""} (${s.fields?.status?.name || ""})`));
  const links = (f.issuelinks || []).flatMap((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    if (!other?.key) return [];
    const relation = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return [`- ${relation || "relates to"} ${other.key} ${other.fields?.summary || ""} (${other.fields?.status?.name || ""})`];
  });
  if (links.length) sections.push("", "## Linked tickets", "", ...links);
  const attachments = (f.attachment || []).map((a) => `- ${a.filename}`);
  if (attachments.length) sections.push("", "## Attachments (names only)", "", ...attachments);
  const all = f.comment?.comments || [];
  const comments = all.slice(-ticketLimits.comments);
  if (comments.length) {
    sections.push("", `## Comments (latest ${comments.length} of ${f.comment?.total ?? all.length})`);
    for (const c of comments) sections.push("", `### ${c.author?.displayName || "Someone"} · ${c.created || ""}`, "", wikiToMarkdown(c.body || ""));
  }
  const text = sections.join("\n");
  if (Buffer.byteLength(text) <= limit) return { markdown: text, truncated: false };
  let cut = text.slice(0, limit);
  while (Buffer.byteLength(cut) > limit - 200) cut = cut.slice(0, -200);
  return { markdown: `${cut}\n\n…(truncated; read the rest at ${summary.url})`, truncated: true };
}

type CacheEntry = { summary: TicketSummary; fingerprint: string; fetchedAt: number; full?: { issue: JiraIssue; at: number } };
const SUMMARY_TTL = 60_000;
const BADGE_TTL = 30 * 60_000;
const MAX_CACHE = 2000;

export type TicketDetail = { summary: TicketSummary; markdown: string; truncated: boolean; fingerprint: string; stale: boolean; fetchedAt: string };

/** Connections, read-through cache and searches (EXTERNAL-TRACKER-SPEC §2–§5). */
export class TicketService {
  readonly connections: ConnectionStore;
  private cache = new Map<string, CacheEntry>();
  private blockedUntil = new Map<string, number>();
  private loaded = false;
  constructor(
    readonly directory: string,
    readonly fetchImpl: Fetch = fetch,
    readonly clock = () => Date.now(),
  ) {
    this.connections = new ConnectionStore(directory);
  }
  private get cachePath() {
    return join(this.directory, "cache.json");
  }
  private cacheKey = (connectionId: string, key: string) => `${connectionId}:${key}`;

  private async loadCache() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.cachePath, "utf8")) as { entries?: Record<string, { summary: TicketSummary; fingerprint: string; fetchedAt: number }> };
      for (const [k, v] of Object.entries(data.entries || {})) if (!this.cache.has(k)) this.cache.set(k, { summary: v.summary, fingerprint: v.fingerprint, fetchedAt: v.fetchedAt });
    } catch {
      // A missing or unreadable cache only means fetching again.
    }
  }
  private saving: Promise<unknown> = Promise.resolve();
  private persist() {
    this.saving = this.saving.then(async () => {
      const entries = [...this.cache.entries()].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_CACHE);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWrite(
        this.cachePath,
        JSON.stringify({ version: 1, entries: Object.fromEntries(entries.map(([k, v]) => [k, { summary: v.summary, fingerprint: v.fingerprint, fetchedAt: v.fetchedAt }])) }),
      );
    }).catch((e) => console.error("Flowly ticket cache not saved:", e instanceof Error ? e.message : String(e)));
  }

  /** Waits for pending cache writes (shutdown, tests). */
  async flush() {
    await this.saving;
  }

  async list(): Promise<Connection[]> {
    return (await this.connections.all()).map(publicConnection);
  }

  /** Tests the credentials, then stores the connection (spec §2). An empty secret on edit keeps the stored one. */
  /**
   * The connection the input describes, checked with Jira (GET /myself). An
   * empty secret or email on an existing connection keeps the stored one.
   */
  private async verify(raw: ConnectionInput): Promise<StoredConnection> {
    const input = connectionInput.parse(raw);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!baseUrl) throw new Error("Enter the Jira address, e.g. https://jira.example.com.");
    const previous = input.id ? await this.connections.get(input.id) : undefined;
    const secret = input.secret || previous?.secret || "";
    const email = input.email || (input.provider === previous?.provider ? previous.email : "");
    if (!secret) throw new Error(input.provider === "jira-cloud" ? "Enter an API token." : "Enter a personal access token.");
    if (input.provider === "jira-cloud" && !email) throw new Error("Enter the email of the Atlassian account the API token belongs to.");
    const candidate: StoredConnection = {
      id: previous?.id || randomUUID(),
      provider: input.provider,
      name: input.name || new URL(baseUrl).host,
      baseUrl,
      email: input.provider === "jira-cloud" ? email : "",
      secret,
      account: "",
      verifiedAt: "",
      authFailed: false,
    };
    const me = await new JiraClient(candidate, this.fetchImpl).myself().catch((error) => {
      throw new Error(error instanceof TicketError ? error.message : "Couldn't reach Jira.");
    });
    candidate.account = me.displayName || me.name || me.emailAddress || "";
    candidate.verifiedAt = new Date(this.clock()).toISOString();
    return candidate;
  }

  /** Test connection (spec §2): checks the address and token without saving anything. */
  async test(raw: ConnectionInput): Promise<{ account: string; baseUrl: string }> {
    const checked = await this.verify(raw);
    return { account: checked.account, baseUrl: checked.baseUrl };
  }

  /** Tests the credentials, then stores the connection (spec §2). */
  async save(raw: ConnectionInput): Promise<Connection> {
    const candidate = await this.verify(raw);
    await this.connections.update((list) => {
      const index = list.findIndex((c) => c.id === candidate.id);
      if (index >= 0) list[index] = candidate;
      else list.push(candidate);
    });
    this.blockedUntil.delete(candidate.id);
    return publicConnection(candidate);
  }

  /**
   * The connection each ticket input reads through now (spec §2): its own, or,
   * once that one was removed, any connection to the same Jira (the link's
   * host and path), so adding the Jira again brings its tickets back. A ticket
   * whose Jira has no connection maps to null: it stays a plain link.
   */
  async locate(list: readonly { id: string; target: string; ticket?: TicketRef }[]): Promise<Map<string, TicketRef | null>> {
    const connections = await this.connections.all();
    const out = new Map<string, TicketRef | null>();
    for (const a of list) {
      if (!a.ticket) continue;
      const own = connections.find((c) => c.id === a.ticket!.connectionId);
      const same = own || connections.find((c) => keyFromUrl(a.target, c.baseUrl) === a.ticket!.key);
      out.set(a.id, same ? { ...a.ticket, connectionId: same.id, provider: same.provider } : null);
    }
    return out;
  }

  async remove(id: string) {
    await this.connections.update((list) => {
      const index = list.findIndex((c) => c.id === id);
      if (index >= 0) list.splice(index, 1);
    });
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${id}:`)) this.cache.delete(key);
    return { id };
  }

  /** Runs one request for a connection, honouring backoff and recording refused tokens. */
  private async call<T>(connectionId: string, run: (client: JiraClient) => Promise<T>): Promise<T> {
    const connection = await this.connections.get(connectionId);
    if (connection.authFailed) throw new TicketError("TICKET_AUTH", "Jira refused the token. Update the connection in Flowly settings.");
    const blocked = this.blockedUntil.get(connectionId) || 0;
    if (blocked > this.clock()) throw new TicketError("TICKET_UNAVAILABLE", "Jira asked Flowly to wait; try again shortly.");
    try {
      return await run(new JiraClient(connection, this.fetchImpl));
    } catch (error) {
      if (error instanceof TicketError && error.code === "TICKET_AUTH")
        await this.connections
          .update((list) => {
            const c = list.find((x) => x.id === connectionId);
            if (c) c.authFailed = true;
          })
          .catch(() => undefined);
      if (error instanceof TicketError && error.code === "TICKET_UNAVAILABLE") {
        const retryAfter = (error as TicketError & { retryAfter?: number }).retryAfter;
        this.blockedUntil.set(connectionId, this.clock() + Math.min(300, Math.max(retryAfter || 5, 5)) * 1000);
      }
      throw error;
    }
  }

  private remember(connection: StoredConnection, issue: JiraIssue, full: boolean) {
    const summary = summaryOf(connection, issue);
    const key = this.cacheKey(connection.id, summary.key);
    const previous = this.cache.get(key);
    const now = this.clock();
    const entry: CacheEntry = {
      summary,
      // A summary-only fetch can't see content changes; keep the fingerprint while `updated` is unchanged.
      fingerprint: full ? contentFingerprint(issue) : previous && previous.summary.updated === summary.updated ? previous.fingerprint : "",
      fetchedAt: now,
      ...(full ? { full: { issue, at: now } } : previous?.full && previous.summary.updated === summary.updated ? { full: previous.full } : {}),
    };
    this.cache.set(key, entry);
    return entry;
  }

  /** Picker results (spec §5.2): recent when empty, else by key, number or text. */
  async search(input: { connectionId: string; query: string }): Promise<{ results: TicketSummary[] }> {
    await this.loadCache();
    const connection = await this.connections.get(input.connectionId);
    const query = classifyQuery(input.query, connection.baseUrl);
    const issues = await this.call(connection.id, async (client) => {
      if (query.kind === "recent") return client.search(recentJql, ticketLimits.recent);
      if (query.kind === "key")
        return client.issue(query.key).then(
          (issue) => [issue],
          (error) => {
            if (error instanceof TicketError && error.code === "TICKET_NOT_FOUND") return [];
            throw error;
          },
        );
      if (query.kind === "number") {
        const recent = await client.search(recentJql, ticketLimits.recent);
        const jql = jqlKeys(numberCandidates(query.number, recent.map((i) => ({ key: i.key || "" }))));
        return jql ? client.search(jql, ticketLimits.search) : [];
      }
      const keys = await client.picker(query.text).catch((error) => {
        if (error instanceof TicketError && error.code !== "TICKET_INVALID") throw error;
        return [] as string[];
      });
      const jql = jqlKeys(keys.slice(0, ticketLimits.search));
      const found = jql ? await client.search(jql, ticketLimits.search) : [];
      if (found.length) {
        const order = new Map(keys.map((k, i) => [k, i]));
        return found.sort((a, b) => (order.get(a.key || "") ?? 99) - (order.get(b.key || "") ?? 99));
      }
      return client.search(textJql(query.text), ticketLimits.search);
    });
    const results = issues.filter((i) => i.key).map((issue) => this.remember(connection, issue, false).summary);
    this.persist();
    return { results };
  }

  /** The ticket a link or bare key names, checked against the tracker; null when it isn't a ticket link. */
  async recognize(target: string): Promise<{ ticket: TicketRef; url: string; title: string } | null> {
    const connections = await this.connections.all();
    const match = ticketTarget(target, connections);
    if (!match) return null;
    return this.resolve(match.connectionId, match.key);
  }

  /** Fetches the ticket (it must exist and be visible) and returns what an artifact stores. */
  async resolve(connectionId: string, rawKey: string): Promise<{ ticket: TicketRef; url: string; title: string }> {
    await this.loadCache();
    const key = issueKey(rawKey);
    if (!key) throw new TicketError("TICKET_INVALID", `"${rawKey}" is not a ticket key.`);
    const connection = await this.connections.get(connectionId);
    const issue = await this.call(connectionId, (client) => client.issue(key));
    const entry = this.remember(connection, issue, false);
    this.persist();
    const summary = entry.summary;
    return {
      ticket: { connectionId, provider: connection.provider, key: summary.key, remoteId: summary.remoteId },
      url: summary.url,
      title: ticketTitle(summary.key, summary.summary),
    };
  }

  /**
   * Current summaries for tickets (spec §3.3): reused for `maxAge`, else one
   * batched search per connection. Failures fall back to the cache, marked stale.
   */
  async summaries(refs: readonly TicketRef[], maxAge = SUMMARY_TTL, fingerprints = true): Promise<Map<string, { summary: TicketSummary; fingerprint: string; stale: boolean }>> {
    await this.loadCache();
    const out = new Map<string, { summary: TicketSummary; fingerprint: string; stale: boolean }>();
    const now = this.clock();
    const byConnection = new Map<string, string[]>();
    for (const ref of refs) {
      const hit = this.cache.get(this.cacheKey(ref.connectionId, ref.key));
      if (hit && now - hit.fetchedAt < maxAge) out.set(this.cacheKey(ref.connectionId, ref.key), { summary: hit.summary, fingerprint: hit.fingerprint, stale: false });
      else byConnection.set(ref.connectionId, [...(byConnection.get(ref.connectionId) || []), ref.key]);
    }
    let fetched = false;
    for (const [connectionId, keys] of byConnection) {
      const connection = await this.connections.get(connectionId).catch(() => null);
      const jql = jqlKeys(keys);
      let issues: JiraIssue[] | null = null;
      if (connection && jql) issues = await this.call(connectionId, (client) => client.search(jql, 50)).catch(() => null);
      if (issues && connection) {
        fetched = true;
        for (const issue of issues) this.remember(connection, issue, false);
      }
      for (const key of keys) {
        const hit = this.cache.get(this.cacheKey(connectionId, key));
        if (hit) out.set(this.cacheKey(connectionId, key), { summary: hit.summary, fingerprint: hit.fingerprint, stale: !issues });
      }
    }
    // Content fingerprints need the full ticket; fetch it only where `updated` moved.
    for (const ref of fingerprints ? refs : []) {
      const k = this.cacheKey(ref.connectionId, ref.key);
      const hit = this.cache.get(k);
      if (!hit || hit.fingerprint || out.get(k)?.stale) continue;
      const detail = await this.detail(ref).catch(() => null);
      if (detail) out.set(k, { summary: detail.summary, fingerprint: detail.fingerprint, stale: detail.stale });
    }
    if (fetched) this.persist();
    return out;
  }

  /** Badge/sidebar summaries: cached up to 30 minutes (spec §3.3). */
  badges(refs: readonly TicketRef[], refresh = false) {
    return this.summaries(refs, refresh ? 0 : BADGE_TTL, false);
  }

  /** The full ticket (spec §4.2); the cache answers for 60 s, and when Jira can't be reached. */
  async detail(ref: Pick<TicketRef, "connectionId" | "key">, refresh = false): Promise<TicketDetail> {
    await this.loadCache();
    const k = this.cacheKey(ref.connectionId, ref.key);
    const hit = this.cache.get(k);
    const now = this.clock();
    if (!refresh && hit?.full && now - hit.full.at < SUMMARY_TTL) return this.render(hit, false);
    const connection = await this.connections.get(ref.connectionId);
    try {
      const issue = await this.call(ref.connectionId, (client) => client.issue(ref.key, true));
      const entry = this.remember(connection, issue, true);
      this.persist();
      return this.render(entry, false);
    } catch (error) {
      if (hit?.full && error instanceof TicketError && error.code === "TICKET_UNAVAILABLE") return this.render(hit, true);
      throw error;
    }
  }

  private render(entry: CacheEntry, stale: boolean): TicketDetail {
    const { markdown, truncated } = ticketMarkdown(entry.summary, entry.full!.issue);
    return { summary: entry.summary, markdown, truncated, fingerprint: entry.fingerprint, stale, fetchedAt: new Date(entry.full!.at).toISOString() };
  }

  /** Last known summary without any request (titles while offline). */
  async cached(ref: Pick<TicketRef, "connectionId" | "key">) {
    await this.loadCache();
    return this.cache.get(this.cacheKey(ref.connectionId, ref.key))?.summary;
  }
}

/** Per-session content fingerprints last seen, for ticket `unread` (spec §4.1). */
export class TicketReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "ticket-reads.json");
  }
  private async load(): Promise<Record<string, Record<string, string>>> {
    try {
      return z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return {};
    }
  }
  async seen(agentId: string) {
    await this.tail;
    return (await this.load())[agentId] || {};
  }
  mark(agentId: string, fingerprints: Record<string, string>) {
    const job = this.tail.then(async () => {
      const state = await this.load();
      state[agentId] = { ...(state[agentId] || {}), ...fingerprints };
      const agents = Object.keys(state);
      for (const old of agents.slice(0, Math.max(0, agents.length - 2000))) delete state[old];
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWrite(this.path, JSON.stringify(state));
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}
