import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { Server as SocketServer } from "socket.io";
import { ClientEventRecordSchema, ResourceRefSchema, createId, nowIso, supportedLocales, type ArtifactRecord, type BackendEventRecord, type BackendRunRecord, type ClientEventRecord, type CollectionRecord, type CollectionSchema, type GatewayMcpConfigRecord, type JsonValue, type SupportedLocale } from "@samurai-agent/core-schemas";
import { builtinSurfaceRendererRegistryEntries } from "@samurai-agent/ui-protocol";
import { domainCommandInputSources, listActionCatalogEntries, listDomainCommandEntries, listDomainQueryEntries, pluginManifests, type DomainCommandInputSource } from "@samurai-agent/action-catalog";
import { proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import { parseDomainOperationInput, type DomainCommandId, type GeneratedSurfaceCreateInput, type GeneratedSurfaceReviseInput, type TrustedDomainContext } from "@samurai-agent/domain-operations";
import {
  createDefaultAgentBackendRegistry,
  createProviderRegistryFromEnv,
  generatedSurfaceCsp,
  safeGeneratedSurfaceAssetPath
} from "@samurai-agent/runtime";
import type { RunChatTurnResult } from "@samurai-agent/runtime";
import { createSurfaceRenderSpec, parseSurfaceOperation, type SurfaceOperation, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  WorkspaceServerError,
  WorkspaceFileStore,
  WorkspaceServerStore,
  WorkspaceLearningRunner,
  createInternalWorkspaceMaintenanceCaller,
  assertOpaqueId,
  canonicalJson,
  createVerifiedWorkspaceHumanCaller,
  loadWorkspaceServerConfig,
  readWorkspaceBundleV4Transport,
  resolveRequestWorkspaceId,
  verifyAccountSignature,
  type WorkspaceLearningScope,
  type WorkspaceKnowledgeReviewPort,
  type WorkspaceLearningSettings,
  type WorkspaceCompletionResourceKind,
  type WorkspaceCompletionAttestationPort,
  type WorkspaceCompletionReviewPort,
  type WorkspaceCompletionPolicyOperation,
  type WorkspaceCompletionScope,
  type WorkspaceCompletionSemanticCuratorPort,
  type WorkspaceCompletionCuratorService,
  type WorkspaceCompletionJobService,
  type WorkspaceCompletionService,
  type WorkspaceBundleV3Manifest,
  type WorkspaceBundleV4Manifest,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService,
  type WorkspaceServerConfig
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerCore, type WorkspaceServerCore } from "./core";
import { WorkspaceRealtimeGate, roomSocketRoom, workspaceSocketRoom } from "./realtime";
import { WorkspaceWorkerSupervisor } from "../workers/workspace-worker-supervisor";
import { createWorkspaceCompletionBackendReviewPort } from "../workers/workspace-completion-review-port";
import { createWorkspaceLearningBackendReviewPort } from "../workers/workspace-learning-review-port";
import { PostgresRuntimeExecutionWorker } from "../workers/postgres-runtime-execution-worker";
import { PostgresRuntimeCommandService, type PostgresRuntimeChatCompletionEvent } from "../adapters/runtime/postgres-runtime-chat";
import { runPostgresChatTurnThroughDomainOperation } from "../adapters/runtime/postgres-chat-domain-operation";
import { createPostgresChatSessionThroughDomainOperation } from "../adapters/runtime/postgres-session-domain-operation";
import { PostgresRuntimeClientEvents } from "../adapters/runtime/postgres-runtime-client-events";
import { PostgresRuntimeSettings } from "../adapters/runtime/postgres-runtime-settings";
import { PostgresRuntimeAutomation, type PostgresRuntimeAutomationExecutionResult } from "../adapters/runtime/postgres-runtime-automation";
import { PostgresKnowledgeWiki } from "../adapters/runtime/postgres-knowledge-wiki";
import { PostgresCollection } from "../adapters/runtime/postgres-collection";
import { PostgresKnowledgeMemory } from "../adapters/runtime/postgres-knowledge-memory";
import { PostgresKnowledgeSkill } from "../adapters/runtime/postgres-knowledge-skill";
import { PostgresArtifact } from "../adapters/runtime/postgres-artifact";
import { PostgresGeneratedSurface, type GeneratedSurfaceTargetCommandResult } from "../adapters/runtime/postgres-generated-surface";
import { PostgresGatewayDomainOperations } from "../adapters/runtime/postgres-gateway-domain-operation";
import { PostgresSkillDomainOperations } from "../adapters/runtime/postgres-skill-domain-operation";
import { PostgresGatewayMaintenanceWorker } from "../workers/postgres-gateway-maintenance-worker";
import { PostgresSkillOptimizationWorker } from "../workers/postgres-skill-optimization-worker";
import type { OAuthAccountAuthorizationPort, OAuthBrowserSessionPort } from "@samurai-agent/external-integration";
import {
  createPostgresExternalIntegrationRuntime,
  externalIntegrationRequestWorkspaceId,
  isPostgresExternalIntegrationPath
} from "../adapters/external/postgres-external-integration";
import { PostgresExternalAppIngressFactory } from "../adapters/external/postgres-external-app-ingress";
import { runPostgresExternalIntegrationContext } from "../adapters/external/postgres-external-integration-store";

const automationJobKinds = ["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"] as const;
const postgresTemporaryContextMaxBytes = 8 * 1024 * 1024;
const internalWorkspaceRecordTypes = new Set(["artifact_transaction"]);

interface AuthenticatedRequest extends Request {
  samurai?: {
    accountId: string;
    requestId: string;
    timestamp: string;
    signature: string;
    canonicalPayloadHash: string;
    publicKey: string;
    signedPayload: {
      method: string;
      path: string;
      workspaceId?: string;
      operationId?: string;
      requestId: string;
      timestamp: string;
      body: unknown;
    };
    workspaceId?: string;
  };
}

export interface WorkspaceServerHttp {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketServer;
  config: WorkspaceServerConfig;
  workerSupervisor: WorkspaceWorkerSupervisor;
  close(): Promise<void>;
}

/** The host may register narrow review cassettes. No provider client or
 * credential is constructed here, so the Server never gains an implicit
 * external-Agent connection. */
export interface WorkspaceServerHttpOptions {
  reviewPorts?: readonly WorkspaceKnowledgeReviewPort[];
  /** Optional host cassette for the explicitly requested semantic dry-run.
   * It is never created from an HTTP request or enabled by default. */
  semanticCuratorPort?: WorkspaceCompletionSemanticCuratorPort;
  /** Optional process-owned cassette for completion review jobs. When omitted,
   * standard composition uses the host-owned Samurai Native backend without
   * passing DB, file, or Agent-worktree capabilities to it. */
  completionReviewPort?: WorkspaceCompletionReviewPort;
  /** Host-only verification cassette. HTTP cannot select this Port or submit
   * a raw attestation result. */
  attestationPort?: WorkspaceCompletionAttestationPort;
  /** Optional host-owned backend registry. It is shared by the HTTP Runtime
   * entry and never receives database or filesystem capabilities. */
  backendRegistry?: ReturnType<typeof createDefaultAgentBackendRegistry>;
  /** Optional host-owned Samurai login/session adapters for OAuth browser
   * approval. Without these ports the external HTTP surface stays mounted but
   * browser authorization fails closed. */
  externalIntegration?: {
    browserSession?: OAuthBrowserSessionPort;
    browserAuthorization?: OAuthAccountAuthorizationPort;
    allowedOrigins?: readonly string[];
    trustedProxy?: boolean;
    hookRelayCommand?: string;
  };
}

export async function createWorkspaceServerHttp(
  config = loadWorkspaceServerConfig(),
  options: WorkspaceServerHttpOptions = {}
): Promise<WorkspaceServerHttp> {
  const core = await createWorkspaceServerCore(config, { attestationPort: options.attestationPort });
  const { store, files, bundles, completionBundles, commands, learning, completion, completionJobs, curator, completionMigrations, maintenance } = core;
  const provider = createProviderRegistryFromEnv();
  const backendRegistry = options.backendRegistry ?? createDefaultAgentBackendRegistry(
    provider,
    process.env,
    { repoRoot: process.cwd() }
  );
  const completionReviewPort = options.completionReviewPort ?? createWorkspaceCompletionBackendReviewPort(backendRegistry);
  const learningReviewPort = options.reviewPorts === undefined
    ? createWorkspaceLearningBackendReviewPort(backendRegistry)
    : undefined;
  let knowledgeWiki: PostgresKnowledgeWiki;
  let collections: PostgresCollection;
  let learningRunner!: WorkspaceLearningRunner;
  const automation = new PostgresRuntimeAutomation({
    database: core.database,
    store,
    backendRegistry,
    agentWorktreeRoot: path.join(config.storageRoot, "agent-worktrees"),
    coreWorkspaceRoot: path.join(config.storageRoot, "workspaces"),
    reindexWiki: (context, roomId) => knowledgeWiki.reindex(context, roomId),
    runMemoryReview: (context, input) => learningRunner.runCycle(context, { roomId: input.roomId }, input.signal).then((jobs) => learningExecutionResult("memory_review", jobs)),
    runLearningEvaluation: (context, input) => runPostgresAutomationEvaluation(completion, completionJobs, context, input),
    runSkillCurator: (context, input) => runPostgresAutomationCurator(completion, completionJobs, curator, context, input),
    runCollectionTrigger: async (context, input) => {
      const target = collectionTriggerTargetFromJob(input.job.delivery_target);
      if (!target) return { status: "blocked", summary: "Collection trigger payload is invalid.", errorCode: "automation_collection_trigger_invalid" };
      const result = await collections.runAction(context, target.roomId, {
        id: `collection_trigger_${input.job.id}`,
        kind: "collection.action.run",
        collection_id: target.collectionId,
        action_id: target.actionId,
        record_id: target.recordId,
        payload: target.payload
      });
      return { status: "completed", summary: `Executed Collection trigger ${target.collectionId}/${target.actionId}.` };
    },
    maxRuns: 10
  });
  knowledgeWiki = new PostgresKnowledgeWiki(completion, commands);
  collections = new PostgresCollection(commands, files, {
    enqueue: async (context, input) => {
      const targetPayload: Record<string, JsonValue> = {
        channel: "collection_trigger",
        room_id: input.roomId,
        collection_id: input.collectionId,
        record_id: input.recordId,
        event: input.event,
        trigger_id: stringValue(input.trigger, "id") ?? stringValue(input.trigger, "trigger_id") ?? "collection_trigger",
        action_id: stringValue(input.trigger, "action_id") ?? stringValue(input.trigger, "action") ?? "",
        action_kind: stringValue(input.trigger, "kind") ?? stringValue(input.trigger, "action_kind") ?? "custom_instruction",
        record: input.record as unknown as JsonValue,
        ...(input.patch ? { patch: input.patch as unknown as JsonValue } : {})
      };
      const actionId = String(targetPayload.action_id ?? "").trim();
      if (!actionId) throw new WorkspaceServerError("collection_trigger_action_missing", 422);
      await automation.createJob({ ...context, operationId: `collection_trigger_${context.operationId}_${targetPayload.trigger_id}` }, {
        roomId: input.roomId,
        title: `Collection trigger ${input.collectionId}/${actionId}`,
        kind: "custom_instruction",
        schedule: "once",
        targetInstruction: "Execute the configured Collection trigger action through the Room-scoped Core.",
        deliveryTarget: targetPayload,
        nextRunAt: nowIso(),
        maxAttempts: 3
      });
    }
  });
  const knowledgeMemory = new PostgresKnowledgeMemory(completion, commands);
  const knowledgeSkill = new PostgresKnowledgeSkill(completion, commands);
  const runtimeSettings = new PostgresRuntimeSettings(core.database, store);
  const artifacts = new PostgresArtifact(commands, files, (context, input) => commands.ingestCompletionActivity(context, input));
  const generatedSurfaces = new PostgresGeneratedSurface(
    commands,
    files,
    createPostgresGeneratedSurfaceTargetCommand({ commands, collections, artifacts })
  );
  const clientEvents = new PostgresRuntimeClientEvents(core.database, store);
  const externalIngress = new PostgresExternalAppIngressFactory({
    files,
    commands,
    completion,
    knowledgeWiki,
    knowledgeMemory,
    collections,
    artifacts
  });
  const skillOptimizationHostComplete = async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
    const content = input.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n").trim();
    const output = await provider.generate({
      envelope: {
        id: createId("envelope"),
        source: "web",
        actor_identity: "owner",
        session_key: input.sessionId ? `skill-optimization:${input.sessionId}` : "skill-optimization:worker",
        user_intent: content || "Generate a reviewable Skill optimization candidate.",
        attachments: [],
        input_locale: "ja",
        output_locale: "ja",
        metadata: {},
        received_at: nowIso()
      },
      activeMemory: [],
      knowledgeWiki: [],
      collectionNotes: [],
      selectedSkills: [],
      sessionSearch: [],
      availableTools: [],
      recentMessages: [],
      temporaryContext: []
    });
    return { content: output.content };
  };
  const externalIntegration = await createPostgresExternalIntegrationRuntime({
    database: core.database,
    commands,
    ingress: externalIngress,
    config,
    ...(options.externalIntegration?.browserSession ? { browserSession: options.externalIntegration.browserSession } : {}),
    ...(options.externalIntegration?.browserAuthorization ? { browserAuthorization: options.externalIntegration.browserAuthorization } : {}),
    ...(options.externalIntegration?.allowedOrigins ? { allowedOrigins: options.externalIntegration.allowedOrigins } : {}),
    ...(options.externalIntegration?.trustedProxy !== undefined ? { trustedProxy: options.externalIntegration.trustedProxy } : {}),
    ...(options.externalIntegration?.hookRelayCommand ? { hookRelayCommand: options.externalIntegration.hookRelayCommand } : {})
  });
  const resolveWorkerContexts = async (signal: AbortSignal) => {
    if (signal.aborted) return { state: "disabled" as const, reason: "aborted_before_identity_resolution" };
    if (config.mode === "self_host") {
      if (!config.selfHostWorkspaceId || !config.initialAdminId) {
        return { state: "disabled" as const, reason: "self_host_worker_identity_unconfigured" };
      }
      const identity = await maintenance.getIdentity({ workspaceId: config.selfHostWorkspaceId, accountId: config.initialAdminId });
      return identity.accountId
        ? { state: "enabled" as const, contexts: [{ workspaceId: config.selfHostWorkspaceId, accountId: identity.accountId }] }
        : { state: "disabled" as const, reason: "maintenance_identity_unconfigured" };
    }
    const identities = await maintenance.listConfiguredIdentities();
    return {
      state: "enabled" as const,
      contexts: identities.map((identity) => ({ workspaceId: identity.workspaceId, accountId: identity.accountId }))
    };
  };
  const app = express();
  const httpServer = createServer(app);
  const corsOrigins = config.corsOrigins;
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  });
  app.use(requestRateGuard({ windowMs: 60_000, limit: config.publicNetwork ? 180 : 600 }));
  app.use(cors({ origin: corsOrigins.length > 0 ? [...corsOrigins] : false, credentials: false }));
  app.use(express.json({ limit: "36mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use((req, res, next) => {
    if (!isPostgresExternalIntegrationPath(req.path)) {
      next();
      return;
    }
    const workspaceId = externalIntegrationRequestWorkspaceId({
      query: req.query as Record<string, unknown>,
      body: req.body,
      headers: req.headers as Record<string, unknown>
    }, config);
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    const onClosed = () => {
      if (!req.complete) controller.abort();
    };
    req.once("aborted", onAborted);
    req.once("close", onClosed);
    const request = {
      method: req.method,
      url: `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`,
      headers: externalRequestHeaders(req),
      body: req.body,
      remoteAddress: req.socket.remoteAddress,
      signal: controller.signal
    };
    void runPostgresExternalIntegrationContext({ ...(workspaceId ? { workspaceId } : {}) }, () => externalIntegration.handler(request))
      .then((response) => {
        if (res.headersSent) return;
        for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
        res.status(response.status).send(response.body);
      })
      .catch(next)
      .finally(() => {
        req.off("aborted", onAborted);
        req.off("close", onClosed);
      });
  });
  const io = new SocketServer(httpServer, { cors: { origin: corsOrigins.length > 0 ? [...corsOrigins] : false, credentials: false } });
  const realtimeGate = new WorkspaceRealtimeGate();
  learningRunner = new WorkspaceLearningRunner(learning, options.reviewPorts ?? (learningReviewPort ? [learningReviewPort] : []), {
    onSettled: async ({ context, job }) => {
      await realtimeGate.run(context.workspaceId, async () => {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: job.roomId, kind: "learning.job.updated" });
      });
    }
  });
  const workerSupervisor = new WorkspaceWorkerSupervisor({
    learningRunner,
    maintenance,
    executionJobWorker: new PostgresRuntimeExecutionWorker(core.database),
    gatewayMaintenance: new PostgresGatewayMaintenanceWorker(core.database),
    skillOptimizationWorker: new PostgresSkillOptimizationWorker({
      database: core.database,
      completion,
      repoRoot: process.cwd(),
      hostComplete: skillOptimizationHostComplete
    }),
    automationScheduler: automation,
    clientEventQueue: {
      runTick: async (context, { signal }) => {
        if (signal.aborted) return;
        await clientEvents.expire({
          ...context,
          operationId: `client_event_expire_${context.operationId}`
        });
      }
    },
    ...(completionReviewPort ? { reviewPort: completionReviewPort } : {}),
    ...(options.semanticCuratorPort ? { semanticPort: options.semanticCuratorPort } : {}),
    resolveContext: async (signal) => {
      const resolved = await resolveWorkerContexts(signal);
      if (resolved.state === "disabled") return resolved;
      const firstContext = resolved.contexts[0];
      return firstContext
        ? { state: "enabled", context: firstContext }
        : { state: "disabled", reason: "worker_contexts_unconfigured" };
    },
    resolveContexts: resolveWorkerContexts,
    retryDisabledContext: config.mode === "hosted"
  });

  const authenticate = accountAuthenticator(store);
  const authenticateWorkspace = workspaceAuthenticator(store, config);
  // An invitee is authenticated but not a Workspace member yet. The token is
  // the sole authorization for this one route; all other routes require a
  // current membership before reaching the store.
  const authenticateInvitationAcceptance = workspaceAuthenticator(store, config, { requireMembership: false });

  const gatewayOperationsFor = (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">) => new PostgresGatewayDomainOperations({
    database: core.database,
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    // Gateway pairing is transport admission only. Until a verified Room
    // participant is resolved, the shared Core deliberately stops before
    // Session/Chat/Sandbox execution.
    core: {
      ensureSession: async () => { throw new WorkspaceServerError("gateway_participant_authentication_required", 403); },
      runChat: async () => { throw new WorkspaceServerError("gateway_participant_authentication_required", 403); }
    },
    emit: async (name) => {
      await emitAuthorizedWorkspaceEvent(io, store, { workspaceId: context.workspaceId, kind: name });
    },
    notFoundError: (message) => new WorkspaceServerError(message, 404),
    conflictError: (message) => new WorkspaceServerError(message, 409),
    errorMessage: (error) => publicError(error).error
  });

  const gatewayContextFor = (req: Request, inputSource: TrustedDomainContext["inputSource"], roomId?: string): TrustedDomainContext => {
    const context = workspaceContext(req);
    const signed = authenticated(req);
    const operationId = req.header("x-samurai-operation-id")?.trim() || req.header("idempotency-key")?.trim();
    if (!operationId) throw new WorkspaceServerError("workspace_operation_id_required", 400);
    return {
      inputSource,
      workspaceId: context.workspaceId,
      actorId: context.accountId,
      correlationId: signed.requestId,
      idempotencyKey: operationId,
      ...(roomId ? { roomId } : {})
    };
  };

  const skillOperationsFor = (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId?: string) => new PostgresSkillDomainOperations({
    database: core.database,
    completion,
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    repoRoot: process.cwd(),
    hostComplete: skillOptimizationHostComplete,
    autoStartOptimization: false,
    ...(roomId ? { roomId } : {})
  });

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const workerStatus = workerSupervisor.status();
    let database: { ok: true } | { ok: false; reason: string };
    try {
      await core.database.ping();
      database = { ok: true };
    } catch (error) {
      database = { ok: false, reason: publicError(error).error };
    }
    res.json({
      ok: database.ok,
      storage: "postgresql",
      db: database,
      mode: config.mode,
      ...(config.mode === "self_host" ? { workspace_id: config.selfHostWorkspaceId } : {}),
      rls: "required",
      public_network: config.publicNetwork,
      worker_supervisor: {
        state: workerStatus.state,
        enabled: workerStatus.enabled,
        consecutive_failures: workerStatus.consecutiveFailures,
        successful_ticks: workerStatus.successfulTicks,
        ...(workerStatus.disabledReason ? { disabled_reason: workerStatus.disabledReason } : {}),
        ...(workerStatus.stopReason ? { stop_reason: workerStatus.stopReason } : {}),
        ...(workerStatus.lastTickAt ? { last_tick_at: workerStatus.lastTickAt } : {}),
        ...(workerStatus.lastSuccessfulTickAt ? { last_successful_tick_at: workerStatus.lastSuccessfulTickAt } : {}),
        ...(workerStatus.workspaceCount !== undefined ? { workspace_count: workerStatus.workspaceCount } : {}),
        ...(workerStatus.nextRetryAt ? { next_retry_at: workerStatus.nextRetryAt } : {}),
        ...(workerStatus.lastError?.code ? { last_error_code: workerStatus.lastError.code } : {})
      }
    });
  }));

  app.post("/api/account/register", asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const accountId = stringField(body, "account_id");
    const publicKey = stringField(body, "public_key");
    const displayName = stringField(body, "display_name");
    const signed = signedHeaders(req);
    if (signed.accountId !== accountId) throw new WorkspaceServerError("account_signature_payload_mismatch", 401);
    verifyAccountSignature({
      signed,
      publicKey,
      payload: { method: req.method, path: req.path, requestId: signed.requestId, timestamp: signed.timestamp, body }
    });
    const account = await commands.registerAccount({ id: accountId, publicKey, displayName });
    res.status(201).json({ account });
  }));

  app.get("/api/account/workspaces", authenticate, asyncRoute(async (req, res) => {
    const accountId = authenticated(req).accountId;
    res.json({ workspaces: await store.listWorkspaces(accountId) });
  }));

  app.post("/api/workspaces", authenticate, asyncRoute(async (req, res) => {
    if (config.mode !== "hosted") throw new WorkspaceServerError("self_host_accepts_one_workspace", 409);
    const body = objectBody(req.body);
    const workspace = await commands.createWorkspace({
      id: stringField(body, "workspace_id"),
      name: stringField(body, "name"),
      ownerAccountId: authenticated(req).accountId,
      operationId: stringHeader(req, "x-samurai-operation-id"),
      hostingMode: "hosted",
      databasePlacement: "shared"
    });
    res.status(201).json(workspace);
  }));

  /** Target-side import: it receives a verified portable Bundle, never a source server path. */
  app.post("/api/workspaces/imports", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const targetWorkspaceId = stringField(body, "target_workspace_id");
    const imported = await commands.importWorkspaceBundleTransport({
      accountId: authenticated(req).accountId,
      operationId: stringHeader(req, "x-samurai-operation-id")
    }, {
      transport: body.bundle,
      targetWorkspaceId,
      ...(optionalStringField(body, "target_workspace_name") ? { targetWorkspaceName: optionalStringField(body, "target_workspace_name") } : {})
    });
    res.status(201).json({ workspace_id: imported.workspaceId, manifest: imported.manifest, ...(imported.receipt ? { receipt: imported.receipt } : {}) });
  }));

  /** Chunked target import avoids loading a whole Workspace Bundle into RAM. */
  app.post("/api/workspaces/imports/staging", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const operationId = stringHeader(req, "x-samurai-operation-id");
    await commands.stageWorkspaceBundle({ accountId: authenticated(req).accountId, operationId }, {
      targetWorkspaceId: stringField(body, "target_workspace_id"),
      ...(optionalStringField(body, "target_workspace_name") ? { targetWorkspaceName: optionalStringField(body, "target_workspace_name") } : {}),
      manifest: workspaceBundleManifestField(body, "manifest")
    });
    res.status(201).end();
  }));

  app.put("/api/workspaces/imports/staging/:operationId/entries/{*entryPath}", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const operationId = pathParam(req, "operationId");
    if (operationId !== stringHeader(req, "x-samurai-operation-id")) throw new WorkspaceServerError("workspace_operation_id_mismatch", 400);
    const content = Buffer.from(base64Field(body, "content_base64"), "base64");
    await commands.writeWorkspaceBundleEntry(
      { accountId: authenticated(req).accountId, operationId },
      wildcardParam(req.params.entryPath),
      content
    );
    res.status(204).end();
  }));

  app.post("/api/workspaces/imports/staging/:operationId/complete", authenticate, asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    if (operationId !== stringHeader(req, "x-samurai-operation-id")) throw new WorkspaceServerError("workspace_operation_id_mismatch", 400);
    const imported = await commands.completeWorkspaceBundleImport({ accountId: authenticated(req).accountId, operationId });
    res.status(201).json({ workspace_id: imported.workspaceId, manifest: imported.manifest, ...(imported.receipt ? { receipt: imported.receipt } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ workspace: await store.getWorkspace(workspaceContext(req)) });
  }));

  app.get("/api/workspaces/:workspaceId/rooms", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ rooms: await store.listRooms(workspaceContext(req)) });
  }));

  app.get("/api/workspaces/:workspaceId/agents", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ agents: await store.listAgents(workspaceContext(req)) });
  }));

  app.get("/api/workspaces/:workspaceId/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await runtimeSettings.get(workspaceContext(req)));
  }));

  app.patch("/api/workspaces/:workspaceId/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await runtimeSettings.patch(context, objectBody(req.body)));
  }));

  app.get("/api/workspaces/:workspaceId/agent-backends", authenticateWorkspace, asyncRoute(async (_req, res) => {
    res.json(backendRegistry.statuses());
  }));

  // PostgreSQL Gateway control-plane surface. Every mutation is bound through
  // the formal Gateway Domain Operation, while list/detail queries use the
  // same RLS-scoped adapter and never touch the legacy compatibility Store.
  app.get("/api/workspaces/:workspaceId/gateway/pairings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const gateway = gatewayOperationsFor(workspaceContext(req));
    res.json(await gateway.adapter.listPairings({
      ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
      ...(queryString(req, "channel") ? { channel: queryString(req, "channel") } : {}),
      ...(queryString(req, "source_identity") ? { sourceIdentity: queryString(req, "source_identity") } : {}),
      ...(queryString(req, "session_key") ? { sessionKey: queryString(req, "session_key") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/pairing-policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).listPairingPolicies());
  }));
  app.get("/api/workspaces/:workspaceId/gateway/pairing-policies/:channel", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).getPairingPolicy(pathParam(req, "channel") as never));
  }));
  app.post("/api/workspaces/:workspaceId/gateway/pairing-policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.pairing_policy.save", objectBody(req.body));
    res.status(201).json(result.value);
  }));
  app.get("/api/workspaces/:workspaceId/gateway/routing-policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).listRoutingPolicies());
  }));
  app.get("/api/workspaces/:workspaceId/gateway/routing-policies/:channel", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).getRoutingPolicy(pathParam(req, "channel") as never));
  }));
  app.post("/api/workspaces/:workspaceId/gateway/routing-policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.routing_policy.save", objectBody(req.body));
    res.status(201).json(result.value);
  }));
  app.post("/api/workspaces/:workspaceId/gateway/pairings/expire", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.pairing.expire", objectBody(req.body));
    res.json(result.value);
  }));
  for (const action of ["approve", "reject", "rotate", "revoke"] as const) {
    app.post(`/api/workspaces/:workspaceId/gateway/pairings/:pairingId/${action}`, authenticateWorkspace, asyncRoute(async (req, res) => {
      const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), `gateway.pairing.${action}`, { pairing_id: pathParam(req, "pairingId") });
      res.json(result.value);
    }));
  }
  app.get("/api/workspaces/:workspaceId/gateway/inbound", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).adapter.listInboundMessages({
      ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
      ...(queryString(req, "channel") ? { channel: queryString(req, "channel") } : {}),
      ...(queryString(req, "source_identity") ? { sourceIdentity: queryString(req, "source_identity") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/boundary-policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).adapter.listBoundaryPolicies({
      ...(queryString(req, "source_channel") ? { sourceChannel: queryString(req, "source_channel") } : {}),
      ...(queryString(req, "session_key") ? { sessionKey: queryString(req, "session_key") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/mcp-configs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const enabled = queryString(req, "enabled");
    res.json((await gatewayOperationsFor(workspaceContext(req)).adapter.listMcpConfigs({
      ...(enabled === "true" || enabled === "false" ? { enabled: enabled === "true" } : {}),
      ...(queryString(req, "server_name") ? { serverName: queryString(req, "server_name") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    })).map(summarizePostgresGatewayMcpConfig));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/mcp-configs/:configId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const config = await gatewayOperationsFor(workspaceContext(req)).adapter.getMcpConfig(pathParam(req, "configId"));
    if (!config) throw new WorkspaceServerError("gateway_mcp_config_not_found", 404);
    res.json(summarizePostgresGatewayMcpConfig(config));
  }));
  app.post("/api/workspaces/:workspaceId/gateway/mcp-configs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.mcp_config.save", objectBody(req.body));
    res.status(201).json(summarizePostgresGatewayMcpConfig(result.value as never));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/concurrency-locks", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).adapter.listConcurrencyLocks({
      ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.post("/api/workspaces/:workspaceId/gateway/concurrency-locks/expire", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.concurrency_lock.expire", objectBody(req.body));
    res.json(result.value);
  }));
  app.get("/api/workspaces/:workspaceId/gateway/sandbox-instances", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).adapter.listSandboxInstances({
      ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
      ...(queryString(req, "scope") ? { scope: queryString(req, "scope") } : {}),
      ...(queryString(req, "backend") ? { backend: queryString(req, "backend") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.get("/api/workspaces/:workspaceId/gateway/sandbox-workspace-syncs", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await gatewayOperationsFor(workspaceContext(req)).adapter.listSandboxWorkspaceSyncs({
      ...(queryString(req, "instance_id") ? { instanceId: queryString(req, "instance_id") } : {}),
      ...(queryString(req, "instance_key") ? { instanceKey: queryString(req, "instance_key") } : {}),
      ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
      ...(queryString(req, "direction") ? { direction: queryString(req, "direction") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  for (const action of ["recreate", "delete"] as const) {
    app.post(`/api/workspaces/:workspaceId/gateway/sandbox-instances/:sandboxId/${action}`, authenticateWorkspace, asyncRoute(async (req, res) => {
      const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), `gateway.sandbox.${action}`, { sandbox_id: pathParam(req, "sandboxId") });
      res.json(result.value);
    }));
  }
  app.post("/api/workspaces/:workspaceId/gateway/sandbox-instances/:sandboxId/sync", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.sandbox.sync", {
      sandbox_id: pathParam(req, "sandboxId"),
      ...(body.direction === undefined ? {} : { direction: body.direction }),
      dry_run: body.dry_run === undefined ? true : booleanField(body, "dry_run")
    });
    res.json(result.value);
  }));
  app.post("/api/workspaces/:workspaceId/gateway/repair", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await gatewayOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "gateway.state.repair", {
      dry_run: body.dry_run === undefined ? true : booleanField(body, "dry_run")
    });
    res.json(result.value);
  }));
  app.post("/api/workspaces/:workspaceId/gateway/inbound", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const result = await gatewayOperationsFor(context).execute(gatewayContextFor(req, "gateway_inbound"), "gateway.inbound.route", objectBody(req.body));
    res.status(202).json(result.value);
  }));

  // Skill Optimization uses the same formal operations as the Runtime. The
  // body remains in Completion's recoverable file transaction; only durable
  // run/candidate/evaluation state is read from the PostgreSQL adapter.
  app.get("/api/workspaces/:workspaceId/skill-optimizations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const roomId = queryString(req, "room_id") || undefined;
    res.json(await skillOperationsFor(context, roomId).adapter.listRuns({
      ...(queryString(req, "skill_id") ? { skillId: queryString(req, "skill_id") } : {}),
      ...(roomId ? { roomId } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));
  app.get("/api/workspaces/:workspaceId/skill-optimizations/:runId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const detail = await skillOperationsFor(workspaceContext(req)).adapter.detail(pathParam(req, "runId"));
    if (!detail) throw new WorkspaceServerError("skill_optimization_run_not_found", 404);
    res.json(detail);
  }));
  app.post("/api/workspaces/:workspaceId/skills/:skillId/optimizations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await skillOperationsFor(workspaceContext(req), optionalStringField(body, "room_id") || undefined).execute(
      gatewayContextFor(req, "runtime_api", optionalStringField(body, "room_id") || undefined),
      "skill.optimization.start",
      {
        skill_id: pathParam(req, "skillId"),
        ...(optionalStringField(body, "objective") ? { objective: optionalStringField(body, "objective") } : {}),
        ...(body.golden_examples === undefined ? {} : { golden_examples: body.golden_examples }),
        ...(body.synthetic_examples === undefined ? {} : { synthetic_examples: body.synthetic_examples })
      }
    );
    res.status(202).json(result.value);
  }));
  app.post("/api/workspaces/:workspaceId/skill-optimizations/:runId/cancel", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await skillOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "skill.optimization.cancel", { optimization_run_id: pathParam(req, "runId") });
    res.json(result.value);
  }));
  for (const action of ["promote", "reject"] as const) {
    app.post(`/api/workspaces/:workspaceId/skill-optimizations/:runId/${action}`, authenticateWorkspace, asyncRoute(async (req, res) => {
      const body = objectBody(req.body);
      const candidateId = optionalStringField(body, "candidate_id") || queryString(req, "candidate_id");
      if (!candidateId) throw new WorkspaceServerError("skill_optimization_candidate_id_required", 400);
      const result = await skillOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), `skill.optimization.${action}`, {
        optimization_run_id: pathParam(req, "runId"), candidate_id: candidateId
      });
      res.json(result.value);
    }));
  }
  app.post("/api/workspaces/:workspaceId/skill-optimizations/:runId/rollback", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await skillOperationsFor(workspaceContext(req)).execute(gatewayContextFor(req, "runtime_api"), "skill.optimization.rollback", {
      ...(optionalStringField(body, "promotion_id") ? { promotion_id: optionalStringField(body, "promotion_id") } : {}),
      ...(optionalStringField(body, "snapshot_id") ? { snapshot_id: optionalStringField(body, "snapshot_id") } : {})
    });
    res.json(result.value);
  }));

  app.get("/api/workspaces/:workspaceId/surface/contract", authenticateWorkspace, asyncRoute(async (req, res) => {
    const source = queryString(req, "source");
    if (source && !domainCommandInputSources.includes(source as DomainCommandInputSource)) {
      throw new WorkspaceServerError("invalid_domain_command_source", 400);
    }
    const renderers = [...builtinSurfaceRendererRegistryEntries];
    res.json({
      protocol_version: "1",
      renderers,
      render_kinds: [...new Set(renderers.map((renderer) => renderer.kind))],
      commands: listDomainCommandEntries(source as DomainCommandInputSource | undefined),
      queries: listDomainQueryEntries(source as DomainCommandInputSource | undefined),
      input_sources: domainCommandInputSources
    });
  }));
  app.get("/api/workspaces/:workspaceId/surface/renderers", authenticateWorkspace, asyncRoute(async (_req, res) => {
    res.json({ renderers: [...builtinSurfaceRendererRegistryEntries] });
  }));

  app.get("/api/workspaces/:workspaceId/action-catalog", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ actions: listActionCatalogEntries(queryString(req, "category")), plugins: pluginManifests.map((plugin) => ({ id: plugin.id, name: plugin.name, version: plugin.version, action_ids: plugin.actions.map((action) => action.id) })) });
  }));
  app.get("/api/workspaces/:workspaceId/capabilities", authenticateWorkspace, asyncRoute(async (_req, res) => {
    res.json({ capabilities: [proposalCapabilityManifest] });
  }));
  app.get("/api/workspaces/:workspaceId/capabilities/:capabilityId", authenticateWorkspace, asyncRoute(async (req, res) => {
    if (pathParam(req, "capabilityId") !== proposalCapabilityManifest.id) throw new WorkspaceServerError("capability_not_found", 404);
    res.json(proposalCapabilityManifest);
  }));
  app.get("/api/workspaces/:workspaceId/domain/commands", authenticateWorkspace, asyncRoute(async (req, res) => {
    const source = queryString(req, "source");
    if (source && !domainCommandInputSources.includes(source as DomainCommandInputSource)) throw new WorkspaceServerError("invalid_domain_command_source", 400);
    res.json({ commands: listDomainCommandEntries(source as DomainCommandInputSource | undefined), input_sources: domainCommandInputSources });
  }));
  app.get("/api/workspaces/:workspaceId/domain/queries", authenticateWorkspace, asyncRoute(async (req, res) => {
    const source = queryString(req, "source");
    if (source && !domainCommandInputSources.includes(source as DomainCommandInputSource)) throw new WorkspaceServerError("invalid_domain_query_source", 400);
    res.json({ queries: listDomainQueryEntries(source as DomainCommandInputSource | undefined), input_sources: domainCommandInputSources });
  }));

  // Room-scoped Runtime entry. The old unscoped chat routes are not mounted in
  // this PostgreSQL process; every request below is signed and passes through
  // the same Workspace/Room RLS context as the other Server operations.
  app.get("/api/workspaces/:workspaceId/chat/sessions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listSessions());
  }));

  app.post("/api/workspaces/:workspaceId/chat/sessions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory);
    const input = {
      roomId: stringField(body, "room_id"),
      ...(optionalStringField(body, "title") ? { title: optionalStringField(body, "title") } : {}),
      ...(body.ui_locale === undefined ? {} : { uiLocale: supportedLocaleField(body, "ui_locale") }),
      ...(body.output_locale === undefined ? {} : { outputLocale: supportedLocaleField(body, "output_locale") })
    };
    const session = await createPostgresChatSessionThroughDomainOperation(runtimeCommands, {
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operationId: context.operationId,
      input: {
        room_id: input.roomId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.uiLocale ? { ui_locale: input.uiLocale } : {}),
        ...(input.outputLocale ? { output_locale: input.outputLocale } : {})
      }
    });
    res.status(201).json(session);
  }));

  app.post("/api/workspaces/:workspaceId/chat/messages", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const roomId = stringField(body, "room_id");
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    const session = await createPostgresChatSessionThroughDomainOperation(runtimeCommands, {
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operationId: context.operationId,
      input: {
        room_id: roomId,
        ...(optionalStringField(body, "title") ? { title: optionalStringField(body, "title") } : {}),
        ...(body.ui_locale === undefined ? {} : { ui_locale: supportedLocaleField(body, "ui_locale") }),
        ...(body.output_locale === undefined ? {} : { output_locale: supportedLocaleField(body, "output_locale") })
      }
    });
    const result = await runPostgresChatTurnThroughDomainOperation(runtimeCommands, {
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      sessionId: session.id,
      idempotencyKey: context.operationId,
      input: {
        content: stringField(body, "content"),
        ...(optionalStringField(body, "agent_id") ? { agent_id: optionalStringField(body, "agent_id") } : {}),
        ...(optionalStringField(body, "backend_id") ? { backend_id: optionalStringField(body, "backend_id") } : {}),
        ...(body.input_locale === undefined ? {} : { input_locale: supportedLocaleField(body, "input_locale") }),
        ...(body.output_locale === undefined ? {} : { output_locale: supportedLocaleField(body, "output_locale") }),
        ...(body.metadata === undefined ? {} : { metadata: jsonObjectField(body, "metadata") }),
        ...(body.attachments === undefined ? {} : { attachments: resourceRefsField(body, "attachments") }),
        ...(body.temporary_context === undefined ? {} : { temporary_context: temporaryContextField(body, "temporary_context") })
      }
    });
    const renderSpec = postgresChatRenderSpec(result);
    res.status(201).json({ result, render_spec: renderSpec, render_specs: [renderSpec] });
  }));

  app.get("/api/workspaces/:workspaceId/chat/sessions/:sessionId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const detail = await runtimeCommands.getSessionDetail(pathParam(req, "sessionId"));
    if (!detail) throw new WorkspaceServerError("runtime_session_not_found", 404);
    res.json(detail);
  }));

  /**
   * Compatibility read model for clients that need a durable transcript.
   * The transcript is projected from PostgreSQL runtime records; it never
   * opens a local Workspace database or exposes a second persistence path.
   */
  app.get("/api/workspaces/:workspaceId/chat/sessions/:sessionId/transcript", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const detail = await runtimeCommands.getSessionDetail(pathParam(req, "sessionId"));
    if (!detail) throw new WorkspaceServerError("runtime_session_not_found", 404);
    res.json({
      session: detail.session,
      messages: detail.messages,
      message_presentations: detail.messagePresentations,
      operations: detail.operations,
      policy_decisions: [],
      audit_records: detail.auditRecords,
      artifacts: detail.artifacts,
      backend_runs: detail.backendRuns,
      backend_events: detail.backendEvents,
      tool_runs: detail.toolRuns,
      workspace_changes: detail.workspaceChanges,
      change_history: [],
      run_history: []
    });
  }));

  app.get("/api/workspaces/:workspaceId/chat/sessions/:sessionId/resume-state", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const detail = await runtimeCommands.getSessionDetail(pathParam(req, "sessionId"));
    if (!detail) throw new WorkspaceServerError("runtime_session_not_found", 404);
    const runs = [...detail.backendRuns].sort(comparePostgresBackendRunDesc);
    const latestRun = runs[0];
    const resumableRuns = runs.filter((run) => run.status === "waiting_for_backend_input");
    const eventsByRunId = new Map<string, BackendEventRecord[]>();
    for (const event of detail.backendEvents) {
      const events = eventsByRunId.get(event.run_id) ?? [];
      events.push(event);
      eventsByRunId.set(event.run_id, events);
    }
    const summarize = (run: BackendRunRecord) => summarizePostgresRunForResume(run, eventsByRunId.get(run.id) ?? []);
    res.json({
      session: detail.session,
      can_resume: resumableRuns.length > 0,
      next_required_action: resumableRuns.length > 0 ? "submit_backend_native_input" : "none",
      resume_api: `/api/workspaces/${encodeURIComponent(workspaceContext(req).workspaceId)}/chat/runs/:runId/resume`,
      latest_run: latestRun ? summarize(latestRun) : undefined,
      resumable_runs: resumableRuns.map(summarize),
      transcript_counts: {
        messages: detail.messages.length,
        operations: detail.operations.length,
        backend_runs: detail.backendRuns.length,
        backend_events: detail.backendEvents.length,
        tool_runs: detail.toolRuns.length,
        workspace_changes: detail.workspaceChanges.length,
        artifacts: detail.artifacts.length,
        policy_decisions: 0,
        audit_records: detail.auditRecords.length
      }
    });
  }));

  app.post("/api/workspaces/:workspaceId/chat/sessions/:sessionId/messages", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const idempotencyKey = stringHeader(req, "idempotency-key");
    const completionContext: WorkspaceRequestContext = {
      ...context,
      operationId: `runtime_chat_activity_${createHash("sha256").update(`${context.workspaceId}|${idempotencyKey}`).digest("hex").slice(0, 48)}`
    };
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, completionContext, event));
    const metadata = body.metadata === undefined ? undefined : jsonObjectField(body, "metadata");
    const result = await runPostgresChatTurnThroughDomainOperation(runtimeCommands, {
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      sessionId: pathParam(req, "sessionId"),
      idempotencyKey,
      input: {
        content: stringField(body, "content"),
        ...(optionalStringField(body, "agent_id") ? { agent_id: optionalStringField(body, "agent_id") } : {}),
        ...(optionalStringField(body, "backend_id") ? { backend_id: optionalStringField(body, "backend_id") } : {}),
        ...(body.input_locale === undefined ? {} : { input_locale: supportedLocaleField(body, "input_locale") }),
        ...(body.output_locale === undefined ? {} : { output_locale: supportedLocaleField(body, "output_locale") }),
        ...(metadata ? { metadata } : {}),
        ...(body.attachments === undefined ? {} : { attachments: resourceRefsField(body, "attachments") }),
        ...(body.temporary_context === undefined ? {} : { temporary_context: temporaryContextField(body, "temporary_context") })
      }
    });
    const renderSpec = postgresChatRenderSpec(result);
    res.json({ result, render_spec: renderSpec, render_specs: [renderSpec] });
  }));

  app.get("/api/workspaces/:workspaceId/chat/runs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listBackendRuns(queryString(req, "session_id")));
  }));

  app.get("/api/workspaces/:workspaceId/chat/runs/:runId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const run = await runtimeCommands.getBackendRun(pathParam(req, "runId"));
    if (!run) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    res.json(run);
  }));

  app.get("/api/workspaces/:workspaceId/chat/runs/:runId/events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const runId = pathParam(req, "runId");
    const run = await runtimeCommands.getBackendRun(runId);
    if (!run) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    const afterSequence = queryNumber(req, "after_sequence");
    const limitValue = queryNumber(req, "limit");
    const limit = limitValue === undefined ? undefined : Math.max(1, Math.min(limitValue, 1_000));
    res.json(await runtimeCommands.listBackendEvents({ runId, ...(afterSequence === undefined ? {} : { afterSequence: Math.max(0, afterSequence) }), ...(limit === undefined ? {} : { limit }) }));
  }));

  app.post("/api/workspaces/:workspaceId/chat/runs/:runId/cancel", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    res.json(await runtimeCommands.cancelBackendRun(pathParam(req, "runId")));
  }));

  app.post("/api/workspaces/:workspaceId/chat/runs/:runId/resume", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const body = objectBody(req.body);
    const input = body.input === undefined ? {} : jsonObjectField(body, "input");
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    res.json(await runtimeCommands.resumeBackendRun(pathParam(req, "runId"), input));
  }));

  app.post("/api/workspaces/:workspaceId/chat/runs/:runId/sync", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    res.json(await runtimeCommands.syncBackendRun(pathParam(req, "runId")));
  }));

  app.post("/api/workspaces/:workspaceId/chat/runs/:runId/recover", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    res.json(await runtimeCommands.recoverBackendRun(pathParam(req, "runId")));
  }));

  app.post("/api/workspaces/:workspaceId/chat/runs/:runId/retry", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const body = objectBody(req.body);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
      async (event) => recordPostgresChatCompletionActivity(commands, context, event));
    const result = await runtimeCommands.retryBackendRun(pathParam(req, "runId"), {
      idempotencyKey: context.operationId,
      ...(body.confirm_unknown === true ? { confirmUnknown: true } : {})
    });
    const renderSpec = postgresChatRenderSpec(result);
    res.json({ result, render_spec: renderSpec, render_specs: [renderSpec] });
  }));

  app.get("/api/workspaces/:workspaceId/chat/changes", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listWorkspaceChanges(queryString(req, "session_id")));
  }));

  app.get("/api/workspaces/:workspaceId/chat/activity", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("runtime_activity_room_id_required", 400);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listActivity(roomId));
  }));

  app.get("/api/workspaces/:workspaceId/chat/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId) throw new WorkspaceServerError("runtime_search_room_id_required", 400);
    if (!query) throw new WorkspaceServerError("runtime_search_query_required", 400);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.search(roomId, query));
  }));

  // Runtime compatibility aliases.  The old local API exposed these names
  // without a workspace prefix; the PostgreSQL server keeps the same public
  // concepts under an authenticated Workspace boundary.  Each alias below
  // calls the same PostgreSQL command service as the canonical chat route.
  app.get("/api/workspaces/:workspaceId/activity", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("runtime_activity_room_id_required", 400);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listActivity(roomId));
  }));
  app.get("/api/workspaces/:workspaceId/workspace-changes", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listWorkspaceChanges(queryString(req, "session_id")));
  }));
  app.get("/api/workspaces/:workspaceId/backend-runs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    res.json(await runtimeCommands.listBackendRuns(queryString(req, "session_id")));
  }));
  app.get("/api/workspaces/:workspaceId/backend-runs/:runId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const run = await runtimeCommands.getBackendRun(pathParam(req, "runId"));
    if (!run) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    res.json(run);
  }));
  app.get("/api/workspaces/:workspaceId/backend-runs/:runId/tool-runs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const run = await runtimeCommands.getBackendRun(pathParam(req, "runId"));
    if (!run) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    if (!run.session_id) throw new WorkspaceServerError("runtime_backend_session_missing", 409);
    const detail = await runtimeCommands.getSessionDetail(run.session_id);
    res.json(detail?.toolRuns.filter((toolRun) => toolRun.run_id === run.id) ?? []);
  }));
  app.get("/api/workspaces/:workspaceId/backend-runs/:runId/tool-runs/diagnostics", authenticateWorkspace, asyncRoute(async (req, res) => {
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const run = await runtimeCommands.getBackendRun(pathParam(req, "runId"));
    if (!run) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    if (!run.session_id) throw new WorkspaceServerError("runtime_backend_session_missing", 409);
    const detail = await runtimeCommands.getSessionDetail(run.session_id);
    const toolRuns = (detail?.toolRuns ?? []).filter((toolRun) => toolRun.run_id === run.id);
    const status = queryString(req, "status");
    res.json({ tool_runs: status ? toolRuns.filter((toolRun) => toolRun.status === status) : toolRuns });
  }));
  app.get("/api/workspaces/:workspaceId/tool-runs/diagnostics", authenticateWorkspace, asyncRoute(async (req, res) => {
    const sessionId = queryString(req, "session_id");
    if (!sessionId) throw new WorkspaceServerError("session_id_required", 400);
    const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, workspaceContext(req), io, store, knowledgeMemory);
    const detail = await runtimeCommands.getSessionDetail(sessionId);
    if (!detail) throw new WorkspaceServerError("runtime_session_not_found", 404);
    const runId = queryString(req, "run_id");
    const status = queryString(req, "status");
    const toolRuns = detail.toolRuns.filter((toolRun) => (!runId || toolRun.run_id === runId) && (!status || toolRun.status === status));
    res.json({ tool_runs: toolRuns });
  }));
  for (const action of ["cancel", "resume", "stream-sync"] as const) {
    app.post(`/api/workspaces/:workspaceId/backend-runs/:runId/${action}`, authenticateWorkspace, asyncRoute(async (req, res) => {
      const context = operationContext(req);
      const runtimeCommands = postgresRuntimeCommands(core.database, config, backendRegistry, context, io, store, knowledgeMemory,
        (event) => recordPostgresChatCompletionActivity(commands, context, event));
      const runId = pathParam(req, "runId");
      if (action === "cancel") {
        res.json(await runtimeCommands.cancelBackendRun(runId));
      } else if (action === "resume") {
        const body = objectBody(req.body);
        res.json(await runtimeCommands.resumeBackendRun(runId, body.input === undefined ? {} : jsonObjectField(body, "input")));
      } else {
        res.json(await runtimeCommands.syncBackendRun(runId));
      }
    }));
  }

  app.get("/api/workspaces/:workspaceId/client-events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const targetClientKind = optionalStringField(req.query as Record<string, unknown>, "target_client_kind");
    if (targetClientKind !== undefined && targetClientKind !== "desktop" && targetClientKind !== "web" && targetClientKind !== "any") {
      throw new WorkspaceServerError("client_event_target_kind_invalid", 400);
    }
    const status = optionalStringField(req.query as Record<string, unknown>, "status");
    if (status !== undefined && !["pending", "delivered", "acked", "expired", "failed"].includes(status)) {
      throw new WorkspaceServerError("client_event_status_invalid", 400);
    }
    res.json({ events: await clientEvents.list(workspaceContext(req), {
      ...(targetClientKind ? { targetClientKind: targetClientKind as ClientEventRecord["target_client_kind"] } : {}),
      ...(optionalStringField(req.query as Record<string, unknown>, "target_client_id") ? { targetClientId: optionalStringField(req.query as Record<string, unknown>, "target_client_id") } : {}),
      ...(status ? { status: status as ClientEventRecord["status"] } : {}),
      ...(queryNumber(req, "limit") !== undefined ? { limit: queryNumber(req, "limit") } : {})
    }) });
  }));

  app.post("/api/workspaces/:workspaceId/client-events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const event = ClientEventRecordSchema.safeParse(req.body);
    if (!event.success) throw new WorkspaceServerError("client_event_invalid", 400);
    const saved = await clientEvents.save(operationContext(req), event.data);
    res.status(saved.replayed ? 200 : 201).json(saved);
  }));

  app.post("/api/workspaces/:workspaceId/client-events/:eventId/deliver", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await clientEvents.deliver(operationContext(req), pathParam(req, "eventId"));
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/client-events/:eventId/ack", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await clientEvents.acknowledge(operationContext(req), pathParam(req, "eventId"));
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/client-events/:eventId/fail", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const errorCode = optionalStringField(body, "error_code") ?? "client_event_failed";
    const result = await clientEvents.fail(operationContext(req), pathParam(req, "eventId"), errorCode);
    res.json(result);
  }));

  // Knowledge Wiki is the Markdown-facing Knowledge projection. Every read
  // requires a Room, and every mutation uses the signed Completion command
  // boundary; the HTTP layer never writes a Wiki file or table directly.
  app.get("/api/workspaces/:workspaceId/knowledge-wiki", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json({ pages: await knowledgeWiki.list(workspaceContext(req), roomId, queryString(req, "include_archived") === "true") });
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/graph", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json(await knowledgeWiki.graph(workspaceContext(req), roomId, queryString(req, "query")));
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/active-retrieval", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json(await knowledgeWiki.graph(workspaceContext(req), roomId, queryString(req, "q")));
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/diagnostics", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json(await knowledgeWiki.diagnostics(workspaceContext(req), roomId));
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/lint", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json(await knowledgeWiki.diagnostics(workspaceContext(req), roomId));
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-wiki/reindex", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = stringField(objectBody(req.body), "room_id");
    res.json(await knowledgeWiki.reindex(workspaceContext(req), roomId));
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-wiki/proposals", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const saved = await knowledgeWiki.create(context, {
      roomId: stringField(body, "room_id"), title: stringField(body, "title"), content: stringField(body, "content"),
      ...(optionalStringField(body, "slug") ? { slug: optionalStringField(body, "slug") } : {}),
      ...(body.tags === undefined ? {} : { tags: stringArrayField(body, "tags") }),
      ...(body.content_locale === undefined ? {} : { contentLocale: supportedLocaleField(body, "content_locale") }),
      ...(body.knowledge_kind === undefined ? {} : { knowledgeKind: completionKnowledgeKind(stringField(body, "knowledge_kind")) }),
      reason: optionalStringField(body, "reason") ?? "Knowledge Wiki proposal created"
    });
    if (!saved.replayed && saved.wiki.scope.kind === "room" && saved.wiki.scope.roomId) {
      await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.wiki.scope.roomId, kind: "knowledge-wiki.updated" });
    }
    res.status(saved.replayed ? 200 : 201).json(saved);
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.get(workspaceContext(req), pathParam(req, "wikiId")));
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId/backlinks", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_wiki_room_id_required", 400);
    res.json(await knowledgeWiki.backlinks(workspaceContext(req), roomId, pathParam(req, "wikiId")));
  }));
  app.patch("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const saved = await knowledgeWiki.update(context, pathParam(req, "wikiId"), {
      ...(optionalStringField(body, "title") ? { title: optionalStringField(body, "title") } : {}),
      ...(body.content === undefined ? {} : { content: stringField(body, "content") }),
      ...(body.tags === undefined ? {} : { tags: stringArrayField(body, "tags") }),
      ...(body.content_locale === undefined ? {} : { contentLocale: supportedLocaleField(body, "content_locale") }),
      reason: optionalStringField(body, "reason") ?? "Knowledge Wiki page updated"
    });
    res.json(saved);
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId/accept", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await knowledgeWiki.setState(context, pathParam(req, "wikiId"), "active", "Knowledge Wiki proposal accepted"));
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId/reject", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await knowledgeWiki.setState(context, pathParam(req, "wikiId"), "rejected", "Knowledge Wiki proposal rejected"));
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-wiki/:wikiId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await knowledgeWiki.setArchived(context, pathParam(req, "wikiId"), true, "Knowledge Wiki page archived"));
  }));
  app.get("/api/workspaces/:workspaceId/wiki", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json({ pages: await knowledgeWiki.list(workspaceContext(req), roomId, queryString(req, "include_archived") === "true") });
  }));
  app.get("/api/workspaces/:workspaceId/wiki/active-retrieval", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json(await knowledgeWiki.graph(workspaceContext(req), roomId, queryString(req, "q")));
  }));
  app.get("/api/workspaces/:workspaceId/wiki/graph", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json(await knowledgeWiki.graph(workspaceContext(req), roomId, queryString(req, "q")));
  }));
  app.get("/api/workspaces/:workspaceId/wiki/diagnostics", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json(await knowledgeWiki.diagnostics(workspaceContext(req), roomId));
  }));
  app.get("/api/workspaces/:workspaceId/wiki/lint", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json(await knowledgeWiki.diagnostics(workspaceContext(req), roomId));
  }));
  app.get("/api/workspaces/:workspaceId/wiki/:wikiId/backlinks", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("wiki_room_id_required", 400);
    res.json(await knowledgeWiki.backlinks(workspaceContext(req), roomId, pathParam(req, "wikiId")));
  }));
  app.get("/api/workspaces/:workspaceId/wiki/:wikiId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.get(workspaceContext(req), pathParam(req, "wikiId")));
  }));
  app.post("/api/workspaces/:workspaceId/wiki/proposals", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    res.status(201).json(await knowledgeWiki.create(context, { roomId: stringField(body, "room_id"), title: stringField(body, "title"), content: stringField(body, "content"), ...(optionalStringField(body, "slug") ? { slug: optionalStringField(body, "slug") } : {}), ...(body.tags === undefined ? {} : { tags: stringArrayField(body, "tags") }), reason: optionalStringField(body, "reason") ?? "Knowledge Wiki proposal created" }));
  }));
  app.patch("/api/workspaces/:workspaceId/wiki/:wikiId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await knowledgeWiki.update(operationContext(req), pathParam(req, "wikiId"), { ...(optionalStringField(body, "title") ? { title: optionalStringField(body, "title") } : {}), ...(body.content === undefined ? {} : { content: stringField(body, "content") }), ...(body.tags === undefined ? {} : { tags: stringArrayField(body, "tags") }), reason: optionalStringField(body, "reason") ?? "Knowledge Wiki page updated" }));
  }));
  app.post("/api/workspaces/:workspaceId/wiki/:wikiId/accept", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.setState(operationContext(req), pathParam(req, "wikiId"), "active", "Knowledge Wiki proposal accepted"));
  }));
  app.post("/api/workspaces/:workspaceId/wiki/:wikiId/reject", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.setState(operationContext(req), pathParam(req, "wikiId"), "rejected", "Knowledge Wiki proposal rejected"));
  }));
  app.post("/api/workspaces/:workspaceId/wiki/:wikiId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.setArchived(operationContext(req), pathParam(req, "wikiId"), true, "Knowledge Wiki page archived"));
  }));
  app.post("/api/workspaces/:workspaceId/wiki/reindex", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeWiki.reindex(workspaceContext(req), stringField(objectBody(req.body), "room_id")));
  }));

  app.get("/api/workspaces/:workspaceId/knowledge-memory", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_memory_room_id_required", 400);
    res.json({ memories: await knowledgeMemory.list(workspaceContext(req), roomId, queryString(req, "include_archived") === "true") });
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-memory/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("knowledge_memory_search_input_required", 400);
    res.json({ memories: await knowledgeMemory.search(workspaceContext(req), roomId, query, queryNumber(req, "limit") ?? 50) });
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-memory/active-retrieval", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("knowledge_memory_room_id_required", 400);
    const query = queryString(req, "q");
    res.json({ memories: query
      ? await knowledgeMemory.search(workspaceContext(req), roomId, query, queryNumber(req, "limit") ?? 50)
      : await knowledgeMemory.list(workspaceContext(req), roomId, false) });
  }));
  app.get("/api/workspaces/:workspaceId/knowledge-memory/:memoryId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeMemory.get(workspaceContext(req), pathParam(req, "memoryId")));
  }));
  app.post("/api/workspaces/:workspaceId/knowledge-memory/:memoryId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await knowledgeMemory.archive(context, pathParam(req, "memoryId"), optionalStringField(objectBody(req.body), "reason") ?? "Memory archived by owner"));
  }));
  // Compatibility aliases keep the former resource names on the PostgreSQL
  // server while all reads and writes remain Completion-backed.
  app.get("/api/workspaces/:workspaceId/memory", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("memory_room_id_required", 400);
    res.json({ memories: await knowledgeMemory.list(workspaceContext(req), roomId, queryString(req, "include_archived") === "true") });
  }));
  app.get("/api/workspaces/:workspaceId/memory/active-retrieval", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("memory_room_id_required", 400);
    const query = queryString(req, "q");
    res.json({ memories: query ? await knowledgeMemory.search(workspaceContext(req), roomId, query, queryNumber(req, "limit") ?? 50) : await knowledgeMemory.list(workspaceContext(req), roomId, false) });
  }));
  app.get("/api/workspaces/:workspaceId/memory/:memoryId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeMemory.get(workspaceContext(req), pathParam(req, "memoryId")));
  }));
  app.post("/api/workspaces/:workspaceId/memory/:memoryId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeMemory.archive(operationContext(req), pathParam(req, "memoryId"), optionalStringField(objectBody(req.body), "reason") ?? "Memory archived by owner"));
  }));

  app.get("/api/workspaces/:workspaceId/skills", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("skill_room_id_required", 400);
    res.json({ skills: await knowledgeSkill.list(workspaceContext(req), roomId, queryString(req, "include_archived") === "true") });
  }));
  app.get("/api/workspaces/:workspaceId/skills/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("skill_search_input_required", 400);
    res.json({ skills: await knowledgeSkill.search(workspaceContext(req), roomId, query, queryNumber(req, "limit") ?? 50) });
  }));
  app.get("/api/workspaces/:workspaceId/skills/:skillId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await knowledgeSkill.get(workspaceContext(req), pathParam(req, "skillId")));
  }));
  app.get("/api/workspaces/:workspaceId/skills/:skillId/support", authenticateWorkspace, asyncRoute(async (req, res) => {
    const files = await knowledgeSkill.listSupportFiles(workspaceContext(req), pathParam(req, "skillId"));
    res.json({ files: files.map((file) => ({ path: file.relativePath, file_path: file.filePath, content_hash: file.contentHash, content_size: file.contentSize })) });
  }));
  app.get("/api/workspaces/:workspaceId/skills/:skillId/support/{*supportPath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const supportPath = wildcardParam(req.params.supportPath);
    const file = await knowledgeSkill.getSupportFile(workspaceContext(req), pathParam(req, "skillId"), supportPath);
    res.type("application/octet-stream").send(file.content);
  }));
  app.patch("/api/workspaces/:workspaceId/skills/:skillId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await knowledgeSkill.patch(operationContext(req), pathParam(req, "skillId"), {
      ...(optionalStringField(body, "title") ? { title: optionalStringField(body, "title") } : {}),
      ...(optionalStringField(body, "description") !== undefined ? { description: optionalStringField(body, "description") } : {}),
      ...(body.content === undefined ? {} : { content: stringField(body, "content") }),
      ...(body.tags === undefined ? {} : { tags: stringArrayField(body, "tags") })
    }));
  }));
  app.post("/api/workspaces/:workspaceId/skills/:skillId/state", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const state = stringField(body, "state");
    if (!(state === "candidate" || state === "project" || state === "active" || state === "stale" || state === "archived" || state === "pinned")) throw new WorkspaceServerError("skill_state_invalid", 400);
    res.json(await knowledgeSkill.patch(operationContext(req), pathParam(req, "skillId"), { state }));
  }));

  // Collection files are the editable source. PostgreSQL keeps only the
  // Room-scoped index, versions, and recovery state; all UI mutations below
  // pass through the Collection use case and return a Surface render spec.
  app.get("/api/workspaces/:workspaceId/collections/schemas", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ schemas: await collections.listSchemas(workspaceContext(req), roomId) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/actions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const schemas = await collections.listSchemas(workspaceContext(req), roomId);
    res.json({ actions: schemas.flatMap((schema) => [...schema.actions, { id: "refresh", label: "更新", operation_kind: "collection.view.present", collection_id: schema.id }]) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/triggers", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const schemas = await collections.listSchemas(workspaceContext(req), roomId);
    res.json({ triggers: schemas.flatMap((schema) => schema.triggers.map((trigger, index) => ({
      ...trigger,
      collection_id: schema.id,
      trigger_id: typeof trigger.id === "string" ? trigger.id : `trigger_${index + 1}`,
      delivery_supported: true,
      status: trigger.enabled === false ? "disabled" : "ready"
    }))) });
  }));
  app.post("/api/workspaces/:workspaceId/collections/schemas", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const schema = objectBody(body.schema) as unknown as CollectionSchema;
    const saved = await collections.saveSchema(context, stringField(body, "room_id"), schema, body.expected_version === undefined ? undefined : numberField(body, "expected_version"));
    const { replayed, ...resource } = saved;
    res.status(replayed ? 200 : 201).json({ schema: resource, replayed });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/schema", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ schema: await collections.getSchema(workspaceContext(req), roomId, pathParam(req, "collectionId")) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/actions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const schema = await collections.getSchema(workspaceContext(req), roomId, pathParam(req, "collectionId"));
    res.json({ actions: [...schema.actions, { id: "refresh", label: "更新", operation_kind: "collection.view.present" }] });
  }));
  app.post("/api/workspaces/:workspaceId/collections/:collectionId/actions/:actionId/run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const operation = parseSurfaceOperation({
      id: context.operationId,
      kind: "collection.action.run",
      collection_id: pathParam(req, "collectionId"),
      action_id: pathParam(req, "actionId"),
      ...(optionalStringField(body, "record_id") ? { record_id: optionalStringField(body, "record_id") } : {}),
      payload: body.payload === undefined ? {} : jsonObjectField(body, "payload")
    });
    if (!operation || operation.kind !== "collection.action.run") throw new WorkspaceServerError("collection_action_invalid", 400);
    const result = await collections.runAction(context, roomId, operation);
    res.status(201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/triggers", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const schema = await collections.getSchema(workspaceContext(req), roomId, pathParam(req, "collectionId"));
    res.json({ triggers: schema.triggers.map((trigger, index) => ({
      ...trigger,
      collection_id: schema.id,
      trigger_id: typeof trigger.id === "string" ? trigger.id : `trigger_${index + 1}`,
      delivery_supported: false,
      status: trigger.enabled === false ? "disabled" : "blocked",
      reason: trigger.enabled === false ? undefined : "collection_trigger_delivery_not_supported"
    })) });
  }));
  app.put("/api/workspaces/:workspaceId/collections/:collectionId/schema", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const schema = objectBody(body.schema) as unknown as CollectionSchema;
    const saved = await collections.saveSchema(context, stringField(body, "room_id"), schema, numberField(body, "expected_version"));
    const { replayed, ...resource } = saved;
    res.json({ schema: resource, replayed });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/records", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ records: await collections.listRecords(workspaceContext(req), roomId, pathParam(req, "collectionId")) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/view-data", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const records = await collections.listRecords(workspaceContext(req), roomId, pathParam(req, "collectionId"));
    const ids = queryStringList(req, "ids");
    const fields = queryStringList(req, "fields");
    const selected = ids.length > 0 ? records.filter((record) => ids.includes(record.id)) : records;
    res.json({ records: selected.map((record) => fields.length === 0 ? record : ({ ...record, data: Object.fromEntries(fields.filter((field) => field in record.data).map((field) => [field, record.data[field]])) })) });
  }));
  app.put("/api/workspaces/:workspaceId/collections/:collectionId/view-data", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const roomId = stringField(body, "room_id");
    const mode = optionalStringField(body, "mode") ?? "upsert";
    if (mode !== "create" && mode !== "upsert" && mode !== "merge") throw new WorkspaceServerError("collection_view_data_mode_invalid", 400);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) throw new WorkspaceServerError("collection_view_data_items_required", 400);
    const written: string[] = [];
    const rejected: Array<{ id: string; problem: string }> = [];
    for (const [index, item] of items.entries()) {
      const value = objectBody(item);
      const recordId = optionalStringField(value, "id") ?? optionalStringField(value, "record_id");
      if (!recordId) {
        rejected.push({ id: "(missing)", problem: "record_id_required" });
        continue;
      }
      const { id: _id, record_id: _recordId, collection_id: _collectionId, resource_refs: _resourceRefs, data: nestedData, ...flatData } = value;
      const data = nestedData !== undefined ? jsonObjectField(value, "data") : flatData as Record<string, JsonValue>;
      const itemContext = { ...context, operationId: `${context.operationId}:view-data:${index}` };
      try {
        const existing = await collections.getRecord(workspaceContext(req), roomId, pathParam(req, "collectionId"), recordId);
        if (mode === "create") {
          rejected.push({ id: recordId, problem: "record_already_exists" });
          continue;
        }
        await collections.applyPatch(itemContext, roomId, pathParam(req, "collectionId"), recordId, { changes: data, expected_version: existing.version });
        written.push(recordId);
      } catch (error) {
        if (!(error instanceof WorkspaceServerError) || error.status !== 404) {
          rejected.push({ id: recordId, problem: error instanceof Error ? error.message : "collection_record_write_failed" });
          continue;
        }
        if (mode === "merge") {
          rejected.push({ id: recordId, problem: "record_not_found" });
          continue;
        }
        await collections.createRecord(itemContext, roomId, { id: recordId, collection_id: pathParam(req, "collectionId"), data, resource_refs: [], created_at: nowIso(), updated_at: nowIso() });
        written.push(recordId);
      }
    }
    res.json({ action: "putItems", collection_id: pathParam(req, "collectionId"), mode, written, rejected });
  }));
  app.post("/api/workspaces/:workspaceId/collections/:collectionId/records", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const collectionId = pathParam(req, "collectionId");
    const record = await collections.createRecord(context, stringField(body, "room_id"), collectionRecordFromBody(collectionId, body));
    const { replayed, ...resource } = record;
    res.status(replayed ? 200 : 201).json({ record: resource, replayed });
  }));
  app.post("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId/patches", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const changes = jsonObjectField(body, "changes");
    const record = await collections.applyPatch(context, stringField(body, "room_id"), pathParam(req, "collectionId"), pathParam(req, "recordId"), {
      ...(optionalStringField(body, "patch_id") ? { id: optionalStringField(body, "patch_id") } : {}),
      changes,
      ...(body.expected_version === undefined ? {} : { expected_version: numberField(body, "expected_version") })
    });
    const { replayed, ...resource } = record;
    res.json({ record: resource, replayed });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/patches", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ patches: await collections.listPatches(workspaceContext(req), roomId, pathParam(req, "collectionId")) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ record: await collections.getRecord(workspaceContext(req), roomId, pathParam(req, "collectionId"), pathParam(req, "recordId")) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId/refs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json(await collections.resolveRecordRefs(workspaceContext(req), roomId, pathParam(req, "collectionId"), pathParam(req, "recordId")));
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId/patches", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ patches: await collections.listPatches(workspaceContext(req), roomId, pathParam(req, "collectionId"), pathParam(req, "recordId")) });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId/patches/:patchId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    const patch = await collections.getPatch(workspaceContext(req), roomId, pathParam(req, "collectionId"), pathParam(req, "recordId"), pathParam(req, "patchId"));
    if (!patch) throw new WorkspaceServerError("collection_patch_not_found", 404);
    res.json({ patch });
  }));
  app.delete("/api/workspaces/:workspaceId/collections/:collectionId/records/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const record = await collections.deleteRecord(context, stringField(body, "room_id"), pathParam(req, "collectionId"), pathParam(req, "recordId"), numberField(body, "expected_version"));
    const { replayed, ...resource } = record;
    res.json({ record: resource, replayed });
  }));
  app.get("/api/workspaces/:workspaceId/collections/:collectionId/notes", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("collection_room_id_required", 400);
    res.json({ notes: await collections.listNotes(workspaceContext(req), roomId, pathParam(req, "collectionId")) });
  }));
  app.post("/api/workspaces/:workspaceId/collections/reindex", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    res.json(await collections.reindex(context, stringField(objectBody(req.body), "room_id")));
  }));
  app.post("/api/workspaces/:workspaceId/collections/surface/operations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const operation = parseSurfaceOperation(body.operation);
    const context = operationContext(req);
    if (!operation || operation.id !== context.operationId) throw new WorkspaceServerError("collection_surface_operation_invalid", 400);
    let result: unknown;
    let resultKind: "collection_view" | "collection_record" | "collection_patch" | "collection_delete" | "collection_action";
    let renderSpec: SurfaceRenderSpec;
    if (operation.kind === "collection.view.present") {
      const presented = await collections.presentView(context, roomId, operation.collection_id, operation.view_id);
      result = presented;
      resultKind = "collection_view";
      renderSpec = presented.render_spec;
    } else if (operation.kind === "collection.record.create") {
      const record = await collections.createRecord(context, roomId, {
        id: operation.record_id, collection_id: operation.collection_id, data: operation.data, resource_refs: [], created_at: nowIso(), updated_at: nowIso()
      });
      result = record;
      resultKind = "collection_record";
      renderSpec = (await collections.presentView(context, roomId, operation.collection_id)).render_spec;
    } else if (operation.kind === "collection.record.patch") {
      const record = await collections.applyPatch(context, roomId, operation.collection_id, operation.record_id, {
        id: operation.patch_id, changes: operation.changes,
        ...(operation.expected_version === undefined ? {} : { expected_version: operation.expected_version })
      });
      result = record;
      resultKind = "collection_patch";
      renderSpec = (await collections.presentView(context, roomId, operation.collection_id, operation.metadata?.view_id && typeof operation.metadata.view_id === "string" ? operation.metadata.view_id : undefined)).render_spec;
    } else if (operation.kind === "collection.record.delete") {
      result = await collections.deleteRecord(context, roomId, operation.collection_id, operation.record_id, operation.expected_version);
      resultKind = "collection_delete";
      renderSpec = (await collections.presentView(context, roomId, operation.collection_id, operation.view_id)).render_spec;
    } else if (operation.kind === "collection.action.run") {
      const action = await collections.runAction(context, roomId, operation);
      result = action.result;
      resultKind = "collection_action";
      renderSpec = action.presented.render_spec;
    } else {
      throw new WorkspaceServerError("collection_surface_operation_kind_invalid", 400);
    }
    res.status(201).json({ operation, result_kind: resultKind, render_spec: renderSpec, render_specs: [renderSpec], result });
  }));

  app.get("/api/workspaces/:workspaceId/artifacts", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("artifact_room_id_required", 400);
    res.json({ artifacts: await artifacts.list(workspaceContext(req), roomId) });
  }));
  app.get("/api/workspaces/:workspaceId/artifacts/:artifactId/content", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("artifact_room_id_required", 400);
    const detail = await artifacts.get(workspaceContext(req), roomId, pathParam(req, "artifactId"));
    res.type(detail.artifact.metadata.content_type === "application/json" ? "application/json" : "text/plain").send(detail.content);
  }));
  app.get("/api/workspaces/:workspaceId/artifacts/:artifactId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("artifact_room_id_required", 400);
    res.json(await artifacts.get(workspaceContext(req), roomId, pathParam(req, "artifactId")));
  }));
  app.post("/api/workspaces/:workspaceId/artifacts", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await artifacts.create(context, {
      roomId: stringField(body, "room_id"),
      title: stringField(body, "title"),
      content: artifactContentField(body, "content"),
      ...(body.kind === undefined ? {} : { kind: artifactKindField(body, "kind") }),
      ...(body.locale === undefined ? {} : { locale: supportedLocaleField(body, "locale") }),
      ...(body.source_locales === undefined ? {} : { sourceLocales: supportedLocaleArrayField(body, "source_locales") }),
      ...(body.metadata === undefined ? {} : { metadata: jsonObjectField(body, "metadata") })
    });
    if (!result.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: stringField(body, "room_id"), kind: "artifact.created" });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.post("/api/workspaces/:workspaceId/artifacts/surface/operations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const operation = parseSurfaceOperation(body.operation);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    if (!operation || operation.kind !== "artifact.request" || operation.id !== context.operationId) throw new WorkspaceServerError("artifact_surface_operation_invalid", 400);
    const result = await artifacts.runSurfaceOperation(context, roomId, operation);
    res.status(201).json(result);
  }));

  // Generated Surface is a Room-scoped projection. Its bundle files are read
  // through the Workspace File boundary, while create/revise/state/action and
  // interaction changes use the formal Domain Operation handlers.
  app.get("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("generated_surface_room_id_required", 400);
    res.json(await generatedSurfaces.detail(workspaceContext(req), roomId, pathParam(req, "surfaceId")));
  }));

  app.get("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/revisions/:revisionId/bundle", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("generated_surface_room_id_required", 400);
    res.json(await generatedSurfaces.bundle(workspaceContext(req), roomId, pathParam(req, "surfaceId"), pathParam(req, "revisionId")));
  }));

  app.get("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/revisions/:revisionId/preview", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("generated_surface_room_id_required", 400);
    const context = workspaceContext(req);
    const exported = await generatedSurfaces.export(context, roomId, { surface_id: pathParam(req, "surfaceId"), revision_id: pathParam(req, "revisionId"), format: "html" });
    const assets = await generatedSurfaces.readAssets(context, roomId, exported.revision);
    res.set("Content-Security-Policy", generatedSurfaceCsp);
    res.set("X-Content-Type-Options", "nosniff");
    res.type("html").send(generatedSurfaceDocument(exported.bundle, exported.surface.actions, generatedSurfaceAssetPayload(assets)));
  }));

  app.get("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/export", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("generated_surface_room_id_required", 400);
    const format = queryString(req, "format") === "zip" ? "zip" : "html";
    const input = { surface_id: pathParam(req, "surfaceId"), ...(queryString(req, "revision_id") ? { revision_id: queryString(req, "revision_id") } : {}), format } as const;
    if (format === "zip") {
      const zip = await generatedSurfaces.createExportZip(workspaceContext(req), roomId, input);
      res.json({ file_name: zip.fileName, content_type: "application/zip", content_base64: zip.content.toString("base64") });
      return;
    }
    const context = workspaceContext(req);
    const exported = await generatedSurfaces.export(context, roomId, input);
    const assets = await generatedSurfaces.readAssets(context, roomId, exported.revision);
    const content = generatedSurfaceDocument(exported.bundle, exported.surface.actions, generatedSurfaceAssetPayload(assets));
    res.json({ file_name: exported.file_name, content_type: "text/html", content_base64: Buffer.from(content, "utf8").toString("base64") });
  }));

  app.post("/api/workspaces/:workspaceId/generated-surfaces", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const { room_id: _roomId, ...input } = body;
    const context = operationContext(req);
    const result = await generatedSurfaces.create(context, roomId, input as GeneratedSurfaceCreateInput);
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/revise", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const { room_id: _roomId, ...input } = body;
    const context = operationContext(req);
    const result = await generatedSurfaces.revise(context, roomId, { ...input, surface_id: pathParam(req, "surfaceId") } as GeneratedSurfaceReviseInput);
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/actions/:actionId/run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const actionPayload = body.action_payload === undefined ? {} : jsonObjectField(body, "action_payload");
    const result = await generatedSurfaces.runAction(context, {
      room_id: roomId,
      surface_id: pathParam(req, "surfaceId"),
      action_id: pathParam(req, "actionId"),
      ...(optionalStringField(body, "revision_id") ? { revision_id: optionalStringField(body, "revision_id") } : {}),
      ...(optionalStringField(body, "interaction_id") ? { interaction_id: optionalStringField(body, "interaction_id") } : {}),
      ...(optionalStringField(body, "message_id") ? { message_id: optionalStringField(body, "message_id") } : {}),
      confirmed: body.confirmed === true,
      action_payload: actionPayload
    });
    res.status(201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/state", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const action = stringField(body, "action");
    if (action !== "pin" && action !== "unpin" && action !== "archive") throw new WorkspaceServerError("generated_surface_state_action_invalid", 400);
    res.json(await generatedSurfaces.state(context, {
      room_id: roomId,
      surface_id: pathParam(req, "surfaceId"),
      action,
      ...(optionalStringField(body, "interaction_id") ? { interaction_id: optionalStringField(body, "interaction_id") } : {}),
      ...(optionalStringField(body, "message_id") ? { message_id: optionalStringField(body, "message_id") } : {})
    }));
  }));

  app.post("/api/workspaces/:workspaceId/generated-surfaces/:surfaceId/interactions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const kind = stringField(body, "kind");
    if (!["opened", "pinned", "unpinned", "dismissed", "action", "corrected", "regenerated"].includes(kind)) {
      throw new WorkspaceServerError("generated_surface_interaction_kind_invalid", 400);
    }
    const commandResult = body.command_result === undefined ? undefined : generatedSurfaceJsonValueField(body, "command_result");
    res.status(201).json(await generatedSurfaces.recordInteraction(context, {
      room_id: roomId,
      surface_id: pathParam(req, "surfaceId"),
      kind: kind as never,
      ...(optionalStringField(body, "interaction_id") ? { interaction_id: optionalStringField(body, "interaction_id") } : {}),
      ...(optionalStringField(body, "revision_id") ? { revision_id: optionalStringField(body, "revision_id") } : {}),
      ...(optionalStringField(body, "message_id") ? { message_id: optionalStringField(body, "message_id") } : {}),
      ...(optionalStringField(body, "command_id") ? { command_id: optionalStringField(body, "command_id") } : {}),
      ...(commandResult === undefined ? {} : { command_result: commandResult }),
      ...(body.user_feedback === undefined ? {} : { user_feedback: stringField(body, "user_feedback") })
    }));
  }));

  app.get("/api/workspaces/:workspaceId/automation/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = optionalStringField(req.query as Record<string, unknown>, "room_id");
    res.json({ jobs: await automation.listJobs(workspaceContext(req), roomId) });
  }));

  app.post("/api/workspaces/:workspaceId/automation/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const created = await automation.createJob(context, {
      roomId: stringField(body, "room_id"),
      title: stringField(body, "title"),
      kind: automationKindField(body, "kind"),
      schedule: stringField(body, "schedule"),
      targetInstruction: stringField(body, "target_instruction"),
      ...(body.delivery_target === undefined ? {} : { deliveryTarget: jsonObjectField(body, "delivery_target") }),
      ...(body.enabled === undefined ? {} : { enabled: booleanField(body, "enabled") }),
      ...(body.next_run_at === undefined ? {} : { nextRunAt: stringField(body, "next_run_at") }),
      ...(body.max_attempts === undefined ? {} : { maxAttempts: numberField(body, "max_attempts") }),
      ...(optionalStringField(body, "connection_id") ? { connectionId: optionalStringField(body, "connection_id") } : {}),
      ...(body.session_ref === undefined ? {} : { sessionRef: jsonObjectField(body, "session_ref") })
    });
    if (!created.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: created.job.room_id!, kind: "automation.job.created" });
    res.status(created.replayed ? 200 : 201).json(created);
  }));

  app.get("/api/workspaces/:workspaceId/automation/jobs/:jobId/runs", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ runs: await automation.listRuns(workspaceContext(req), pathParam(req, "jobId")) });
  }));

  app.get("/api/workspaces/:workspaceId/automation/runs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("automation_room_id_required", 400);
    res.json({ runs: await automation.listRunsForRoom(workspaceContext(req), roomId) });
  }));

  app.post("/api/workspaces/:workspaceId/automation/run-now", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await automation.runNow(context, {
      roomId: stringField(body, "room_id"),
      kind: automationKindField(body, "kind")
    });
    if (!result.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: result.job.room_id!, kind: "automation.job.created" });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/automation/jobs/:jobId/management", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const state = stringField(body, "state");
    if (state !== "allowed" && state !== "manager_stopped") throw new WorkspaceServerError("automation_management_state_invalid", 400);
    const context = operationContext(req);
    const updated = await automation.setManagementState(context, { jobId: pathParam(req, "jobId"), state });
    if (!updated.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: updated.job.room_id!, kind: "automation.job.management_changed" });
    res.status(updated.replayed ? 200 : 200).json(updated);
  }));

  app.post("/api/workspaces/:workspaceId/agents", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.registerAgent(operationContext(req), {
      ...(optionalStringField(body, "agent_id") ? { id: optionalStringField(body, "agent_id") } : {}),
      displayName: stringField(body, "display_name"),
      ...(optionalStringField(body, "description") ? { description: optionalStringField(body, "description") } : {}),
      ...(optionalStringField(body, "backend_id") ? { backendId: optionalStringField(body, "backend_id") } : {})
    });
    if (!result.replayed) await emitAuthorizedWorkspaceEvent(io, store, { workspaceId: result.agent.workspaceId, kind: "workspace.agent.registered" });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/rooms", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const created = await commands.createRoom(operationContext(req), {
        id: optionalStringField(body, "room_id"),
        name: stringField(body, "name"),
        ...(optionalStringField(body, "parent_room_id") ? { parentRoomId: optionalStringField(body, "parent_room_id") } : {}),
        expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
      });
      if (!created.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: created.room.id, kind: "room.created" });
      }
      return created;
    });
    res.status(result.replayed ? 200 : 201).json({ room: result.room, replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/rooms/:roomId/members", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ members: await store.listRoomMembers(workspaceContext(req), pathParam(req, "roomId")) });
  }));

  app.get("/api/workspaces/:workspaceId/rooms/:roomId/agent-permissions", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ permissions: await store.listAgentRoomPermissions(workspaceContext(req), pathParam(req, "roomId")) });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/agents/:agentId/permission", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => commands.setAgentRoomPermission(context, {
      roomId: pathParam(req, "roomId"),
      agentId: pathParam(req, "agentId"),
      canView: booleanField(body, "can_view"),
      canEdit: booleanField(body, "can_edit"),
      canExecute: booleanField(body, "can_execute"),
      expectedVersion: numberField(body, "expected_version")
    }));
    if (!result.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: result.permission.roomId, kind: "workspace.agent.room_permission.changed" });
    res.status(result.replayed ? 200 : 201).json({ permission: result.permission, replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/connections", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ connections: await store.listConnectionDescriptors(workspaceContext(req)) });
  }));

  app.put("/api/workspaces/:workspaceId/connections/:connectionId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const allowedRoomIds = body.allowed_room_ids === undefined ? undefined : stringArrayField(body, "allowed_room_ids");
    const ingressClasses = body.ingress_classes === undefined ? undefined : stringArrayField(body, "ingress_classes");
    if (body.token !== undefined || body.api_key !== undefined || body.secret !== undefined || body.secret_ref !== undefined) {
      throw new WorkspaceServerError("workspace_connection_secret_forbidden", 400);
    }
    const result = await realtimeGate.run(context.workspaceId, async () => commands.upsertConnectionDescriptor(context, {
      id: pathParam(req, "connectionId"),
      ...(optionalStringField(body, "agent_id") ? { agentId: optionalStringField(body, "agent_id") } : {}),
      principalAccountId: stringField(body, "principal_account_id"),
      connectorId: stringField(body, "connector_id"),
      appId: stringField(body, "app_id"),
      status: connectionStatusField(body, "status"),
      expiresAt: stringField(body, "expires_at"),
      ...(optionalStringField(body, "revoked_at") ? { revokedAt: optionalStringField(body, "revoked_at") } : {}),
      ...(allowedRoomIds ? { allowedRoomIds } : {}),
      ...(body.room_limit === undefined ? {} : { roomLimit: numberField(body, "room_limit") }),
      ...(ingressClasses ? { ingressClasses } : {}),
      expectedVersion: numberField(body, "expected_version")
    }));
    if (!result.replayed) {
      for (const roomId of result.descriptor.allowedRoomIds) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId, kind: "workspace.connection_descriptor.changed" });
      }
    }
    res.status(result.replayed ? 200 : 201).json({ connection: result.descriptor, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/rooms/:roomId/parent/preview", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const preview = await store.previewRoomMove(workspaceContext(req), {
      roomId: pathParam(req, "roomId"),
      parentRoomId: nullableStringField(body, "parent_room_id")
    });
    res.json({ preview });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/parent", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const moved = await commands.moveRoom(operationContext(req), {
        roomId: pathParam(req, "roomId"),
        parentRoomId: nullableStringField(body, "parent_room_id"),
        expectedRoomVersion: numberField(body, "expected_room_version"),
        expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
      });
      if (!moved.replayed) {
        for (const roomId of moved.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId, kind: "room.moved" });
        }
      }
      return moved;
    });
    res.json({ room: result.room, affected_room_ids: result.affectedRoomIds, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId/preview", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const preview = await store.previewRoomMemberChange(workspaceContext(req), {
      roomId: pathParam(req, "roomId"),
      accountId: pathParam(req, "accountId"),
      role: roleField(body, "role"),
      state: membershipStateField(body, "state")
    });
    res.json({ preview });
  }));

  app.put("/api/workspaces/:workspaceId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const memberAccountId = pathParam(req, "accountId");
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const changed = await commands.setWorkspaceMember(operationContext(req), {
        accountId: memberAccountId,
        role: roleField(body, "role"),
        state: membershipStateField(body, "state"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!changed.replayed) {
        await revalidateWorkspaceMemberSockets(io, store, context.workspaceId, memberAccountId);
        for (const roomId of changed.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId, kind: "room.member.changed" });
        }
      }
      return changed;
    });
    res.json({ member: result.member, replayed: result.replayed });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = pathParam(req, "roomId");
    const memberAccountId = pathParam(req, "accountId");
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const changed = await commands.setRoomMember(operationContext(req), {
        roomId,
        accountId: memberAccountId,
        role: roleField(body, "role"),
        state: membershipStateField(body, "state"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!changed.replayed) {
        for (const affectedRoomId of changed.revalidationRoomIds) {
          await revalidateRoomMemberSockets(io, store, context.workspaceId, affectedRoomId, memberAccountId);
        }
        for (const affectedRoomId of changed.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: affectedRoomId, kind: "room.member.changed" });
        }
      }
      return changed;
    });
    res.json({ member: result.member, affected_room_ids: result.affectedRoomIds, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/invitations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.createInvitation(operationContext(req), {
      ...(optionalStringField(body, "room_id") ? { roomId: optionalStringField(body, "room_id") } : {}),
      workspaceRole: roleField(body, "workspace_role"),
      ...(optionalStringField(body, "room_role") ? { roomRole: roleField(body, "room_role") } : {}),
      expiresAt: stringField(body, "expires_at"),
      expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
    });
    res.status(201).json({
      invitation: result.invitation,
      invite_token: result.token,
      ...(config.publicBaseUrl ? { invite_url: workspaceInvitationLink(config.publicBaseUrl, workspaceContext(req).workspaceId, result.token) } : {})
    });
  }));

  app.post("/api/workspaces/:workspaceId/invitations/accept", authenticateInvitationAcceptance, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const accepted = await commands.acceptInvitation(context, stringField(body, "invite_token"));
      if (!accepted.replayed) {
        for (const roomId of accepted.revalidationRoomIds) {
          await revalidateRoomMemberSockets(io, store, context.workspaceId, roomId, context.accountId);
          await emitAuthorizedRoomWorkspaceEvent(io, store, {
            workspaceId: context.workspaceId,
            roomId,
            kind: "room.member.changed"
          });
        }
      }
      return accepted;
    });
    res.json({ accepted: result.accepted, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/invitations/:invitationId/revoke", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await commands.revokeInvitation(operationContext(req), pathParam(req, "invitationId"), numberField(body, "expected_version"));
    res.status(204).end();
  }));

  // The old learning projection remains readable while a Workspace is
  // migrated, but cannot become a second write path beside Completion.
  app.use("/api/workspaces/:workspaceId/learning", (req, _res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      next(new WorkspaceServerError("workspace_learning_legacy_write_retired", 410));
      return;
    }
    next();
  });

  // Historical read endpoints remain available for migration comparison.
  app.post("/api/workspaces/:workspaceId/learning/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.ingestActivity(context, {
        ...(optionalStringField(body, "activity_id") ? { id: optionalStringField(body, "activity_id") } : {}),
        roomId: stringField(body, "room_id"),
        groupKey: stringField(body, "group_key"),
        sourceKind: stringField(body, "source_kind"),
        ...(optionalStringField(body, "source_id") ? { sourceId: optionalStringField(body, "source_id") } : {}),
        ...(optionalStringField(body, "correction_of_activity_id") ? { correctionOfActivityId: optionalStringField(body, "correction_of_activity_id") } : {}),
        instructionSummary: stringField(body, "instruction_summary"),
        ...(optionalStringField(body, "result_summary") ? { resultSummary: optionalStringField(body, "result_summary") } : {}),
        outcome: learningOutcomeField(body, "outcome"),
        verificationState: learningVerificationField(body, "verification_state"),
        failureState: learningFailureField(body, "failure_state"),
        ...(body.explicit_remember === undefined ? {} : { explicitRemember: booleanField(body, "explicit_remember") }),
        ...(body.finalized_resource === undefined ? {} : { finalizedResource: booleanField(body, "finalized_resource") }),
        ...(body.reusable_completion === undefined ? {} : { reusableCompletion: booleanField(body, "reusable_completion") }),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") })
      });
      if (!saved.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.activity.roomId, kind: "learning.activity.ingested" });
        if (saved.job) learningRunner.schedule(context, { roomId: saved.activity.roomId });
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    const activities = await learning.listActivities(workspaceContext(req), {
      roomId,
      ...(queryString(req, "group_key") ? { groupKey: queryString(req, "group_key") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ activities });
  }));

  app.post("/api/workspaces/:workspaceId/learning/activities/:activityId/resource-uses", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.recordResourceUse(context, {
        ...(optionalStringField(body, "resource_use_id") ? { id: optionalStringField(body, "resource_use_id") } : {}),
        resourceId: stringField(body, "resource_id"),
        resourceVersion: numberField(body, "resource_version"),
        activityId: pathParam(req, "activityId"),
        outcome: learningResourceUseOutcome(body, "outcome"),
        summary: stringField(body, "summary")
      });
      if (!saved.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.roomId, kind: "learning.resource.used" });
        if (saved.job) learningRunner.schedule(context, { roomId: saved.roomId });
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.putResource(context, {
        scope: learningScopeField(body),
        kind: learningResourceKind(stringField(body, "kind")),
        ...(body.is_absolute_rule === undefined ? {} : { isAbsoluteRule: booleanField(body, "is_absolute_rule") }),
        title: stringField(body, "title"),
        content: stringField(body, "content"),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") }),
        reason: stringField(body, "reason"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.created");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const scope = learningScopeQuery(req);
    const kind = queryString(req, "kind");
    const resources = await learning.listResources(workspaceContext(req), {
      scope,
      ...(kind ? { kind: learningResourceKind(kind) } : {}),
      ...(queryString(req, "include_archived") === "true" ? { includeArchived: true } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ resources });
  }));

  app.get("/api/workspaces/:workspaceId/learning/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const resourceId = pathParam(req, "resourceId");
    const [resource, versions, evidence] = await Promise.all([
      learning.getResource(context, resourceId),
      learning.listResourceVersions(context, resourceId),
      learning.listEvidence(context, resourceId)
    ]);
    res.json({ resource, versions, evidence });
  }));

  app.put("/api/workspaces/:workspaceId/learning/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.putResource(context, {
        id: pathParam(req, "resourceId"),
        scope: learningScopeField(body),
        kind: learningResourceKind(stringField(body, "kind")),
        ...(body.is_absolute_rule === undefined ? {} : { isAbsoluteRule: booleanField(body, "is_absolute_rule") }),
        title: stringField(body, "title"),
        content: stringField(body, "content"),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") }),
        reason: stringField(body, "reason"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/fixed", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.setResourceFixed(context, {
        resourceId: pathParam(req, "resourceId"), fixed: booleanField(body, "fixed"),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.archiveResource(context, {
        resourceId: pathParam(req, "resourceId"), archived: booleanField(body, "archived"),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/copy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.copyResource(context, {
        resourceId: pathParam(req, "resourceId"), targetScope: learningTargetScopeField(body),
        ...(optionalStringField(body, "target_resource_id") ? { id: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.copied");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/move", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    // Moving preserves an archived source projection. Notify both Room views,
    // while keeping the source Room identifier out of the target-room event.
    const source = await learning.getResource(workspaceContext(req), pathParam(req, "resourceId"));
    const sourceRoomId = source.scope.kind === "room" ? source.scope.roomId : undefined;
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.moveResource(context, {
        resourceId: pathParam(req, "resourceId"), targetRoomId: stringField(body, "target_room_id"),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) {
        if (sourceRoomId) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: sourceRoomId, kind: "learning.resource.moved" });
        }
        await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.moved");
      }
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/promote", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.promoteResource(context, {
        resourceId: pathParam(req, "resourceId"),
        ...(optionalStringField(body, "target_resource_id") ? { id: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.promoted");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_learning_search_input_required", 400);
    res.json({ resources: await learning.searchKnowledge(workspaceContext(req), { roomId, query, ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}) }) });
  }));

  app.get("/api/workspaces/:workspaceId/learning/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    const layers = await learning.getSettingsLayers(workspaceContext(req), roomId);
    res.json({
      settings: publicLearningSettings(layers.effective),
      ...(layers.workspace ? { workspace_settings: publicLearningSettings(layers.workspace) } : {}),
      ...(layers.room ? { room_settings: publicLearningSettings(layers.room) } : {})
    });
  }));

  app.put("/api/workspaces/:workspaceId/learning/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const scope = learningScopeField(body);
      const saved = await learning.updateSettings(context, {
        scope,
        ...(body.enabled === undefined ? {} : { enabled: booleanField(body, "enabled") }),
        ...(optionalStringField(body, "engine_id") ? { engineId: optionalStringField(body, "engine_id") } : {}),
        ...(optionalStringField(body, "model") ? { model: optionalStringField(body, "model") } : {}),
        ...(optionalStringField(body, "secret_ref") ? { secretRef: optionalStringField(body, "secret_ref") } : {}),
        ...(body.currency_limit === undefined ? {} : { currencyLimit: nonnegativeNumberField(body, "currency_limit") }),
        ...(body.token_limit === undefined ? {} : { tokenLimit: nonnegativeNumberField(body, "token_limit") }),
        ...(body.clear_engine_id === undefined ? {} : { clearEngineId: booleanField(body, "clear_engine_id") }),
        ...(body.clear_model === undefined ? {} : { clearModel: booleanField(body, "clear_model") }),
        ...(body.clear_secret_ref === undefined ? {} : { clearSecretRef: booleanField(body, "clear_secret_ref") }),
        ...(body.clear_currency_limit === undefined ? {} : { clearCurrencyLimit: booleanField(body, "clear_currency_limit") }),
        ...(body.clear_token_limit === undefined ? {} : { clearTokenLimit: booleanField(body, "clear_token_limit") }),
        ...(body.remove_override === undefined ? {} : { removeOverride: booleanField(body, "remove_override") }),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) {
        if (scope.kind === "room") {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: scope.roomId!, kind: "learning.settings.updated" });
          learningRunner.schedule(context, { roomId: scope.roomId });
        } else {
          await emitAuthorizedWorkspaceEvent(io, store, { workspaceId: context.workspaceId, kind: "learning.settings.updated" });
          learningRunner.schedule(context);
        }
      }
      return saved;
    });
    res.json({ settings: publicLearningSettings(result.settings), replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/learning/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    res.json({ jobs: await learning.listJobs(workspaceContext(req), { roomId, ...(queryString(req, "status") ? { status: learningJobStatus(queryString(req, "status")!) } : {}), ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}) }) });
  }));

  app.get("/api/workspaces/:workspaceId/learning/jobs/:jobId/attempts", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ attempts: await learning.listJobAttempts(workspaceContext(req), pathParam(req, "jobId")) });
  }));

  // Server 04 completion contract. These routes are deliberately separate
  // from the legacy /learning store: they read file-backed bodies only via
  // the Workspace Server Command boundary.
  app.post("/api/workspaces/:workspaceId/completion/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.ingestCompletionActivity(context, {
        ...(optionalStringField(body, "activity_id") ? { id: optionalStringField(body, "activity_id") } : {}),
        roomId: stringField(body, "room_id"),
        ...(optionalStringField(body, "episode_id") ? { episodeId: optionalStringField(body, "episode_id") } : {}),
        ...(optionalStringField(body, "goal") ? { goal: optionalStringField(body, "goal") } : {}),
        sourceApp: stringField(body, "source_app"),
        ...(optionalStringField(body, "source_id") ? { sourceId: optionalStringField(body, "source_id") } : {}),
        ...(optionalStringField(body, "external_episode_key") ? { externalEpisodeKey: optionalStringField(body, "external_episode_key") } : {}),
        ...(optionalStringField(body, "correction_of_activity_id") ? { correctionOfActivityId: optionalStringField(body, "correction_of_activity_id") } : {}),
        ...(optionalStringField(body, "operation_id") ? { operationId: optionalStringField(body, "operation_id") } : {}),
        instructionSummary: stringField(body, "instruction_summary"),
        ...(optionalStringField(body, "result_summary") ? { resultSummary: optionalStringField(body, "result_summary") } : {}),
        ...(body.changed_resources === undefined ? {} : { changedResources: stringArrayField(body, "changed_resources") }),
        verificationOutcome: completionVerificationField(body, "verification_outcome"),
        failureState: completionFailureField(body, "failure_state"),
        outcome: completionOutcomeField(body, "outcome"),
        ...(body.explicit_remember === undefined ? {} : { explicitRemember: booleanField(body, "explicit_remember") }),
        ...(body.payload === undefined ? {} : { payload: completionPayloadField(body, "payload") }),
        ...(body.session_ref === undefined ? {} : { sessionRef: completionSessionRefField(body, "session_ref") })
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.activity.roomId, kind: "completion.activity.ingested" });
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/activities/:activityId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ activity: await completion.getActivity(workspaceContext(req), pathParam(req, "activityId")) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/activities/:activityId/evidence", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ evidence: await completion.listActivityEvidence(workspaceContext(req), pathParam(req, "activityId"), queryNumber(req, "limit")) });
  }));

  app.post("/api/workspaces/:workspaceId/completion/episodes", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.createCompletionEpisode(operationContext(req), {
      ...(optionalStringField(body, "episode_id") ? { id: optionalStringField(body, "episode_id") } : {}),
      roomId: stringField(body, "room_id"), goal: stringField(body, "goal"),
      ...(optionalStringField(body, "source_app") ? { sourceApp: optionalStringField(body, "source_app") } : {}),
      ...(optionalStringField(body, "external_episode_key") ? { externalEpisodeKey: optionalStringField(body, "external_episode_key") } : {}),
      ...(body.session_ref === undefined ? {} : { sessionRef: completionSessionRefField(body, "session_ref") })
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/episodes/:episodeId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const episodeId = pathParam(req, "episodeId");
    const [episode, activities] = await Promise.all([completion.getEpisode(context, episodeId), completion.listEpisodeActivities(context, episodeId, queryNumber(req, "limit"))]);
    res.json({ episode, activities });
  }));
  app.get("/api/workspaces/:workspaceId/completion/episodes/:episodeId/evidence", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ evidence: await completion.listEpisodeEvidence(workspaceContext(req), pathParam(req, "episodeId"), queryNumber(req, "limit")) });
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.createCompletionResource(context, completionResourceInput(body));
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.created");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.put("/api/workspaces/:workspaceId/completion/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const input = completionResourceInput(body);
      if (input.expectedVersion === undefined) throw new WorkspaceServerError("workspace_completion_resource_version_required", 400);
      const saved = await commands.updateCompletionResource(context, pathParam(req, "resourceId"), input as typeof input & { expectedVersion: number });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const kind = queryString(req, "kind");
    const page = await completion.listResourcesPage(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      ...(kind ? { kind: completionResourceKind(kind) } : {}),
      ...(queryString(req, "include_archived") === "true" ? { includeArchived: true } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ resources: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const resourceId = pathParam(req, "resourceId");
    const [current, versions, evidence] = await Promise.all([
      completion.getResource(context, resourceId),
      completion.listResourceVersions(context, resourceId, queryNumber(req, "versions_limit")),
      completion.listEvidence(context, resourceId, queryNumber(req, "evidence_limit"))
    ]);
    res.json({ resource: current.resource, current_version: current.version, versions, evidence });
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId/body", authenticateWorkspace, asyncRoute(async (req, res) => {
    const version = queryNumber(req, "version");
    res.json(await completion.getResourceBody(workspaceContext(req), pathParam(req, "resourceId"), version));
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/fixed", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.setCompletionResourceFixed(context, { resourceId: pathParam(req, "resourceId"), fixed: booleanField(body, "fixed"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.setCompletionResourceArchived(context, { resourceId: pathParam(req, "resourceId"), archived: booleanField(body, "archived"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/redact", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const resource = await completion.getResource(workspaceContext(req), pathParam(req, "resourceId"));
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.redactCompletionResource(context, { resourceId: pathParam(req, "resourceId"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.redacted");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/jobs/raw-outputs/:rawOutputId/redact", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.redactCompletionRawJobOutput(operationContext(req), {
      rawOutputId: pathParam(req, "rawOutputId"), reason: stringField(body, "reason")
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/promote", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.promoteCompletionCandidate(context, { resourceId: pathParam(req, "resourceId"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.promoted");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/copy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.copyCompletionResource(context, {
        resourceId: pathParam(req, "resourceId"), targetScope: completionTargetScopeField(body),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.copied");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/move", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.moveCompletionResource(context, {
        resourceId: pathParam(req, "resourceId"), targetRoomId: stringField(body, "target_room_id"),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.moved");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/promote-to-workspace", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.promoteCompletionResourceToWorkspace(context, {
        resourceId: pathParam(req, "resourceId"), ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.promoted_to_workspace");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/knowledge/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_completion_search_input_required", 400);
    const page = await completion.searchKnowledgePage(workspaceContext(req), {
      roomId,
      query,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ resources: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/skills/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_completion_search_input_required", 400);
    const page = await completion.searchSkillsPage(workspaceContext(req), {
      roomId,
      query,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ skills: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/skills", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completion.listSkillsPage(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ skills: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId/files", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ files: await completion.listSkillFiles(workspaceContext(req), pathParam(req, "resourceId"), queryNumber(req, "version"), queryNumber(req, "limit")) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await completion.getSkillFile(workspaceContext(req), pathParam(req, "resourceId"), wildcardParam(req.params.filePath), queryNumber(req, "version"));
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-samurai-file-sha256", result.file.contentHash);
    res.send(result.content);
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getSkillDocument(workspaceContext(req), pathParam(req, "resourceId"), queryNumber(req, "version")));
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/uses", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.recordCompletionUse(context, {
        ...(optionalStringField(body, "use_id") ? { id: optionalStringField(body, "use_id") } : {}), resourceId: pathParam(req, "resourceId"),
        resourceVersion: numberField(body, "resource_version"), ...(optionalStringField(body, "activity_id") ? { activityId: optionalStringField(body, "activity_id") } : {}),
        ...(optionalStringField(body, "episode_id") ? { episodeId: optionalStringField(body, "episode_id") } : {}), event: completionUseEventField(body, "event"),
        ...(optionalStringField(body, "outcome") ? { outcome: completionUseOutcomeField(body, "outcome") } : {}),
        ...(optionalStringField(body, "supersedes_use_id") ? { supersedesUseId: optionalStringField(body, "supersedes_use_id") } : {}), summary: stringField(body, "summary")
      });
      if (!saved.replayed) {
        const resource = await completion.getResource(workspaceContext(req), saved.use.resourceId);
        await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.used");
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/evaluations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.recordCompletionEvaluation(context, {
        ...(optionalStringField(body, "evaluation_id") ? { id: optionalStringField(body, "evaluation_id") } : {}), resourceId: stringField(body, "resource_id"), resourceVersion: numberField(body, "resource_version"),
        episodeId: stringField(body, "episode_id"), outcome: completionUseOutcomeField(body, "outcome"),
        ...(optionalStringField(body, "source_activity_id") ? { sourceActivityId: optionalStringField(body, "source_activity_id") } : {}),
        ...(optionalStringField(body, "correction_of_evaluation_id") ? { correctionOfEvaluationId: optionalStringField(body, "correction_of_evaluation_id") } : {})
      });
      if (!saved.replayed) {
        const resource = await completion.getResource(workspaceContext(req), saved.evaluation.resourceId);
        await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.evaluated");
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId/evaluations", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.listEvaluations(workspaceContext(req), {
      resourceId: pathParam(req, "resourceId"),
      ...(queryNumber(req, "version") ? { resourceVersion: queryNumber(req, "version") } : {}),
      ...(queryString(req, "episode_id") ? { episodeId: queryString(req, "episode_id")! } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));

  app.get("/api/workspaces/:workspaceId/completion/configuration", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json({ configuration: await completion.getEffectiveConfiguration(workspaceContext(req), roomId) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/maintenance", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await maintenance.getIdentity(workspaceContext(req)));
  }));
  app.put("/api/workspaces/:workspaceId/completion/maintenance", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const saved = await commands.configureCompletionMaintenanceIdentity(operationContext(req), { accountId: stringField(body, "account_id") });
    res.json(saved);
  }));
  app.get("/api/workspaces/:workspaceId/completion/migrations/legacy", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ preview: await completionMigrations.previewLegacy(workspaceContext(req)) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/migrations/legacy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.migrateCompletionLegacy(operationContext(req), {
      ...(body.dry_run === undefined ? {} : { dryRun: booleanField(body, "dry_run") })
    });
    res.json(result);
  }));
  app.put("/api/workspaces/:workspaceId/completion/configuration", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.updateCompletionConfiguration(operationContext(req), {
      scope: completionScopeField(body),
      ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
      values: objectField(body, "values")
    });
    res.json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/startup-context", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const operation = queryString(req, "operation");
    if (!roomId || !operation) throw new WorkspaceServerError("workspace_completion_startup_context_input_required", 400);
    res.json(await completion.getStartupContext(workspaceContext(req), { roomId, operation: completionPolicyOperation(operation) }));
  }));

  app.get("/api/workspaces/:workspaceId/completion/profile", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getWorkspaceDocument(workspaceContext(req), "profile"));
  }));
  app.put("/api/workspaces/:workspaceId/completion/profile", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await commands.writeCompletionWorkspaceDocument(operationContext(req), { kind: "profile", content: stringField(body, "content"), expectedVersion: numberField(body, "expected_version") }));
  }));
  app.get("/api/workspaces/:workspaceId/completion/soul", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getWorkspaceDocument(workspaceContext(req), "soul"));
  }));
  app.put("/api/workspaces/:workspaceId/completion/soul", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await commands.writeCompletionWorkspaceDocument(operationContext(req), { kind: "soul", content: stringField(body, "content"), expectedVersion: numberField(body, "expected_version") }));
  }));

  app.post("/api/workspaces/:workspaceId/completion/policies/requests", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.requestCompletionPolicyChange(operationContext(req), {
      ...(optionalStringField(body, "request_id") ? { id: optionalStringField(body, "request_id") } : {}), roomId: stringField(body, "room_id"), summary: stringField(body, "summary"), proposedRules: body.proposed_rules,
      ...(optionalStringField(body, "source_job_id") ? { sourceJobId: optionalStringField(body, "source_job_id") } : {})
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.applyCompletionPolicy(operationContext(req), {
      ...(optionalStringField(body, "policy_id") ? { id: optionalStringField(body, "policy_id") } : {}), scope: completionScopeField(body), title: stringField(body, "title"), content: stringField(body, "content"),
      rules: body.rules, reason: stringField(body, "reason"),
      ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
      ...(body.enabled === undefined ? {} : { enabled: booleanField(body, "enabled") })
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const page = await completion.listResourcesPage(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      kind: "policy",
      includeArchived: queryString(req, "include_archived") === "true",
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ policies: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/requests", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ requests: await completion.listPolicyChangeRequests(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/:policyId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getPolicy(workspaceContext(req), pathParam(req, "policyId")));
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/:policyId/audit", authenticateWorkspace, asyncRoute(async (req, res) => {
    const policy = await completion.getPolicy(workspaceContext(req), pathParam(req, "policyId"));
    const entries = await store.listAuditEntries(workspaceContext(req), {
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      subjectKind: "completion_policy",
      subjectId: policy.resource.id
    });
    res.json({ entries });
  }));

  app.get("/api/workspaces/:workspaceId/completion/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completionJobs.listJobsPage(workspaceContext(req), {
      roomId,
      ...(queryString(req, "status") ? { status: completionJobStatusField(queryString(req, "status")!) } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ jobs: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/jobs/:jobId/attempts", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ attempts: await completionJobs.listAttempts(workspaceContext(req), pathParam(req, "jobId"), queryNumber(req, "limit")) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/curator", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json(await curator.getStatus(workspaceContext(req), roomId));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/dry-run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await curator.dryRun(workspaceContext(req), stringField(body, "room_id")));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/semantic/dry-run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    if (!options.semanticCuratorPort) throw new WorkspaceServerError("workspace_completion_semantic_curator_unavailable", 503);
    res.json(await curator.runSemantic(operationContext(req), {
      roomId: stringField(body, "room_id"), port: options.semanticCuratorPort, dryRun: true
    }));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await curator.runLight(operationContext(req), { roomId: stringField(body, "room_id"), ...(body.dry_run === undefined ? {} : { dryRun: booleanField(body, "dry_run") }) }));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/pause", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.setPaused(operationContext(req), { roomId: stringField(body, "room_id"), paused: true }); res.status(204).end();
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/resume", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.setPaused(operationContext(req), { roomId: stringField(body, "room_id"), paused: false }); res.status(204).end();
  }));
  app.put("/api/workspaces/:workspaceId/completion/curator/semantic", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await curator.setSemanticEnabled(operationContext(req), { roomId: stringField(body, "room_id"), enabled: booleanField(body, "enabled") });
    res.status(204).end();
  }));
  app.get("/api/workspaces/:workspaceId/completion/curator/snapshots", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id"); if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json({ snapshots: await curator.listSnapshots(workspaceContext(req), roomId) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/snapshots/:snapshotId/rollback", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.rollbackSnapshot(operationContext(req), { roomId: stringField(body, "room_id"), snapshotId: pathParam(req, "snapshotId") }); res.status(204).end();
  }));
  app.get("/api/workspaces/:workspaceId/completion/curator/archives", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completion.listArchivedAiResourcesPage(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ archives: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/archives/:resourceId/restore", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const current = await completion.getResource(workspaceContext(req), pathParam(req, "resourceId"));
      if (current.resource.scope.kind !== "room" || current.resource.scope.roomId !== roomId
        || current.resource.creationSource !== "ai" || !current.resource.aiManaged || current.resource.lifecycleState !== "archived") {
        throw new WorkspaceServerError("workspace_completion_curator_archive_not_found", 404);
      }
      const saved = await commands.setCompletionResourceArchived(context, {
        resourceId: current.resource.id,
        archived: false,
        expectedVersion: numberField(body, "expected_version"),
        reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.curator.archive_restored");
      return saved;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/records", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_records_room_id_required", 400);
    const recordType = queryString(req, "record_type");
    if (recordType && internalWorkspaceRecordTypes.has(recordType)) throw new WorkspaceServerError("workspace_record_not_found", 404);
    const records = await store.listRecords(workspaceContext(req), {
      roomId,
      ...(recordType ? { recordType } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_record_room_id_required", 400);
    if (internalWorkspaceRecordTypes.has(pathParam(req, "recordType"))) throw new WorkspaceServerError("workspace_record_not_found", 404);
    res.json({ record: await store.getRecord(workspaceContext(req), { roomId, recordType: pathParam(req, "recordType"), id: pathParam(req, "recordId") }) });
  }));

  app.put("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    if (internalWorkspaceRecordTypes.has(pathParam(req, "recordType"))) throw new WorkspaceServerError("workspace_record_not_found", 404);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.putRecord(operationContext(req), {
        roomId: stringField(body, "room_id"),
        recordType: pathParam(req, "recordType"),
        id: pathParam(req, "recordId"),
        expectedVersion: numberField(body, "expected_version"),
        payload: objectField(body, "payload"),
        ...(optionalStringField(body, "search_text") ? { searchText: optionalStringField(body, "search_text") } : {})
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.json(result);
  }));

  app.delete("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    if (internalWorkspaceRecordTypes.has(pathParam(req, "recordType"))) throw new WorkspaceServerError("workspace_record_not_found", 404);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const deleted = await commands.deleteRecord(operationContext(req), {
        roomId: stringField(body, "room_id"),
        recordType: pathParam(req, "recordType"),
        id: pathParam(req, "recordId"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!deleted.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, deleted.event);
      return deleted;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const query = queryString(req, "q");
    if (!query) throw new WorkspaceServerError("workspace_search_query_required", 400);
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_search_room_id_required", 400);
    const records = await store.searchRecords(workspaceContext(req), {
      query,
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_events_room_id_required", 400);
    const events = await store.listEvents(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ events });
  }));

  app.get("/api/workspaces/:workspaceId/audit", authenticateWorkspace, asyncRoute(async (req, res) => {
    const entries = await store.listAuditEntries(workspaceContext(req), {
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ entries });
  }));

  app.post("/api/workspaces/:workspaceId/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.putJob(operationContext(req), {
        roomId: stringField(body, "room_id"),
        ...(optionalStringField(body, "job_id") ? { id: optionalStringField(body, "job_id") } : {}),
        kind: stringField(body, "kind"),
        idempotencyKey: stringField(body, "idempotency_key"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
        ...(optionalStringField(body, "status") ? { status: jobStatusField(body, "status") } : {}),
        payload: objectField(body, "payload")
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json({ job: result.job, replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const filePath = wildcardParam(req.params.filePath);
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_file_room_id_required", 400);
    const read = await files.read(workspaceContext(req), { roomId, path: filePath });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-samurai-file-version", String(read.file.version));
    res.setHeader("x-samurai-file-sha256", read.file.sha256);
    res.send(read.content);
  }));

  app.put("/api/workspaces/:workspaceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const filePath = wildcardParam(req.params.filePath);
    const content = Buffer.from(stringField(body, "content_base64"), "base64");
    if (content.byteLength > 8 * 1024 * 1024) throw new WorkspaceServerError("workspace_file_too_large", 413);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.writeFile(operationContext(req), {
        roomId: stringField(body, "room_id"),
        path: filePath,
        content,
        expectedVersion: numberField(body, "expected_version")
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.json({ file: result.file, event: result.event, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/transfers", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const result = await commands.beginTransfer(context);
    res.status(201).json({
      transfer_id: result.transferId,
      manifest: result.manifest,
      bundle_download_path: `/api/workspaces/${encodeURIComponent(context.workspaceId)}/transfers/${encodeURIComponent(result.transferId)}/bundle`
    });
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/bundle", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const transferId = pathParam(req, "transferId");
    const transfer = await completionBundles.getTransferBundle(context, transferId);
    const transport = await readWorkspaceBundleV4Transport(transfer.directory);
    res.setHeader("content-type", "application/vnd.samurai.workspace-bundle-v4+json");
    res.json(transport);
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/manifest", authenticateWorkspace, asyncRoute(async (req, res) => {
    const transfer = await completionBundles.getTransferBundle(workspaceContext(req), pathParam(req, "transferId"));
    res.json({ manifest: transfer.manifest });
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/entries/{*entryPath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const entry = await completionBundles.getTransferEntry(workspaceContext(req), pathParam(req, "transferId"), wildcardParam(req.params.entryPath));
    res.setHeader("content-type", entry.contentType);
    res.send(entry.content);
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/receipt", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await commands.recordTransferReceipt(operationContext(req), {
      transferId: pathParam(req, "transferId"),
      targetWorkspaceId: stringField(body, "target_workspace_id"),
      receipt: transferReceiptField(body, "receipt")
    });
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/rollback", authenticateWorkspace, asyncRoute(async (req, res) => {
    await commands.rollbackTransfer(operationContext(req), pathParam(req, "transferId"));
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/complete", authenticateWorkspace, asyncRoute(async (req, res) => {
    await commands.completeTransfer(operationContext(req), pathParam(req, "transferId"));
    res.status(204).end();
  }));

  const socketRateGuard = createRateGuard({ windowMs: 60_000, limit: config.publicNetwork ? 30 : 120 });
  io.use(async (socket, next) => {
    try {
      if (!socketRateGuard(socket.handshake.address || "unknown")) throw new WorkspaceServerError("workspace_rate_limit_exceeded", 429);
      const auth = objectBody(socket.handshake.auth);
      const accountId = stringField(auth, "account_id");
      const requestId = stringField(auth, "request_id");
      const timestamp = stringField(auth, "timestamp");
      const signature = stringField(auth, "signature");
      const workspaceId = resolveRequestWorkspaceId(config, optionalStringField(auth, "workspace_id"));
      const publicKey = await store.getAccountPublicKey(accountId);
      if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
      verifyAccountSignature({
        signed: { accountId, requestId, timestamp, signature },
        publicKey,
        payload: { method: "SOCKET", path: "/socket.io", workspaceId, requestId, timestamp, body: {} }
      });
      await store.getWorkspace({ workspaceId, accountId });
      await assertNotCompletionMaintenanceIdentity(store, { workspaceId, accountId });
      socket.data.samurai = { workspaceId, accountId };
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("socket_authentication_failed"));
    }
  });

  io.on("connection", (socket) => {
    const identity = socket.data.samurai as { workspaceId: string; accountId: string };
    socket.join(workspaceSocketRoom(identity.workspaceId));
    socket.on("workspace:subscribe-room", async (input: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const body = objectBody(input);
        const roomId = stringField(body, "room_id");
        await realtimeGate.run(identity.workspaceId, async () => {
          await store.assertRoomReadable(identity, roomId);
          socket.join(roomSocketRoom(identity.workspaceId, roomId));
        });
        acknowledge?.({ ok: true });
      } catch (error) {
        acknowledge?.({ ok: false, error: publicError(error) });
      }
    });
    socket.on("workspace:resync", async (input: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const body = objectBody(input);
        const roomId = stringField(body, "room_id");
        const events = await realtimeGate.run(identity.workspaceId, async () => {
          await store.assertRoomReadable(identity, roomId);
          return store.listEvents(identity, {
            roomId,
            ...(typeof body.after === "number" ? { afterId: body.after } : {})
          });
        });
        acknowledge?.({ ok: true, events });
      } catch (error) {
        acknowledge?.({ ok: false, error: publicError(error) });
      }
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.code, ...(normalized.details ? { details: normalized.details } : {}) });
  });

  await workerSupervisor.start();

  return {
    app,
    httpServer,
    io,
    config,
    workerSupervisor,
    async close(): Promise<void> {
      const failures: unknown[] = [];
      try {
        await workerSupervisor.stop();
        const workerStatus = workerSupervisor.status();
        if (workerStatus.stopReason === "shutdown_close_failed") {
          failures.push(new Error(workerStatus.lastError?.message ?? "workspace_worker_shutdown_failed"));
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        await new Promise<void>((resolve) => io.close(() => resolve()));
      } catch (error) {
        failures.push(error);
      }
      try {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        externalIntegration.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await core.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, "workspace_server_shutdown_failed");
    }
  };
}

