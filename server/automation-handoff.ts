import type { PaseoApi } from "@getpaseo/client";
import { laneName } from "../shared/lanes";
import { linksOf, type LinkView } from "../shared/links";
import { jobOf, subCardActive, type SubCardLine } from "../shared/automation";
import type { Board, Task } from "../shared/model";
import { defaultGit, readHead, type Git } from "./workpad";

/** get_task's handoffs together carry at most `total` characters of evidence, one link at most `perLink`. */
export const handoffBudget = { total: 16_000, perLink: 6_000 } as const;

/** A card's delivery note and workpad checks as bounded card data (never instructions). */
function handoffEvidence(board: Board, taskId: string) {
  const pad = board.workpads.find((w) => w.taskId === taskId);
  const delivery = [...board.events].reverse().find((e) => e.taskId === taskId && e.actor === "agent" && e.to === "in_review");
  return JSON.stringify({ delivery: delivery?.note?.slice(0, 1500), acceptance: pad?.acceptance.slice(0, 8), validation: pad?.validation.slice(0, 8), confusions: pad?.confusions.slice(0, 4) }).slice(0, handoffBudget.perLink);
}

const unmetBlockers = (board: Board, taskId: string) =>
  linksOf(board, taskId).filter((v) => v.relation === "blocked_by" && v.other?.status !== "done").map((v) => `${v.other?.title ?? "Unavailable card"} (${v.link.from}): ${v.other?.archivedAt ? "archived" : v.other?.status ?? "missing"}`);

/** A bounded read projection, never authority to write another card. */
export async function cardHandoff(board: Board, taskId: string, paseo: PaseoApi): Promise<SubCardLine | null> {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const project = board.projects.find((p) => p.id === task.projectId);
  const job = jobOf(board, taskId);
  const directory = await paseo.workspaces.ref(task.workspaceId).refresh().then((w) => w?.workspaceDirectory, () => undefined);
  const head = directory ? await readHead(directory, defaultGit, new Date().toISOString()).catch(() => null) : null;
  return {
    id: task.id, title: task.title, lane: laneName(project, task.status),
    ...(job ? { job: { state: job.state, verdict: job.verdict, code: job.code } } : {}),
    ...(directory ? { directory } : {}), ...(head?.branch ? { branch: head.branch } : {}),
    evidence: handoffEvidence(board, taskId),
    blockers: unmetBlockers(board, taskId),
  };
}

export type LinkHandoff = { branch?: string; directory?: string; evidence: string; blockers: string[] };

/** The branch a card's work is on as last recorded (its delivery or workpad write); no git. */
const storedBranch = (board: Board, taskId: string) => {
  const pad = board.workpads.find((w) => w.taskId === taskId);
  return pad?.head?.branch || pad?.env?.head?.branch || undefined;
};

const directoryOf = (task: Task, paseo: PaseoApi) => paseo.workspaces.ref(task.workspaceId).refresh().then((w) => w?.workspaceDirectory || undefined, () => undefined);

/** One `rev-parse --abbrev-ref`, never `git status`: only the branch name is wanted. */
async function liveBranch(directory: string | undefined, git: Git) {
  if (!directory) return undefined;
  const branch = await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => "");
  return branch && branch !== "HEAD" ? branch : undefined;
}

/** The integration location of a potentially busy parent; reading it must not refresh its git index. */
export async function cardLocation(board: Board, taskId: string, paseo: PaseoApi, git: Git = defaultGit) {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const directory = await directoryOf(task, paseo);
  const branch = storedBranch(board, taskId) ?? (await liveBranch(directory, git));
  return { id: task.id, title: task.title, lane: laneName(board.projects.find((p) => p.id === task.projectId), task.status), branch, directory };
}

/** A linked card worth a handoff: delivered (In review) or settled (nothing moves it), and neither finished nor archived. */
const wantsHandoff = (board: Board, v: LinkView) =>
  !!v.other && (v.relation === "sub_card" || v.relation === "blocked_by") && !v.other.archivedAt && !["done", "cancelled"].includes(v.other.status) &&
  (v.other.status === "in_review" || !subCardActive(board, v.other.id));

/**
 * What get_task adds to its links (SUB-CARDS-SPEC §8), bounded as a whole: a handoff for each delivered or settled
 * sub-card and blocker, In review and most recently updated first, whose evidence shares one budget (the rest
 * point to the card's directory and branch instead); the parent's branch on sub_card_of, and the branch a Done
 * blocker was delivered on. Branches come from the stored HEAD; only a card without one costs a `rev-parse`.
 * Linked workspaces are read only for handoffs and a parent without a stored branch.
 */
export async function linkExtras(board: Board, taskId: string, paseo: PaseoApi, git: Git) {
  const views = linksOf(board, taskId).filter((v) => v.other);
  const seen = new Set<string>();
  const wanted = views
    .filter((v) => wantsHandoff(board, v))
    .sort((a, b) => Number(b.other!.status === "in_review") - Number(a.other!.status === "in_review") || b.other!.updatedAt.localeCompare(a.other!.updatedAt))
    .filter((v) => {
      if (seen.has(v.other!.id)) return false;
      seen.add(v.other!.id);
      return true;
    });
  let left: number = handoffBudget.total;
  const handoffs = new Map<string, LinkHandoff>();
  const branches = new Map<string, string>();
  const located = await Promise.all(
    wanted.map(async (v) => {
      const directory = await directoryOf(v.other!, paseo);
      return { v, directory, branch: storedBranch(board, v.other!.id) ?? (await liveBranch(directory, git)) };
    }),
  );
  for (const { v, directory, branch } of located) {
    const full = handoffEvidence(board, v.other!.id);
    const fits = full.length <= left;
    if (fits) left -= full.length;
    handoffs.set(v.other!.id, {
      ...(branch ? { branch } : {}),
      ...(directory ? { directory } : {}),
      evidence: fits ? full : `Omitted: get_task carries at most ${handoffBudget.total} characters of handoff evidence and the links before this one used them. Inspect this card's directory and branch (git log, git diff) instead.`,
      blockers: unmetBlockers(board, v.other!.id),
    });
  }
  await Promise.all(
    views.map(async (v) => {
      const other = v.other!;
      const known = v.relation === "sub_card_of" || (v.relation === "blocked_by" && other.status === "done");
      if (!known || handoffs.has(other.id)) return;
      const branch = storedBranch(board, other.id) ?? (v.relation === "sub_card_of" ? await liveBranch(await directoryOf(other, paseo), git) : undefined);
      if (branch) branches.set(other.id, branch);
    }),
  );
  return { handoffs, branches };
}
