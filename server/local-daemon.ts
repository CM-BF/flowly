import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/**
 * COMPAT(sdk-local-daemon): a short-lived local daemon connection for the few
 * daemon calls the plugin SDK (`PaseoApi`, @getpaseo/client 0.11.2) does not
 * expose yet: workspace restore, session unarchive (WORKSPACE-RESTORE-SPEC) and
 * clearing a session's native attention (SESSION-ATTENTION-SPEC). Connects the
 * way the `paseo` CLI does: the address from `paseo.pid` and the local
 * credential file. The token is never logged. `methods` must exist on this
 * Paseo version, otherwise `unsupported` is thrown. Callers close the client.
 */
export async function openLocalDaemon(
  home: string,
  clientId: string,
  methods: readonly (keyof DaemonClient)[],
  unsupported: string,
): Promise<DaemonClient> {
  const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown };
  const listen = typeof lock.listen === "string" ? lock.listen.trim().replace(/^tcp:\/\//, "") : "";
  if (!/^[\w.-]+:\d+$|^\[[\da-f:]+\]:\d+$/i.test(listen))
    throw new Error("The Paseo daemon address is not a local TCP endpoint.");
  const token = (await readFile(join(home, "local-credential"), "utf8").catch(() => "")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("The Paseo local credential is unavailable.");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId,
    clientType: "cli",
    localCredential: () => token,
    reconnect: { enabled: false },
    connectTimeoutMs: 5000,
  });
  try {
    await client.connect();
    for (const method of methods)
      if (typeof client[method] !== "function") throw new Error(unsupported);
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }
  return client;
}
