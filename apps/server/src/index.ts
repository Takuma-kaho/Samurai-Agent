import cors from "cors";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server as SocketServer } from "socket.io";
import {
  CaptureModeSchema,
  ExternalProviderRoleSchema,
  ProvenanceSchema,
  ResourceRefSchema,
  createId,
  nowIso,
  supportedLocales,
  type SettingsRecord,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import {
  AgentRuntime,
  RuntimeRequestError,
  createProviderRegistryFromEnv,
  type ProviderAdapter,
  type ProviderDiagnostics,
  type ProviderRegistry
} from "@samurai-agent/runtime";
import type { RuntimeEventSink } from "@samurai-agent/ui-protocol";
import { WorkspaceStore } from "@samurai-agent/workspace-store";

const defaultPort = 4317;
const defaultEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const loadedEnvPaths = new Set<string>();

export interface CreateApiServerOptions {
  workspaceDataDir?: string;
  provider?: ProviderAdapter;
}

export interface ApiServer {
  app: Express;
  httpServer: HttpServer;
  io: SocketServer;
  store: WorkspaceStore;
  runtime: AgentRuntime;
}

export function loadServerEnv(envPath = defaultEnvPath): void {
  if (!existsSync(envPath) || loadedEnvPaths.has(envPath)) {
    return;
  }
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(`Node.js process.loadEnvFile() is required to load ${envPath}. Upgrade Node.js or provide env vars through the shell.`);
  }
  process.loadEnvFile(envPath);
  loadedEnvPaths.add(envPath);
}