export async function startWorkspaceServer(config = loadWorkspaceServerConfig()): Promise<WorkspaceServerHttp> {
  const server = await createWorkspaceServerHttp(config);
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(config.port, config.bindAddress, () => {
      server.httpServer.off("error", reject);
      resolve();
    });
  });
  console.log(`Samurai Workspace Server listening on http://${config.bindAddress}:${config.port}`);
  return server;
}

function accountAuthenticator(store: WorkspaceServerStore) {
  return asyncRoute(async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const signed = signedHeaders(req);
    const publicKey = await store.getAccountPublicKey(signed.accountId);
    if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
    const payload = signedRequestPayload(req);
    verifyAccountSignature({
      signed,
      publicKey,
      payload
    });
    req.samurai = {
      accountId: signed.accountId,
      requestId: signed.requestId,
      timestamp: signed.timestamp,
      signature: signed.signature,
      canonicalPayloadHash: hashCanonicalSignedPayload(payload),
      publicKey,
      signedPayload: payload
    };
    next();
  });
}

function workspaceAuthenticator(
  store: WorkspaceServerStore,
  config: WorkspaceServerConfig,
  options: { requireMembership?: boolean } = {}
) {
  return asyncRoute(async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const signed = signedHeaders(req);
    const headerWorkspaceId = req.header("x-samurai-workspace-id")?.trim();
    const pathWorkspaceId = optionalPathParam(req, "workspaceId");
    if (headerWorkspaceId && pathWorkspaceId && headerWorkspaceId !== pathWorkspaceId) throw new WorkspaceServerError("workspace_id_mismatch", 400);
    const workspaceId = resolveRequestWorkspaceId(config, pathWorkspaceId || headerWorkspaceId);
    const publicKey = await store.getAccountPublicKey(signed.accountId);
    if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
    const payload = signedRequestPayload(req, workspaceId);
    verifyAccountSignature({
      signed: { accountId: signed.accountId, requestId: signed.requestId, timestamp: signed.timestamp, signature: stringHeader(req, "x-samurai-signature") },
      publicKey,
      payload
    });
    if (options.requireMembership !== false) {
      await store.getWorkspace({ workspaceId, accountId: signed.accountId });
      await assertNotCompletionMaintenanceIdentity(store, { workspaceId, accountId: signed.accountId });
    }
    req.samurai = {
      accountId: signed.accountId,
      requestId: signed.requestId,
      timestamp: signed.timestamp,
      signature: signed.signature,
      canonicalPayloadHash: hashCanonicalSignedPayload(payload),
      publicKey,
      signedPayload: payload,
      workspaceId
    };
    next();
  });
}

