import { z } from "zod";

export const statuses = [
  "backlog",
  "todo",
  "design",
  "development",
  "test",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export const statusLabels: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  design: "Design",
  development: "Development",
  test: "Test",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
/** The working stages that replaced In progress (WORKFLOW-STAGES-SPEC). */
export const workStatuses = ["design", "development", "test"] as const satisfies readonly Status[];
export const isWorkStatus = (status: string): status is (typeof workStatuses)[number] =>
  (workStatuses as readonly string[]).includes(status);
/** Retired status: only found in history (events, receipts) written before board v4. */
export const legacyStatus = "in_progress" as const;
export const priorities = ["low", "normal", "high", "urgent"] as const;
/** What kind of work a card is (TASK-TYPE-SPEC). Optional on a task. */
export const taskTypes = ["feature", "bugfix", "research", "refactor", "docs", "chore"] as const;
export const taskTypeLabels: Record<TaskType, string> = {
  feature: "Feature",
  bugfix: "Bug fix",
  research: "Research",
  refactor: "Refactor",
  docs: "Docs",
  chore: "Chore",
};
export const statusSchema = z.enum(statuses);
export type Status = z.infer<typeof statusSchema>;
/** Statuses that may appear in history: current ones plus the retired In progress. */
export const historyStatusSchema = z.union([statusSchema, z.literal(legacyStatus)]);
export type HistoryStatus = z.infer<typeof historyStatusSchema>;
export const historyStatusLabel = (status: HistoryStatus) =>
  status === legacyStatus ? "In progress" : statusLabels[status];
export const prioritySchema = z.enum(priorities);
export const taskTypeSchema = z.enum(taskTypes);
export type TaskType = z.infer<typeof taskTypeSchema>;
const timestamp = z.string();
/**
 * A project's lane configuration: the built-in statuses in display order, each
 * enabled or not, optionally renamed. Absent means every lane, default order and
 * names. Lanes define the project's workflow: people, rules and agents only use
 * enabled lanes.
 */
export const laneSchema = z.strictObject({
  status: statusSchema,
  name: z.string().trim().max(40).optional(),
  enabled: z.boolean(),
});
export const lanesSchema = z
  .array(laneSchema)
  .length(statuses.length)
  .refine((lanes) => new Set(lanes.map((l) => l.status)).size === lanes.length, "Each lane appears once.")
  .refine((lanes) => lanes.some((l) => l.enabled), "Keep at least one lane enabled.");
export type Lane = z.infer<typeof laneSchema>;

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
  /** Session-driven status rules (AUTO-STATUS-SPEC). Absent means enabled. */
  autoStatus: z.boolean().optional(),
  /** Display order in the project chooser (lower first); absent sorts by creation. */
  position: z.number().optional(),
  lanes: lanesSchema.optional(),
  /** Linked multi-repo project: symlinks the plugin created inside its own root (PROJECT-PICKER-SPEC). */
  links: z.array(z.object({ name: z.string(), target: z.string() })).optional(),
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
  /** Absent: no type (all cards created before task types). */
  type: taskTypeSchema.optional(),
  position: z.number(),
  revision: z.number().int().positive(),
  operationId: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
  /** The plugin created this workspace for the card (not linked to an existing one). Absent on older cards. */
  ownsWorkspace: z.boolean().optional(),
  /** Created from an idea proposed on another card (IDEAS-SPEC §2.2). */
  origin: z.object({ taskId: z.string(), ideaId: z.string() }).optional(),
});
/** A follow-up an agent proposed on its card; the user may turn it into a card (IDEAS-SPEC). */
export const ideaStatuses = ["open", "accepted", "dismissed"] as const;
export const ideaLimits = { title: 120, detail: 4000, rationale: 1000, context: 4000, openPerTask: 10, keptPerTask: 50 } as const;
export const ideaSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  eventId: z.string(),
  title: z.string().trim().min(1).max(ideaLimits.title),
  detail: z.string().max(ideaLimits.detail),
  rationale: z.string().max(ideaLimits.rationale),
  context: z.string().max(ideaLimits.context),
  type: taskTypeSchema.optional(),
  priority: prioritySchema.optional(),
  status: z.enum(ideaStatuses),
  acceptedTaskId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Idea = z.infer<typeof ideaSchema>;
