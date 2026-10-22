import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The official Paseo CLI ships inside the app bundle next to the daemon, and a
 * desktop-managed daemon does not have it on PATH. Calls the SDK has no API for
 * (session settings, project create/delete) go through it with argument arrays.
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
