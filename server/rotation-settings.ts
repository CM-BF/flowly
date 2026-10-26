import { readFile, stat } from "node:fs/promises";
import { rotationLimits, type RotationLimits } from "../shared/session-rotation";

/** Developer acceptance only: no host-wide override, and the 200 MiB no-read guard is immutable. */
export async function fixtureRotationOverrides(path: string): Promise<(taskId: string, projectId: string) => Partial<RotationLimits>> {
  let value: unknown;
  try {
    if ((await stat(path)).size > 65536) throw new Error("oversize");
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => ({});
    throw new Error("Invalid fixture rotation overrides; keep the default policy.");
  }
  const file = value as { version?: unknown; fixtures?: unknown };
  if (file?.version !== 1 || !Array.isArray(file.fixtures) || file.fixtures.length > 20) throw new Error("Rotation overrides require explicit fixture task/project identities.");
  const rows = file.fixtures.map(row => {
    if (!row || typeof row !== "object" || (!row.taskId && !row.projectId) || (row.taskId !== undefined && typeof row.taskId !== "string") || (row.projectId !== undefined && typeof row.projectId !== "string") || !row.limits || typeof row.limits !== "object") throw new Error("Invalid fixture rotation scope.");
    const limits: Partial<RotationLimits> = {};
    for (const [key, value] of Object.entries(row.limits)) {
      if (!Object.hasOwn(rotationLimits, key) || key === "bytesNoRead" || typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > rotationLimits[key as keyof RotationLimits]) throw new Error("Invalid fixture rotation threshold.");
      (limits as Record<string, number>)[key] = value;
    }
    return { taskId: row.taskId as string | undefined, projectId: row.projectId as string | undefined, limits };
  });
  return (taskId, projectId) => rows.reduce((result, row) => row.taskId && row.taskId !== taskId || row.projectId && row.projectId !== projectId ? result : { ...result, ...row.limits }, {});
}
