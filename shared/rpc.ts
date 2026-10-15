import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  boardSchema,
  projectInput,
  projectEdit,
  taskInput,
  taskEdit,
  taskPlacement,
  projectSchema,
  taskSchema,
} from "./model";
import { healthSchema, preparationSchema } from "./tools";
import {
  sessionReadStateSchema,
  sessionReadReceiptSchema,
  markSessionReadInput,
} from "./session-attention";

export const readSessionReceipts = defineRpc({
  name: "sessions.read-state",
  input: z.strictObject({}),
  output: sessionReadStateSchema,
});
export const markSessionRead = defineRpc({
  name: "sessions.mark-read",
  input: markSessionReadInput,
  output: sessionReadReceiptSchema,
});

export const readBoard = defineRpc({
  name: "board.read",
  input: z.object({}),
  output: boardSchema,
});
export const createProject = defineRpc({
  name: "projects.create",
  input: projectInput,
  output: projectSchema,
});
export const updateProject = defineRpc({
  name: "projects.update",
  input: projectEdit,
  output: projectSchema,
});
export const createTask = defineRpc({
  name: "tasks.create",
  input: taskInput,
  output: taskSchema,
});
export const updateTask = defineRpc({
  name: "tasks.update",
  input: taskEdit,
  output: taskSchema,
});
export const moveTask = defineRpc({
  name: "tasks.move",
  input: z.object({
    id: z.string(),
    revision: z.number(),
    direction: z.enum(["up", "down"]),
  }),
  output: taskSchema,
});
export const placeTask = defineRpc({
  name: "tasks.place",
  input: taskPlacement,
  output: taskSchema,
});
export const listResources = defineRpc({
  name: "resources.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({ id: z.string(), name: z.string(), path: z.string() }),
    ),
    workspaces: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        name: z.string(),
        path: z.string(),
        status: z.string(),
        repoPaths: z.array(z.string()),
        owner: z.string(),
      }),
    ),
  }),
});
export const taskContext = defineRpc({
  name: "tasks.context",
  input: z.object({ id: z.string() }),
  output: z.object({
    available: z.boolean(),
    reason: z.string(),
    context: z.string(),
    owner: z.string(),
    workspaceRepoPaths: z.array(z.string()),
    directories: z.array(z.object({ repo: z.string(), directory: z.string() })),
  }),
});
export const toolsHealth = defineRpc({
  name: "tools.health",
  input: z.object({}),
  output: healthSchema,
});
export const prepareSession = defineRpc({
  name: "tools.prepare-session",
  input: z.object({ id: z.string(), operationId: z.string().min(1).max(200) }),
  output: preparationSchema,
});
export const prepareExisting = defineRpc({
  name: "tools.prepare-existing",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: preparationSchema,
});
export const accessState = defineRpc({
  name: "tools.access-state",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: healthSchema.extend({
    methods: z.array(z.string()),
    lastSuccessAt: z.string().nullable(),
    lastAction: z.string().nullable(),
  }),
});
export const wrapupCheckSchema = z.object({
  taskId: z.string(),
  revision: z.number().int(),
  workspace: z
    .object({ id: z.string(), kind: z.string(), directory: z.string() })
    .nullable(),
  archiveWorkspace: z.boolean(),
  sessions: z.number().int(),
  git: z
    .object({
      branch: z.string(),
      uncommitted: z.number().int(),
      unpushed: z.number().int(),
    })
    .nullable(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type WrapupCheck = z.infer<typeof wrapupCheckSchema>;
export const wrapupResultSchema = z.object({
  archivedSessions: z.number().int(),
  archivedWorkspace: z.boolean(),
  note: z.string(),
});
export type WrapupResult = z.infer<typeof wrapupResultSchema>;
export const wrapupCheck = defineRpc({
  name: "tasks.wrapup-check",
  input: z.strictObject({ id: z.string().min(1) }),
  output: wrapupCheckSchema,
});
export const wrapup = defineRpc({
  name: "tasks.wrapup",
  input: z.strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    acknowledgeWarnings: z.boolean(),
  }),
  output: wrapupResultSchema,
});
export const managedSessions = defineRpc({
  name: "sessions.managed",
  input: z.strictObject({}),
  output: z.array(
    z.object({ agentId: z.string(), taskId: z.string(), workspaceId: z.string() }),
  ),
});
export const configureSession = defineRpc({
  name: "sessions.configure",
  input: z
    .strictObject({
      taskId: z.string().min(1).max(200),
      // IDs become CLI arguments: never allow a leading "-" (option injection).
      agentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
      thinkingOptionId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
      modeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
      stop: z.boolean().optional(),
    })
    .refine((i) => i.thinkingOptionId || i.modeId || i.stop, { message: "Nothing to change." }),
  output: z.object({ applied: z.array(z.string()) }),
});
