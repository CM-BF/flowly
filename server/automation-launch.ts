import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { automationLaunchSchema, type AutomationLaunch } from "../shared/automation-launch";
import { maxImageBytes } from "../shared/composer";
import type { Board } from "../shared/model";

/** Attachments stay off board reads; crash leftovers are collected after an hour. */
export class AutomationLaunches {
  constructor(private directory: string) {}
  private get root() { return join(this.directory, "automation-launches"); }
  key(taskId: string, launch: AutomationLaunch) {
    return createHash("sha256").update(JSON.stringify([taskId, launch.operationId, launch])).digest("hex");
  }
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid automation launch reference.");
    return join(this.root, `${key}.json`);
  }
  async save(taskId: string, input: AutomationLaunch) {
    const launch = automationLaunchSchema.parse(input);
    if (launch.images?.some((image) => Buffer.from(image.data, "base64").length > maxImageBytes)) throw new Error("Image exceeds 5 MB.");
    const key = this.key(taskId, launch);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ taskId, launch }), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path(key));
    } finally { await unlink(temp).catch(() => {}); }
    return key;
  }
  async read(taskId: string, key: string): Promise<AutomationLaunch> {
    const data = JSON.parse(await readFile(this.path(key), "utf8"));
    const launch = automationLaunchSchema.parse(data.launch);
    if (data.taskId !== taskId || this.key(taskId, launch) !== key) throw new Error("Automation launch does not belong to this card.");
    return launch;
  }
  async collect(board: Board) {
    const referenced = new Set(board.automation.filter((job) => !job.launchConsumed && job.launchKey).map((job) => job.launchKey));
    for (const file of await readdir(this.root).catch(() => [] as string[])) {
      if (referenced.has(file.replace(/\.json$/, ""))) continue;
      const path = join(this.root, file);
      const data = file.endsWith(".json") ? await readFile(path, "utf8").then((s) => JSON.parse(s)).catch(() => null) : null;
      const job = board.automation.find((j) => `${j.launchKey}.json` === file);
      const old = Date.now() - (await stat(path)).mtimeMs > 3600_000;
      if (job?.launchConsumed || (data?.taskId && !board.tasks.some((t) => t.id === data.taskId)) || old) await unlink(path);
    }
  }
}