function signedHeaders(req: Request): { accountId: string; requestId: string; timestamp: string; signature: string } {
  return {
    accountId: stringHeader(req, "x-samurai-account-id"),
    requestId: stringHeader(req, "x-samurai-request-id"),
    timestamp: stringHeader(req, "x-samurai-timestamp"),
    signature: stringHeader(req, "x-samurai-signature")
  };
}

function workspaceContext(req: Request): Pick<WorkspaceRequestContext, "workspaceId" | "accountId"> {
  const authenticatedRequest = authenticated(req);
  if (!authenticatedRequest.workspaceId) throw new WorkspaceServerError("workspace_id_required", 400);
  return { workspaceId: authenticatedRequest.workspaceId, accountId: authenticatedRequest.accountId };
}

/** The scheduler's separate Account is intentionally database-only.  Its
 * signing key must not become a second human/Native-App mutation path. */
async function assertNotCompletionMaintenanceIdentity(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">
): Promise<void> {
  const result = await store.database.withContext(context, async (sql) =>
    sql.query<{ allowed: boolean }>("SELECT samurai_is_completion_maintenance_identity($1) AS allowed", [context.workspaceId])
  );
  if (result.rows[0]?.allowed === true) throw new WorkspaceServerError("workspace_completion_maintenance_http_forbidden", 403);
}

