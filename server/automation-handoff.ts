import type { PaseoApi } from "@getpaseo/client";
import { laneName } from "../shared/lanes";
import { linksOf } from "../shared/links";
import { jobOf, type SubCardLine } from "../shared/automation";
import type { Board } from "../shared/model";
import { defaultGit, readHead } from "./workpad";

/** A bounded read projection, never authority to write another card. */
export async function cardHandoff(board: Board, taskId: string, paseo: PaseoApi): Promise<SubCardLine | null> {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const project = board.projects.find((p) => p.id === task.projectId);
  const job = jobOf(board, taskId);
  const directory = await paseo.workspaces.ref(task.workspaceId).refresh().then((w) => w?.workspaceDirectory, () => undefined);
  const head = directory ? await readHead(directory, defaultGit, new Date().toISOString()).catch(() => null) : null;
  const pad = board.workpads.find((w) => w.taskId === taskId);
  const delivery = [...board.events].reverse().find((e) => e.taskId === taskId && e.actor === "agent" && e.to === "in_review");
  return {
    id: task.id, title: task.title, lane: laneName(project, task.status),
    ...(job ? { job: { state: job.state, verdict: job.verdict, code: job.code } } : {}),
    ...(directory ? { directory } : {}), ...(head?.branch ? { branch: head.branch } : {}),
    evidence: JSON.stringify({ delivery: delivery?.note?.slice(0, 1500), acceptance: pad?.acceptance.slice(0, 8), validation: pad?.validation.slice(0, 8), confusions: pad?.confusions.slice(0, 4) }).slice(0, 6000),
    blockers: linksOf(board, taskId).filter((v) => v.relation === "blocked_by" && v.other?.status !== "done").map((v) => `${v.other?.title ?? "Unavailable card"} (${v.link.from}): ${v.other?.archivedAt ? "archived" : v.other?.status ?? "missing"}`),
  };
}
