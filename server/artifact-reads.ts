import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const stateSchema = z.object({
  version: z.literal(1),
  /** agentId → when that session last read the card's artifacts through kanban_get_task. */
  reads: z.record(z.string(), z.string()),
});
type State = z.infer<typeof stateSchema>;
const MAX_SESSIONS = 2000;

/**
 * When each session last read its card's artifacts (CARD-ARTIFACTS-SPEC §4.2),
 * so get_task can flag artifacts added or edited since. Kept out of board.json:
 * a read must not change the board or its revision.
 */
export class ArtifactReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "artifact-reads.json");
  }
  private async load(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, reads: {} };
      throw new Error(`Artifact read data is invalid; preserved at ${this.path}.`);
    }
  }
  async lastRead(agentId: string): Promise<string | undefined> {
    await this.tail;
    return (await this.load()).reads[agentId];
  }
  /** Records a read at `at`; never moves a session's mark backwards. Oldest sessions drop past the cap. */
  mark(agentId: string, at: string): Promise<void> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      if (state.reads[agentId] && state.reads[agentId] >= at) return;
      state.reads[agentId] = at;
      const entries = Object.entries(state.reads);
      if (entries.length > MAX_SESSIONS)
        state.reads = Object.fromEntries(entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SESSIONS));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        try {
          await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}
