import type { PaseoApi } from "@getpaseo/client";
import { resolveModels, type SummaryModelChoice } from "../shared/summary";
import type { RemovableAgent, RemoveAgent } from "./summarizer-remove";

/** Fetch only providers named by the configured list (or the default Auto pair). */
export async function availableModels(paseo: PaseoApi, configured: SummaryModelChoice) {
  const choices = typeof configured === "string" ? (configured ? [configured] : []) : configured;
  const wanted = choices.length ? choices.map((id) => id.slice(0, id.indexOf("/"))) : ["claude", "codex"];
  const available = (await paseo.providers.listAvailable()).providers;
  return Promise.all(available.filter((p) => wanted.includes(p.provider)).map(async (p) => {
    if (!p.available) return { provider: p.provider, available: false, models: [] };
    const result = await paseo.providers.listModels(p.provider).catch(() => null);
    return { provider: p.provider, available: !!result && !result.error, models: result?.models || [] };
  }));
}

type ModelAgent = RemovableAgent & {
  waitForFinish(timeout: number): Promise<{ status: string; error?: string | null; lastMessage?: string | null }>;
};

/** Only model create/wait/parse/cleanup are retried; the caller persists after this returns. */
export async function runSummaryModels<T>(
  paseo: PaseoApi,
  configured: SummaryModelChoice,
  options: { create(model: string): Promise<ModelAgent>; parse(text: string | null | undefined): T; remove: RemoveAgent; timeoutMs: number; signal?: AbortSignal },
): Promise<{ model: string; output: T }> {
  const models = resolveModels(configured, await abortable(availableModels(paseo, configured), options.signal));
  const failures: string[] = [];
  for (const model of models) {
    if (options.signal?.aborted) throw new Error("Cancelled");
    try {
      const creating = options.create(model);
      let agent: ModelAgent;
      try { agent = await modelDeadline(abortable(creating, options.signal), options.timeoutMs); }
      catch (error) {
        // Creation can finish after cancellation or a timeout; remove only this run's eventual session.
        void creating.then(options.remove).catch(() => undefined);
        throw error;
      }
      let output: T;
      try {
        const result = await modelDeadline(abortable(agent.waitForFinish(options.timeoutMs), options.signal), options.timeoutMs);
        if (result.status !== "idle" || result.error) throw new Error(
          result.status === "timeout" ? "The summary model timed out."
            : result.status === "permission" ? "The summary model asked for a permission."
              : result.error || "The summary model failed.",
        );
        output = options.parse(result.lastMessage);
      } finally {
        await options.remove(agent);
      }
      return { model, output };
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.join("; "));
}

/** Cancellation never leaves an event listener behind on a completed operation. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Cancelled"));
    if (signal.aborted) { void work.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function modelDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The summary model timed out.")), ms); })]).finally(() => clearTimeout(timer));
}
