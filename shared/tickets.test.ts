import { describe, expect, test } from "vitest";
import { classifyQuery, issueKey, jqlKeys, jqlText, keyFromUrl, normalizeBaseUrl, numberCandidates, ticketTarget, wikiToMarkdown } from "./tickets";

const dc = { id: "dc", baseUrl: "https://jira.example.com" };
const cloud = { id: "cloud", baseUrl: "https://team.atlassian.net" };
const sub = { id: "sub", baseUrl: "https://tools.example.com/jira" };

describe("recognizing ticket links (EXTERNAL-TRACKER-SPEC §3.1)", () => {
  test("keys are normalized and anything else is not a key", () => {
    expect(issueKey(" shopsr-123 ")).toBe("SHOPSR-123");
    expect(issueKey("AB_1-9")).toBe("AB_1-9");
    expect(issueKey("123")).toBeNull();
    expect(issueKey("SHOPSR-12a")).toBeNull();
    expect(issueKey("x) OR key = Y-1")).toBeNull();
  });

  test("browse links, board links with selectedIssue, context paths; other hosts and paths do not match", () => {
    expect(keyFromUrl("https://jira.example.com/browse/SHOPSR-123", dc.baseUrl)).toBe("SHOPSR-123");
    expect(keyFromUrl("https://JIRA.example.com/browse/shopsr-7?focusedCommentId=1#c", dc.baseUrl)).toBe("SHOPSR-7");
    expect(keyFromUrl("https://jira.example.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=AB-2", dc.baseUrl)).toBe("AB-2");
    expect(keyFromUrl("https://tools.example.com/jira/browse/AB-3", sub.baseUrl)).toBe("AB-3");
    expect(keyFromUrl("https://tools.example.com/other/browse/AB-3", sub.baseUrl)).toBeNull();
    expect(keyFromUrl("https://evil.example.org/browse/AB-3", dc.baseUrl)).toBeNull();
    expect(keyFromUrl("https://jira.example.com/projects/AB", dc.baseUrl)).toBeNull();
  });

  test("a bare key needs exactly one connection; a link picks its own", () => {
    expect(ticketTarget("AB-1", [dc])).toEqual({ connectionId: "dc", key: "AB-1" });
    expect(ticketTarget("AB-1", [dc, cloud])).toBeNull();
    expect(ticketTarget("https://team.atlassian.net/browse/AB-1", [dc, cloud])).toEqual({ connectionId: "cloud", key: "AB-1" });
    expect(ticketTarget("https://github.com/a/b/issues/1", [dc])).toBeNull();
    expect(ticketTarget("docs/spec.md", [dc])).toBeNull();
  });

  test("base URLs keep the context path and drop credentials and trailing slashes", () => {
    expect(normalizeBaseUrl("https://jira.example.com/")).toBe("https://jira.example.com");
    expect(normalizeBaseUrl("https://tools.example.com/jira//")).toBe("https://tools.example.com/jira");
    expect(normalizeBaseUrl("https://u:p@jira.example.com")).toBeNull();
    expect(normalizeBaseUrl("ftp://jira.example.com")).toBeNull();
    expect(normalizeBaseUrl("jira")).toBeNull();
  });
});

describe("picker queries (EXTERNAL-TRACKER-SPEC §5.2)", () => {
  test("empty, key, link, number and text", () => {
    expect(classifyQuery("  ", dc.baseUrl)).toEqual({ kind: "recent" });
    expect(classifyQuery("shopsr-1", dc.baseUrl)).toEqual({ kind: "key", key: "SHOPSR-1" });
    expect(classifyQuery("https://jira.example.com/browse/AB-9", dc.baseUrl)).toEqual({ kind: "key", key: "AB-9" });
    expect(classifyQuery("#123", dc.baseUrl)).toEqual({ kind: "number", number: "123" });
    expect(classifyQuery("empty result page", dc.baseUrl)).toEqual({ kind: "text", text: "empty result page" });
  });

  test("a number is tried in the projects of my recent tickets, most recent first", () => {
    expect(numberCandidates("12", [{ key: "B-1" }, { key: "A-2" }, { key: "B-3" }])).toEqual(["B-12", "A-12"]);
    expect(numberCandidates("12", [])).toEqual([]);
  });

  test("user text is a single escaped JQL string literal", () => {
    expect(jqlText('say "hi"')).toBe('"say hi"');
    expect(jqlText('a" OR project = X OR summary ~ "b')).toBe('"a OR project = X OR summary b"');
    expect(jqlText("back\\slash (x) [y] *z? a:b")).toBe('"back slash x y z a b"');
    expect(jqlText("中文 标题")).toBe('"中文 标题"');
  });

  test("key lists only ever contain validated keys", () => {
    expect(jqlKeys(["ab-1", "B-2"])).toBe("key in (AB-1, B-2)");
    expect(jqlKeys(["A-1) OR (1=1", "x"])).toBeNull();
    expect(jqlKeys([])).toBeNull();
  });
});

describe("wiki markup to Markdown", () => {
  test("headings, lists, code, links, marks and tables", () => {
    const wiki = [
      "h2. Steps",
      "# open the page",
      "## scroll",
      "* *bold* and _italic_ and {{code}}",
      "See [the doc|https://example.com/doc] or [~alice]",
      "{code:java}",
      "int a = 1;",
      "{code}",
      "||Name||Value||",
      "|a|1|",
      "----",
      "bq. quoted",
    ].join("\n");
    expect(wikiToMarkdown(wiki)).toBe(
      [
        "## Steps",
        "1. open the page",
        "  1. scroll",
        "- **bold** and *italic* and `code`",
        "See [the doc](https://example.com/doc) or @alice",
        "```java",
        "int a = 1;",
        "```",
        "| Name | Value |",
        "| --- | --- |",
        "| a | 1 |",
        "---",
        "> quoted",
      ].join("\n"),
    );
  });

  test("single-line and unclosed code blocks, noformat", () => {
    expect(wikiToMarkdown("{noformat}raw *text*{noformat}")).toBe("```\nraw *text*\n```");
    expect(wikiToMarkdown("{code}\nunclosed")).toBe("```\nunclosed\n```");
  });
});
