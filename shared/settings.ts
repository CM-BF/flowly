import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-scoped board view preferences (not board data). */
export const boardViewSettings = defineSettings({
  id: "board-view",
  scope: "host",
  version: 1,
  schema: z.object({ lastProjectId: z.string().max(200).default("") }),
});