export async function createApiServer(options: CreateApiServerOptions = {}): Promise<ApiServer> {
  loadServerEnv();
  const workspaceDataDir = options.workspaceDataDir ?? process.env.WORKSPACE_DATA_DIR ?? fileURLToPath(new URL("../../../workspace-data", import.meta.url));
  const store = await WorkspaceStore.create({ rootDir: workspaceDataDir });
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    cors: {
      origin: true
    }
  });

  const emit: RuntimeEventSink = async (name, payload) => {
    io.emit(name, payload);
  };
  const provider = options.provider ?? createProviderRegistryFromEnv();
  const runtime = new AgentRuntime(store, emit, provider);

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) => {
      res.json({
        ok: true,
        db: databaseStatus(store),
        llm: providerStatus(provider),
        backends: runtime.listAgentBackends(),
        workspaceDataDir: store.rootDir
      });
    });

    app.get("/api/agent-backends", (_req, res) => {
      res.json(runtime.listAgentBackends());
    });

    app.post("/api/chat/sessions", async (req, res, next) => {
      try {
        const settings = await store.getSettings();
        const session = await runtime.createSession({
          title: typeof req.body?.title === "string" ? req.body.title : undefined,
          ui_locale: asSupportedLocale(req.body?.ui_locale) ?? settings.ui_locale,
          output_locale: asSupportedLocale(req.body?.output_locale) ?? settings.output_locale
        });
        res.status(201).json(session);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/chat/sessions", async (_req, res, next) => {
      try {
        const sessions = await store.listSessions();
        const activeSessions = await Promise.all(
          sessions.map(async (session) => ({
            session,
            messageCount: (await store.listMessages(session.id)).length,
            operationCount: (await store.listOperations(session.id)).length
          }))
        );
        res.json(activeSessions.filter((item) => item.messageCount > 0 || item.operationCount > 0).map((item) => item.session));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/chat/sessions/:sessionId", async (req, res, next) => {
      try {
        const session = await store.getSession(req.params.sessionId);
        if (!session) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        const [messages, operations, artifacts, auditRecords, memory, activity, backendRuns, backendEvents, workspaceChanges] = await Promise.all([
          store.listMessages(session.id),
          store.listOperations(session.id),
          store.listArtifactsForSession(session.id),
          store.listAuditRecords(),
          store.listMemoryForSession(session.id),
          store.readActivityInputs().then((inputs) => import("@samurai-agent/audit").then(({ buildActivityInboxItems }) => buildActivityInboxItems(inputs))),
          store.listBackendRuns(session.id),
          store.listBackendEvents({ sessionId: session.id }),
          store.listWorkspaceChanges(session.id)
        ]);
        res.json({ session, messages, operations, artifacts, auditRecords, memory, activity, backendRuns, backendEvents, workspaceChanges });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/chat/sessions/:sessionId/messages", async (req, res, next) => {
      try {
        const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
        if (!content) {
          res.status(400).json({ error: "content_required" });
          return;
        }
        const result = await runtime.runChatTurn({
          sessionId: req.params.sessionId,
          content,
          backend_id: typeof req.body?.backend_id === "string" ? req.body.backend_id : undefined,
          input_locale: asSupportedLocale(req.body?.input_locale),
          output_locale: asSupportedLocale(req.body?.output_locale),
          metadata: isRecord(req.body?.metadata) ? req.body.metadata : {}
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/chat/messages", async (req, res, next) => {
      try {
        const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
        if (!content) {
          res.status(400).json({ error: "content_required" });
          return;
        }
        const settings = await store.getSettings();
        const session = await runtime.createSession({
          ui_locale: asSupportedLocale(req.body?.ui_locale) ?? settings.ui_locale,
          output_locale: asSupportedLocale(req.body?.output_locale) ?? settings.output_locale
        });
        const result = await runtime.runChatTurn({
          sessionId: session.id,
          content,
          backend_id: typeof req.body?.backend_id === "string" ? req.body.backend_id : undefined,
          input_locale: asSupportedLocale(req.body?.input_locale),
          output_locale: asSupportedLocale(req.body?.output_locale),
          metadata: isRecord(req.body?.metadata) ? req.body.metadata : {}
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/search", async (req, res, next) => {
      try {
        const query = typeof req.query.q === "string" ? req.query.q : "";
        res.json(await store.search(query));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/artifacts/:id", async (req, res, next) => {
      try {
        const artifact = await store.getArtifact(req.params.id);
        if (!artifact) {
          res.status(404).json({ error: "artifact_not_found" });
          return;
        }
        const [content, operation, auditRecords] = await Promise.all([
          store.readArtifactContent(req.params.id),
          store.getOperation(artifact.source_operation_id),
          store.listAuditRecordsForOperation(artifact.source_operation_id)
        ]);
        res.json({ artifact, content, operation, auditRecords });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/audit", async (_req, res, next) => {
      try {
        const [auditRecords, operations, policyDecisions, approvalRequests, rollbackPoints] = await Promise.all([
          store.listAuditRecords(),
          store.listOperations(),
          store.listPolicyDecisions(),
          store.listApprovalRequests(),
          store.listRollbackPoints()
        ]);
        res.json({ auditRecords, operations, policyDecisions, approvalRequests, rollbackPoints });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/activity", async (_req, res, next) => {
      try {
        const { buildActivityInboxItems } = await import("@samurai-agent/audit");
        res.json(buildActivityInboxItems(await store.readActivityInputs()));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/backend-runs", async (req, res, next) => {
      try {
        const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
        res.json(await store.listBackendRuns(sessionId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/backend-runs/:runId/events", async (req, res, next) => {
      try {
        const run = await store.getBackendRun(req.params.runId);
        if (!run) {
          res.status(404).json({ error: "backend_run_not_found" });
          return;
        }
        res.json(await store.listBackendEvents({ runId: req.params.runId }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/workspace-changes", async (req, res, next) => {
      try {
        const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
        res.json(await store.listWorkspaceChanges(sessionId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/memory", async (_req, res, next) => {
      try {
        res.json(await store.listMemory());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/memory/:id", async (req, res, next) => {
      try {
        const memory = await store.getMemory(req.params.id);
        if (!memory) {
          res.status(404).json({ error: "memory_not_found" });
          return;
        }
        const content = await store.readMemoryContent(req.params.id);
        res.json({ memory, content });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/skills", async (_req, res, next) => {
      try {
        res.json(await store.listSkills());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/skills/:id", async (req, res, next) => {
      try {
        const skill = await store.getSkill(req.params.id);
        if (!skill) {
          res.status(404).json({ error: "skill_not_found" });
          return;
        }
        const markdown = await store.readSkillMarkdown(req.params.id);
        res.json({ skill, markdown });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/skills/candidates", async (req, res, next) => {
      try {
        const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
        const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
        if (!title || !description) {
          res.status(400).json({ error: "title_and_description_required" });
          return;
        }
        const result = await runtime.createSkillCandidate({
          title,
          description,
          content: typeof req.body?.content === "string" ? req.body.content : "",
          tags: stringArray(req.body?.tags),
          required_capabilities: stringArray(req.body?.required_capabilities)
        });
        res.status(201).json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/skills/projects", async (req, res, next) => {
      try {
        const candidateId = typeof req.body?.candidate_id === "string" ? req.body.candidate_id : "";
        if (!candidateId) {
          res.status(400).json({ error: "candidate_id_required" });
          return;
        }
        const result = await runtime.saveSkillProject({ candidateId });
        res.status(201).json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki", async (_req, res, next) => {
      try {
        res.json(await store.listWiki());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki/:id", async (req, res, next) => {
      try {
        const wiki = await store.getWiki(req.params.id);
        if (!wiki) {
          res.status(404).json({ error: "wiki_not_found" });
          return;
        }
        const content = await store.readWikiContent(req.params.id);
        res.json({ wiki, content });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/proposals", async (req, res, next) => {
      try {
        const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
        const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
        if (!title || !content) {
          res.status(400).json({ error: "title_and_content_required" });
          return;
        }
        const result = await runtime.createWikiProposal({
          title,
          content,
          slug: typeof req.body?.slug === "string" ? req.body.slug : undefined,
          tags: stringArray(req.body?.tags),
          content_locale: asSupportedLocale(req.body?.content_locale),
          source_refs: resourceRefs(req.body?.source_refs),
          provenance: provenance(req.body?.provenance)
        });
        res.status(201).json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/accept", async (req, res, next) => {
      try {
        res.json(runtimeWritePayload(await runtime.acceptWikiPage(req.params.id)));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/reject", async (req, res, next) => {
      try {
        res.json(runtimeWritePayload(await runtime.rejectWikiPage(req.params.id)));
      } catch (error) {
        next(error);
      }
    });

    app.patch("/api/wiki/:id", async (req, res, next) => {
      try {
        const result = await runtime.patchWikiPage({
          id: req.params.id,
          title: typeof req.body?.title === "string" ? req.body.title.trim() : undefined,
          content: typeof req.body?.content === "string" ? req.body.content : undefined,
          tags: Array.isArray(req.body?.tags) ? stringArray(req.body.tags) : undefined,
          content_locale: asSupportedLocale(req.body?.content_locale),
          source_refs: Array.isArray(req.body?.source_refs) ? resourceRefs(req.body.source_refs) : undefined,
          provenance: isRecord(req.body?.provenance) ? provenance(req.body.provenance) : undefined
        });
        res.json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/archive", async (req, res, next) => {
      try {
        res.json(runtimeWritePayload(await runtime.archiveWikiPage(req.params.id)));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/reindex", async (_req, res, next) => {
      try {
        res.json(runtimeWritePayload(await runtime.reindexWiki()));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/schemas", async (req, res, next) => {
      try {
        const result = await runtime.saveCollectionSchema(req.body);
        res.status(201).json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/schema", async (req, res, next) => {
      try {
        const schema = await store.getCollectionSchema(req.params.collectionId);
        if (!schema) {
          res.status(404).json({ error: "collection_schema_not_found" });
          return;
        }
        res.json(schema);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/:collectionId/records", async (req, res, next) => {
      try {
        const now = nowIso();
        const record = {
          id: typeof req.body?.id === "string" ? req.body.id : createId("record"),
          collection_id: req.params.collectionId,
          data: isRecord(req.body?.data) ? req.body.data : {},
          resource_refs: Array.isArray(req.body?.resource_refs) ? req.body.resource_refs : [],
          created_at: typeof req.body?.created_at === "string" ? req.body.created_at : now,
          updated_at: typeof req.body?.updated_at === "string" ? req.body.updated_at : now
        };
        const result = await runtime.createCollectionRecord(record);
        res.status(201).json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/:collectionId/records/:recordId/patches", async (req, res, next) => {
      try {
        const patch = {
          id: typeof req.body?.id === "string" ? req.body.id : createId("patch"),
          record_id: req.params.recordId,
          changes: isRecord(req.body?.changes) ? req.body.changes : {},
          source_operation_id: typeof req.body?.source_operation_id === "string" ? req.body.source_operation_id : "pending_runtime_operation",
          created_at: typeof req.body?.created_at === "string" ? req.body.created_at : nowIso()
        };
        const result = await runtime.applyCollectionPatch({
          collectionId: req.params.collectionId,
          recordId: req.params.recordId,
          patch
        });
        res.json(runtimeWritePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/notes", async (req, res, next) => {
      try {
        res.json(await store.listCollectionNotes(req.params.collectionId));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/memory-review/run", async (_req, res, next) => {
      try {
        const result = await runtime.runMemoryReviewAutomation();
        res.status(201).json({
          automationRun: result.automationRun,
          operation: result.operation,
          policyDecision: result.policyDecision,
          auditRecord: result.auditRecord,
          ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
          activity: result.activity
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/memory/:id/archive", async (req, res, next) => {
      try {
        const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : "";
        if (!sessionId) {
          res.status(400).json({ error: "session_id_required" });
          return;
        }
        const result = await runtime.archiveMemory({
          memoryId: req.params.id,
          sessionId,
          actorIdentity: "owner",
          decidedBy: typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner"
        });
        res.json(archiveMemoryPayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/settings", async (_req, res, next) => {
      try {
        res.json(await store.getSettings());
      } catch (error) {
        next(error);
      }
    });

    app.patch("/api/settings", async (req, res, next) => {
      try {
        const patch: Partial<SettingsRecord> = {};
        const uiLocale = asSupportedLocale(req.body?.ui_locale);
        const outputLocale = asSupportedLocale(req.body?.output_locale);
        if (uiLocale) {
          patch.ui_locale = uiLocale;
        }
        if (outputLocale) {
          patch.output_locale = outputLocale;
        }
        for (const key of ["memory_capture_mode", "knowledge_wiki_capture_mode", "skill_capture_mode"] as const) {
          if (key in (req.body ?? {})) {
            const parsed = CaptureModeSchema.safeParse(req.body[key]);
            if (!parsed.success) {
              res.status(400).json({ error: "invalid_capture_mode", field: key });
              return;
            }
            patch[key] = parsed.data;
          }
        }
        if (!("knowledge_wiki_capture_mode" in (req.body ?? {})) && "llm_wiki_capture_mode" in (req.body ?? {})) {
          const parsed = CaptureModeSchema.safeParse(req.body.llm_wiki_capture_mode);
          if (!parsed.success) {
            res.status(400).json({ error: "invalid_capture_mode", field: "llm_wiki_capture_mode" });
            return;
          }
          patch.knowledge_wiki_capture_mode = parsed.data;
        }
        if ("external_provider_role" in (req.body ?? {})) {
          const parsed = ExternalProviderRoleSchema.safeParse(req.body.external_provider_role);
          if (!parsed.success) {
            res.status(400).json({ error: "invalid_external_provider_role" });
            return;
          }
          patch.external_provider_role = parsed.data;
        }
        const settings = await store.patchSettings(patch);
        io.emit("settings.updated", settings);
        res.json(settings);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/approval-requests/:id/approve", async (req, res, next) => {
      try {
        const result = await runtime.approveRequest(req.params.id, typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner");
        res.json(approvalLifecyclePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/approval-requests/:id/deny", async (req, res, next) => {
      try {
        const result = await runtime.denyRequest(
          req.params.id,
          typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner",
          typeof req.body?.reason === "string" ? req.body.reason : "Denied by owner."
        );
        res.json(approvalLifecyclePayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof RuntimeRequestError) {
        const status =
          error.code === "not_found"
            ? 404
            : error.code === "forbidden"
              ? 403
              : error.code === "provider_failed"
                ? 502
                : 409;
        if (error.code === "provider_not_configured" || error.code === "provider_failed") {
          res.status(status).json(providerErrorPayload(error));
          return;
        }
        res.status(status).json({
          error: error.code,
          message: error.message,
          ...(error.payload ? runtimeErrorPayload(error.payload) : {})
        });
        return;
      }

      console.error(error);
      res.status(500).json({
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    });

  return { app, httpServer, io, store, runtime };
}

export async function startServer(port?: number): Promise<ApiServer> {
  loadServerEnv();
  const resolvedPort = port ?? Number(process.env.PORT ?? defaultPort);
  const server = await createApiServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.httpServer.off("error", onError);
      resolve();
    };
    server.httpServer.once("error", onError);
    server.httpServer.once("listening", onListening);
    server.httpServer.listen(resolvedPort, "127.0.0.1");
  });
  console.log(`Samurai Agent API listening on http://127.0.0.1:${resolvedPort}`);
  return server;
}

function asSupportedLocale(value: unknown): SupportedLocale | undefined {
  return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? (value as SupportedLocale) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resourceRefs(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => ResourceRefSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data);
}

function provenance(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const parsed = ProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function runtimeWritePayload(result: {
  resource: unknown;
  operation: unknown;
  policyDecision: unknown;
  auditRecord: unknown;
  rollbackPoint?: unknown;
  activity: unknown;
}) {
  return {
    resource: result.resource,
    operation: result.operation,
    policyDecision: result.policyDecision,
    auditRecord: result.auditRecord,
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity
  };
}

function approvalLifecyclePayload(result: Awaited<ReturnType<AgentRuntime["approveRequest"]>>) {
  return {
    approvalRequest: result.approvalRequest,
    operation: result.operation,
    auditRecord: result.auditRecord,
    activity: result.activity
  };
}

function archiveMemoryPayload(result: Awaited<ReturnType<AgentRuntime["archiveMemory"]>>) {
  return {
    memory: result.memory,
    content: result.content,
    operation: result.operation,
    auditRecord: result.auditRecord,
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity,
    changed: result.changed,
    ...(result.warning ? { warning: result.warning } : {})
  };
}

function runtimeErrorPayload(payload: NonNullable<RuntimeRequestError["payload"]>) {
  if ("backendRun" in payload) {
    return {
      session: payload.session,
      messages: payload.messages,
      backendRun: payload.backendRun,
      backendEvents: payload.backendEvents,
      workspaceChanges: payload.workspaceChanges
    };
  }
  if ("approvalRequest" in payload) {
    return approvalLifecyclePayload(payload);
  }
  return archiveMemoryPayload(payload);
}

function providerErrorPayload(error: RuntimeRequestError) {
  const code = error.code === "provider_not_configured" ? "provider_not_configured" : "provider_failed";
  const diagnostic = safeProviderDiagnostics(error.diagnostics, code);
  return {
    error: error.code,
    reason: diagnostic.reason,
    provider: diagnostic.provider,
    model: diagnostic.model,
    status: diagnostic.status,
    retryable: diagnostic.retryable,
    ...(error.payload ? runtimeErrorPayload(error.payload) : {})
  };
}

function safeProviderDiagnostics(
  diagnostics: ProviderDiagnostics | undefined,
  code: "provider_not_configured" | "provider_failed"
): ProviderDiagnostics {
  return {
    provider: safeShortString(diagnostics?.provider),
    model: safeShortString(diagnostics?.model),
    status: diagnostics?.status,
    reason: diagnostics?.reason ?? (code === "provider_not_configured" ? "not_configured" : "unknown"),
    retryable: diagnostics?.retryable ?? false
  };
}

function safeShortString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").slice(0, 80);
}

function providerStatus(provider: ProviderAdapter) {
  if ("getStatus" in provider && typeof provider.getStatus === "function") {
    return (provider as ProviderRegistry).getStatus();
  }
  return {
    configured: true,
    primary: {
      provider: provider.id,
      model: provider.model,
      configured: true
    },
    fallbacks: []
  };
}

function databaseStatus(store: WorkspaceStore) {
  try {
    const stat = statSync(store.dbPath);
    return {
      ok: true,
      path: store.dbPath,
      sizeBytes: stat.size
    };
  } catch (error) {
    return {
      ok: false,
      path: store.dbPath,
      reason: error instanceof Error ? error.message : "unknown"
    };
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  await startServer();
}