function operationContext(req: Request): WorkspaceRequestContext {
  const context = workspaceContext(req);
  const signed = authenticated(req);
  const operationId = assertOpaqueId(stringHeader(req, "x-samurai-operation-id"), "workspace_operation_id_invalid");
  return {
    ...context,
    operationId,
    caller: createVerifiedWorkspaceHumanCaller({
      signed: {
        accountId: signed.accountId,
        requestId: signed.requestId,
        timestamp: signed.timestamp,
        signature: signed.signature
      },
      publicKey: signed.publicKey,
      payload: signed.signedPayload,
      operationId
    })
  };
}

function postgresRuntimeCommands(
  database: WorkspaceServerCore["database"],
  config: WorkspaceServerConfig,
  backendRegistry: ReturnType<typeof createDefaultAgentBackendRegistry>,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId"> & Partial<Pick<WorkspaceRequestContext, "operationId">>,
  io: SocketServer,
  store: WorkspaceServerStore,
  knowledgeMemory: PostgresKnowledgeMemory,
  onCompletionActivity?: (event: PostgresRuntimeChatCompletionEvent) => Promise<void>
): PostgresRuntimeCommandService {
  const clientEvents = new PostgresRuntimeClientEvents(database, store);
  let runtimeCommands: PostgresRuntimeCommandService;
  runtimeCommands = new PostgresRuntimeCommandService({
    database,
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    ...(context.operationId ? { operationId: context.operationId } : {}),
    backendRegistry,
    knowledgeMemory,
    agentWorktreeRoot: path.join(config.storageRoot, "agent-worktrees", context.workspaceId),
    coreWorkspaceRoot: path.join(config.storageRoot, "workspaces"),
    readWorkspaceFile: async (fileContext, roomId, ref) => {
      if (ref.kind !== "file") throw new WorkspaceServerError("runtime_workspace_attachment_kind_invalid", 400);
      const file = await new WorkspaceFileStore(store).read(fileContext, { roomId, path: ref.uri });
      return { path: file.file.path, version: file.file.version, sha256: file.file.sha256, content: file.content };
    },
    ...(onCompletionActivity ? { onCompletionActivity } : {}),
    onEvent: async (event: BackendEventRecord, roomId: string) => {
      await emitAuthorizedRoomWorkspaceEvent(io, store, {
        workspaceId: context.workspaceId,
        roomId,
        kind: "runtime.event.created"
      });
      if (event.event_type !== "run_completed" && event.event_type !== "run_failed" && event.event_type !== "backend_waiting_for_native_input") return;
      const run = await runtimeCommands.getBackendRun(event.run_id);
      if (!run) return;
      const notification = PostgresRuntimeClientEvents.notificationForRun(run);
      if (!notification) return;
      const operationId = `client_event_save_${createHash("sha256").update(`${context.workspaceId}|${notification.id}`).digest("hex").slice(0, 40)}`;
      await clientEvents.save({ workspaceId: context.workspaceId, accountId: context.accountId, operationId }, notification);
    }
  });
  return runtimeCommands;
}

