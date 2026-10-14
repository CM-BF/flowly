import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import {
  progressInputSchema,
  statusInputSchema,
  toolContextSchema,
  toolResultSchema,
  type ToolIdentity,
  type ToolPreparation,
} from "../shared/tools";
import { AgentService } from "./agent-service";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ToolSecrets, writePrivate } from "./tool-context";
import { ToolError, toolFailure } from "./tool-error";
import { cliSource } from "./cli-source";
import { skillText, workingInstructions } from "./skill-source";

export class ToolServer {
  readonly secrets: ToolSecrets;
  readonly agents: AgentService;
  private server?: Server;
  private handler?: McpHttpHandler;
  private starting?: Promise<void>;
  private preparation = Promise.resolve<unknown>(undefined);
  private url = "";
  private reason = "Starting Kanban tool service…";
  private stopped = false;
  constructor(readonly store: BoardStore) {
    this.secrets = new ToolSecrets(store.directory);
    this.agents = new AgentService(store, this.secrets);
  }
  attach(paseo: PaseoApi) {
    this.agents.attach(paseo);
  }
  health() {
    const listening = !!this.server?.listening;
    return {
      listening,
      sdkReady: this.agents.sdkReady,
      ready: listening && this.agents.sdkReady,
      reason:
        this.reason ||
        (!this.agents.sdkReady
          ? "Waiting for Paseo context. Refresh the drawer or start a session turn."
          : ""),
      version: 1 as const,
    };
  }
  async start() {
    if (this.stopped)
      throw new ToolError(
        "TOOLS_UNAVAILABLE",
        "Tool service is stopping.",
        true,
      );
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    const job = this.initialize();
    this.starting = job;
    try {
      await job;
      this.reason = "";
    } catch (e) {
      this.reason = toolFailure(e).message;
      await this.closeListener();
      throw new ToolError("TOOLS_UNAVAILABLE", this.reason, true);
    } finally {
      this.starting = undefined;
    }
  }
  private token(value: string | undefined) {
    if (!value?.startsWith("Bearer "))
      throw new ToolError("UNAUTHORIZED", "Missing Kanban session credential.");
    return this.secrets.authenticate(value.slice(7));
  }
  private async initialize() {
    await this.secrets.initialize();
    await writePrivate(
      join(this.store.directory, "ultra-kanban.mjs"),
      cliSource,
      0o700,
    );
    await writePrivate(join(this.store.directory, "SKILL.md"), skillText);
    let port = 0;
    const discoveryFile = join(this.store.directory, "tool-endpoint.json");
    try {
      port = z
        .object({
          version: z.literal(1),
          port: z.number().int().min(1).max(65535),
          url: z.string(),
        })
        .parse(JSON.parse(await readFile(discoveryFile, "utf8"))).port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError(
          "TOOLS_UNAVAILABLE",
          `Tool discovery is invalid; preserved at ${discoveryFile}.`,
        );
    }
    const wrap = async (operation: () => Promise<object>) => {
      try {
        const value = await operation();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value as Record<string, unknown>,
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify(toolFailure(e)) },
          ],
          structuredContent: { error: toolFailure(e) },
        };
      }
    };
    this.handler = createMcpHandler(
      ({ requestInfo }) => {
        const identity = this.token(
          requestInfo?.headers.get("authorization") || undefined,
        );
        const mcp = new McpServer({
          name: "paseo-ultra-kanban",
          version: "0.2.0",
        });
        mcp.registerTool(
          "kanban_get_task",
          {
            description:
              "Read this session's current Kanban card, effective repo/worktree directories, both revisions and signed request. Read before work or any write.",
            inputSchema: z.strictObject({}),
            outputSchema: toolContextSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          () => wrap(() => this.agents.get(identity)),
        );
        mcp.registerTool(
          "kanban_update_status",
          {
            description:
              "Update this card to in_progress, blocked or in_review. Copy revisions and request from get_task, include a note. Done/cancelled are human decisions. Retry identical uncertain requests only.",
            inputSchema: statusInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => wrap(() => this.agents.write(identity, "status", input)),
        );
        mcp.registerTool(
          "kanban_report_progress",
          {
            description:
              "Append this session's checkpoint/blocker/result/question without changing card status or task revision. kind=question asks the user something and marks the card Needs you until they reply. Copy revisions/request from get_task. Partial contribution does not complete the card.",
            inputSchema: progressInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => wrap(() => this.agents.write(identity, "progress", input)),
        );
        return mcp;
      },
      { responseMode: "json", maxRequestBodySize: 65536 },
    );
    const nodeHandler = toNodeHandler(this.handler, {
      maxRequestBodySize: 65536,
    });
    const host = localhostHostValidation(),
      origin = localhostOriginValidation();
    this.server = createServer((req, res) => {
      if (!host(req, res) || !origin(req, res)) return;
      void (async () => {
        if (this.stopped)
          throw new ToolError(
            "TOOLS_UNAVAILABLE",
            "Tool service is stopping.",
            true,
          );
        const identity = this.token(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        );
        const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
        if (pathname === "/mcp") {
          await nodeHandler(req, res);
          return;
        }
        if (pathname !== "/api" || req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        await this.apiRequest(req, res, identity);
      })().catch((e) =>
        this.json(
          res,
          { ok: false, error: toolFailure(e) },
          e instanceof ToolError && e.code === "UNAUTHORIZED" ? 401 : 400,
        ),
      );
    });
    this.server.requestTimeout = 25000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Kanban listener has no port.");
    this.url = `http://127.0.0.1:${address.port}/`;
    await writePrivate(
      discoveryFile,
      JSON.stringify({ version: 1, port: address.port, url: this.url }),
    );
  }
  private json(res: ServerResponse, value: unknown, status = 200) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
  }
  private async apiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    identity: ToolIdentity,
  ) {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const data = Buffer.from(chunk);
      length += data.length;
      if (length > 65536) {
        req.resume();
        throw new ToolError("INVALID_INPUT", "Request body is too large.");
      }
      chunks.push(data);
    }
    const body = z
      .strictObject({
        action: z.enum(["get", "status", "progress"]),
        input: z.unknown(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const value =
      body.action === "get"
        ? (z.strictObject({}).parse(body.input),
          await this.agents.get(identity))
        : await this.agents.write(identity, body.action, body.input);
    this.json(res, { ok: true, result: value });
  }
  private async prepare(
    identity: ToolIdentity,
    context: string,
    method: "mcp" | "cli",
  ): Promise<ToolPreparation> {
    await this.start();
    const contextFile = await this.secrets.writeContext(identity, method),
      cliPath = join(this.store.directory, "ultra-kanban.mjs"),
      skillPath = join(this.store.directory, "SKILL.md");
    return {
      agentId: identity.agentId,
      contextFile,
      cliPath,
      skillPath,
      instructions: workingInstructions(
        context,
        cliPath,
        contextFile,
        skillPath,
      ),
      mcp: {
        type: "http",
        url: `${this.url}mcp`,
        headers: {
          Authorization: `Bearer ${this.secrets.credential(identity)}`,
        },
      },
    };
  }
  async prepareSession(taskId: string, operationId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const job = this.preparation.then(async () => {
      await this.start();
      const board = await this.store.read(),
        task = board.tasks.find((t) => t.id === taskId);
      if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
      const ctx = await new BoardService(this.store).context(taskId, paseo);
      if (!ctx.available)
        throw new ToolError("RESOURCE_UNAVAILABLE", ctx.reason);
      const identity = await this.secrets.prepared(
        taskId,
        task.workspaceId,
        operationId,
      );
      const existing = await paseo.agents.ref(identity.agentId).refresh();
      if (
        existing?.agent &&
        (existing.agent.workspaceId !== task.workspaceId ||
          existing.agent.archivedAt)
      )
        throw new ToolError(
          "SESSION_MISMATCH",
          "Prepared agent ID now belongs to an unavailable/different session.",
        );
      return this.prepare(identity, ctx.context, "mcp");
    });
    this.preparation = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  async prepareExisting(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    await this.start();
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId);
    if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
    const identity = { taskId, agentId, workspaceId: task.workspaceId };
    const current = await this.agents.get(identity, false);
    if (current.task.archivedAt || current.project.archivedAt)
      throw new ToolError("ARCHIVED", "Task/project is archived.");
    const ctx = await new BoardService(this.store).context(taskId, paseo);
    return this.prepare(identity, ctx.context, "cli");
  }
  async sessionContext(
    agentId: string,
    workspaceId: string | null,
    paseo: PaseoApi,
  ) {
    this.attach(paseo);
    if (!workspaceId) return null;
    const board = await this.store.read(),
      task = board.tasks.find((t) => t.workspaceId === workspaceId),
      project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || task.archivedAt || project?.archivedAt) return null;
    // Only Kanban-managed sessions get tools: launched from the card (prepared
    // with credentials) or explicitly opted in via "Send Kanban work
    // instructions". Other sessions in a card's workspace stay untouched.
    if (!(await this.secrets.hasContext(agentId))) return null;
    await this.start();
    return this.secrets.writeContext(
      { agentId, workspaceId, taskId: task.id },
      "cli",
    );
  }
  async accessState(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId),
      actor = await paseo.agents.ref(agentId).refresh();
    if (!task || !actor?.agent || actor.agent.workspaceId !== task.workspaceId)
      throw new ToolError(
        "SESSION_MISMATCH",
        "Session does not belong to this card.",
      );
    let methods: string[] = [];
    try {
      const data = JSON.parse(
        await readFile(this.secrets.contextFile(agentId), "utf8"),
      );
      if (data.identity.taskId === taskId)
        methods = z.array(z.string()).parse(data.methods || []);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const durable = (await this.store.read()).agentReceipts
        .filter((r) => r.agentId === agentId && r.taskId === taskId)
        .at(-1),
      recent = this.agents.accesses.get(agentId);
    return {
      methods,
      lastSuccessAt: recent?.at || durable?.at || null,
      lastAction: recent?.action || durable?.action || null,
      ...this.health(),
    };
  }
  async stop() {
    this.stopped = true;
    if (this.starting) await this.starting.catch(() => undefined);
    await this.closeListener();
    await this.store.read().catch(() => undefined);
  }
  private async closeListener() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
    await this.handler?.close();
    this.server = undefined;
    this.handler = undefined;
  }
}
