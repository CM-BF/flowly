import { z } from "zod";
import { relations } from "./links";
import {
  taskSchema,
  projectSchema,
  eventSchema,
  receiptSchema,
  statusSchema,
  legacyStatus,
  ideaLimits,
  ideaStatuses,
  artifactLimits,
  artifactRoles,
  artifactKinds,
  prioritySchema,
  taskTypeSchema,
} from "./model";

export const agentStatuses = ["design", "development", "test", "blocked", "in_review"] as const;
export const revisionSchema = z.strictObject({
  task: z.number().int().positive(),
  project: z.number().int().positive(),
});
export const requestSchema = z.strictObject({
  id: z.string().min(1).max(4096),
  issuedAt: z.string().datetime(),
});
const base = {
  expectedRevision: revisionSchema,
  request: requestSchema,
  note: z.string().trim().min(1).max(10000),
};
export const statusInputSchema = z.strictObject({
  ...base,
  status: z
    .enum([...agentStatuses, legacyStatus])
    .describe(
      "One of allowedStatuses. in_progress is a deprecated alias kept for older sessions: it keeps the current work stage, else Development.",
    ),
});
export const progressInputSchema = z.strictObject({
  ...base,
  kind: z.enum(["progress", "blocker", "result", "question"]).default("progress"),
});
/** kanban_propose_idea (IDEAS-SPEC §3): a follow-up outside this card's scope. */
export const ideaInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
  request: requestSchema,
  title: z.string().trim().min(1).max(ideaLimits.title).describe("Short task title for the follow-up card."),
  detail: z
    .string()
    .trim()
    .min(1)
    .max(ideaLimits.detail)
    .describe("What the follow-up task should do and how to tell it is done."),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(ideaLimits.rationale)
    .describe("Why it is worth doing and what in this card's work led to it."),
  context: z
    .string()
    .trim()
    .max(ideaLimits.context)
    .default("")
    .describe("Files, branches and findings the new task needs; its agent cannot see this conversation."),
  type: taskTypeSchema.optional(),
  priority: prioritySchema.optional(),
  scope: z
    .enum(["here", "new"])
    .default("new")
    .describe(
      "here: an extension of this card's goal that this card's session can continue with its current context; new: divergent work that deserves its own card.",
    ),
});
/** kanban_add_artifact (CARD-ARTIFACTS-SPEC §4.1): register an input or a deliverable of this card. */
export const artifactInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
  request: requestSchema,
  role: z.enum(artifactRoles).describe("input: material this card worked from; output: something it delivered."),
  target: z
    .string()
    .trim()
    .min(1)
    .max(artifactLimits.target)
    .describe("An http(s) link, or a file/directory path (absolute, or relative to the workspace directory) inside this card's directories."),
  title: z.string().trim().max(artifactLimits.title).optional().describe("Short title; defaults to the file name or link."),
  note: z.string().trim().max(artifactLimits.note).optional().describe("One line on what it is for."),
});
/** kanban_remove_artifact: only artifacts an agent added. */
export const artifactRemovalSchema = z.strictObject({
  expectedRevision: revisionSchema,
  request: requestSchema,
  id: z.string().min(1).describe("Artifact id from get_task."),
});
export const identitySchema = z.strictObject({
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
});
export type ToolIdentity = z.infer<typeof identitySchema>;
export const toolContextSchema = z.object({
  identity: identitySchema,
  task: taskSchema,
  project: projectSchema,
  revision: revisionSchema,
  request: requestSchema,
  toolVersion: z.literal(1),
  writable: z.boolean(),
  reason: z.string(),
  allowedStatuses: z.array(z.enum(agentStatuses)),
  /** The project's lanes (its workflow), in order, with display names. */
  lanes: z.array(z.object({ status: statusSchema, name: z.string() })),
  scope: z.object({
    mode: z.enum(["all", "selected"]),
    repoPaths: z.array(z.string()),
    directories: z.array(z.object({ repo: z.string(), directory: z.string() })),
  }),
  workspace: z.object({
    id: z.string(),
    directory: z.string(),
    nativeOwner: z.string(),
    status: z.string(),
    repoPaths: z.array(z.string()),
  }),
  sessions: z.object({
    entries: z.array(
      z.object({ id: z.string(), title: z.string(), status: z.string() }),
    ),
    partial: z.boolean(),
    unavailableReason: z.string(),
  }),
  activity: z.array(eventSchema),
  /** Ideas proposed on this card (IDEAS-SPEC §3), to avoid proposing duplicates. */
  ideas: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(ideaStatuses),
      scope: z.enum(["here", "new"]).optional(),
      acceptedTaskId: z.string().optional(),
      acceptedAgentId: z.string().optional(),
    }),
  ),
  /** The card's inputs and deliverables (CARD-ARTIFACTS-SPEC §4.2). `absolutePath` only for files. */
  artifacts: z.array(
    z.object({
      id: z.string(),
      role: z.enum(artifactRoles),
      kind: z.enum(artifactKinds),
      target: z.string(),
      absolutePath: z.string().optional(),
      title: z.string(),
      note: z.string(),
      createdBy: z.enum(["human", "agent"]),
      missing: z.boolean(),
    }),
  ),
  /** Linked cards, read-only (CARD-LINKS-SPEC §4). `resolved` only for blocked_by. */
  links: z.array(
    z.object({
      relation: z.enum(relations),
      taskId: z.string(),
      title: z.string(),
      status: statusSchema,
      laneName: z.string(),
      archived: z.boolean(),
      resolved: z.boolean().optional(),
    }),
  ),
});
export const toolResultSchema = z.object({
  receipt: receiptSchema.omit({
    key: true,
    payloadHash: true,
    expiresAt: true,
  }),
  replayed: z.boolean(),
  /** The proposed idea, for kanban_propose_idea. */
  ideaId: z.string().optional(),
  /** The added, updated or removed artifact, for the artifact tools. */
  artifactId: z.string().optional(),
  current: toolContextSchema.nullable(),
  contextError: z.string().optional(),
});
export const healthSchema = z.object({
  listening: z.boolean(),
  sdkReady: z.boolean(),
  ready: z.boolean(),
  reason: z.string(),
  version: z.literal(1),
});
export const preparationSchema = z.object({
  agentId: z.string(),
  contextFile: z.string(),
  cliPath: z.string(),
  skillPath: z.string(),
  instructions: z.string(),
  mcp: z.object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
});
export type ToolContext = z.infer<typeof toolContextSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type ToolPreparation = z.infer<typeof preparationSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export type ProgressInput = z.infer<typeof progressInputSchema>;
export type IdeaInput = z.infer<typeof ideaInputSchema>;
export type ArtifactToolInput = z.infer<typeof artifactInputSchema>;
export type ArtifactRemovalInput = z.infer<typeof artifactRemovalSchema>;
