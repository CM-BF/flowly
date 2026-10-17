import { msg } from "./i18n";
import type { Artifact, ArtifactRole } from "./model";

/** Card artifacts: pure helpers shared by daemon, tools and client (CARD-ARTIFACTS-SPEC). */

export const isUrlTarget = (target: string) => /^https?:\/\//i.test(target.trim());

/** Whether `target` is a usable http(s) URL. */
export function validUrl(target: string) {
  try {
    const url = new URL(target.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

/** Last path segment of a file target ("./docs/a.md" → "a.md"). */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The title used when none is given: the file name, or host + path of a link. */
export function defaultTitle(kind: Artifact["kind"], target: string) {
  if (kind === "file") return baseName(target).slice(0, 120);
  try {
    const url = new URL(target);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120);
  } catch {
    return target.slice(0, 120);
  }
}

/** A stored file target resolved against the workspace directory ("./x" is relative to it). */
export function absoluteTarget(target: string, workspaceDirectory: string) {
  if (!target.startsWith("./")) return target;
  return `${workspaceDirectory.replace(/\/+$/, "")}/${target.slice(2)}`;
}

/** A card's artifacts, newest first, in display groups (outputs first, CARD-ARTIFACTS-SPEC §5.2). */
export const artifactGroups: readonly { role: ArtifactRole; title: string }[] = [
  { role: "output", title: msg("Outputs") },
  { role: "input", title: msg("Inputs") },
];
export function artifactsOf(list: readonly Artifact[], taskId: string) {
  return list.filter((a) => a.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "Input: <title>" for activity events. */
export const artifactNoteLine = (artifact: Pick<Artifact, "role" | "title">) =>
  `${artifact.role === "input" ? "Input" : "Output"}: ${artifact.title}`;

/** Context lines for a new session (CARD-ARTIFACTS-SPEC §4.2); at most `limit` per role. */
export function artifactContextLines(list: readonly Artifact[], limit = 10): string[] {
  return (
    [
      ["input", "Inputs:"],
      ["output", "Outputs so far:"],
    ] as const
  ).flatMap(([role, heading]) => {
    const own = list.filter((a) => a.role === role);
    if (!own.length) return [];
    return [
      heading,
      ...own.slice(0, limit).map((a) => `- ${a.title}: ${a.target}`),
      ...(own.length > limit ? [`- …and ${own.length - limit} more`] : []),
    ];
  });
}