/** Converts a settled PG Runtime run into the product's formal Completion
 * Activity. Runtime's detailed operational ledger remains the source for
 * execution state; Completion receives a stable, Room-scoped evidence row. */
async function recordPostgresChatCompletionActivity(
  commands: WorkspaceServerCore["commands"],
  context: WorkspaceRequestContext,
  event: PostgresRuntimeChatCompletionEvent
): Promise<void> {
  const roomId = event.session.room_id;
  if (!roomId) return;
  const outcome = event.run.status === "completed"
    ? "completed"
    : event.run.status === "cancelled"
      ? "cancelled"
      : event.run.status === "outcome_unknown"
        ? "unknown"
    : event.run.status === "waiting_for_backend_input"
      ? "unknown"
      : "failed";
  const changedResources = [event.operation?.result_ref?.id, event.run.output_message_id].filter((value): value is string => Boolean(value));
  await commands.ingestCompletionActivity(context, {
    id: `completion_activity_${createHash("sha256").update(`${context.workspaceId}|${event.run.id}`).digest("hex").slice(0, 48)}`,
    roomId,
    sourceApp: "samurai-workspace-chat",
    sourceId: event.run.id,
    ...(event.operation ? { operationId: event.operation.id } : {}),
    instructionSummary: event.instructionSummary,
    ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    changedResources,
    verificationOutcome: outcome === "completed" ? "not_run" : outcome === "unknown" ? "unknown" : "failed",
    failureState: outcome === "completed" ? "none" : "unresolved",
    outcome,
    payload: {
      backend_id: event.run.backend_id,
      runtime_run_id: event.run.id,
      runtime_status: event.run.status,
      ...(event.run.error_code ? { error_code: event.run.error_code } : {})
    },
    ...(event.run.session_ref ? {
      sessionRef: {
        appId: event.run.session_ref.app_id,
        ...(event.run.session_ref.session_id ? { sessionId: event.run.session_ref.session_id } : {})
      }
    } : {})
  });
}

