import { z } from "zod";

/**
 * External tickets as read-only card inputs (EXTERNAL-TRACKER-SPEC). Pure
 * helpers shared by daemon, tools and client: recognizing ticket links,
 * classifying picker searches and escaping them into JQL.
 */

export const ticketProviders = ["jira-dc", "jira-cloud"] as const;
export type TicketProvider = (typeof ticketProviders)[number];
export const ticketProviderSchema = z.enum(ticketProviders);

export const ticketLimits = { perCreate: 5, recent: 10, search: 20, query: 200, name: 60, comments: 20, readBytes: 32 * 1024 } as const;

/** A connection as the client sees it: never the credential. */
export const connectionSchema = z.object({
  id: z.string(),
  provider: ticketProviderSchema,
  name: z.string(),
  /** Normalized: https origin plus optional context path, no trailing slash. */
  baseUrl: z.string(),
  /** Display name of the account the token belongs to, from the last successful test. */
  account: z.string(),
  verifiedAt: z.string(),
  /** The last request was refused (401/403): the token needs replacing. */
  authFailed: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionInput = z.strictObject({
  /** Present: replace this connection (an empty secret keeps the stored one). */
  id: z.string().optional(),
  provider: ticketProviderSchema,
  name: z.string().trim().max(ticketLimits.name).default(""),
  baseUrl: z.string().trim().min(1).max(500),
  /** Jira Cloud: the account email used with the API token. */
  email: z.string().trim().max(200).default(""),
  /** Jira DC: personal access token. Jira Cloud: API token. */
  secret: z.string().trim().max(2000).default(""),
});
export type ConnectionInput = z.input<typeof connectionInput>;

/** Stored on a ticket artifact; the ticket content lives in the daemon's cache. */
export const ticketRefSchema = z.object({
  connectionId: z.string(),
  provider: ticketProviderSchema,
  key: z.string().max(64),
  remoteId: z.string().max(64),
});
export type TicketRef = z.infer<typeof ticketRefSchema>;

/** One row of the ticket picker and the summary shown on a card. */
export const ticketSummarySchema = z.object({
  connectionId: z.string(),
  key: z.string(),
  remoteId: z.string(),
  url: z.string(),
  summary: z.string(),
  status: z.string(),
  /** Jira status category: new | indeterminate | done (or "" when unknown). */
  statusCategory: z.string(),
  type: z.string(),
  priority: z.string(),
  assignee: z.string(),
  updated: z.string(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/** The text before an issue key and number, e.g. "SHOPSR" in SHOPSR-123. */
const keyPattern = /^([A-Za-z][A-Za-z0-9_]{0,30})-(\d{1,9})$/;

/** "shopsr-123" → "SHOPSR-123"; anything else → null. */
export function issueKey(value: string): string | null {
  const match = keyPattern.exec(value.trim());
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

/** https origin plus context path without a trailing slash; null when not an http(s) URL. */
export function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

export const browseUrl = (baseUrl: string, key: string) => `${baseUrl}/browse/${key}`;

/**
 * The issue key a link points at when it belongs to `baseUrl`: /browse/KEY-1,
 * or any page with ?selectedIssue=KEY-1 (boards). null otherwise.
 */
export function keyFromUrl(value: string, baseUrl: string): string | null {
  let url: URL, base: URL;
  try {
    url = new URL(value.trim());
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== base.host.toLowerCase()) return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) return null;
  const rest = url.pathname.slice(prefix.length);
  const browse = /^\/browse\/([^/?#]+)\/?$/.exec(rest);
  if (browse) return issueKey(decodeURIComponent(browse[1]!));
  const selected = url.searchParams.get("selectedIssue");
  return selected ? issueKey(selected) : null;
}

/** The connection and key a link or bare key refers to; a bare key needs exactly one connection. */
export function ticketTarget(value: string, connections: readonly Pick<Connection, "id" | "baseUrl">[]) {
  const trimmed = value.trim();
  for (const c of connections) {
    const key = keyFromUrl(trimmed, c.baseUrl);
    if (key) return { connectionId: c.id, key };
  }
  const key = issueKey(trimmed);
  if (key && connections.length === 1) return { connectionId: connections[0]!.id, key };
  return null;
}

/** What a picker search box holds (EXTERNAL-TRACKER-SPEC §5.2). */
export type TicketQuery =
  | { kind: "recent" }
  | { kind: "key"; key: string }
  | { kind: "number"; number: string }
  | { kind: "text"; text: string };

export function classifyQuery(raw: string, baseUrl: string): TicketQuery {
  const value = raw.trim();
  if (!value) return { kind: "recent" };
  const fromUrl = keyFromUrl(value, baseUrl);
  if (fromUrl) return { kind: "key", key: fromUrl };
  const key = issueKey(value);
  if (key) return { kind: "key", key };
  if (/^#?\d{1,9}$/.test(value)) return { kind: "number", number: value.replace(/^#/, "") };
  return { kind: "text", text: value.slice(0, ticketLimits.query) };
}

/** Candidate keys for a bare number: the project keys of the given tickets, most recent first. */
export function numberCandidates(number: string, recent: readonly Pick<TicketSummary, "key">[], limit = 5) {
  const projects: string[] = [];
  for (const t of recent) {
    const project = t.key.split("-")[0];
    if (project && !projects.includes(project)) projects.push(project);
  }
  return projects.slice(0, limit).map((p) => `${p}-${number}`);
}

/**
 * A JQL string literal holding user text. Quotes and backslashes are escaped,
 * and characters Jira's text search reserves are dropped (they would be read
 * as operators, or reject the query).
 */
export function jqlText(value: string) {
  const cleaned = value
    .replace(/[+\-&|!(){}[\]^~*?:\\/"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ticketLimits.query);
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A JQL list of keys; each one is validated, so nothing else reaches the query. */
export function jqlKeys(keys: readonly string[]) {
  const valid = keys.map(issueKey).filter((k): k is string => !!k);
  return valid.length ? `key in (${valid.join(", ")})` : null;
}

export const recentJql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const textJql = (text: string) => `summary ~ ${jqlText(text)} ORDER BY updated DESC`;

/** Artifact title for a ticket: "KEY summary". */
export const ticketTitle = (key: string, summary: string) => `${key} ${summary}`.trim().slice(0, 120);

/**
 * Jira wiki markup (Jira DC and the Cloud v2 API) to Markdown, for agents and
 * the preview. Covers the common blocks and inline marks; anything else stays
 * as written, which is still readable.
 */
export function wikiToMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    if (fence !== null) {
      const marker = fence === "code" ? "{code}" : "{noformat}";
      const end = raw.indexOf(marker);
      if (end >= 0) {
        if (end > 0) out.push(raw.slice(0, end));
        out.push("```");
        fence = null;
        const rest = raw.slice(end + marker.length).trim();
        if (rest) out.push(inline(rest));
      } else out.push(raw);
      continue;
    }
    const open = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/.exec(raw);
    if (open) {
      const language = open[1] === "code" ? (open[2] || "").split("|")[0]!.replace(/^language=/, "").trim() : "";
      const after = open[3]!;
      const close = after.indexOf(open[1] === "code" ? "{code}" : "{noformat}");
      if (close >= 0) {
        out.push("```" + language, after.slice(0, close), "```");
        continue;
      }
      out.push("```" + language);
      if (after.trim()) out.push(after);
      fence = open[1]!;
      continue;
    }
    const heading = /^h([1-6])\.\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${"#".repeat(Number(heading[1]))} ${inline(heading[2]!)}`);
      continue;
    }
    const list = /^([*#-]+)\s+(.*)$/.exec(raw);
    if (list && !/^-{4,}$/.test(raw.trim())) {
      const depth = list[1]!.length - 1;
      const ordered = list[1]!.endsWith("#");
      out.push(`${"  ".repeat(depth)}${ordered ? "1." : "-"} ${inline(list[2]!)}`);
      continue;
    }
    if (/^\s*----\s*$/.test(raw)) {
      out.push("---");
      continue;
    }
    if (/^\s*bq\.\s+/.test(raw)) {
      out.push(`> ${inline(raw.replace(/^\s*bq\.\s+/, ""))}`);
      continue;
    }
    if (/^\s*\|\|/.test(raw)) {
      const cells = raw.trim().replace(/^\|\||\|\|$/g, "").split("||").map((c) => inline(c.trim()));
      out.push(`| ${cells.join(" | ")} |`, `| ${cells.map(() => "---").join(" | ")} |`);
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      out.push(`| ${cells.join(" | ")} |`);
      continue;
    }
    out.push(inline(raw.replace(/\{quote\}/g, "")));
  }
  if (fence !== null) out.push("```");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inline(text: string) {
  return text
    .replace(/\{\{([^}]+)\}\}/g, "`$1`")
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, (_, label: string, href: string) =>
      /^https?:\/\//i.test(href.trim()) ? `[${label.trim()}](${href.trim()})` : `${label.trim()} (${href.trim()})`,
    )
    .replace(/\[(https?:\/\/[^\]\s]+)\]/g, "<$1>")
    .replace(/\[~([^\]]+)\]/g, "@$1")
    .replace(/!([^!\s|]+)(\|[^!]*)?!/g, "[image: $1]")
    .replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=$|[\s).,;:!?])/g, "$1**$2**")
    .replace(/(^|[\s(])_(\S(?:[^_]*\S)?)_(?=$|[\s).,;:!?])/g, "$1*$2*")
    .replace(/(^|[\s(])-(\S(?:[^-]*\S)?)-(?=$|[\s).,;:!?])/g, "$1~~$2~~")
    .replace(/\{color(?::[^}]*)?\}/g, "");
}
