import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { boardSorts } from "./sort";
import { priorities, statusSchema, taskTypes } from "./model";

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
    /** Board filters, remembered between visits. */
    filterSearch: z.string().max(200).default(""),
    filterPriority: z.enum(["all", ...priorities]).default("all"),
    filterType: z.enum(["all", ...taskTypes]).default("all"),
    showArchived: z.boolean().default(false),
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

/** What happens when a card is moved into Done or Cancelled (MULTITASK-SPEC). */
export const wrapupSettings = defineSettings({
  id: "wrap-up",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Off: ask whether to wrap up. On: archive the workspace automatically when the preflight is clean. */
    autoWrapup: z.boolean().default(false),
    /** Off: deleting a card asks whether to archive its sessions/workspace. On: archive without asking when the preflight is clean. */
    archiveOnDelete: z.boolean().default(false),
  }),
});
export type WrapupSettings = z.infer<typeof wrapupSettings.schema>;
export function wrapupSettingsValues(values: unknown): WrapupSettings {
  const parsed = wrapupSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : wrapupSettings.schema.parse({});
}

/** Whether session lifecycle rules may move cards between lanes (AUTO-STATUS-SPEC). */
export const statusSettings = defineSettings({
  id: "auto-status",
  scope: "host",
  version: 1,
  schema: z.object({
    /** On: rules A1/A1r run (a project can still opt out). Off: lifecycle facts are recorded, lanes never move. */
    autoStatus: z.boolean().default(true),
  }),
});
export type StatusSettings = z.infer<typeof statusSettings.schema>;
export function statusSettingsValues(values: unknown): StatusSettings {
  const parsed = statusSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : statusSettings.schema.parse({});
}