function signedRequestPayload(req: Request, workspaceId?: string): {
  method: string;
  path: string;
  workspaceId?: string;
  operationId?: string;
  idempotencyKey?: string;
  requestId: string;
  timestamp: string;
  body: unknown;
} {
  const signed = signedHeaders(req);
  return {
    method: req.method,
    path: req.path,
    ...(workspaceId ? { workspaceId } : {}),
    ...(req.header("x-samurai-operation-id") ? { operationId: stringHeader(req, "x-samurai-operation-id") } : {}),
    ...(req.header("idempotency-key") ? { idempotencyKey: stringHeader(req, "idempotency-key") } : {}),
    requestId: signed.requestId,
    timestamp: signed.timestamp,
    body: req.body ?? {}
  };
}

function hashCanonicalSignedPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function authenticated(req: Request): NonNullable<AuthenticatedRequest["samurai"]> {
  const value = (req as AuthenticatedRequest).samurai;
  if (!value) throw new WorkspaceServerError("account_authentication_required", 401);
  return value;
}

async function emitLearningResourceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  workspaceId: string,
  resource: { scope: WorkspaceLearningScope },
  kind: string
): Promise<void> {
  if (resource.scope.kind === "room") {
    await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId, roomId: resource.scope.roomId!, kind });
    return;
  }
  await emitAuthorizedWorkspaceEvent(io, store, { workspaceId, kind });
}

