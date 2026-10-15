import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { boardSorts } from "./sort";
import { statusSchema } from "./model";

/** Host-scoped board view preferences (not board data). */
export const boardViewSettings = defineSettings({
  id: "board-view",
  scope: "host",
  version: 1,
  schema: z.object({
    lastProjectId: z.string().max(200).default(""),
    /** Mirrors Paseo's app "Default send" setting, which plugins cannot read. */
    sendBehavior: z.enum(["steer", "queue", "interrupt"]).default("steer"),
    /** New task form: start the first agent together with the task. */
    startAgentOnCreate: z.boolean().default(true),
    /** Order of cards inside each column. */
    boardSort: z.enum(boardSorts).default("manual"),
    /** Desktop columns shown as a narrow strip. */
    collapsedColumns: z.array(statusSchema).max(7).default([]),
  }),
});

export type BoardView = z.infer<typeof boardViewSettings.schema>;
/**
 * Stored values may predate newer fields (the host does not apply schema
 * defaults), so always read through this to get a complete, valid object.
 */
export function boardViewValues(values: unknown): BoardView {
  const parsed = boardViewSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : boardViewSettings.schema.parse({});
}
