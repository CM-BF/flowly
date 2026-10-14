import { z } from "zod";

export const statuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export const statusLabels: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
export const priorities = ["low", "normal", "high", "urgent"] as const;
export const statusSchema = z.enum(statuses);
export type Status = z.infer<typeof statusSchema>;
export const prioritySchema = z.enum(priorities);
const timestamp = z.string();
export const projectSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000),
  paseoProjectId: z.string(),
  primaryPath: z.string(),
  repos: z.array(z.string()).min(1),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
});
export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  sourcePath: z.string(),
  repoPaths: z.array(z.string()),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000),
  status: statusSchema,
  priority: prioritySchema,
  position: z.number(),
  revision: z.number().int().positive(),
  operationId: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
});
export const eventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  actor: z.enum(["human", "agent", "system"]),
  action: z.string(),
  agentId: z.string().optional(),
  note: z.string().max(10000).optional(),
  from: statusSchema.optional(),
  to: statusSchema.optional(),
  reportKind: z.enum(["progress", "blocker", "result"]).optional(),
  at: timestamp,
});
export const boardSchema = z.object({
  version: z.literal(3),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  events: z.array(eventSchema),
});
export const previousBoardSchema = boardSchema.extend({
  version: z.literal(2),
});
export const receiptSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  taskId: z.string(),
  payloadHash: z.string(),
  action: z.enum(["status", "progress"]),
  eventId: z.string(),
  taskRevision: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  status: statusSchema,
  at: z.string(),
  expiresAt: z.string(),
});
export const storageSchema = boardSchema.extend({
  agentReceipts: z.array(receiptSchema).max(5000),
});
export const legacyBoardSchema = boardSchema.extend({
  version: z.literal(1),
  tasks: z.array(taskSchema.omit({ repoPaths: true })),
});
export type Board = z.infer<typeof storageSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type BoardEvent = z.infer<typeof eventSchema>;
export const emptyBoard = (): Board => ({
  version: 3,
  revision: 0,
  projects: [],
  tasks: [],
  events: [],
  agentReceipts: [],
});
export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(""),
  primaryPath: z.string().min(1),
  paseoProjectId: z.string().optional(),
});
export const projectEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(10000).optional(),
  archived: z.boolean().optional(),
});
export const taskInput = z.strictObject({
  projectId: z.string(),
  operationId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  status: statusSchema.default("todo"),
  priority: prioritySchema.default("normal"),
  mode: z.enum(["existing", "directory", "worktree"]),
  workspaceId: z.string().optional(),
  baseRef: z.string().default(""),
  branchName: z.string().optional(),
});
export const taskEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  archived: z.boolean().optional(),
  note: z.string().max(10000).optional(),
  actor: z.enum(["human", "agent"]).default("human"),
  agentId: z.string().optional(),
});
export type ProjectInput = z.infer<typeof projectInput>;
export type TaskInput = z.infer<typeof taskInput>;
export type TaskEdit = z.infer<typeof taskEdit>;
export const taskPlacement = z
  .strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    status: statusSchema,
    beforeId: z.string().min(1).nullable(),
    afterId: z.string().min(1).nullable(),
  })
  .refine((input) => !(input.beforeId && input.afterId), {
    message: "Choose one drop anchor.",
  });
export type TaskPlacement = z.infer<typeof taskPlacement>;