async function emitCompletionResourceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  workspaceId: string,
  resource: { scope: WorkspaceCompletionScope },
  kind: string
): Promise<void> {
  if (resource.scope.kind === "room") {
    await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId, roomId: resource.scope.roomId!, kind });
    return;
  }
  await emitAuthorizedWorkspaceEvent(io, store, { workspaceId, kind });
}

/** Workspace-wide events contain no Room identity. Every recipient is still
 * checked at delivery time so a stale socket cannot observe post-revocation
 * configuration or Workspace-scoped Knowledge changes. */
async function emitAuthorizedWorkspaceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  event: { workspaceId: string; kind?: string }
): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== event.workspaceId || !identity.accountId) continue;
    try {
      await store.getWorkspace({ workspaceId: event.workspaceId, accountId: identity.accountId });
      socket.emit("workspace:event", event);
    } catch {
      socket.emit("workspace:access-revoked", { workspaceId: event.workspaceId });
      socket.disconnect(true);
    }
  }
}

/**
 * A Room event is never broadcast to the Workspace as a whole.  A socket is
 * checked again immediately before delivery, inside the same local gate used
 * by hierarchy and membership changes.  This closes the post-commit window
 * where a stale Socket.IO room subscription could otherwise disclose an
 * event after its access was revoked.
 *
 * Hierarchy events also reach directly-authorized Workspace sockets that have
 * not yet joined the new Room channel.  That lets their tree refresh without
 * revealing the Room to parent-only members.
 */
async function emitAuthorizedRoomWorkspaceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  event: { workspaceId: string; roomId: string; kind?: string }
): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== event.workspaceId || !identity.accountId) continue;
    const roomChannel = roomSocketRoom(event.workspaceId, event.roomId);
    const wasSubscribed = socket.rooms.has(roomChannel);
    let delivered = false;
    try {
      delivered = await store.deliverRoomRealtimeIfReadable(
        { workspaceId: event.workspaceId, accountId: identity.accountId },
        event.roomId,
        () => { socket.emit("workspace:event", event); }
      );
    } catch {
      delivered = false;
    }
    if (!delivered) {
      socket.leave(roomChannel);
      // A Socket that never knew this Room must receive no Room identifier.
      // Otherwise a normal hidden-Room update becomes an existence oracle.
      if (wasSubscribed) {
        socket.emit("workspace:room-access-revoked", { workspaceId: event.workspaceId, roomId: event.roomId });
      }
      continue;
    }
  }
}

async function revalidateWorkspaceMemberSockets(io: SocketServer, store: WorkspaceServerStore, workspaceId: string, accountId: string): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== workspaceId || identity.accountId !== accountId) continue;
    try {
      await store.getWorkspace({ workspaceId, accountId });
    } catch {
      socket.emit("workspace:access-revoked", { workspaceId });
      socket.disconnect(true);
      continue;
    }
    socket.emit("workspace:access-changed", { workspaceId });
    for (const joinedRoom of socket.rooms) {
      const prefix = `workspace:${workspaceId}:room:`;
      if (!joinedRoom.startsWith(prefix)) continue;
      const roomId = joinedRoom.slice(prefix.length);
      try {
        await store.assertRoomReadable({ workspaceId, accountId }, roomId);
      } catch {
        socket.leave(joinedRoom);
        socket.emit("workspace:room-access-revoked", { workspaceId, roomId });
      }
    }
  }
}

async function revalidateRoomMemberSockets(io: SocketServer, store: WorkspaceServerStore, workspaceId: string, roomId: string, accountId: string): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId === workspaceId && identity.accountId === accountId) {
      const roomChannel = roomSocketRoom(workspaceId, roomId);
      const wasSubscribed = socket.rooms.has(roomChannel);
      try {
        await store.assertRoomReadable({ workspaceId, accountId }, roomId);
        socket.emit("workspace:room-access-changed", { workspaceId, roomId });
      } catch {
        socket.leave(roomChannel);
        // A connection which was never subscribed must not learn a hidden
        // Room id merely because an old/redundant revoke command is replayed
        // against its membership row.
        if (wasSubscribed) {
          socket.emit("workspace:room-access-revoked", { workspaceId, roomId });
        }
      }
    }
  }
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}

function requestRateGuard(options: { windowMs: number; limit: number }): (req: Request, res: Response, next: NextFunction) => void {
  const allow = createRateGuard(options);
  return (req, _res, next) => {
    if (!allow(req.ip || req.socket.remoteAddress || "unknown")) {
      next(new WorkspaceServerError("workspace_rate_limit_exceeded", 429));
      return;
    }
    next();
  };
}

function createRateGuard(options: { windowMs: number; limit: number }): (key: string) => boolean {
  const entries = new Map<string, { startedAt: number; count: number }>();
  return (key) => {
    const now = Date.now();
    if (entries.size > 10_000) {
      for (const [entryKey, entry] of entries) if (now - entry.startedAt >= options.windowMs) entries.delete(entryKey);
    }
    const existing = entries.get(key);
    if (!existing || now - existing.startedAt >= options.windowMs) {
      entries.set(key, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= options.limit;
  };
}

function collectionRecordFromBody(collectionId: string, body: Record<string, unknown>): CollectionRecord {
  const timestamp = nowIso();
  return {
    id: stringField(body, "record_id"),
    collection_id: collectionId,
    ...(body.version === undefined ? {} : { version: numberField(body, "version") }),
    data: jsonObjectField(body, "data"),
    resource_refs: body.resource_refs === undefined ? [] : resourceRefsField(body, "resource_refs"),
    created_at: optionalStringField(body, "created_at") ?? timestamp,
    updated_at: optionalStringField(body, "updated_at") ?? timestamp
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("request_body_invalid", 400);
  return value as Record<string, unknown>;
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError(`${key}_required`, 400);
  return value as Record<string, unknown>;
}

function jsonObjectField(body: Record<string, unknown>, key: string): Record<string, JsonValue> {
  const value = objectField(body, key);
  const encoded = JSON.stringify(value);
  if (encoded.length > 200_000 || !isJsonObject(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value as Record<string, JsonValue>;
}

function isJsonObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return isJsonObject(value);
  return false;
}

function supportedLocaleField(body: Record<string, unknown>, key: string): SupportedLocale {
  const value = stringField(body, key);
  if (!(supportedLocales as readonly string[]).includes(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value as SupportedLocale;
}

function learningExecutionResult(
  kind: string,
  jobs: ReadonlyArray<{ status: string; blockedReason?: string }>
): PostgresRuntimeAutomationExecutionResult {
  const blocked = jobs.find((job) => job.status === "blocked");
  if (blocked) return { status: "blocked", summary: `${kind} was blocked.`, errorCode: blocked.blockedReason ?? "automation_learning_job_blocked" };
  const failed = jobs.find((job) => job.status === "failed");
  if (failed) return { status: "failed", summary: `${kind} failed.`, errorCode: "automation_learning_job_failed" };
  const unsettled = jobs.find((job) => job.status === "queued" || job.status === "running");
  if (unsettled) return { status: "blocked", summary: `${kind} did not reach a terminal state.`, errorCode: "automation_learning_job_not_settled" };
  return {
    status: "completed",
    summary: jobs.length > 0 ? `${kind} settled ${jobs.length} Room-scoped learning job(s).` : `${kind} found no due Room-scoped learning job.`
  };
}

function completionExecutionResult(
  kind: string,
  result: { status: string; curatorStatus?: string; evaluationCount?: number }
): PostgresRuntimeAutomationExecutionResult {
  if (result.status === "blocked") return { status: "blocked", summary: `${kind} was blocked.`, errorCode: "automation_completion_job_blocked" };
  if (result.status === "failed" || result.status === "repairable_validation") return { status: "failed", summary: `${kind} failed.`, errorCode: "automation_completion_job_failed" };
  if (result.status === "stale_input") return { status: "failed", summary: `${kind} input changed before settlement.`, errorCode: "automation_completion_job_stale_input" };
  if (result.status === "idle") return { status: "completed", summary: `${kind} found no due Room-scoped job.` };
  return {
    status: "completed",
    summary: result.evaluationCount === undefined
      ? `${kind} completed${result.curatorStatus ? ` with status ${result.curatorStatus}` : ""}.`
      : `${kind} completed ${result.evaluationCount} evaluation(s).`
  };
}

function automationMaintenanceContext(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  const operationId = `automation_core_${createHash("sha256").update(`${context.operationId}:${suffix}`).digest("hex").slice(0, 40)}`;
  return {
    ...context,
    operationId,
    caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: context.accountId, operationId })
  };
}

async function runPostgresAutomationEvaluation(
  completion: WorkspaceCompletionService,
  completionJobs: WorkspaceCompletionJobService,
  context: WorkspaceRequestContext,
  input: { roomId: string; workerId: string; signal: AbortSignal }
): Promise<PostgresRuntimeAutomationExecutionResult> {
  if (input.signal.aborted) return { status: "failed", summary: "learning_evaluation was aborted.", errorCode: "automation_worker_aborted" };
  const maintenanceContext = automationMaintenanceContext(context, `${input.workerId}:evaluation:${input.roomId}`);
  await completion.enqueueEvaluationCatchup(maintenanceContext, { roomId: input.roomId, limit: 1 });
  const result = await completionJobs.runOneEvaluation(maintenanceContext, { workerId: input.workerId, roomId: input.roomId });
  return completionExecutionResult("learning_evaluation", result);
}

async function runPostgresAutomationCurator(
  completion: WorkspaceCompletionService,
  completionJobs: WorkspaceCompletionJobService,
  curator: WorkspaceCompletionCuratorService,
  context: WorkspaceRequestContext,
  input: { roomId: string; workerId: string; signal: AbortSignal }
): Promise<PostgresRuntimeAutomationExecutionResult> {
  if (input.signal.aborted) return { status: "failed", summary: "skill_curator was aborted.", errorCode: "automation_worker_aborted" };
  const maintenanceContext = automationMaintenanceContext(context, `${input.workerId}:curator:${input.roomId}`);
  const inputHash = await curator.inputHash(maintenanceContext, { roomId: input.roomId, mode: "light" });
  await completionJobs.enqueueCurator(maintenanceContext, { roomId: input.roomId, mode: "light", inputHash });
  const result = await completionJobs.runOneCurator(maintenanceContext, { workerId: input.workerId, curator, roomId: input.roomId });
  return completionExecutionResult("skill_curator", result);
}

function automationKindField(body: Record<string, unknown>, key: string): (typeof automationJobKinds)[number] {
  const value = stringField(body, key);
  if (!(automationJobKinds as readonly string[]).includes(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value as (typeof automationJobKinds)[number];
}

function artifactKindField(body: Record<string, unknown>, key: string): ArtifactRecord["kind"] {
  const value = stringField(body, key);
  const kinds: readonly ArtifactRecord["kind"][] = ["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"];
  if (!kinds.includes(value as ArtifactRecord["kind"])) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value as ArtifactRecord["kind"];
}

function artifactContentField(body: Record<string, unknown>, key: string): string | Record<string, JsonValue> | JsonValue[] {
  const value = body[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.every(isJsonValue)) throw new WorkspaceServerError(`${key}_invalid`, 400);
    return value as JsonValue[];
  }
  if (value && typeof value === "object" && isJsonObject(value)) return value as Record<string, JsonValue>;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function supportedLocaleArrayField(body: Record<string, unknown>, key: string): SupportedLocale[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.map((item) => {
    if (typeof item !== "string" || !(supportedLocales as readonly string[]).includes(item)) throw new WorkspaceServerError(`${key}_invalid`, 400);
    return item as SupportedLocale;
  });
}

function resourceRefsField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (!Array.isArray(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  try {
    return ResourceRefSchema.array().max(32).parse(value);
  } catch {
    throw new WorkspaceServerError(`${key}_invalid`, 400);
  }
}

interface PostgresTemporaryContextAttachment {
  id: string;
  kind: "desktop_screenshot";
  label?: string;
  source_name?: string;
  mime_type: "image/png";
  data_url: string;
  created_at: string;
  expires_at: string;
  metadata?: Record<string, JsonValue>;
}

/**
 * AppShot is intentionally carried only through the signed Runtime request.
 * It is validated here and never copied into a Runtime message, Activity, or
 * database row. The Backend receives the ephemeral attachment directly.
 */
function temporaryContextField(body: Record<string, unknown>, key: string): PostgresTemporaryContextAttachment[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > 4) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new WorkspaceServerError(`${key}_invalid`, 400);
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.id)
      ? record.id
      : undefined;
    if (!id || record.kind !== "desktop_screenshot") throw new WorkspaceServerError(`${key}_invalid`, 400);
    const dataUrl = typeof record.data_url === "string" ? record.data_url.trim() : "";
    const bytes = parsePostgresTemporaryContextPngDataUrl(dataUrl);
    if (!bytes) throw new WorkspaceServerError(`${key}_invalid`, 400);
    const createdAt = typeof record.created_at === "string" ? record.created_at.trim() : "";
    const expiresAt = typeof record.expires_at === "string" ? record.expires_at.trim() : "";
    const expiresAtMs = Date.parse(expiresAt);
    if (!createdAt || !expiresAt || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new WorkspaceServerError(`${key}_expired_or_invalid`, 400);
    }
    const sourceName = typeof record.source_name === "string" ? record.source_name.trim().slice(0, 160) : "";
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 240) : sourceName || "Desktop screenshot";
    return {
      id,
      kind: "desktop_screenshot",
      ...(label ? { label } : {}),
      ...(sourceName ? { source_name: sourceName } : {}),
      mime_type: "image/png",
      data_url: `data:image/png;base64,${bytes.toString("base64")}`,
      created_at: createdAt,
      expires_at: expiresAt,
      ...(record.metadata === undefined ? {} : { metadata: jsonObjectField(record, "metadata") })
    };
  });
}

function parsePostgresTemporaryContextPngDataUrl(dataUrl: string): Buffer | undefined {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return undefined;
  const base64 = dataUrl.slice(prefix.length);
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > postgresTemporaryContextMaxBytes) return undefined;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47];
  return pngSignature.every((byte, index) => bytes[index] === byte) ? bytes : undefined;
}

function workspaceBundleManifestField(body: Record<string, unknown>, key: string): WorkspaceBundleV3Manifest | WorkspaceBundleV4Manifest {
  const value = objectField(body, key);
  const formatVersion = numberField(value, "format_version");
  if (formatVersion === 4) return value as unknown as WorkspaceBundleV4Manifest;
  const source = objectField(value, "source");
  const files = objectField(value, "files");
  const recordCounts = objectField(value, "record_counts");
  if (formatVersion !== 3 || source.hosting_mode !== "hosted" && source.hosting_mode !== "self_host"
    || source.database_placement !== "shared" && source.database_placement !== "dedicated") {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  const normalizedFiles: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    normalizedFiles[path] = hash;
  }
  const normalizedCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(recordCounts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    normalizedCounts[name] = count;
  }
  const schemaVersion = value.schema_version;
  if (schemaVersion !== undefined && (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  const transferId = optionalStringField(value, "transfer_id");
  return {
    format_version: 3,
    workspace_id: stringField(value, "workspace_id"),
    exported_at: stringField(value, "exported_at"),
    source: { hosting_mode: source.hosting_mode, database_placement: source.database_placement },
    ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }),
    ...(transferId ? { transfer_id: transferId } : {}),
    files: normalizedFiles,
    record_counts: normalizedCounts,
    integrity_hash: stringField(value, "integrity_hash")
  };
}