export const ideaEdit = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["open", "dismissed"]),
});
export type IdeaEdit = z.infer<typeof ideaEdit>;
export const eventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  actor: z.enum(["human", "agent", "system"]),
  action: z.string(),
  agentId: z.string().optional(),
  note: z.string().max(10000).optional(),
  from: historyStatusSchema.optional(),
  to: historyStatusSchema.optional(),
  reportKind: z.enum(["progress", "blocker", "result", "question"]).optional(),
  /** Set when a status rule, not a person or an agent tool, made the change. */
  rule: z.string().max(20).optional(),
  outcome: z.enum(["completed", "failed", "canceled"]).optional(),
  at: timestamp,
});
export const boardSchema = z.object({
  version: z.literal(4),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  events: z.array(eventSchema),
  /** Absent in files written before ideas (IDEAS-SPEC §2.1). */
  ideas: z.array(ideaSchema).default([]),
});
export const previousBoardSchema = boardSchema.extend({
  version: z.literal(2),
});
/** v3 differs from v4 only by the retired in_progress status, rewritten before parsing. */
export const v3BoardSchema = boardSchema.extend({
  version: z.literal(3),
});
export const receiptSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  taskId: z.string(),
  payloadHash: z.string(),
  action: z.enum(["status", "progress", "idea"]),
  eventId: z.string(),
  taskRevision: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  status: historyStatusSchema,
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
  version: 4,
  revision: 0,
  projects: [],
  tasks: [],
  events: [],
  ideas: [],
  agentReceipts: [],
});
export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(""),
  primaryPath: z.string().min(1),
  paseoProjectId: z.string().optional(),
});
const linkTargets = z.array(z.string().trim().min(1).max(4096)).min(1).max(50);
export const linkedProjectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(""),
  links: linkTargets,
});
export const projectLinksEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  links: linkTargets,
});
export type LinkedProjectInput = z.infer<typeof linkedProjectInput>;
export type ProjectLinksEdit = z.infer<typeof projectLinksEdit>;
/** Removes a project and its cards from the board only (PROJECT-REMOVE-SPEC). */
export const projectRemoval = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int(),
  /** Also remove the native Paseo project (its folders, worktrees and branches stay on disk). */
  alsoPaseo: z.boolean().default(false),
});
export type ProjectRemoval = z.input<typeof projectRemoval>;
/** Permanently deletes a card from the board (TASK-DELETE-SPEC). */
export const taskDeletion = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int(),
  /** First archive its sessions, and its workspace when the card owns it or it is a worktree. */
  archive: z.boolean().default(false),
  /** Required with `archive` when the preflight reported warnings. */
  acknowledgeWarnings: z.boolean().default(false),
});
export type TaskDeletion = z.infer<typeof taskDeletion>;
export const projectEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(10000).optional(),
  archived: z.boolean().optional(),
  autoStatus: z.boolean().optional(),
  lanes: lanesSchema.optional(),
});
export const taskInput = z.strictObject({
  projectId: z.string(),
  operationId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  status: statusSchema.default("todo"),
  priority: prioritySchema.default("normal"),
  type: taskTypeSchema.optional(),
  mode: z.enum(["existing", "directory", "worktree"]),
  workspaceId: z.string().optional(),
  baseRef: z.string().default(""),
  branchName: z.string().optional(),
  /** Create from this open idea (IDEAS-SPEC §6). */
  ideaId: z.string().min(1).optional(),
});
export const taskEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  /** null clears the type. */
  type: taskTypeSchema.nullable().optional(),
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

/** Chooser order: explicit position first, then creation time. */
export function projectOrder<T extends { position?: number; createdAt: string; id: string }>(a: T, b: T) {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER,
    pb = b.position ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
export type ProjectEdit = z.infer<typeof projectEdit>;
