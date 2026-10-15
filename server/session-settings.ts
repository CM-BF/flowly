import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BoardStore } from "./store";
import { paseoHome } from "./service";

const execute = promisify(execFile);
type Run = (file: string, args: string[]) => Promise<string>;
const defaultRun: Run = async (file, args) =>
  (await execute(file, args, { timeout: 20000, maxBuffer: 1 << 20 })).stdout;

/**
 * The official Paseo CLI ships inside the app bundle next to the daemon. The
 * plugin SDK has no session-settings API, so changes go through the CLI
 * (argument arrays only), which talks to the same daemon.
 */
export async function resolvePaseoCli(execPath = process.execPath, env = process.env) {
  const candidates = [
    env.PASEO_CLI,
    // .../Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper
    join(dirname(execPath), "..", "..", "..", "..", "Resources", "bin", "paseo"),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* try next */
    }
  }
  return "paseo";
}

export type SessionSettingsInput = {
  taskId: string;
  agentId: string;
  thinkingOptionId?: string;
  modeId?: string;
  stop?: boolean;
};

/** Validated, card-scoped session setting changes for Kanban sessions. */
export class SessionSettingsService {
  constructor(
    readonly store: BoardStore,
    readonly run: Run = defaultRun,
    readonly cli: () => Promise<string> = () => resolvePaseoCli(),
  ) {}

  async apply(input: SessionSettingsInput, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const snapshot = await paseo.agents.ref(input.agentId).refresh();
    const agent = snapshot?.agent;
    if (!agent || agent.workspaceId !== task.workspaceId)
      throw new Error("Session is unavailable or belongs to a different workspace.");
    if (agent.archivedAt) throw new Error("Restore the session before changing its settings.");
    if (input.modeId && !agent.availableModes?.some((m) => m.id === input.modeId))
      throw new Error("That permission mode is not available for this session.");
    const bin = await this.cli();
    const home = ["--home", paseoHome()];
    const applied: string[] = [];
    if (input.stop) {
      await this.run(bin, ["agent", "stop", agent.id, ...home]);
      applied.push("stopped");
    }
    if (input.thinkingOptionId) {
      await this.run(bin, ["agent", "update", agent.id, "--thinking", input.thinkingOptionId, ...home]);
      applied.push("reasoning");
    }
    if (input.modeId) {
      await this.run(bin, ["agent", "mode", agent.id, input.modeId, ...home]);
      applied.push("permissions");
    }
    return { applied };
  }
}