function base64Field(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WorkspaceServerError(`${key}_invalid`, 400);
  }
  return value;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${key}_required`, 400);
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.trim();
}

function stringValue(value: Record<string, JsonValue>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function collectionTriggerTargetFromJob(value: Record<string, JsonValue>): {
  roomId: string;
  collectionId: string;
  recordId: string;
  actionId: string;
  payload: Record<string, JsonValue>;
} | undefined {
  if (value.channel !== "collection_trigger") return undefined;
  const roomId = stringValue(value, "room_id");
  const collectionId = stringValue(value, "collection_id");
  const recordId = stringValue(value, "record_id");
  const actionId = stringValue(value, "action_id");
  if (!roomId || !collectionId || !recordId || !actionId) return undefined;
  return { roomId, collectionId, recordId, actionId, payload: value };
}

/** A move must state its destination explicitly; null means Workspace root. */
function nullableStringField(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) throw new WorkspaceServerError(`${key}_required`, 400);
  const value = body[key];
  if (value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.trim();
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function nonnegativeNumberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function learningPayloadField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = objectField(body, key);
  const text = JSON.stringify(value);
  if (text.length > 200_000 || /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\bAKIA[A-Z0-9]{16}\b)/.test(text)) {
    throw new WorkspaceServerError("workspace_learning_secret_content_forbidden", 400);
  }
  return value;
}

function learningScopeField(body: Record<string, unknown>): WorkspaceLearningScope {
  const kind = stringField(body, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "room_id") };
  throw new WorkspaceServerError("scope_kind_invalid", 400);
}

function learningTargetScopeField(body: Record<string, unknown>): WorkspaceLearningScope {
  const kind = stringField(body, "target_scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "target_room_id") };
  throw new WorkspaceServerError("target_scope_kind_invalid", 400);
}

function learningScopeQuery(req: Request): WorkspaceLearningScope {
  const kind = queryString(req, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    return { kind, roomId };
  }
  throw new WorkspaceServerError("scope_kind_required", 400);
}

function learningResourceKind(value: string): "knowledge" | "memory" | "skill" | "workspace_rule" {
  if (value === "memory" || value === "workspace_rule") throw new WorkspaceServerError("workspace_learning_legacy_write_retired", 410);
  if (value === "knowledge" || value === "skill") return value;
  throw new WorkspaceServerError("workspace_learning_resource_kind_invalid", 400);
}

function learningOutcomeField(body: Record<string, unknown>, key: string): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  const value = stringField(body, key);
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "outcome_unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningResourceUseOutcome(body: Record<string, unknown>, key: string): "confirmed_success" | "confirmed_failure" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed_success" || value === "confirmed_failure" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningVerificationField(body: Record<string, unknown>, key: string): "confirmed" | "failed" | "not_run" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed" || value === "failed" || value === "not_run" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningFailureField(body: Record<string, unknown>, key: string): "none" | "resolved" | "unresolved" {
  const value = stringField(body, key);
  if (value === "none" || value === "resolved" || value === "unresolved") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningJobStatus(value: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked") return value;
  throw new WorkspaceServerError("status_invalid", 400);
}

function completionScopeField(body: Record<string, unknown>): WorkspaceCompletionScope {
  const kind = stringField(body, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "room_id") };
  throw new WorkspaceServerError("workspace_completion_scope_invalid", 400);
}

function completionTargetScopeField(body: Record<string, unknown>): WorkspaceCompletionScope {
  const kind = stringField(body, "target_scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "target_room_id") };
  throw new WorkspaceServerError("workspace_completion_target_scope_invalid", 400);
}

function completionResourceKind(value: string): WorkspaceCompletionResourceKind {
  if (value === "knowledge" || value === "skill" || value === "policy") return value;
  throw new WorkspaceServerError("workspace_completion_resource_kind_invalid", 400);
}

function completionResourceInput(body: Record<string, unknown>) {
  const kind = completionResourceKind(stringField(body, "kind"));
  if (kind === "policy") throw new WorkspaceServerError("workspace_completion_policy_apply_required", 400);
  const scope = completionScopeField(body);
  return {
    ...(optionalStringField(body, "resource_id") ? { id: optionalStringField(body, "resource_id") } : {}),
    scope,
    kind,
    ...(kind === "knowledge" ? { knowledgeKind: completionKnowledgeKind(stringField(body, "knowledge_kind")) } : {}),
    title: stringField(body, "title"),
    content: stringField(body, "content"),
    metadata: completionPayloadField(body, "metadata"),
    reason: stringField(body, "reason"),
    ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
    ...(body.ai_managed === undefined ? {} : { aiManaged: booleanField(body, "ai_managed") }),
    ...(kind === "skill" && body.support_files !== undefined ? { supportFiles: completionSkillSupportFilesField(body) } : {})
  };
}

function completionKnowledgeKind(value: string): "fact" | "decision" | "explanation" | "experience_rule" {
  if (value === "fact" || value === "decision" || value === "explanation" || value === "experience_rule") return value;
  throw new WorkspaceServerError("workspace_completion_knowledge_kind_invalid", 400);
}

function completionPayloadField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = objectField(body, key);
  if (JSON.stringify(value).length > 200_000) throw new WorkspaceServerError("workspace_completion_payload_invalid", 400);
  return value;
}

function completionSkillSupportFilesField(body: Record<string, unknown>): Array<{ path: string; content: Buffer }> {
  const value = body.support_files;
  if (!Array.isArray(value) || value.length > 99) throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 400);
  return value.map((entry) => {
    const file = objectField(entry, "support_file");
    const content = Buffer.from(base64Field(file, "content_base64"), "base64");
    if (content.byteLength > 8 * 1024 * 1024) throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 413);
    return { path: stringField(file, "path"), content };
  });
}

function completionSessionRefField(body: Record<string, unknown>, key: string): { appId: string; sessionId?: string; turnId?: string; messageId?: string; resumeUrl?: string } {
  const value = objectField(body, key);
  return {
    appId: stringField(value, "app_id"),
    ...(optionalStringField(value, "session_id") ? { sessionId: optionalStringField(value, "session_id") } : {}),
    ...(optionalStringField(value, "turn_id") ? { turnId: optionalStringField(value, "turn_id") } : {}),
    ...(optionalStringField(value, "message_id") ? { messageId: optionalStringField(value, "message_id") } : {}),
    ...(optionalStringField(value, "resume_url") ? { resumeUrl: optionalStringField(value, "resume_url") } : {})
  };
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new WorkspaceServerError(`${key}_invalid`, 400);
  }
  return value.map((item) => item.trim());
}

function completionOutcomeField(body: Record<string, unknown>, key: string): "completed" | "failed" | "cancelled" | "unknown" {
  const value = stringField(body, key);
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionVerificationField(body: Record<string, unknown>, key: string): "confirmed" | "failed" | "not_run" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed" || value === "failed" || value === "not_run" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionFailureField(body: Record<string, unknown>, key: string): "none" | "resolved" | "unresolved" {
  const value = stringField(body, key);
  if (value === "none" || value === "resolved" || value === "unresolved") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionUseEventField(body: Record<string, unknown>, key: string): "selected" | "body_loaded" | "support_loaded" | "actually_used" | "outcome" | "correction" {
  const value = stringField(body, key);
  if (value === "selected" || value === "body_loaded" || value === "support_loaded" || value === "actually_used" || value === "outcome" || value === "correction") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionUseOutcomeField(body: Record<string, unknown>, key: string): "confirmed_success" | "confirmed_failure" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed_success" || value === "confirmed_failure" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionJobStatusField(value: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked") return value;
  throw new WorkspaceServerError("status_invalid", 400);
}

function completionPolicyOperation(value: string): WorkspaceCompletionPolicyOperation {
  if (["activity.ingest", "resource.create", "resource.update", "resource.archive", "resource.copy", "resource.move", "resource.promote", "file.import", "curator.apply", "external.send", "policy.apply", "membership.change"].includes(value)) {
    return value as WorkspaceCompletionPolicyOperation;
  }
  throw new WorkspaceServerError("workspace_completion_policy_operation_invalid", 400);
}

function publicLearningSettings(settings: WorkspaceLearningSettings): Omit<WorkspaceLearningSettings, "secretRef"> {
  const { secretRef: _secretRef, ...publicSettings } = settings;
  return publicSettings;
}

function roleField(body: Record<string, unknown>, key: string): "owner" | "admin" | "member" | "guest" {
  const role = stringField(body, key);
  if (role === "owner" || role === "admin" || role === "member" || role === "guest") return role;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function membershipStateField(body: Record<string, unknown>, key: string): "active" | "revoked" {
  const state = stringField(body, key);
  if (state === "active" || state === "revoked") return state;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function connectionStatusField(body: Record<string, unknown>, key: string): "active" | "revoked" | "expired" {
  const status = stringField(body, key);
  if (status === "active" || status === "revoked" || status === "expired") return status;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function transferReceiptField(body: Record<string, unknown>, key: string): {
  format_version: 1;
  transfer_id: string;
  source_workspace_id: string;
  source_integrity_hash: string;
  target_workspace_id: string;
  imported_at: string;
  target_integrity_hash: string;
} {
  const value = objectField(body, key);
  const formatVersion = numberField(value, "format_version");
  if (formatVersion !== 1) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  const importedAt = stringField(value, "imported_at");
  if (!Number.isFinite(new Date(importedAt).getTime())) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  const sourceIntegrityHash = sha256Field(value, "source_integrity_hash");
  const targetIntegrityHash = sha256Field(value, "target_integrity_hash");
  if (sourceIntegrityHash !== targetIntegrityHash) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return {
    format_version: 1,
    transfer_id: stringField(value, "transfer_id"),
    source_workspace_id: stringField(value, "source_workspace_id"),
    source_integrity_hash: sourceIntegrityHash,
    target_workspace_id: stringField(value, "target_workspace_id"),
    imported_at: importedAt,
    target_integrity_hash: targetIntegrityHash
  };
}

function sha256Field(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return value;
}

function workspaceInvitationLink(serverUrl: string, workspaceId: string, token: string): string {
  const link = new URL("samurai://workspace-invite");
  link.searchParams.set("server", serverUrl);
  link.searchParams.set("workspace_id", workspaceId);
  link.searchParams.set("token", token);
  return link.toString();
}

function jobStatusField(body: Record<string, unknown>, key: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  const status = stringField(body, key);
  if (status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function stringHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) throw new WorkspaceServerError(`${name.replaceAll("-", "_")}_required`, 401);
  return value;
}

function externalRequestHeaders(req: Request): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.join(",") : value
  ]));
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryStringList(req: Request, key: string): string[] {
  const value = req.query[key];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim())
    .filter(Boolean);
}

function queryNumber(req: Request, key: string): number | undefined {
  const value = queryString(req, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return parsed;
}

function wildcardParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join("/") : value;
  if (!raw) throw new WorkspaceServerError("workspace_file_path_required", 400);
  return raw;
}

function pathParam(req: Request, key: string): string {
  const value = optionalPathParam(req, key);
  if (!value) throw new WorkspaceServerError(`${key}_required`, 400);
  return value;
}

function optionalPathParam(req: Request, key: string): string | undefined {
  const value = req.params[key];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function createPostgresGeneratedSurfaceTargetCommand(dependencies: {
  commands: WorkspaceServerCommandService;
  collections: PostgresCollection;
  artifacts: PostgresArtifact;
}): (
  context: WorkspaceRequestContext,
  input: { roomId: string; commandId: string; payload: Record<string, JsonValue>; operationId: string }
) => Promise<GeneratedSurfaceTargetCommandResult> {
  return async (context, input) => {
    await dependencies.commands.assertRoomExecutable(context, input.roomId);
    let payload: Record<string, JsonValue>;
    try {
      payload = parseDomainOperationInput(input.commandId as DomainCommandId, input.payload) as unknown as Record<string, JsonValue>;
    } catch {
      throw new WorkspaceServerError("generated_surface_target_payload_invalid", 400, { command_id: input.commandId });
    }
    let result: unknown;
    let changedResources: string[] = [];
    switch (input.commandId) {
      case "artifact.create": {
        const created = await dependencies.artifacts.create(context, {
          roomId: input.roomId,
          title: generatedSurfaceRequiredString(payload, "title"),
          content: generatedSurfaceRequiredString(payload, "content"),
          ...(payload.input_locale === undefined ? {} : { sourceLocales: [supportedLocaleField({ input_locale: payload.input_locale }, "input_locale")] }),
          ...(payload.kind === undefined ? {} : { kind: artifactKindField({ kind: payload.kind }, "kind") }),
          ...(payload.output_locale === undefined ? {} : { locale: supportedLocaleField({ output_locale: payload.output_locale }, "output_locale") }),
          ...(payload.metadata === undefined ? {} : { metadata: generatedSurfaceObject(payload.metadata, "metadata") })
        });
        result = created;
        changedResources = [created.artifact.id, created.artifact.file_ref.uri];
        break;
      }
      case "collection.record.create": {
        const collectionId = generatedSurfaceRequiredString(payload, "collection_id");
        const recordId = generatedSurfaceOptionalString(payload, "record_id") ?? `record_${createHash("sha256").update(`${input.operationId}|${collectionId}`).digest("hex").slice(0, 40)}`;
        const record = await dependencies.collections.createRecord(context, input.roomId, {
          id: recordId,
          collection_id: collectionId,
          data: generatedSurfaceObject(payload.data, "data"),
          resource_refs: payload.resource_refs === undefined ? [] : ResourceRefSchema.array().max(32).parse(payload.resource_refs),
          created_at: nowIso(),
          updated_at: nowIso()
        });
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        changedResources = [record.id, record.file_path];
        break;
      }
      case "collection.patch.apply": {
        const record = await dependencies.collections.applyPatch(
          context,
          input.roomId,
          generatedSurfaceRequiredString(payload, "collection_id"),
          generatedSurfaceRequiredString(payload, "record_id"),
          {
            changes: generatedSurfaceObject(payload.changes, "changes"),
            ...(generatedSurfaceOptionalString(payload, "patch_id") ? { id: generatedSurfaceOptionalString(payload, "patch_id") } : {}),
            ...(typeof payload.expected_version === "number" ? { expected_version: payload.expected_version } : {})
          }
        );
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        changedResources = [record.id, record.file_path];
        break;
      }
      case "collection.record.delete": {
        const record = await dependencies.collections.deleteRecord(
          context,
          input.roomId,
          generatedSurfaceRequiredString(payload, "collection_id"),
          generatedSurfaceRequiredString(payload, "record_id"),
          generatedSurfaceRequiredNumber(payload, "expected_version")
        );
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        changedResources = [record.id, record.file_path];
        break;
      }
      case "collection.action.run": {
        const operation = parseSurfaceOperation({
          id: input.operationId,
          kind: "collection.action.run",
          collection_id: generatedSurfaceRequiredString(payload, "collection_id"),
          action_id: generatedSurfaceRequiredString(payload, "action_id"),
          ...(generatedSurfaceOptionalString(payload, "record_id") ? { record_id: generatedSurfaceOptionalString(payload, "record_id") } : {}),
          payload: payload.payload === undefined ? {} : generatedSurfaceObject(payload.payload, "payload")
        });
        if (!operation || operation.kind !== "collection.action.run") throw new WorkspaceServerError("generated_surface_target_payload_invalid", 400);
        const action = await dependencies.collections.runAction(context, input.roomId, operation);
        result = action.result;
        changedResources = [operation.collection_id];
        break;
      }
      default:
        throw new WorkspaceServerError("generated_surface_target_command_not_connected", 503, { command_id: input.commandId });
    }

    const resultValue = result as JsonValue;
    await dependencies.commands.ingestCompletionActivity(context, {
      id: `completion_activity_${createHash("sha256").update(`${context.workspaceId}|generated_surface_target|${input.operationId}`).digest("hex").slice(0, 48)}`,
      roomId: input.roomId,
      sourceApp: "generated-surface",
      sourceId: input.commandId,
      operationId: input.operationId,
      instructionSummary: `Generated Surface action: ${input.commandId}`,
      resultSummary: `Generated Surface action ${input.commandId} completed.`,
      changedResources,
      verificationOutcome: "confirmed",
      failureState: "none",
      outcome: "completed",
      payload: { command_id: input.commandId, result: resultValue }
    });
    return { result: resultValue, resourceRefs: changedResources };
  };
}

function generatedSurfaceRequiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`generated_surface_${key}_required`, 400);
  return value.trim();
}

function generatedSurfaceOptionalString(payload: Record<string, JsonValue>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`generated_surface_${key}_invalid`, 400);
  return value.trim();
}

function generatedSurfaceRequiredNumber(payload: Record<string, JsonValue>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new WorkspaceServerError(`generated_surface_${key}_invalid`, 400);
  return value;
}

function generatedSurfaceObject(value: JsonValue | undefined, key: string): Record<string, JsonValue> {
  if (!isJsonObject(value)) throw new WorkspaceServerError(`generated_surface_${key}_invalid`, 400);
  return value as Record<string, JsonValue>;
}

function generatedSurfaceJsonValueField(body: Record<string, unknown>, key: string): JsonValue {
  const value = body[key];
  if (!isJsonValue(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value as JsonValue;
}

function generatedSurfaceDocument(bundle: { html: string; css?: string; script?: string }, actions: Array<{ id: string }> = [], assets: Array<{ path: string; content_base64: string; mime_type: string }> = []): string {
  const bridge = JSON.stringify({ actions: actions.map((action) => action.id) }).replace(/</g, "\\u003c");
  const html = inlineGeneratedSurfaceAssets(bundle.html, assets);
  const css = (bundle.css ?? "").replace(/<\/style/gi, "<\\/style");
  const script = (bundle.script ?? "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${css}</style></head><body>${html}<script>${script}</script><script>window.samuraiGeneratedSurface=${bridge};window.dispatchSamuraiAction=function(actionId,payload){window.parent.postMessage({type:"samurai.generated_surface.action",action_id:actionId,payload:payload||{}},"*")};</script></body></html>`;
}

function generatedSurfaceAssetPayload(assets: Array<{ path: string; content: Buffer; mime_type: string }>): Array<{ path: string; content_base64: string; mime_type: string }> {
  return assets.map((asset) => ({ path: asset.path, content_base64: asset.content.toString("base64"), mime_type: asset.mime_type }));
}

function inlineGeneratedSurfaceAssets(source: string, assets: Array<{ path: string; content_base64: string; mime_type: string }>): string {
  const dataByPath = new Map<string, string>();
  for (const asset of assets) {
    const path = safeGeneratedSurfaceAssetPath(asset.path);
    if (!path) continue;
    const dataUrl = `data:${asset.mime_type};base64,${asset.content_base64}`;
    dataByPath.set(path, dataUrl);
    dataByPath.set(`assets/${path}`, dataUrl);
  }
  const replaceReference = (reference: string): string => {
    const normalized = reference.trim().replace(/^\.\//, "");
    return dataByPath.get(normalized) ?? reference;
  };
  return source
    .replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`)
    .replace(/(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`);
}

function postgresChatRenderSpec(result: RunChatTurnResult): SurfaceRenderSpec {
  const agentMessage = result.messages.find((message) => message.role === "agent");
  return createSurfaceRenderSpec({
    kind: "chat",
    priority: "primary",
    state: result.backendRun.status === "failed" ? "error" : result.backendRun.status === "waiting_for_backend_input" ? "loading" : "ready",
    title: result.session.title,
    resource_refs: [
      { kind: "session", id: result.session.id, uri: `sessions/${result.session.id}`, label: result.session.title },
      { kind: "backend_run", id: result.backendRun.id, uri: `backend-runs/${result.backendRun.id}`, label: result.backendRun.input_summary },
      ...result.artifacts.map((artifact) => artifact.file_ref)
    ],
    props: {
      session_id: result.session.id,
      backend_run_id: result.backendRun.id,
      backend_status: result.backendRun.status,
      message_ids: result.messages.map((message) => message.id),
      primary_message_id: agentMessage?.id ?? null,
      artifact_ids: result.artifacts.map((artifact) => artifact.id),
      memory_ids: result.memories.map((memory) => memory.id),
      reflection_suggestion_ids: result.reflectionSuggestions.map((suggestion) => suggestion.id)
    },
    errors: result.backendRun.status === "failed" ? [{
      code: result.backendRun.error_code ?? "backend_failed",
      message: result.backendRun.output_summary ?? "Backend run failed.",
      retryable: true
    }] : undefined,
    fallback: result.backendRun.status === "failed" ? {
      kind: "run_history",
      title: "Run history",
      message: "Open run history to inspect the failed backend trace.",
      props: { run_ids: [result.backendRun.id], selected_run_id: result.backendRun.id }
    } : undefined
  });
}

function comparePostgresBackendRunDesc(left: BackendRunRecord, right: BackendRunRecord): number {
  return right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id);
}

function summarizePostgresRunForResume(run: BackendRunRecord, events: BackendEventRecord[]) {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const waitingEvent = [...orderedEvents].reverse().find((event) => event.event_type === "backend_waiting_for_native_input");
  const lastEvent = orderedEvents.at(-1);
  return {
    id: run.id,
    session_id: run.session_id,
    backend_id: run.backend_id,
    backend_kind: run.backend_kind,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    error_code: run.error_code,
    input_summary: run.input_summary,
    output_summary: run.output_summary,
    event_count: orderedEvents.length,
    waiting_for_backend_input: run.status === "waiting_for_backend_input",
    waiting_event: waitingEvent
      ? {
          id: waitingEvent.id,
          sequence: waitingEvent.sequence,
          created_at: waitingEvent.created_at,
          payload: waitingEvent.payload
        }
      : undefined,
    last_event: lastEvent
      ? {
          id: lastEvent.id,
          sequence: lastEvent.sequence,
          event_type: lastEvent.event_type,
          created_at: lastEvent.created_at
        }
      : undefined
  };
}

function summarizePostgresGatewayMcpConfig(config: GatewayMcpConfigRecord): Record<string, unknown> {
  if (config.transport === "stdio") {
    return {
      ...config,
      stdio: {
        ...config.stdio,
        env: Object.keys(config.stdio.env),
        secret_env: Object.keys(config.stdio.secret_env),
        secret_files: config.stdio.secret_files.map((file) => ({ secret_ref_id: file.secret_ref_id, filename: file.filename, env: file.env, mode: file.mode }))
      }
    };
  }
  return {
    ...config,
    http: {
      ...config.http,
      headers: Object.keys(config.http.headers),
      secret_headers: Object.keys(config.http.secret_headers)
    }
  };
}

function normalizeError(error: unknown): WorkspaceServerError {
  if (error instanceof WorkspaceServerError) return error;
  const message = error instanceof Error ? error.message : "workspace_server_internal_error";
  // Missing and inaccessible Rooms deliberately share one public response.
  // Never let an endpoint reveal whether a private Room id happens to exist.
  if (/room_(?:not_available|parent_not_available|not_found_or_access_denied)/.test(message)) {
    return new WorkspaceServerError("room_not_available", 404);
  }
  const conflictCode = message.match(/(?:room_(?:parent_membership_required|move_parent_membership_required|hierarchy_cycle|last_owner_cannot_be_removed|membership_version_conflict|version_conflict)|workspace_(?:membership_version_conflict|last_owner_cannot_be_revoked|record_room_change_forbidden|file_room_change_forbidden|account_not_active|agent_room_permission_version_conflict|connection_descriptor_version_conflict))/)?.[0];
  if (conflictCode) return new WorkspaceServerError(conflictCode, 409);
  if (/workspace_(?:agent_input_invalid|agent_room_permission_invalid|connection_descriptor_invalid|connection_principal_not_active|connection_agent_not_active|connection_room_binding_invalid|connection_descriptor_expired|connection_descriptor_revocation_required|connection_descriptor_identity_invalid|connection_room_limit_invalid|connection_ingress_classes_invalid)/.test(message)) {
    return new WorkspaceServerError("workspace_request_rejected", 400);
  }
  if (/room_membership_invalid/.test(message)) return new WorkspaceServerError("room_membership_invalid", 400);
  if (/workspace_admin_permission_required/.test(message)) return new WorkspaceServerError("workspace_admin_permission_required", 403);
  if (/workspace_owner_permission_required/.test(message)) return new WorkspaceServerError("workspace_owner_permission_required", 403);
  if (/workspace_permission_denied/.test(message)) return new WorkspaceServerError("workspace_permission_denied", 403);
  if (/workspace_membership_required/.test(message)) return new WorkspaceServerError("workspace_membership_required", 409);
  if (/permission_denied|owner_permission_required|admin_permission_required/.test(message)) return new WorkspaceServerError("workspace_permission_denied", 403);
  if (/invitation_invalid|membership_invalid/.test(message)) return new WorkspaceServerError("workspace_request_rejected", 400);
  if (/version_conflict|read_only|transfer_not_ready|transfer_source_not_active|transfer_receipt_invalid/.test(message)) {
    return new WorkspaceServerError("workspace_update_conflict", 409);
  }
  if (/not_found/.test(message)) return new WorkspaceServerError("workspace_request_not_found", 404);
  return new WorkspaceServerError("workspace_server_internal_error", 500);
}

function publicError(error: unknown): { error: string; details?: Record<string, unknown> } {
  const normalized = normalizeError(error);
  return { error: normalized.code, ...(normalized.details ? { details: normalized.details } : {}) };
}
