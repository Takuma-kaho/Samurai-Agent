import cors from "cors";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { createHmac, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server as SocketServer } from "socket.io";
import { OwnerTokenManager, SlidingWindowRateLimiter, evaluateApiAccess, isAllowedCorsOrigin, verifySignedWebhook } from "./middleware/security";
import {
  domainCommandInputSources,
  getDomainCommandForProviderToolName,
  getDomainCommandCatalogDiagnostics,
  listDomainQueryEntries,
  getDomainQueryEntry,
  listDomainCommandEntries,
  PluginRuntimeRegistry,
  loadPluginManifests,
  type DomainCommandInputSource,
  type PluginEntrypointLoadResult,
  type PluginManifestLoadIssue,
  type PluginRuntimeStatus,
  type PluginTrustedSigningKey
} from "@samurai-agent/action-catalog";
import {
  capabilityManifests,
  getCapabilityManifest
} from "@samurai-agent/capability-registry";
import {
  CaptureModeSchema,
  CollectionSchemaSchema,
  BackendReleaseReadinessHealthSchema,
  CuratorLifecycleActionSchema,
  EvaluationDiagnosticsReportSchema,
  ExternalSendDiagnosticsReportSchema,
  FileBrowserActionDiagnosticsReportSchema,
  PluginDiagnosticsReportSchema,
  ReflectionDiagnosticsReportSchema,
  ExternalAssistPhaseSchema,
  ExternalAssistStatusSchema,
  ExternalProviderRoleSchema,
  ActorIdentitySchema,
  GatewayDiagnosticsReportSchema,
  GatewaySandboxWorkspaceSyncDirectionSchema,
  GatewaySandboxWorkspaceSyncStatusSchema,
  KnowledgeWikiDiagnosticsReportSchema,
  ProvenanceSchema,
  ResourceRefSchema,
  SkillDiagnosticsReportSchema,
  ClientEventRecordSchema,
  createId,
  clientEventStatuses,
  clientEventTypes,
  clientTargetKinds,
  externalSendChannels,
  gatewayChannels,
  nowIso,
  stableHash,
  supportedLocales,
  toolRunStatuses,
  translationStatuses,
  PolicyEvaluationInputSchema,
  type BackendEventRecord,
  type BackendRunRecord,
  type ClientEventRecord,
  type ClientEventStatus,
  type ClientEventType,
  type ClientTargetKind,
  type EvaluationDiagnosticsReport,
  type FileBrowserActionDiagnosticsReport,
  type ExternalSendRecord,
  type ExternalSendDiagnosticsReport,
  type ExternalSendTransportReadiness,
  type GatewayChannel,
  type GatewayMcpConfigRecord,
  type GatewayDiagnosticsReport,
  type JsonValue,
  type KnowledgeWikiDiagnosticsReport,
  type PluginDiagnosticsReport,
  type ReflectionDiagnosticsReport,
  type ResourceRef,
  type ResourceTranslationRecord,
  type SettingsRecord,
  type SkillDiagnosticsReport,
  type SupportedLocale,
  type OperationRecord,
  type ToolRunDiagnosticsGroup,
  type ToolRunDiagnosticsReport,
  type ToolRunRecord,
  type ToolRunStatus
} from "@samurai-agent/core-schemas";
import { evaluatePolicy } from "@samurai-agent/policy-engine";
import {
  createGatewayEnvelope,
  cronMemoryReviewGatewayContext,
  inspectSandboxExecutorCapabilities,
  localCliGatewayContext,
  resolveGatewaySessionRouting,
  sessionKeyForExternalSource,
  summarizeGatewayMcpConfig,
  webGatewayContext,
  type GatewayContext
} from "@samurai-agent/gateway";
import {
  AgentRuntime,
  createDefaultAgentBackendRegistry,
  RuntimeRequestError,
  createExternalAssistProvidersFromEnv,
  createProviderRegistryFromEnv,
  describeExternalAssistProviderConfig,
  generatedSurfaceCsp,
  planSurfaceOperationDispatch,
  type ExternalAssistProvider,
  type GatewayInboundRuntimeResult,
  type ProviderAdapter,
  type ProviderDiagnostics,
  type ProviderRegistry
} from "@samurai-agent/runtime";
import { composeAgentRuntime } from "./composition/runtime";
import {
  isDomainCommandId,
  isDomainQueryId,
  parseDomainOperationInput,
  type DomainCommandId,
  type DomainOperationInput,
  type DomainOperationOutput,
  type DomainQueryId
} from "@samurai-agent/domain-operations";
import { assertTrustedRuntimePayload, resolveTrustedRuntimeApiInput, type TrustedRuntimeApiContext } from "./domain-ingress";
import { parseSurfaceOperation, type RuntimeEventSink } from "@samurai-agent/ui-protocol";
import { WorkspaceStore, type SessionTranscriptExport } from "@samurai-agent/workspace-store";
import { registerBackendEventRoutes } from "./routes/backend-events";
import { startAutomationScheduler, type AutomationScheduler } from "./workers/automation-scheduler";

const defaultPort = 4317;
const defaultWorkspaceHealthReadinessTimeoutMs = 2_000;
const defaultEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const loadedEnvPaths = new Set<string>();
const temporaryContextTtlMs = 15 * 60 * 1000;
const temporaryContextMaxBytes = 8 * 1024 * 1024;
const apiServerClosePromises = new WeakMap<ApiServer, Promise<void>>();
const defaultServerShutdownTimeoutMs = 10_000;

export interface CreateApiServerOptions {
  workspaceDataDir?: string;
  provider?: ProviderAdapter;
  backendRegistry?: ReturnType<typeof createDefaultAgentBackendRegistry>;
  automationScheduler?: boolean;
  pluginRootDir?: string;
  loadPluginEntrypoints?: boolean;
  allowUnsignedPluginEntrypoints?: boolean;
  pluginTrustedSigningKeys?: PluginTrustedSigningKey[];
  externalAssistProvider?: ExternalAssistProvider | ExternalAssistProvider[];
  ownerToken?: string;
  corsOrigins?: string[];
  productionLogger?: (message: string, metadata: Record<string, unknown>) => void;
}

export interface ApiServer {
  app: Express;
  httpServer: HttpServer;
  io: SocketServer;
  store: WorkspaceStore;
  runtime: AgentRuntime;
  lifecycle: ApiServerLifecycleState;
  temporaryContexts: ReturnType<typeof createTemporaryContextStore>;
  pluginRegistry: PluginRuntimeRegistry;
  pluginCatalogIssues: PluginManifestLoadIssue[];
  pluginEntrypointLoad: PluginEntrypointLoadResult;
  shutdown: ApiServerShutdownState;
  scheduler?: AutomationScheduler;
}

export interface ApiServerShutdownState {
  acceptingRequests: boolean;
  abortController: AbortController;
  activeRequests: Set<Promise<void>>;
  drainWaiters: Set<() => void>;
  timeoutMs: number;
}

interface TemporaryContextRecord {
  id: string;
  kind: "desktop_screenshot";
  label: string;
  source_name?: string;
  mime_type: "image/png";
  data_url: string;
  file_path: string;
  created_at: string;
  expires_at: string;
  metadata: Record<string, JsonValue>;
}

interface TemporaryContextResponse {
  id: string;
  kind: "temporary_context";
  uri: string;
  label: string;
  mime_type: "image/png";
  created_at: string;
  expires_at: string;
}

export interface ApiServerLifecycleState {
  started_at: string;
  closing: boolean;
  close_started_at?: string;
  closed_at?: string;
  close_error?: string;
}

interface GatewayEmailImapTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  maxMessages: number;
  markSeen: boolean;
  timeoutMs: number;
}

interface GatewayEmailImapMessage {
  uid: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  raw?: string;
  message_id?: string;
  in_reply_to?: string;
  internal_date?: string;
  flags?: string[];
}

interface GatewayEmailImapPollResult {
  mailbox: string;
  scanned: number;
  messages: GatewayEmailImapMessage[];
}

interface GatewayEmailImapClient {
  poll(): Promise<GatewayEmailImapPollResult>;
  close(): void;
}

type GatewayEmailImapClientFactory = (config: GatewayEmailImapTransportConfig) => Promise<GatewayEmailImapClient>;

let gatewayEmailImapClientFactory: GatewayEmailImapClientFactory = createNodeGatewayEmailImapClient;

export function setGatewayEmailImapClientFactoryForTest(factory?: GatewayEmailImapClientFactory): void {
  gatewayEmailImapClientFactory = factory ?? createNodeGatewayEmailImapClient;
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

export function defaultWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || process.env.HOME || "";
  if (process.platform === "darwin" && home) {
    return path.join(home, "Library", "Application Support", "Samurai Agent", "workspace");
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    if (appData) {
      return path.join(appData, "Samurai Agent", "workspace");
    }
  }
  const dataHome = env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : "");
  return dataHome ? path.join(dataHome, "samurai-agent", "workspace") : path.resolve("samurai-agent-workspace");
}

export function resolveWorkspaceRoot(optionWorkspaceDataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    optionWorkspaceDataDir?.trim()
      || env.SAMURAI_WORKSPACE_ROOT?.trim()
      || env.WORKSPACE_DATA_DIR?.trim()
      || defaultWorkspaceRoot(env)
  );
}

function resolveBackendWorkingDirectoryMode(env: NodeJS.ProcessEnv = process.env): "workspace" | "repo" {
  const mode = env.SAMURAI_BACKEND_WORKING_DIR_MODE?.trim() || "workspace";
  if (mode === "workspace" || mode === "repo") {
    return mode;
  }
  throw new Error(`SAMURAI_BACKEND_WORKING_DIR_MODE must be "workspace" or "repo", got "${mode}".`);
}

function legacyWorkspaceWarnings(input: { workspaceRoot: string; legacyRepoWorkspaceDir: string; workspaceHadUserDataBeforeCreate: boolean }): Array<{ code: string; message: string; path: string }> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const legacyRoot = path.resolve(input.legacyRepoWorkspaceDir);
  if (workspaceRoot === legacyRoot || !workspaceHasUserData(legacyRoot) || input.workspaceHadUserDataBeforeCreate) {
    return [];
  }
  return [{
    code: "legacy_repo_workspace_data_detected",
    message: "旧repo内 workspace-data にデータがあります。自動移行はしません。必要なら手動で新Workspaceへ移してください。",
    path: legacyRoot
  }];
}

function workspaceHasUserData(rootDir: string): boolean {
  if (!existsSync(rootDir)) {
    return false;
  }
  try {
    return readdirSync(rootDir).some((name) => !name.startsWith("."));
  } catch {
    return false;
  }
}

function serverShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SAMURAI_SERVER_SHUTDOWN_TIMEOUT_MS ?? defaultServerShutdownTimeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultServerShutdownTimeoutMs;
}

async function bootstrapWorkspaceExecutionRoot(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  if (existsSync(path.join(workspaceRoot, ".git"))) {
    return;
  }
  const result = spawnSync("git", ["init"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`Workspace execution root could not be initialized: ${detail}`);
  }
}

export async function createApiServer(options: CreateApiServerOptions = {}): Promise<ApiServer> {
  loadServerEnv();
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceDataDir);
  const legacyRepoWorkspaceDir = fileURLToPath(new URL("../../../workspace-data", import.meta.url));
  const workspaceHadUserDataBeforeCreate = workspaceHasUserData(workspaceRoot);
  await bootstrapWorkspaceExecutionRoot(workspaceRoot);
  const store = await WorkspaceStore.create({ rootDir: workspaceRoot });
  const app = express();
  const httpServer = createServer(app);
  const shutdown: ApiServerShutdownState = {
    acceptingRequests: true,
    abortController: new AbortController(),
    activeRequests: new Set(),
    drainWaiters: new Set(),
    timeoutMs: serverShutdownTimeoutMs()
  };
  app.use((req, res, next) => {
    if (!shutdown.acceptingRequests) {
      res.status(503).json({ error: "server_shutting_down" });
      return;
    }
    const requestController = new AbortController();
    const abortFromShutdown = () => requestController.abort();
    if (shutdown.abortController.signal.aborted) requestController.abort();
    else shutdown.abortController.signal.addEventListener("abort", abortFromShutdown, { once: true });
    (req as Request & { signal?: AbortSignal }).signal = requestController.signal;
    let resolveRequest!: () => void;
    const task = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    shutdown.activeRequests.add(task);
    const finish = () => {
      if (!shutdown.activeRequests.delete(task)) return;
      shutdown.abortController.signal.removeEventListener("abort", abortFromShutdown);
      resolveRequest();
      for (const waiter of shutdown.drainWaiters) waiter();
    };
    const cancel = () => {
      requestController.abort();
      finish();
    };
    res.once("finish", finish);
    res.once("close", cancel);
    res.once("error", cancel);
    req.once("aborted", cancel);
    req.once("error", cancel);
    next();
  });
  const corsOrigins=options.corsOrigins??(process.env.SAMURAI_CORS_ORIGINS?.split(",").map(value=>value.trim()).filter(Boolean)??["http://127.0.0.1:5173","http://localhost:5173"]);
  const ownerToken=options.ownerToken??process.env.SAMURAI_OWNER_TOKEN;
  const ownerTokenManager=ownerToken?new OwnerTokenManager(ownerToken):undefined;
  const io = new SocketServer(httpServer, {
    cors: {
      origin: corsOrigins
    }
  });

  let runtime: AgentRuntime;
  const emit: RuntimeEventSink = async (name, payload) => {
    io.emit(name, payload);
    try {
      await maybeCreateClientEventFromRuntimeEvent(runtime, name, payload);
    } catch (error) {
      console.warn("client_event_creation_failed", redactSecretLikeString(error instanceof Error ? error.message : String(error)));
    }
  };
  const provider = options.provider ?? createProviderRegistryFromEnv();
  const pluginRootDir = options.pluginRootDir ?? process.env.SAMURAI_PLUGIN_ROOT_DIR ?? workspaceRoot;
  const pluginCatalog = await loadPluginManifests(pluginRootDir, {
    trustedSigningKeys: options.pluginTrustedSigningKeys ?? pluginTrustedSigningKeysFromEnv(),
    requireSignature: process.env.SAMURAI_REQUIRE_PLUGIN_SIGNATURE === "1"
  });
  const pluginRegistry = new PluginRuntimeRegistry(pluginCatalog);
  for (const state of await store.listPluginStates()) {
    pluginRegistry.setPluginEnabled(state.manifest_id, state.enabled);
  }
  const pluginEntrypointLoad = (options.loadPluginEntrypoints ?? process.env.SAMURAI_LOAD_PLUGIN_ENTRYPOINTS !== "0")
    ? await pluginRegistry.loadEntrypoints({
      allowUnsigned: options.allowUnsignedPluginEntrypoints ?? process.env.SAMURAI_ALLOW_UNSIGNED_PLUGIN_ENTRYPOINTS === "1"
    })
    : { loaded: [], issues: [] };
  const injectedExternalAssistProviders = normalizeInjectedExternalAssistProviders(options.externalAssistProvider);
  const externalAssistConfig = injectedExternalAssistProviders.length > 0
    ? {
      configured: true,
      source: "injected",
      provider_id: injectedExternalAssistProviders.map((provider) => provider.id).join(", "),
      provider_ids: injectedExternalAssistProviders.map((provider) => provider.id),
      provider_count: injectedExternalAssistProviders.length,
      provider_kind: "injected",
      max_hints: 1,
      timeout_ms: null,
      token_configured: false,
      auth_header: null,
      endpoint_origin: undefined,
      endpoint_path_configured: undefined,
      file_name: undefined,
      errors: [],
      warnings: []
    }
    : describeExternalAssistProviderConfig();
  const externalAssistProviders = injectedExternalAssistProviders.length > 0
    ? injectedExternalAssistProviders
    : createExternalAssistProvidersFromEnv();
  const backendWorkingDirectoryMode = resolveBackendWorkingDirectoryMode();
  const backendRegistry = options.backendRegistry ?? createDefaultAgentBackendRegistry(provider, process.env, { repoRoot });
  const temporaryContexts = createTemporaryContextStore();
  const productionLogger = options.productionLogger ?? ((message: string, metadata: Record<string, unknown>) => {
    console.error(message, metadata);
  });
  runtime = composeAgentRuntime({ store, emit, provider, backendRegistry, pluginRegistry, externalAssistProviders, workspaceOptions: {
    backendWorkingDirectoryMode,
    repoRoot,
    enableBackendBackgroundReview: options.automationScheduler !== false,
    detachBackgroundReview: true,
    resolveTemporaryContextRef: (ref) => temporaryContexts.resolve(ref),
    productionLogger
  } });
  await runtime.startup();
  const scheduler = options.automationScheduler === false ? undefined : startAutomationScheduler(runtime);
  const lifecycle: ApiServerLifecycleState = {
    started_at: nowIso(),
    closing: false
  };
  const settingsPayload = (settings: SettingsRecord) => ({
    ...settings,
    external_assist_config: externalAssistConfig
  });
  const resolveDetailTranslation = async (
    query: Record<string, unknown>,
    sourceRef: ResourceRef,
    sourceLocale: SupportedLocale,
    fallbackText: string
  ) => {
    const targetLocale = asSupportedLocale(query.target_locale);
    const fallbackLocale = asSupportedLocale(query.fallback_locale) ?? sourceLocale;
    const originalHash = stableHash(fallbackText);
    const locale = {
      source_ref: sourceRef,
      source_locale: sourceLocale,
      content_locale: sourceLocale,
      target_locale: targetLocale,
      fallback_locale: fallbackLocale,
      original_hash: originalHash
    };
    if (!targetLocale) {
      return { locale };
    }
    return {
      locale,
      translation_resolution: await store.resolveResourceTranslation({
        sourceRef,
        targetLocale,
        originalHash,
        fallbackText
      })
    };
  };

  app.use(cors({origin:(origin,callback)=>callback(null,isAllowedCorsOrigin(origin,corsOrigins)),credentials:false}));
  const apiRateLimiter=new SlidingWindowRateLimiter(300,60_000);
  app.use("/api",(req,res,next)=>{const decision=evaluateApiAccess({path:req.path,ip:req.ip??req.socket.remoteAddress??"unknown",token:bearerToken(req)??req.get("x-samurai-owner-token")?.trim(),contentLength:req.get("content-length")},{owner:ownerTokenManager,rate:apiRateLimiter,maxBodyBytes:2*1024*1024});if(decision.allowed){next();return}res.status(decision.status).json({error:decision.error})});
  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      if (
        req.url?.startsWith("/api/gateway/slack/events")
        || req.url?.startsWith("/api/gateway/webhooks/")
        || req.url?.startsWith("/api/gateway/line/events")
        || req.url?.startsWith("/api/gateway/email/provider-webhooks/")
      ) {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      }
    }
  }));

  app.post("/api/security/owner-token/rotate",(req,res)=>{if(!ownerTokenManager){res.status(409).json({error:"owner_token_not_configured"});return}const nextToken=typeof req.body?.token==="string"?req.body.token:"";try{ownerTokenManager.rotate(nextToken);res.json({rotated:true})}catch(error){res.status(400).json({error:error instanceof Error?error.message:"owner_token_rotation_failed"})}});

  app.get("/api/health", async (_req, res, next) => {
    try {
      const [pairings, pairingPolicies, routingPolicies, inboundMessages, blockedInbound, failedInbound, boundaryPolicies, mcpConfigs, locks, sandboxInstances, sandboxWorkspaceSyncs, workspaceHealth, backendStatuses, policyDecisions, grants, automationQueue] = await Promise.all([
        store.listGatewayPairings(),
        runtime.listGatewayPairingPolicies(),
        runtime.listGatewayRoutingPolicies(),
        store.listGatewayInboundMessages({ limit: 500 }),
        store.listGatewayInboundMessages({ status: "blocked", limit: 20 }),
        store.listGatewayInboundMessages({ status: "failed", limit: 20 }),
        store.listGatewayBoundaryPolicies(),
        store.listGatewayMcpConfigs(),
        store.listGatewayConcurrencyLocks({ limit: 500 }),
        store.listGatewaySandboxInstances({ limit: 500 }),
        store.listGatewaySandboxWorkspaceSyncs({ limit: 500 }),
        inspectWorkspaceForReadiness(store),
        runtime.listAgentBackends(),
        store.listPolicyDecisions(),
        store.listGrants(),
        store.getAutomationQueueSummary()
      ]);
      const pairingStatuses = countByKey(pairings, "status");
      const pairingPolicyStatuses = countByKey(pairingPolicies, "status");
      const pairingPolicyTrustModes = countByKey(pairingPolicies, "trust_mode");
      const routingPolicyStatuses = countByKey(routingPolicies, "status");
      const routingPolicyStrategies = countByKey(routingPolicies, "session_key_strategy");
      const inboundStatuses = countByKey(inboundMessages, "status");
      const lockStatuses = countByKey(locks, "status");
      const sandboxStatuses = countByKey(sandboxInstances, "status");
      const sandboxBackends = countByKey(sandboxInstances, "backend");
      const sandboxSyncStatuses = countByKey(sandboxWorkspaceSyncs, "status");
      const pluginStatuses = pluginRegistry.listPluginStatuses();
      const startedAtMs = Date.parse(lifecycle.started_at);
      res.json({
        ok: true,
        lifecycle: {
          ...lifecycle,
          uptime_ms: Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0,
          listening: httpServer.listening,
          scheduler_enabled: Boolean(scheduler),
          socket_clients: io.engine.clientsCount
        },
        db: databaseStatus(store),
        llm: providerStatus(provider),
        backends: backendStatuses,
        external_assist: {
          configured: externalAssistProviders.length > 0,
          provider_id: externalAssistProviders.length > 0 ? externalAssistProviders.map((item) => item.id).join(", ") : externalAssistConfig.provider_id,
          provider_ids: externalAssistProviders.length > 0 ? externalAssistProviders.map((item) => item.id) : externalAssistConfig.provider_ids ?? [],
          provider_count: externalAssistProviders.length > 0 ? externalAssistProviders.length : externalAssistConfig.provider_count ?? 0,
          source: externalAssistConfig.source,
          provider_kind: externalAssistConfig.provider_kind,
          max_hints: externalAssistConfig.max_hints,
          timeout_ms: externalAssistConfig.timeout_ms,
          token_configured: externalAssistConfig.token_configured,
          auth_header: externalAssistConfig.auth_header,
          endpoint_origin: externalAssistConfig.endpoint_origin,
          endpoint_path_configured: externalAssistConfig.endpoint_path_configured,
          file_name: externalAssistConfig.file_name,
          errors: externalAssistConfig.errors,
          warnings: externalAssistConfig.warnings
        },
        plugins: {
          manifests: pluginStatuses.length,
          filesystem_manifests: pluginStatuses.filter((status) => status.source === "filesystem").length,
          registered_handlers: pluginStatuses.reduce((sum, status) => sum + status.registered_handler_ids.length, 0),
          missing_handlers: pluginStatuses.reduce((sum, status) => sum + status.missing_handler_ids.length, 0),
          load_issue_count: pluginCatalog.issues.length + pluginEntrypointLoad.issues.length
        },
        policy: {
          capabilities: capabilityManifests.length,
          operations: capabilityManifests.reduce((sum, manifest) => sum + manifest.operations.length, 0),
          decisions: policyDecisions.length,
          grants: grants.length,
          decisions_by_result: countByKey(policyDecisions, "decision")
        },
        automation: {
          scheduler: scheduler?.state ?? {
            enabled: false,
            interval_ms: 0,
            started_at: null,
            running: false,
            tick_count: 0,
            skipped_tick_count: 0,
            last_run_count: 0
          },
          queue: automationQueue
        },
        release: buildBackendReleaseReadinessHealth(),
        gateway: {
          pairing_statuses: pairingStatuses,
          pairing_policy_statuses: pairingPolicyStatuses,
          pairing_policy_trust_modes: pairingPolicyTrustModes,
          routing_policy_statuses: routingPolicyStatuses,
          routing_policy_strategies: routingPolicyStrategies,
          pending_pairings: pairingStatuses.pending ?? 0,
          approved_pairings: pairingStatuses.approved ?? 0,
          inbound_statuses: inboundStatuses,
          blocked_inbound_recent: blockedInbound.length,
          blocked_inbound_reasons: countGatewayInboundErrors(blockedInbound),
          failed_inbound_recent: failedInbound.length,
          failed_inbound_reasons: countGatewayInboundErrors(failedInbound),
          slack_signature_configured: slackSigningSecretConfigured(),
          telegram_webhook_verification_configured: telegramWebhookSecretConfigured(),
          line_signature_configured: lineChannelSecretConfigured(),
          email_provider_webhook_verification_configured: gatewayEmailProviderWebhookVerificationConfigured(),
          email_provider_webhook_verification_providers: gatewayEmailProviderWebhookVerificationProviders(),
          boundary_policies: boundaryPolicies.length,
          mcp_configs: mcpConfigs.length,
          mcp_process_pool: runtime.getMcpProcessPoolStats(),
          concurrency_lock_statuses: lockStatuses,
          active_concurrency_locks: lockStatuses.acquired ?? 0,
          sandbox_executor_statuses: inspectSandboxExecutorCapabilities(),
          sandbox_instance_statuses: sandboxStatuses,
          sandbox_instance_backends: sandboxBackends,
          sandbox_workspace_sync_statuses: sandboxSyncStatuses
        },
        workspace: workspaceHealthReadinessPayload(workspaceHealth),
        workspaceRoot: store.rootDir,
        workspaceDataDir: store.rootDir,
        workspaceWarnings: legacyWorkspaceWarnings({ workspaceRoot: store.rootDir, legacyRepoWorkspaceDir, workspaceHadUserDataBeforeCreate }),
        backendWorkingDirectoryMode
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workspace/health", async (_req, res, next) => {
    try {
      res.json(await store.inspectWorkspace());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workspace/integrity", async (_req, res, next) => {
    try {
      res.json(await store.checkIntegrity());
    } catch (error) {
      next(error);
    }
  });

    app.post("/api/workspace/repair", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "workspace.repair", { dry_run: req.body?.dry_run !== false }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workspace/backups", async (_req, res, next) => {
    try {
      res.json(await store.listWorkspaceBackups());
    } catch (error) {
      next(error);
    }
  });

    app.post("/api/workspace/backups", async (_req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, _req, "workspace.backup.create", {}));
    } catch (error) {
      next(error);
    }
  });

    app.post("/api/workspace/backups/:id/restore", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "workspace.backup.restore", { backup_id: req.params.id }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/resource-translations", async (req, res, next) => {
    try {
      const sourceRef = resourceRefFromQuery(req.query);
      const targetLocale = asSupportedLocale(req.query.target_locale);
      const status = asTranslationStatus(req.query.status);
      res.json(await store.listResourceTranslations({ sourceRef, targetLocale, status }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/resource-translations", async (req, res, next) => {
    try {
      const sourceRef = resourceRef(req.body?.source_ref);
      const sourceLocale = asSupportedLocale(req.body?.source_locale);
      const targetLocale = asSupportedLocale(req.body?.target_locale);
      const status = asTranslationStatus(req.body?.status) ?? "draft";
      if (!sourceRef || !sourceLocale || !targetLocale || typeof req.body?.original_hash !== "string") {
        res.status(400).json({ error: "invalid_resource_translation" });
        return;
      }
      const now = nowIso();
      const record: ResourceTranslationRecord = {
        id: typeof req.body?.id === "string" ? req.body.id : createId("translation"),
        source_ref: sourceRef,
        source_locale: sourceLocale,
        target_locale: targetLocale,
        status,
        original_hash: req.body.original_hash,
        translated_text: typeof req.body?.translated_text === "string" ? req.body.translated_text : "",
        provenance: isRecord(req.body?.provenance) ? provenance(req.body.provenance) : undefined,
        created_at: typeof req.body?.created_at === "string" ? req.body.created_at : now,
        updated_at: typeof req.body?.updated_at === "string" ? req.body.updated_at : now
      };
      res.status(201).json(await runRuntimeApiCommand(runtime, req, "resource.translation.save", record));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/resource-translations/jobs", async (req, res, next) => {
    try {
      const sourceRef = resourceRef(req.body?.source_ref);
      const targetLocale = asSupportedLocale(req.body?.target_locale);
      if (!sourceRef || !targetLocale) {
        res.status(400).json({ error: "invalid_resource_translation_job" });
        return;
      }
      res.status(201).json(await runRuntimeApiWriteCommand(runtime, req, "resource.translation_job.save", {
        source_ref: sourceRef,
        target_locale: targetLocale,
        ...(asSupportedLocale(req.body?.source_locale) ? { source_locale: asSupportedLocale(req.body.source_locale)! } : {}),
        ...(typeof req.body?.schedule === "string" ? { schedule: req.body.schedule } : {}),
        ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
        enabled: req.body?.enabled !== false,
        ...(typeof req.body?.next_run_at === "string" ? { next_run_at: req.body.next_run_at } : {}),
        ...(typeof req.body?.max_attempts === "number" ? { max_attempts: req.body.max_attempts } : {})
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/resource-translations/resolve", async (req, res, next) => {
    try {
      const sourceRef = resourceRef(req.body?.source_ref);
      const targetLocale = asSupportedLocale(req.body?.target_locale);
      if (!sourceRef || !targetLocale) {
        res.status(400).json({ error: "invalid_resource_translation_resolution" });
        return;
      }
      res.json(await store.resolveResourceTranslation({
        sourceRef,
        targetLocale,
        originalHash: typeof req.body?.original_hash === "string" ? req.body.original_hash : undefined,
        fallbackText: typeof req.body?.fallback_text === "string" ? req.body.fallback_text : undefined
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent-backends", async (_req, res, next) => {
    try {
      res.json(await runtime.listAgentBackends());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/chat/sessions", async (req, res, next) => {
    try {
      const session = await runRuntimeApiCommand(runtime, req, "session.create", {
        ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
        ...(asSupportedLocale(req.body?.ui_locale) ? { ui_locale: req.body.ui_locale } : {}),
        ...(asSupportedLocale(req.body?.output_locale) ? { output_locale: req.body.output_locale } : {})
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
          messageCount: (await store.listMessages(session.id)).length
        }))
      );
      res.json(activeSessions.filter((item) => item.messageCount > 0).map((item) => item.session));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/temporary-context", async (req, res, next) => {
    try {
      const input = temporaryContextInput(req.body);
      if (!input) {
        res.status(400).json({ error: "invalid_temporary_context" });
        return;
      }
      const record = await temporaryContexts.save(input);
      res.status(201).json(temporaryContextResponse(record));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/surface/operations", async (req, res, next) => {
    try {
      const operation = parseSurfaceOperation(req.body);
      if (!operation) {
        res.status(400).json({ error: "invalid_surface_operation" });
        return;
      }
      res.status(201).json(await runtime.runSurfaceOperation(operation));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/surface/operations/dispatch-plan", async (req, res, next) => {
    try {
      const operation = parseSurfaceOperation(req.body);
      if (!operation) {
        res.status(400).json({ error: "invalid_surface_operation" });
        return;
      }
      res.json(planSurfaceOperationDispatch(operation));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/surface/renderers", async (_req, res, next) => {
    try {
      res.json(runtime.listSurfaceRenderers());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/surface/contract", async (req, res, next) => {
    try {
      const source = parseDomainCommandInputSource(req.query.source);
      if (req.query.source !== undefined && !source) {
        res.status(400).json({ error: "invalid_domain_command_source" });
        return;
      }
      const renderers = runtime.listSurfaceRenderers();
      res.json({
        protocol_version: "1",
        renderers,
        render_kinds: [...new Set(renderers.map((renderer) => renderer.kind))],
        commands: listDomainCommandEntries(source),
        queries: listDomainQueryEntries(source),
        input_sources: domainCommandInputSources
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/domain/commands", async (req, res, next) => {
    try {
      const source = parseDomainCommandInputSource(req.query.source);
      if (req.query.source !== undefined && !source) {
        domainBadRequest(res, "invalid_domain_command_source");
        return;
      }
      res.json({
        commands: listDomainCommandEntries(source),
        queries: listDomainQueryEntries(source),
        input_sources: domainCommandInputSources
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/domain/commands/diagnostics", async (_req, res, next) => {
    try {
      res.json(getDomainCommandCatalogDiagnostics());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/domain/commands/run", async (req, res, next) => {
    try {
      const commandId = typeof req.body?.command_id === "string" ? req.body.command_id : "";
      if (!commandId) {
        domainBadRequest(res, "domain_command_id_required");
        return;
      }
      warnIgnoredDomainInputSource(req, res);
      if (req.body?.payload !== undefined && !isRecord(req.body.payload)) {
        domainBadRequest(res, "invalid_domain_command_payload");
        return;
      }
      if (getDomainQueryEntry(commandId)) {
        const ingress = await trustedRuntimeApiInput(store, jsonRecord(req.body?.payload ?? {}), {
          sessionId: req.body?.session_id,
          backendRunId: req.body?.backend_run_id
        });
        res.status(200).json(await runtime.runDomainQuery({
          query_id: commandId,
          input_source: "runtime_api",
          payload: ingress.payload
        }, runtimeRequestContext(req, ingress.context)));
        return;
      }
      const ingress = await trustedRuntimeApiInput(store, jsonRecord(req.body?.payload ?? {}), {
        sessionId: req.body?.session_id,
        backendRunId: req.body?.backend_run_id
      });
      res.status(201).json(publicDomainCommandResult(await runtime.runDomainCommand({
        command_id: commandId,
        input_source: "runtime_api",
        idempotency_key: domainCommandIdempotencyKey(req, commandId === "chat.turn.run"),
        payload: ingress.payload
      }, runtimeRequestContext(req, ingress.context))));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/domain/commands/:commandId/run", async (req, res, next) => {
    try {
      warnIgnoredDomainInputSource(req, res);
      if (req.body?.payload !== undefined && !isRecord(req.body.payload)) {
        domainBadRequest(res, "invalid_domain_command_payload");
        return;
      }
      if (getDomainQueryEntry(req.params.commandId)) {
        const ingress = await trustedRuntimeApiInput(store, jsonRecord(req.body?.payload ?? {}), {
          sessionId: req.body?.session_id,
          backendRunId: req.body?.backend_run_id
        });
        res.status(200).json(await runtime.runDomainQuery({
          query_id: req.params.commandId,
          input_source: "runtime_api",
          payload: ingress.payload
        }, runtimeRequestContext(req, ingress.context)));
        return;
      }
      const ingress = await trustedRuntimeApiInput(store, jsonRecord(req.body?.payload ?? {}), {
        sessionId: req.body?.session_id,
        backendRunId: req.body?.backend_run_id
      });
      res.status(201).json(publicDomainCommandResult(await runtime.runDomainCommand({
        command_id: req.params.commandId,
        input_source: "runtime_api",
        idempotency_key: domainCommandIdempotencyKey(req, req.params.commandId === "chat.turn.run"),
        payload: ingress.payload
      }, runtimeRequestContext(req, ingress.context))));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/domain/queries", async (req, res, next) => {
    try {
      const source = parseDomainCommandInputSource(req.query.source);
      if (req.query.source !== undefined && !source) {
        domainBadRequest(res, "invalid_domain_query_source");
        return;
      }
      res.json({ queries: listDomainQueryEntries(source), input_sources: domainCommandInputSources });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/domain/commands/effective", async (req, res, next) => {
    try {
      const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
      if (!sessionId) {
        domainBadRequest(res, "session_id_required");
        return;
      }
      const effective = await runtime.listEffectiveDomainOperations(sessionId, "runtime_api");
      res.json({ session_id: sessionId, commands: effective.commands, input_sources: domainCommandInputSources });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/domain/queries/effective", async (req, res, next) => {
    try {
      const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
      if (!sessionId) {
        domainBadRequest(res, "session_id_required");
        return;
      }
      const effective = await runtime.listEffectiveDomainOperations(sessionId, "runtime_api");
      res.json({ session_id: sessionId, queries: effective.queries, input_sources: domainCommandInputSources });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/domain/queries/:queryId/run", async (req, res, next) => {
    try {
      warnIgnoredDomainInputSource(req, res);
      if (req.body?.payload !== undefined && !isRecord(req.body.payload)) {
        domainBadRequest(res, "invalid_domain_query_payload");
        return;
      }
      const ingress = await trustedRuntimeApiInput(store, jsonRecord(req.body?.payload ?? {}), {
        sessionId: req.body?.session_id,
        backendRunId: req.body?.backend_run_id
      });
      res.status(200).json(await runtime.runDomainQuery({
        query_id: req.params.queryId,
        input_source: "runtime_api",
        payload: ingress.payload
      }, runtimeRequestContext(req, ingress.context)));
    } catch (error) {
      next(error);
    }
  });

    app.post("/api/generated-surfaces/:surfaceId/actions/:actionId/run", async (req, res, next) => {
      try {
        const payload = jsonRecord(req.body?.payload ?? {});
        const actionPayload = payload.action_payload !== undefined && isRecord(payload.action_payload)
          ? jsonRecord(payload.action_payload)
          : {};
        const result = await runtime.runGeneratedSurfaceAction({
          surfaceId: req.params.surfaceId,
          actionId: req.params.actionId,
          revisionId: typeof payload.revision_id === "string" ? payload.revision_id : undefined,
          interactionId: typeof payload.interaction_id === "string" ? payload.interaction_id : `surface_interaction_${Date.now()}`,
          messageId: typeof payload.message_id === "string" ? payload.message_id : undefined,
          actionPayload
        }, runtimeRequestContext(req));
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/generated-surfaces/:surfaceId", async (req, res, next) => {
      try {
        const surface = await store.getGeneratedSurface(req.params.surfaceId);
        if (!surface) {
          res.status(404).json({ error: "generated_surface_not_found" });
          return;
        }
        res.json({ surface, revisions: await store.listGeneratedSurfaceRevisions(surface.id), interactions: await store.listSurfaceInteractions(surface.id) });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/generated-surfaces/:surfaceId/revisions/:revisionId/bundle", async (req, res, next) => {
      try {
        const revision = await store.getGeneratedSurfaceRevision(req.params.revisionId);
        if (!revision || revision.surface_id !== req.params.surfaceId) {
          res.status(404).json({ error: "generated_surface_revision_not_found" });
          return;
        }
        res.json({ revision, bundle: await store.readGeneratedSurfaceBundle(revision.id), csp: generatedSurfaceCsp });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/generated-surfaces/:surfaceId/revisions/:revisionId/assets/{*assetPath}", async (req, res, next) => {
      try {
        const revision = await store.getGeneratedSurfaceRevision(req.params.revisionId);
        if (!revision || revision.surface_id !== req.params.surfaceId) {
          res.status(404).type("text").send("Generated Surface asset not found.");
          return;
        }
        const requestedPath = String(req.params.assetPath ?? "").replace(/^\/+/, "");
        const asset = (await store.readGeneratedSurfaceAssets(revision.id)).find((candidate) => candidate.path === requestedPath);
        if (!asset) {
          res.status(404).type("text").send("Generated Surface asset not found.");
          return;
        }
        res.set("Cache-Control", "private, no-store");
        res.set("X-Content-Type-Options", "nosniff");
        res.type(generatedSurfaceAssetContentType(requestedPath)).send(asset.content);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/generated-surfaces/:surfaceId/revisions/:revisionId/preview", async (req, res, next) => {
      try {
        const surface = await store.getGeneratedSurface(req.params.surfaceId);
        const revision = await store.getGeneratedSurfaceRevision(req.params.revisionId);
        const bundle = revision && revision.surface_id === req.params.surfaceId ? await store.readGeneratedSurfaceBundle(revision.id) : undefined;
        if (!surface || !revision || !bundle) {
          res.status(404).type("text").send("Generated Surface revision not found.");
          return;
        }
        res.set("Content-Security-Policy", generatedSurfaceCsp);
        res.set("Cache-Control", "private, no-store");
        res.set("X-Content-Type-Options", "nosniff");
        res.type("html").send(generatedSurfaceDocument(bundle, surface.actions));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/generated-surfaces/:surfaceId/export", async (req, res, next) => {
      try {
        const surface = await store.getGeneratedSurface(req.params.surfaceId);
        if (!surface) {
          res.status(404).json({ error: "generated_surface_not_found" });
          return;
        }
        const requestedRevision = typeof req.query.revision_id === "string" ? req.query.revision_id : surface.current_revision_id;
        const revision = await store.getGeneratedSurfaceRevision(requestedRevision);
        const bundle = revision && revision.surface_id === surface.id ? await store.readGeneratedSurfaceBundle(revision.id) : undefined;
        if (!revision || !bundle) {
          res.status(404).json({ error: "generated_surface_revision_not_found" });
          return;
        }
        const html = generatedSurfaceDocument(bundle);
        const assets = await store.readGeneratedSurfaceAssets(revision.id);
        const format = req.query.format === "zip" ? "zip" : "html";
        const fileName = `${surface.id}-revision-${revision.revision}.${format}`;
        if (format === "zip") {
          const zip = createStoredZip([
            { name: "index.html", content: html },
            ...(bundle.css ? [{ name: "styles.css", content: bundle.css }] : []),
            ...(bundle.script ? [{ name: "script.js", content: bundle.script }] : []),
            ...assets.map((asset) => ({ name: asset.path, content: asset.content }))
          ]);
          res.set("Content-Disposition", `attachment; filename="${fileName}"`);
          res.type("application/zip").send(zip);
          return;
        }
        res.set("Content-Disposition", `attachment; filename="${fileName}"`);
        res.type("html").send(html);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/skill-optimizations", async (req, res, next) => {
      try {
        const skillId = typeof req.query.skill_id === "string" ? req.query.skill_id : undefined;
        res.json(await store.listSkillOptimizationRuns({ skillId }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/skill-optimizations/:runId", async (req, res, next) => {
      try {
        const run = await store.getSkillOptimizationRun(req.params.runId);
        if (!run) {
          res.status(404).json({ error: "skill_optimization_run_not_found" });
          return;
        }
        const [dataset, candidates] = await Promise.all([
          store.getSkillOptimizationDataset(run.dataset_id),
          store.listOptimizationCandidates(run.id)
        ]);
        const evaluations = (await Promise.all(candidates.map((candidate) => store.listOptimizationEvaluations(candidate.id)))).flat();
        const candidateIds = new Set(candidates.map((candidate) => candidate.id));
        const promotions = (await store.listOptimizationPromotions()).filter((promotion) => promotion.run_id === run.id && candidateIds.has(promotion.candidate_id));
        const snapshots = await Promise.all(promotions.map((promotion) => store.getSkillOptimizationSnapshot(promotion.snapshot_id)));
        res.json({ run, dataset, candidates, evaluations, promotions, snapshots: snapshots.filter(Boolean) });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/action-catalog", async (req, res, next) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      res.json({
        actions: pluginRegistry.listActions(category),
        plugins: pluginRegistry.listPluginStatuses(),
        issues: [...pluginCatalog.issues, ...pluginEntrypointLoad.issues]
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/plugins", async (_req, res, next) => {
    try {
      res.json({
        plugins: pluginRegistry.listPluginStatuses(),
        entrypoints: pluginEntrypointLoad.loaded,
        issues: [...pluginCatalog.issues, ...pluginEntrypointLoad.issues]
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/plugins/:id/status", async (req, res, next) => {
    try {
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      res.json(await runRuntimeApiCommand(runtime, req, "plugin.status.set", {
        plugin_id: req.params.id,
        status: enabled ? "enabled" : "disabled"
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/plugins/diagnostics", async (_req, res, next) => {
    try {
      res.json(pluginDiagnosticsPayload({
        plugins: pluginRegistry.listPluginStatuses(),
        actions: pluginRegistry.listActions(),
        issues: [...pluginCatalog.issues, ...pluginEntrypointLoad.issues]
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/capabilities", async (_req, res, next) => {
    try {
      res.json(capabilityManifests);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/capabilities/:id", async (req, res, next) => {
    try {
      const manifest = getCapabilityManifest(req.params.id);
      if (!manifest) {
        res.status(404).json({ error: "capability_not_found" });
        return;
      }
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/policy/decisions", async (req, res, next) => {
    try {
      const operationId = typeof req.query.operation_id === "string" ? req.query.operation_id : undefined;
      const capabilityId = typeof req.query.capability_id === "string" ? req.query.capability_id : undefined;
      const decisions = await store.listPolicyDecisions();
      res.json(decisions.filter((decision) =>
        (!operationId || decision.operation_id === operationId) &&
        (!capabilityId || decision.capability_id === capabilityId)
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/policy/evaluate", async (req, res, next) => {
    try {
      const rawInput = req.body?.input ?? req.body;
      const parsed = PolicyEvaluationInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_policy_input", issues: parsed.error.issues });
        return;
      }
      const manifest = getCapabilityManifest(parsed.data.capability_id);
      const decision = evaluatePolicy({
        input: parsed.data,
        manifest,
        grants: await store.listGrants(),
        operationId: typeof req.body?.operation_id === "string" ? req.body.operation_id : createId("operation_preview")
      });
      res.json({
        decision,
        manifest,
        operation: manifest?.operations.find((item) => item.operation === parsed.data.operation),
        preview: true
      });
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
        const [messages, messagePresentations, operations, artifacts, auditRecords, memory, activity, backendRuns, backendEvents, workspaceChanges, toolRuns, reflectionRuns] = await Promise.all([
          store.listMessages(session.id),
          store.listMessagePresentations({ sessionId: session.id }),
          store.listOperations(session.id),
          store.listArtifactsForSession(session.id),
          store.listAuditRecords(),
          store.listMemoryForSession(session.id),
          store.readActivityInputs().then((inputs) => import("@samurai-agent/audit").then(({ buildActivityInboxItems }) => buildActivityInboxItems(inputs))),
          store.listBackendRuns(session.id),
          store.listBackendEvents({ sessionId: session.id }),
          store.listWorkspaceChanges(session.id),
          store.listToolRuns({ sessionId: session.id }),
          store.listReflectionRuns(session.id)
        ]);
        res.json({ session, messages, messagePresentations, operations, artifacts, auditRecords, memory, activity, backendRuns, backendEvents, workspaceChanges, toolRuns, reflectionRuns });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/chat/sessions/:sessionId/transcript", async (req, res, next) => {
      try {
        const transcript = await store.exportSessionTranscript(req.params.sessionId);
        if (!transcript) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        res.json(transcript);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/chat/sessions/:sessionId/resume-state", async (req, res, next) => {
      try {
        const transcript = await store.exportSessionTranscript(req.params.sessionId);
        if (!transcript) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        res.json(buildSessionResumeState(transcript));
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
        const result = await runRuntimeApiCommand(runtime, req, "chat.turn.run", {
          content,
          ...(typeof req.body?.backend_id === "string" ? { backend_id: req.body.backend_id } : {}),
          ...(asSupportedLocale(req.body?.input_locale) ? { input_locale: req.body.input_locale } : {}),
          ...(asSupportedLocale(req.body?.output_locale) ? { output_locale: req.body.output_locale } : {}),
          metadata: jsonRecord(req.body?.metadata)
        }, { sessionId: req.params.sessionId }, { requireIdempotencyKey: true });
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
        const result = await runRuntimeApiCommand(runtime, req, "chat.turn.run", {
          content,
          ...(typeof req.body?.backend_id === "string" ? { backend_id: req.body.backend_id } : {}),
          ...(asSupportedLocale(req.body?.ui_locale) ? { ui_locale: req.body.ui_locale } : {}),
          ...(asSupportedLocale(req.body?.input_locale) ? { input_locale: req.body.input_locale } : {}),
          ...(asSupportedLocale(req.body?.output_locale) ? { output_locale: req.body.output_locale } : {}),
          metadata: jsonRecord(req.body?.metadata)
        }, {}, { requireIdempotencyKey: true });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/backend-runs/:runId/tool-calls", async (req, res, next) => {
      try {
        const toolName = typeof req.body?.tool_name === "string" ? req.body.tool_name.trim() : "";
        if (!toolName) {
          res.status(400).json({ error: "tool_name_required" });
          return;
        }
        const toolCallId = typeof req.body?.tool_call_id === "string" ? req.body.tool_call_id.trim() : "";
        if (!toolCallId) {
          res.status(400).json({ error: "tool_call_id_required" });
          return;
        }
        if (req.body?.input !== undefined && !isRecord(req.body.input)) {
          res.status(400).json({ error: "invalid_tool_input" });
          return;
        }
        const token = bearerToken(req);
        if (!token) {
          res.status(401).json({ error: "tool_bridge_token_required" });
          return;
        }
        res.status(201).json(await runtime.runBackendToolBridgeCall({
          runId: req.params.runId,
          token,
          toolName,
          toolCallId,
          toolInput: jsonRecord(req.body?.input ?? {})
        }));
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

    app.post("/api/search/reindex", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "session.search.reindex", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/context/preview", async (req, res, next) => {
      try {
        const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
        if (!sessionId) {
          res.status(400).json({ error: "session_id_required" });
          return;
        }
        res.json(await runtime.previewContext({
          sessionId,
          query: typeof req.query.q === "string" ? req.query.q : ""
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/context/freeze", async (req, res, next) => {
      try {
        const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : "";
        if (!sessionId) {
          res.status(400).json({ error: "session_id_required" });
          return;
        }
        res.json(await runtime.freezeContext({
          sessionId,
          query: typeof req.body?.query === "string"
            ? req.body.query
            : typeof req.body?.q === "string"
              ? req.body.q
              : ""
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/external-assist", async (req, res, next) => {
      try {
        const phaseRaw = typeof req.query.phase === "string" ? req.query.phase : undefined;
        const phase = phaseRaw ? ExternalAssistPhaseSchema.safeParse(phaseRaw) : undefined;
        if (phaseRaw && !phase?.success) {
          res.status(400).json({ error: "invalid_external_assist_phase" });
          return;
        }
        const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
        res.json(await store.listExternalAssistRecords({
          ...(typeof req.query.session_id === "string" ? { sessionId: req.query.session_id } : {}),
          ...(phase?.success ? { phase: phase.data } : {}),
          ...(Number.isFinite(limitRaw) && limitRaw !== undefined ? { limit: Math.max(1, Math.min(100, limitRaw)) } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/external-assist/diagnostics", async (req, res, next) => {
      try {
        const phaseRaw = typeof req.query.phase === "string" ? req.query.phase : undefined;
        const phase = phaseRaw ? ExternalAssistPhaseSchema.safeParse(phaseRaw) : undefined;
        if (phaseRaw && !phase?.success) {
          res.status(400).json({ error: "invalid_external_assist_phase" });
          return;
        }
        const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
        const status = statusRaw ? ExternalAssistStatusSchema.safeParse(statusRaw) : undefined;
        if (statusRaw && !status?.success) {
          res.status(400).json({ error: "invalid_external_assist_status" });
          return;
        }
        const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
        res.json(await store.getExternalAssistDiagnostics({
          ...(typeof req.query.session_id === "string" ? { sessionId: req.query.session_id } : {}),
          ...(phase?.success ? { phase: phase.data } : {}),
          ...(status?.success ? { status: status.data } : {}),
          ...(typeof req.query.provider_id === "string" ? { providerId: req.query.provider_id } : {}),
          ...(Number.isFinite(limitRaw) && limitRaw !== undefined ? { limit: Math.max(1, Math.min(500, limitRaw)) } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/reflection/run", async (req, res, next) => {
      try {
        const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : "";
        if (!sessionId) {
          res.status(400).json({ error: "session_id_required" });
          return;
        }
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "reflection.run", {
          ...(typeof req.body?.source_run_id === "string" ? { source_run_id: req.body.source_run_id } : {})
        }, { sessionId }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/reflection/diagnostics", async (req, res, next) => {
      try {
        const staleAfterHours = typeof req.query.stale_after_hours === "string"
          ? Number.parseInt(req.query.stale_after_hours, 10)
          : undefined;
        res.json(await reflectionDiagnosticsPayload(store, {
          sessionId: typeof req.query.session_id === "string" ? req.query.session_id : undefined,
          staleAfterHours: typeof staleAfterHours === "number" && Number.isFinite(staleAfterHours) && staleAfterHours > 0 ? staleAfterHours : undefined,
          limit: numberQuery(req.query.limit)
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/run", async (req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "curator.run", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/curator/snapshots", async (_req, res, next) => {
      try {
        res.json(await store.listLearningSnapshots());
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/snapshots/prune", async (req, res, next) => {
      try {
        const retain = typeof req.body?.retain === "number" ? req.body.retain : 20;
        res.json(await runRuntimeApiCommand(runtime, req, "learning.snapshot.prune", { retain }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/snapshots/:id/restore", async (req, res, next) => {
      try {
        const restored = await runtime.runDomainCommand({
          command_id: "curator.restore",
          input_source: "runtime_api",
          idempotency_key: domainCommandIdempotencyKey(req),
          payload: { snapshot_id: req.params.id }
        });
        res.json(restored.result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/pause", async (req, res, next) => {
      try {
        const result = await runtime.runDomainCommand({ command_id: "curator.pause", input_source: "runtime_api", idempotency_key: domainCommandIdempotencyKey(req) });
        res.json(result.result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/resume", async (req, res, next) => {
      try {
        const result = await runtime.runDomainCommand({ command_id: "curator.resume", input_source: "runtime_api", idempotency_key: domainCommandIdempotencyKey(req) });
        res.json(result.result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/curator/skill-actions/apply", async (req, res, next) => {
      try {
        const skillId = typeof req.body?.skill_id === "string" ? req.body.skill_id : "";
        const parsedAction = CuratorLifecycleActionSchema.safeParse(req.body?.action);
        const action = parsedAction.success ? parsedAction.data : undefined;
        if (!skillId || !action || action === "review") {
          res.status(400).json({ error: "invalid_curator_skill_action" });
          return;
        }
        res.json(await runRuntimeApiWriteCommand(runtime, req, "skill.lifecycle.apply", {
          skill_id: skillId,
          action
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/evaluation/run", async (req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "evaluation.run", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/evaluation/learning", async (req, res, next) => {
      try {
        res.json(await store.listLearningEvaluations({
          resourceId: typeof req.query.resource_id === "string" ? req.query.resource_id : undefined,
          taskClass: typeof req.query.task_class === "string" ? req.query.task_class : undefined
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/learning/reports", async (req, res, next) => {
      try {
        const jobKind = typeof req.query.job_kind === "string" && ["background_review", "evaluation", "curator"].includes(req.query.job_kind)
          ? req.query.job_kind as "background_review" | "evaluation" | "curator"
          : undefined;
        res.json(await store.listLearningJobReports({ jobKind, limit: numberQuery(req.query.limit) }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/evaluation/diagnostics", async (req, res, next) => {
      try {
        const staleAfterHours = typeof req.query.stale_after_hours === "string"
          ? Number.parseInt(req.query.stale_after_hours, 10)
          : undefined;
        res.json(await evaluationDiagnosticsPayload(store, {
          sessionId: typeof req.query.session_id === "string" ? req.query.session_id : undefined,
          staleAfterHours: typeof staleAfterHours === "number" && Number.isFinite(staleAfterHours) && staleAfterHours > 0 ? staleAfterHours : undefined,
          limit: numberQuery(req.query.limit)
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/reflection-runs/:id", async (req, res, next) => {
      try {
        const reflectionRun = await store.getReflectionRun(req.params.id);
        if (!reflectionRun) {
          res.status(404).json({ error: "reflection_run_not_found" });
          return;
        }
        res.json({
          reflectionRun,
          suggestions: await store.listReflectionSuggestions(reflectionRun.id)
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/reflection-suggestions/:id/apply", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "reflection.suggestion.apply", { suggestion_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/tools/file", async (req, res, next) => {
      try {
        const operation = typeof req.body?.operation === "string" ? req.body.operation : "";
        if (!["file.read", "file.inspect", "file.list", "file.write", "file.patch"].includes(operation)) {
          res.status(400).json({ error: "invalid_file_operation" });
          return;
        }
        const filePath = typeof req.body?.path === "string" ? req.body.path : "";
        if (!filePath) {
          res.status(400).json({ error: "path_required" });
          return;
        }
        const payload = {
          path: filePath,
          ...(typeof req.body?.content === "string" ? { content: req.body.content } : {}),
          ...(typeof req.body?.search === "string" ? { search: req.body.search } : {}),
          ...(typeof req.body?.replace === "string" ? { replace: req.body.replace } : {})
        };
        if (getDomainQueryEntry(operation)) {
          res.setHeader("Warning", '299 - "Query operation sent to legacy command URL"');
          const result = await runDynamicRuntimeApiQuery(runtime, req, operation, payload);
          res.json(isRecord(result) ? result : { resource: result });
          return;
        }
        res.json(await runDynamicRuntimeApiWriteCommand(runtime, req, operation, payload));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/tools/browser", async (req, res, next) => {
      try {
        const operation = typeof req.body?.operation === "string" ? req.body.operation : "";
        if (!["browser.navigate", "browser.extract", "browser.interact", "browser.screenshot", "browser.download_to_workspace"].includes(operation)) {
          res.status(400).json({ error: "invalid_browser_operation" });
          return;
        }
        const url = typeof req.body?.url === "string" ? req.body.url : "";
        if (!url) {
          res.status(400).json({ error: "url_required" });
          return;
        }
        const payload = {
          url,
          ...(typeof req.body?.output_path === "string" ? { output_path: req.body.output_path } : {}),
          ...(typeof req.body?.action === "string" ? { action: req.body.action } : {}),
          ...(typeof req.body?.selector === "string" ? { selector: req.body.selector } : {}),
          ...(typeof req.body?.value === "string" ? { value: req.body.value } : {})
        };
        if (getDomainQueryEntry(operation)) {
          res.setHeader("Warning", '299 - "Query operation sent to legacy command URL"');
          const result = await runDynamicRuntimeApiQuery(runtime, req, operation, payload);
          res.json(isRecord(result) ? result : { resource: result });
          return;
        }
        res.json(await runDynamicRuntimeApiWriteCommand(runtime, req, operation, payload));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/tools/file-browser/diagnostics", async (req, res, next) => {
      try {
        res.json(await fileBrowserActionDiagnosticsPayload(store, {
          sessionId: typeof req.query.session_id === "string" ? req.query.session_id : undefined,
          limit: numberQuery(req.query.limit)
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/external-sends", async (_req, res, next) => {
      try {
        res.json(await store.listExternalSends());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/external-sends/diagnostics", async (req, res, next) => {
      try {
        const staleAfterHours = typeof req.query.stale_after_hours === "string"
          ? Number.parseInt(req.query.stale_after_hours, 10)
          : undefined;
        res.json(await externalSendDiagnosticsPayload(store, {
          staleAfterHours: typeof staleAfterHours === "number" && Number.isFinite(staleAfterHours) && staleAfterHours > 0 ? staleAfterHours : undefined
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/external-sends", async (req, res, next) => {
      try {
        const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
        const body = typeof req.body?.body === "string" ? req.body.body : "";
        const channel = typeof req.body?.channel === "string" ? req.body.channel : "webhook";
        if (!title || !body || !externalSendChannels.includes(channel as (typeof externalSendChannels)[number])) {
          res.status(400).json({ error: "invalid_external_send" });
          return;
        }
        res.status(201).json(await runRuntimeApiWriteCommand(runtime, req, "external.send.prepare", {
          channel: channel as (typeof externalSendChannels)[number],
          target: jsonRecord(req.body?.target),
          title,
          body
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/external-sends/:id/dispatch", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "external.send.dispatch", { send_id: req.params.id, dry_run: req.body?.dry_run !== false }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/pairings", async (req, res, next) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
        const sourceIdentity = typeof req.query.source_identity === "string" ? req.query.source_identity : undefined;
        const sessionKey = typeof req.query.session_key === "string" ? req.query.session_key : undefined;
        const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
        res.json(await store.listGatewayPairings({
          status: isGatewayPairingStatus(status) ? status : undefined,
          channel: isGatewayChannel(channel) ? channel : undefined,
          sourceIdentity,
          sessionKey,
          limit
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/pairing-policies", async (_req, res, next) => {
      try {
        res.json(await runtime.listGatewayPairingPolicies());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/pairing-policies/:channel", async (req, res, next) => {
      try {
        if (!isGatewayChannel(req.params.channel)) {
          res.status(400).json({ error: "invalid_gateway_channel" });
          return;
        }
        res.json(await runtime.getGatewayPairingPolicy(req.params.channel));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairing-policies", async (req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "gateway.pairing_policy.save", req.body));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/routing-policies", async (_req, res, next) => {
      try {
        res.json(await runtime.listGatewayRoutingPolicies());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/routing-policies/:channel", async (req, res, next) => {
      try {
        if (!isGatewayChannel(req.params.channel)) {
          res.status(400).json({ error: "invalid_gateway_channel" });
          return;
        }
        res.json(await runtime.getGatewayRoutingPolicy(req.params.channel));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/routing-policies", async (req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "gateway.routing_policy.save", req.body));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/session-routing/preview", async (req, res, next) => {
      try {
        const channel = typeof req.body?.channel === "string" ? req.body.channel : "webhook";
        const sourceIdentity = typeof req.body?.source_identity === "string" ? req.body.source_identity.trim() : "";
        if (!isGatewayChannel(channel) || !sourceIdentity) {
          res.status(400).json({ error: "invalid_gateway_session_routing_preview" });
          return;
        }
        const input = {
          channel,
          source_identity: sourceIdentity,
          source_label: typeof req.body?.source_label === "string" ? req.body.source_label : undefined,
          account_id: typeof req.body?.account_id === "string" ? req.body.account_id : undefined,
          thread_id: typeof req.body?.thread_id === "string" ? req.body.thread_id : undefined,
          route: typeof req.body?.route === "string" ? req.body.route : undefined,
          metadata: isRecord(req.body?.metadata) ? jsonRecord(req.body.metadata) : {}
        };
        const policy = await runtime.getGatewayRoutingPolicy(channel);
        res.json({
          input,
          policy,
          resolution: resolveGatewaySessionRouting(policy, input)
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairings/expire", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.pairing.expire", {}));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/repair", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.state.repair", {
          dry_run: req.body?.dry_run !== false
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/diagnostics", async (_req, res, next) => {
      try {
        res.json(await gatewayDiagnosticsPayload(store));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairings/:id/approve", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.pairing.approve", { pairing_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairings/:id/reject", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.pairing.reject", { pairing_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairings/:id/rotate", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.pairing.rotate", { pairing_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/pairings/:id/revoke", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.pairing.revoke", { pairing_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/inbound", async (req, res, next) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
        res.json(await store.listGatewayInboundMessages({
          status: isGatewayInboundStatus(status) ? status : undefined,
          limit
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/boundary-policies", async (req, res, next) => {
      try {
        const sourceChannel = typeof req.query.source_channel === "string" && isGatewayBoundarySource(req.query.source_channel)
          ? req.query.source_channel
          : undefined;
        const sessionKey = typeof req.query.session_key === "string" ? req.query.session_key : undefined;
        res.json(await store.listGatewayBoundaryPolicies({ sourceChannel, sessionKey }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/mcp-configs", async (req, res, next) => {
      try {
        const enabled = typeof req.query.enabled === "string"
          ? req.query.enabled === "true"
          : undefined;
        const serverName = typeof req.query.server_name === "string" ? req.query.server_name : undefined;
        const configs = await store.listGatewayMcpConfigs({ enabled, serverName });
        res.json(configs.map(summarizeGatewayMcpConfig));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/mcp-configs/:id", async (req, res, next) => {
      try {
        const config = await store.getGatewayMcpConfig(req.params.id);
        if (!config) {
          res.status(404).json({ error: "gateway_mcp_config_not_found" });
          return;
        }
        res.json(summarizeGatewayMcpConfig(config));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/mcp-configs", async (req, res, next) => {
      try {
        const saved = await runRuntimeApiCommand(runtime, req, "gateway.mcp_config.save", req.body);
        res.status(201).json(summarizeGatewayMcpConfig(saved));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/concurrency-locks", async (req, res, next) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
        res.json(await store.listGatewayConcurrencyLocks({
          status: isGatewayConcurrencyLockStatus(status) ? status : undefined,
          limit
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/concurrency-locks/expire", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.concurrency_lock.expire", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/sandbox-instances", async (req, res, next) => {
      try {
        const status = typeof req.query.status === "string" && isGatewaySandboxInstanceStatus(req.query.status)
          ? req.query.status
          : undefined;
        const scope = typeof req.query.scope === "string" && isSandboxScope(req.query.scope)
          ? req.query.scope
          : undefined;
        const backend = typeof req.query.backend === "string" && isSandboxBackend(req.query.backend)
          ? req.query.backend
          : undefined;
        const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
        res.json(await store.listGatewaySandboxInstances({ status, scope, backend, limit }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/gateway/sandbox-workspace-syncs", async (req, res, next) => {
      try {
        const instanceId = typeof req.query.instance_id === "string" ? req.query.instance_id : undefined;
        const instanceKey = typeof req.query.instance_key === "string" ? req.query.instance_key : undefined;
        const status = typeof req.query.status === "string" && isGatewaySandboxWorkspaceSyncStatus(req.query.status)
          ? req.query.status
          : undefined;
        const direction = typeof req.query.direction === "string" && isGatewaySandboxWorkspaceSyncDirection(req.query.direction)
          ? req.query.direction
          : undefined;
        const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
        res.json(await store.listGatewaySandboxWorkspaceSyncs({ instanceId, instanceKey, status, direction, limit }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/sandbox-instances/:id/recreate", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.sandbox.recreate", { sandbox_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/sandbox-instances/:id/delete", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.sandbox.delete", { sandbox_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/sandbox-instances/:id/sync", async (req, res, next) => {
      try {
        const direction = typeof req.body?.direction === "string" ? req.body.direction : undefined;
        if (direction && !isGatewaySandboxWorkspaceSyncDirection(direction)) {
          res.status(400).json({ error: "invalid_gateway_sandbox_workspace_sync_direction" });
          return;
        }
        res.json(await runRuntimeApiCommand(runtime, req, "gateway.sandbox.sync", {
          sandbox_id: req.params.id,
          ...(direction ? { direction: GatewaySandboxWorkspaceSyncDirectionSchema.parse(direction) } : {}),
          dry_run: req.body?.dry_run !== false
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/envelope-preview", async (req, res, next) => {
      try {
        const context = gatewayEnvelopePreviewContext(req.body);
        if (!context) {
          res.status(400).json({ error: "invalid_gateway_envelope_preview_context" });
          return;
        }
        const userIntent = typeof req.body?.user_intent === "string" ? req.body.user_intent : "";
        const settings = await store.getSettings();
        res.json(createGatewayEnvelope(
          context,
          userIntent,
          asSupportedLocale(req.body?.input_locale) ?? settings.ui_locale,
          asSupportedLocale(req.body?.output_locale) ?? settings.output_locale,
          isRecord(req.body?.metadata) ? req.body.metadata : {}
        ));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/inbound", async (req, res, next) => {
      try {
        const channel = typeof req.body?.channel === "string" ? req.body.channel : "webhook";
        const sourceIdentity = typeof req.body?.source_identity === "string" ? req.body.source_identity.trim() : "";
        const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
        if (!isGatewayChannel(channel) || !sourceIdentity || !body) {
          res.status(400).json({ error: "invalid_gateway_inbound" });
          return;
        }
        const domainResult = await runtime.runDomainCommand({
          command_id: "gateway.inbound.route",
          input_source: "gateway_inbound",
          idempotency_key: gatewayInboundRequestKey(req),
          payload: {
            channel,
            source_identity: sourceIdentity,
            source_label: typeof req.body?.source_label === "string" ? req.body.source_label : undefined,
            body,
            route: typeof req.body?.route === "string" ? req.body.route : undefined,
            metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
            backend_id: typeof req.body?.backend_id === "string" ? req.body.backend_id : undefined,
            input_locale: asSupportedLocale(req.body?.input_locale),
            output_locale: asSupportedLocale(req.body?.output_locale)
          }
        });
        const result = domainResult.result as GatewayInboundRuntimeResult;
        res.status(result.chat ? 201 : 202).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/webhooks/:source_identity", async (req, res, next) => {
      try {
        const webhookSecret=process.env.SAMURAI_GATEWAY_WEBHOOK_SECRET?.trim();
        const rawBody=rawBodyForRequest(req),timestamp=req.get("x-samurai-timestamp")?.trim(),signature=req.get("x-samurai-signature")?.trim();
        if(!webhookSecret||!rawBody||!timestamp||!signature||!verifySignedWebhook({secret:webhookSecret,timestamp,signature,body:rawBody}).ok){res.status(401).json({error:"invalid_gateway_webhook_signature"});return}
        const sourceIdentity = req.params.source_identity.trim();
        const extraction = gatewayWebhookBodyExtraction(req.body);
        if (!sourceIdentity || !extraction?.body) {
          res.status(400).json({ error: "invalid_gateway_webhook" });
          return;
        }
        const domainResult = await runtime.runDomainCommand({
          command_id: "gateway.inbound.route",
          input_source: "gateway_inbound",
          idempotency_key: gatewayInboundRequestKey(req),
          payload: {
            channel: "webhook",
            source_identity: sourceIdentity,
            source_label: stringFromRequest(req.body, req.query as Record<string, unknown>, "source_label"),
            body: extraction.body,
            route: stringFromRequest(req.body, req.query as Record<string, unknown>, "route"),
            account_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "account_id"),
            thread_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "thread_id"),
            metadata: gatewayWebhookMetadata(req.body, extraction.field),
            backend_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "backend_id"),
            input_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "input_locale")),
            output_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "output_locale"))
          }
        });
        const result = domainResult.result as GatewayInboundRuntimeResult;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: {
            channel: "webhook",
            source_identity: sourceIdentity,
            body_field: extraction.field
          }
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/slack/events", async (req, res, next) => {
      try {
        const signature = verifySlackRequestSignature(req);
        if (!signature.ok) {
          res.status(401).json({
            error: "invalid_gateway_slack_signature",
            reason: signature.reason,
            signature_status: signature.status
          });
          return;
        }
        if (isSlackUrlVerification(req.body)) {
          res.json({ challenge: req.body.challenge.trim() });
          return;
        }
        const extraction = gatewaySlackEventExtraction(req.body, req.query as Record<string, unknown>);
        if (!extraction) {
          res.status(400).json({ error: "invalid_gateway_slack_event" });
          return;
        }
        const domainResult = await runtime.runDomainCommand({
          command_id: "gateway.inbound.route",
          input_source: "gateway_inbound",
          idempotency_key: gatewayInboundRequestKey(req),
          payload: {
            channel: "slack",
            source_identity: extraction.source_identity,
            source_label: extraction.source_label,
            body: extraction.body,
            route: stringFromRequest(req.body, req.query as Record<string, unknown>, "route"),
            account_id: extraction.account_id,
            thread_id: extraction.thread_id,
            metadata: gatewaySlackMetadata(req.body, extraction, signature),
            backend_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "backend_id"),
            input_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "input_locale")),
            output_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "output_locale"))
          }
        });
        const result = domainResult.result as GatewayInboundRuntimeResult;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: {
            channel: "slack",
            source_identity: extraction.source_identity,
            body_field: extraction.body_field,
            team_id: extraction.team_id,
            channel_id: extraction.channel_id,
            user_id: extraction.user_id
          }
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/telegram/updates", async (req, res, next) => {
      try {
        const secret = verifyTelegramWebhookSecret(req);
        if (!secret.ok) {
          res.status(401).json({
            error: "invalid_gateway_telegram_secret",
            reason: secret.reason,
            verification_status: secret.status
          });
          return;
        }
        const extraction = gatewayTelegramUpdateExtraction(req.body, req.query as Record<string, unknown>);
        if (!extraction) {
          res.status(400).json({ error: "invalid_gateway_telegram_update" });
          return;
        }
        const domainResult = await runtime.runDomainCommand({
          command_id: "gateway.inbound.route",
          input_source: "gateway_inbound",
          idempotency_key: gatewayInboundRequestKey(req),
          payload: {
            channel: "telegram",
            source_identity: extraction.source_identity,
            source_label: extraction.source_label,
            body: extraction.body,
            route: stringFromRequest(req.body, req.query as Record<string, unknown>, "route"),
            account_id: extraction.account_id,
            thread_id: extraction.thread_id,
            metadata: gatewayTelegramMetadata(req.body, extraction, secret),
            backend_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "backend_id"),
            input_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "input_locale")),
            output_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "output_locale"))
          }
        });
        const result = domainResult.result as GatewayInboundRuntimeResult;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: {
            channel: "telegram",
            source_identity: extraction.source_identity,
            body_field: extraction.body_field,
            update_id: extraction.update_id,
            chat_id: extraction.chat_id,
            user_id: extraction.user_id,
            message_id: extraction.message_id
          }
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/line/events", async (req, res, next) => {
      try {
        const signature = verifyLineRequestSignature(req);
        if (!signature.ok) {
          res.status(401).json({
            error: "invalid_gateway_line_signature",
            reason: signature.reason,
            signature_status: signature.status
          });
          return;
        }
        const extraction = gatewayLineEventExtraction(req.body, req.query as Record<string, unknown>);
        if (!extraction) {
          res.status(400).json({ error: "invalid_gateway_line_event" });
          return;
        }
        const domainResult = await runtime.runDomainCommand({
          command_id: "gateway.inbound.route",
          input_source: "gateway_inbound",
          idempotency_key: gatewayInboundRequestKey(req),
          payload: {
            channel: "line",
            source_identity: extraction.source_identity,
            source_label: extraction.source_label,
            body: extraction.body,
            route: stringFromRequest(req.body, req.query as Record<string, unknown>, "route"),
            account_id: extraction.account_id,
            thread_id: extraction.thread_id,
            metadata: gatewayLineMetadata(req.body, extraction, signature),
            backend_id: stringFromRequest(req.body, req.query as Record<string, unknown>, "backend_id"),
            input_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "input_locale")),
            output_locale: asSupportedLocale(stringFromRequest(req.body, req.query as Record<string, unknown>, "output_locale"))
          }
        });
        const result = domainResult.result as GatewayInboundRuntimeResult;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: {
            channel: "line",
            source_identity: extraction.source_identity,
            body_field: extraction.body_field,
            event_index: extraction.event_index,
            source_type: extraction.source_type,
            user_id: extraction.user_id,
            group_id: extraction.group_id,
            room_id: extraction.room_id,
            message_id: extraction.message_id
          }
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/email/messages", async (req, res, next) => {
      try {
        const routed = await routeGatewayEmailPayload(runtime, req.body, req.query as Record<string, unknown>);
        if (!routed) {
          res.status(400).json({ error: "invalid_gateway_email_message" });
          return;
        }
        const result = routed.result;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: gatewayEmailAdapterSummary(routed.extraction)
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/mobile/messages", async (req, res, next) => {
      try {
        const routed = await routeGatewayMobilePayload(runtime, req.body, req.query as Record<string, unknown>);
        if (!routed) {
          res.status(400).json({ error: "invalid_gateway_mobile_message" });
          return;
        }
        const result = routed.result;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: gatewayMobileAdapterSummary(routed.extraction)
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/email/provider-webhooks/:provider", async (req, res, next) => {
      try {
        const provider = gatewayEmailWebhookProvider(req.params.provider);
        if (!provider) {
          res.status(400).json({ error: "unsupported_gateway_email_provider_webhook" });
          return;
        }
        const verification = verifyGatewayEmailProviderWebhookRequest(req, provider);
        if (!verification.ok) {
          res.status(401).json({
            error: "invalid_gateway_email_provider_webhook_verification",
            provider,
            reason: verification.reason,
            verification_status: verification.status
          });
          return;
        }
        const payload = gatewayEmailProviderWebhookPayload(provider, req.body, req.query as Record<string, unknown>, verification);
        if (!payload) {
          res.status(400).json({ error: "invalid_gateway_email_provider_webhook" });
          return;
        }
        const routed = await routeGatewayEmailPayload(runtime, payload, req.query as Record<string, unknown>);
        if (!routed) {
          res.status(400).json({ error: "invalid_gateway_email_provider_webhook" });
          return;
        }
        const result = routed.result;
        res.status(result.chat ? 201 : 202).json({
          ...result,
          adapter: {
            ...gatewayEmailAdapterSummary(routed.extraction),
            provider
          }
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/gateway/email/imap/poll", async (req, res, next) => {
      try {
        const config = gatewayEmailImapTransportConfig(req.body);
        if (!config) {
          res.status(503).json({
            error: "gateway_email_imap_not_configured",
            message: "Set SAMURAI_EMAIL_IMAP_HOST, SAMURAI_EMAIL_IMAP_USER, and SAMURAI_EMAIL_IMAP_PASSWORD to enable IMAP polling."
          });
          return;
        }
        const client = await gatewayEmailImapClientFactory(config);
        try {
          const poll = await client.poll();
          const messages = [];
          const skipped = [];
          for (const message of poll.messages.slice(0, config.maxMessages)) {
            const payload = gatewayEmailImapPayload(message, config, req.body);
            const routed = await routeGatewayEmailPayload(runtime, payload, req.query as Record<string, unknown>);
            if (!routed) {
              skipped.push({ uid: message.uid, error: "invalid_gateway_email_message" });
              continue;
            }
            messages.push({
              uid: message.uid,
              adapter: gatewayEmailAdapterSummary(routed.extraction),
              ...routed.result
            });
          }
          res.status(200).json({
            transport: {
              channel: "email",
              transport: "imap",
              configured: true,
              mailbox: poll.mailbox,
              mark_seen: config.markSeen,
              scanned: poll.scanned,
              message_count: messages.length,
              skipped_count: skipped.length
            },
            messages,
            skipped
          });
        } finally {
          client.close();
        }
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/automation/queue", async (req, res, next) => {
      try {
        const now = typeof req.query.now === "string" ? req.query.now : undefined;
        res.json(await store.getAutomationQueueSummary(now));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/automation/scheduler", async (_req, res, next) => {
      try {
        res.json(scheduler?.state ?? {
          enabled: false,
          interval_ms: 0,
          started_at: null,
          running: false,
          tick_count: 0,
          skipped_tick_count: 0,
          last_run_count: 0
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/scheduler/tick", async (req, res, next) => {
      try {
        const now = typeof req.body?.now === "string" ? req.body.now : undefined;
        const context = runtimeRequestContext(req);
        const runs = scheduler ? await scheduler.tick(now, context) : await runtime.runDueAutomationJobs(now, context);
        res.status(201).json({ scheduler: scheduler?.state, runs });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/schedules/preview", async (req, res, next) => {
      try {
        const schedule = typeof req.body?.schedule === "string" ? req.body.schedule : "";
        if (!schedule.trim()) {
          res.status(400).json({ error: "invalid_schedule" });
          return;
        }
        res.json(runtime.previewAutomationSchedule(schedule, typeof req.body?.from === "string" ? req.body.from : undefined));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/automation/jobs", async (req, res, next) => {
      try {
        const dueAt = typeof req.query.due_at === "string" ? req.query.due_at : undefined;
        const enabledOnly = req.query.enabled_only === "true";
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
        const jobs = await store.listAutomationJobs({ dueAt, enabledOnly });
        res.json(jobs.filter((job) =>
          (!status || job.status === status) &&
          (!kind || job.kind === kind)
        ));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/automation/runs", async (req, res, next) => {
      try {
        const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        res.json(await store.listAutomationRuns(Number.isFinite(limit) ? limit : 100));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/jobs/:id/status", async (req, res, next) => {
      try {
        const status = req.body?.status;
        if (status !== "enabled" && status !== "disabled") {
          res.status(400).json({ error: "invalid_automation_status" });
          return;
        }
        res.json(await runRuntimeApiWriteCommand(runtime, req, "automation.job.set_status", { job_id: req.params.id, status }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/automation/jobs/:id", async (req, res, next) => {
      try {
        const job = await store.getAutomationJob(req.params.id);
        if (!job) {
          res.status(404).json({ error: "automation_job_not_found" });
          return;
        }
        res.json(job);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/jobs", async (req, res, next) => {
      try {
        const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
        const kind = typeof req.body?.kind === "string" ? req.body.kind : "custom_instruction";
        const schedule = typeof req.body?.schedule === "string" ? req.body.schedule : "daily";
        const targetInstruction = typeof req.body?.target_instruction === "string" ? req.body.target_instruction : title;
        if (!title || !["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"].includes(kind)) {
          res.status(400).json({ error: "invalid_automation_job" });
          return;
        }
        res.status(201).json(await runRuntimeApiWriteCommand(runtime, req, "automation.job.save", {
          title,
          kind,
          schedule,
          target_instruction: targetInstruction,
          delivery_target: jsonRecord(req.body?.delivery_target),
          enabled: req.body?.enabled !== false,
          ...(typeof req.body?.next_run_at === "string" ? { next_run_at: req.body.next_run_at } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/jobs/:id/requeue", async (req, res, next) => {
      try {
        const job = await runRuntimeApiCommand(runtime, req, "automation.job.requeue", {
          job_id: req.params.id,
          ...(typeof req.body?.next_run_at === "string" ? { next_run_at: req.body.next_run_at } : {})
        });
        res.json(job);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/jobs/:id/release-lock", async (req, res, next) => {
      try {
        const job = await runRuntimeApiCommand(runtime, req, "automation.job.release_lock", {
          job_id: req.params.id,
          ...(typeof req.body?.now === "string" ? { now: req.body.now } : {})
        });
        res.json(job);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/automation/jobs/run-due", async (req, res, next) => {
      try {
        const now = typeof req.body?.now === "string" ? req.body.now : undefined;
        const context = runtimeRequestContext(req);
        res.status(201).json(scheduler ? await scheduler.tick(now, context) : await runtime.runDueAutomationJobs(now, context));
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
        const translation = await resolveDetailTranslation(
          req.query as Record<string, unknown>,
          artifact.file_ref,
          artifact.locale,
          content ?? ""
        );
        res.json({ artifact, content, operation, auditRecords, ...translation });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/artifacts/:id/content", async (req, res, next) => {
      try {
        const artifact = await store.getArtifact(req.params.id);
        if (!artifact) {
          res.status(404).json({ error: "artifact_not_found" });
          return;
        }
        const contentType = typeof artifact.metadata.content_type === "string" ? artifact.metadata.content_type : "text/markdown";
        const textContent = await store.readArtifactContent(req.params.id);
        if (textContent !== undefined) {
          res.type(contentType).send(textContent);
          return;
        }
        const binaryContent = await store.readArtifactBinaryContent(req.params.id);
        if (!binaryContent) {
          res.status(404).json({ error: "artifact_content_not_found" });
          return;
        }
        res.type(contentType).send(Buffer.from(binaryContent));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/audit", async (req, res, next) => {
      try {
        const operationId = typeof req.query.operation_id === "string" ? req.query.operation_id : undefined;
        const [auditRecords, operations, policyDecisions, approvalRequests, rollbackPoints] = await Promise.all([
          store.listAuditRecords(),
          store.listOperations(),
          store.listPolicyDecisions(),
          store.listApprovalRequests(),
          store.listRollbackPoints()
        ]);
        res.json({
          auditRecords: auditRecords.filter((record) => !operationId || record.operation_id === operationId),
          operations: operations.filter((operation) => !operationId || operation.id === operationId),
          policyDecisions: policyDecisions.filter((decision) => !operationId || decision.operation_id === operationId),
          approvalRequests: approvalRequests.filter((approval) => !operationId || approval.operation_id === operationId),
          rollbackPoints: rollbackPoints.filter((point) => !operationId || point.operation_id === operationId)
        });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/grants", async (req, res, next) => {
      try {
        const capabilityId = typeof req.query.capability_id === "string" ? req.query.capability_id : undefined;
        const operation = typeof req.query.operation === "string" ? req.query.operation : undefined;
        const grants = await store.listGrants();
        res.json(grants.filter((grant) =>
          (!capabilityId || grant.capability_id === capabilityId) &&
          (!operation || grant.operation === operation)
        ));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/grants/:id", async (req, res, next) => {
      try {
        const grant = await store.getGrant(req.params.id);
        if (!grant) {
          res.status(404).json({ error: "grant_not_found" });
          return;
        }
        res.json(grant);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/grants", async (req, res, next) => {
      res.status(410).json({ error: "deprecated_operation", operation_id: "grant.create", replacement: { kind: "effective_inventory", target: "/api/domain/commands/effective" } });
    });

    app.post("/api/grants/:id/revoke", async (req, res, next) => {
      res.status(410).json({ error: "deprecated_operation", operation_id: "grant.revoke", replacement: { kind: "effective_inventory", target: "/api/domain/commands/effective" } });
    });

    app.get("/api/rollback-points", async (req, res, next) => {
      try {
        const operationId = typeof req.query.operation_id === "string" ? req.query.operation_id : undefined;
        const points = await store.listRollbackPoints();
        res.json(points.filter((point) => !operationId || point.operation_id === operationId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/rollback-points/:id", async (req, res, next) => {
      try {
        const point = await store.getRollbackPoint(req.params.id);
        if (!point) {
          res.status(404).json({ error: "rollback_point_not_found" });
          return;
        }
        res.json(point);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/rollback/:id/restore", async (req, res, next) => {
      try {
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "rollback.restore", { rollback_point_id: req.params.id }));
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

    app.get("/api/backend-runs/:runId", async (req, res, next) => {
      try {
        const run = await store.getBackendRun(req.params.runId);
        if (!run) {
          res.status(404).json({ error: "backend_run_not_found" });
          return;
        }
        res.json(run);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/client-events", async (req, res, next) => {
      try {
        const targetClientKind = parseClientTargetKind(req.query.target_client_kind);
        const status = parseClientEventStatus(req.query.status);
        if (req.query.target_client_kind !== undefined && !targetClientKind) {
          res.status(400).json({ error: "invalid_client_target_kind" });
          return;
        }
        if (req.query.status !== undefined && !status) {
          res.status(400).json({ error: "invalid_client_event_status" });
          return;
        }
        const now = nowIso();
        await runtime.runDomainCommand({
          command_id: "client.event.expire",
          input_source: "runtime_api",
          idempotency_key: `client-event-expire:${stableHash({ now })}`,
          payload: { now }
        });
        res.json(await store.listClientEvents({
          targetClientKind,
          targetClientId: typeof req.query.target_client_id === "string" ? req.query.target_client_id : undefined,
          status,
          limit: numberQuery(req.query.limit)
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/client-events", async (req, res, next) => {
      try {
        const event = clientEventFromRequestBody(req.body);
        if (!event) {
          res.status(400).json({ error: "invalid_client_event" });
          return;
        }
        res.status(201).json(await runRuntimeApiCommand(runtime, req, "client.event.save", event));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/client-events/:eventId/deliver", async (req, res, next) => {
      try {
        const event = await runRuntimeApiCommand(runtime, req, "client.event.deliver", { event_id: req.params.eventId });
        res.json(event);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/client-events/:eventId/ack", async (req, res, next) => {
      try {
        const event = await runRuntimeApiCommand(runtime, req, "client.event.ack", { event_id: req.params.eventId });
        res.json(event);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/client-events/:eventId/fail", async (req, res, next) => {
      try {
        const errorCode = typeof req.body?.error_code === "string" && req.body.error_code.trim()
          ? req.body.error_code.trim()
          : "client_event_failed";
        const event = await runRuntimeApiCommand(runtime, req, "client.event.fail", { event_id: req.params.eventId, error_code: errorCode });
        res.json(event);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/backend-runs/:runId/cancel", async (req, res, next) => {
      try {
        res.json(await runtime.cancelBackendRun(req.params.runId));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/backend-runs/:runId/resume", async (req, res, next) => {
      try {
        res.json(await runtime.resumeBackendRun(req.params.runId, jsonRecord(req.body)));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/backend-runs/:runId/stream-sync", async (req, res, next) => {
      try {
        const maxEvents = typeof req.body?.max_events === "number" ? req.body.max_events : undefined;
        const timeoutMs = typeof req.body?.timeout_ms === "number" ? req.body.timeout_ms : undefined;
        res.json(await runtime.syncBackendStream(req.params.runId, { maxEvents, timeoutMs }));
      } catch (error) {
        next(error);
      }
    });

    registerBackendEventRoutes(app, store);

    app.get("/api/backend-runs/:runId/tool-runs", async (req, res, next) => {
      try {
        const run = await store.getBackendRun(req.params.runId);
        if (!run) {
          res.status(404).json({ error: "backend_run_not_found" });
          return;
        }
        res.json(await store.listToolRuns({ runId: req.params.runId }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/backend-runs/:runId/tool-runs/diagnostics", async (req, res, next) => {
      try {
        const run = await store.getBackendRun(req.params.runId);
        if (!run) {
          res.status(404).json({ error: "backend_run_not_found" });
          return;
        }
        const status = asToolRunStatus(req.query.status);
        if (req.query.status !== undefined && !status) {
          res.status(400).json({ error: "invalid_tool_run_status" });
          return;
        }
        res.json(toolRunDiagnosticsPayload(await store.getToolRunDiagnostics({
          runId: req.params.runId,
          status,
          limit: numberQuery(req.query.limit)
        })));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/tool-runs/diagnostics", async (req, res, next) => {
      try {
        const status = asToolRunStatus(req.query.status);
        if (req.query.status !== undefined && !status) {
          res.status(400).json({ error: "invalid_tool_run_status" });
          return;
        }
        res.json(toolRunDiagnosticsPayload(await store.getToolRunDiagnostics({
          runId: typeof req.query.run_id === "string" ? req.query.run_id : undefined,
          sessionId: typeof req.query.session_id === "string" ? req.query.session_id : undefined,
          status,
          limit: numberQuery(req.query.limit)
        })));
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

    app.get("/api/memory/active-retrieval", async (req, res, next) => {
      try {
        res.json(await runtime.previewActiveMemory({
          query: typeof req.query.q === "string" ? req.query.q : ""
        }));
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
        const translation = await resolveDetailTranslation(
          req.query as Record<string, unknown>,
          {
            kind: "memory",
            id: memory.id,
            uri: memory.file_path,
            label: memory.topic
          },
          memory.content_locale,
          content ?? ""
        );
        res.json({ memory, content, ...translation });
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

    app.get("/api/skills/diagnostics", async (_req, res, next) => {
      try {
        res.json(await skillDiagnosticsPayload(store));
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
        const supportFiles = await store.listSkillSupportFiles(req.params.id);
        const sourceLocale = asSupportedLocale(req.query.source_locale) ?? "ja";
        const translation = await resolveDetailTranslation(
          req.query as Record<string, unknown>,
          {
            kind: "skill",
            id: skill.id,
            uri: skill.file_path,
            label: skill.title
          },
          sourceLocale,
          markdown ?? ""
        );
        res.json({ skill, markdown, supportFiles, ...translation });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/skills/:id/support", async (req, res, next) => {
      try {
        const skill = await store.getSkill(req.params.id);
        if (!skill) {
          res.status(404).json({ error: "skill_not_found" });
          return;
        }
        res.json(await store.listSkillSupportFiles(req.params.id));
      } catch (error) {
        next(error);
      }
    });

    app.patch("/api/skills/:id", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "skill.patch", {
          skill_id: req.params.id,
          ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
          ...(typeof req.body?.description === "string" ? { description: req.body.description } : {}),
          ...(typeof req.body?.content === "string" ? { content: req.body.content } : {}),
          ...(Array.isArray(req.body?.tags) ? { tags: stringArray(req.body.tags) } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/skills/:id/state", async (req, res, next) => {
      try {
        const state = req.body?.state;
        if (state !== "active" && state !== "disabled") {
          res.status(400).json({ error: "invalid_skill_state" });
          return;
        }
        res.json(await runRuntimeApiWriteCommand(runtime, req, "skill.lifecycle.apply", {
          skill_id: req.params.id,
          action: state === "active" ? "reactivate" : "archive"
        }));
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
        const result = await runRuntimeApiWriteCommand(runtime, req, "skill.candidate.create", {
          title,
          description,
          content: typeof req.body?.content === "string" && req.body.content.trim() ? req.body.content : description,
          tags: stringArray(req.body?.tags),
          required_capabilities: stringArray(req.body?.required_capabilities)
        });
        res.status(201).json(result);
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
        const result = await runRuntimeApiWriteCommand(runtime, req, "skill.project.save", { candidate_id: candidateId });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/skills/:id/support", async (req, res, next) => {
      try {
        const supportPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
        if (!supportPath) {
          res.status(400).json({ error: "support_path_required" });
          return;
        }
        const content = typeof req.body?.content === "string" ? req.body.content : "";
        const result = await runRuntimeApiWriteCommand(runtime, req, "skill.support_file.save", {
          skill_id: req.params.id,
          path: supportPath,
          content
        });
        res.status(201).json(result);
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

    app.get("/api/wiki/active-retrieval", async (req, res, next) => {
      try {
        res.json(await runtime.previewKnowledgeWiki({
          query: typeof req.query.q === "string" ? req.query.q : ""
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki/graph", async (req, res, next) => {
      try {
        res.json(await runtime.previewKnowledgeWikiGraph({
          activeOnly: req.query.active_only === "false" ? false : true
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki/diagnostics", async (_req, res, next) => {
      try {
        res.json(await knowledgeWikiDiagnosticsPayload(store));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki/lint", async (_req, res, next) => {
      try {
        res.json(await runtime.inspectKnowledgeWikiQuality());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/wiki/:id/backlinks", async (req, res, next) => {
      try {
        const report = await runtime.inspectKnowledgeWikiQuality();
        res.json(report.backlinks[req.params.id] ?? []);
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
        const translation = await resolveDetailTranslation(
          req.query as Record<string, unknown>,
          {
            kind: "wiki",
            id: wiki.id,
            uri: wiki.file_path,
            label: wiki.title
          },
          wiki.content_locale,
          content ?? ""
        );
        res.json({ wiki, content, ...translation });
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
        const proposalProvenance = provenance(req.body?.provenance);
        const result = await runRuntimeApiWriteCommand(runtime, req, "wiki.proposal.create", {
          title,
          content,
          ...(typeof req.body?.slug === "string" ? { slug: req.body.slug } : {}),
          tags: stringArray(req.body?.tags),
          ...(asSupportedLocale(req.body?.content_locale) ? { content_locale: req.body.content_locale } : {}),
          source_refs: resourceRefs(req.body?.source_refs),
          ...(proposalProvenance ? { provenance: proposalProvenance } : {})
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/accept", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "wiki.accept", { wiki_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/reject", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "wiki.reject", { wiki_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.patch("/api/wiki/:id", async (req, res, next) => {
      try {
        const patchProvenance = provenance(req.body?.provenance);
        const result = await runRuntimeApiWriteCommand(runtime, req, "wiki.patch", {
          wiki_id: req.params.id,
          ...(typeof req.body?.title === "string" ? { title: req.body.title.trim() } : {}),
          ...(typeof req.body?.content === "string" ? { content: req.body.content } : {}),
          ...(Array.isArray(req.body?.tags) ? { tags: stringArray(req.body.tags) } : {}),
          ...(asSupportedLocale(req.body?.content_locale) ? { content_locale: req.body.content_locale } : {}),
          ...(Array.isArray(req.body?.source_refs) ? { source_refs: resourceRefs(req.body.source_refs) } : {}),
          ...(patchProvenance ? { provenance: patchProvenance } : {})
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/:id/archive", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "wiki.archive", { wiki_id: req.params.id }));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/wiki/reindex", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "wiki.reindex", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/schemas", async (_req, res, next) => {
      try {
        res.json(await store.listCollectionSchemas());
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/schemas", async (req, res, next) => {
      try {
        const parsed = CollectionSchemaSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_collection_schema", details: parsed.error.flatten() });
          return;
        }
        const result = await runRuntimeApiWriteCommand(runtime, req, "collection.schema.save", parsed.data);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/reindex", async (req, res, next) => {
      try {
        res.json(await runRuntimeApiWriteCommand(runtime, req, "collection.reindex", {}));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/triggers", async (_req, res, next) => {
      try {
        res.json(await store.listCollectionTriggerStates());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/actions", async (_req, res, next) => {
      try {
        res.json(await runtime.listCollectionActions());
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

    app.get("/api/collections/:collectionId/actions", async (req, res, next) => {
      try {
        res.json(await runtime.listCollectionActions(req.params.collectionId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/triggers", async (req, res, next) => {
      try {
        res.json(await store.listCollectionTriggerStates(req.params.collectionId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/records", async (req, res, next) => {
      try {
        res.json(await store.listCollectionRecords(req.params.collectionId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/view-data", async (req, res, next) => {
      try {
        const ids = queryStringList(req.query.ids);
        const fields = queryStringList(req.query.fields);
        res.json(await runRuntimeApiQuery(runtime, req, "collection.records.list", {
          collection_id: req.params.collectionId,
          ...(ids.length > 0 ? { ids } : {}),
          ...(fields.length > 0 ? { fields } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.put("/api/collections/:collectionId/view-data", async (req, res, next) => {
      try {
        const result = await runtime.runCollectionManageCompatibility({
          action: "putItems",
          collection_id: req.params.collectionId,
          items: Array.isArray(req.body?.items) ? req.body.items.map(jsonSafe) : [],
          mode: typeof req.body?.mode === "string" ? req.body.mode : "merge"
        }, "runtime_api", domainCommandIdempotencyKey(req));
        res.json(result);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/patches", async (req, res, next) => {
      try {
        res.json(await store.listCollectionPatches({ collectionId: req.params.collectionId }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/records/:recordId", async (req, res, next) => {
      try {
        const record = await store.getCollectionRecord(req.params.collectionId, req.params.recordId);
        if (!record) {
          res.status(404).json({ error: "collection_record_not_found" });
          return;
        }
        const content = JSON.stringify(record.data, null, 2);
        const sourceLocale = asSupportedLocale(record.data.content_locale) ?? asSupportedLocale(req.query.source_locale) ?? "ja";
        const translation = await resolveDetailTranslation(
          req.query as Record<string, unknown>,
          {
            kind: "collection_record",
            id: record.id,
            uri: record.file_path,
            label: `${record.collection_id}/${record.id}`
          },
          sourceLocale,
          content
        );
        res.json({ ...record, ...translation });
      } catch (error) {
        next(error);
      }
    });

    app.delete("/api/collections/:collectionId/records/:recordId", async (req, res, next) => {
      try {
        const result = await runRuntimeApiWriteCommand(runtime, req, "collection.record.delete", {
          collection_id: req.params.collectionId,
          record_id: req.params.recordId,
          ...(typeof req.query.view_id === "string" ? { view_id: req.query.view_id } : {})
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/records/:recordId/refs", async (req, res, next) => {
      try {
        res.json(await store.resolveCollectionRecordRefs(req.params.collectionId, req.params.recordId));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/records/:recordId/patches", async (req, res, next) => {
      try {
        res.json(await store.listCollectionPatches({
          collectionId: req.params.collectionId,
          recordId: req.params.recordId
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/collections/:collectionId/records/:recordId/patches/:patchId", async (req, res, next) => {
      try {
        const patch = await store.getCollectionPatch(req.params.collectionId, req.params.recordId, req.params.patchId);
        if (!patch) {
          res.status(404).json({ error: "collection_patch_not_found" });
          return;
        }
        res.json(patch);
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
        const result = await runRuntimeApiWriteCommand(runtime, req, "collection.record.create", {
          record_id: record.id,
          collection_id: record.collection_id,
          data: jsonRecord(record.data),
          resource_refs: resourceRefs(record.resource_refs)
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/:collectionId/records/:recordId/patches", async (req, res, next) => {
      try {
        const expectedVersion = positiveIntegerOrUndefined(req.body?.expected_version, undefined);
        if (!expectedVersion) {
          res.status(400).json({ error: "expected_version_required" });
          return;
        }
        const patch = {
          id: typeof req.body?.id === "string" ? req.body.id : createId("patch"),
          record_id: req.params.recordId,
          changes: isRecord(req.body?.changes) ? req.body.changes : {},
          created_at: typeof req.body?.created_at === "string" ? req.body.created_at : nowIso()
        };
        const result = await runRuntimeApiWriteCommand(runtime, req, "collection.patch.apply", {
          collection_id: req.params.collectionId,
          record_id: req.params.recordId,
          patch_id: patch.id,
          expected_version: expectedVersion,
          changes: jsonRecord(patch.changes)
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/collections/:collectionId/actions/:actionId/run", async (req, res, next) => {
      try {
        const result = await runRuntimeApiWriteCommand(runtime, req, "collection.action.run", {
          collection_id: req.params.collectionId,
          action_id: req.params.actionId,
          ...(typeof req.body?.backend_id === "string" ? { backend_id: req.body.backend_id } : {}),
          ...(typeof req.body?.record_id === "string" ? { record_id: req.body.record_id } : {}),
          payload: jsonRecord(req.body?.payload)
        });
        res.json(result);
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

    app.post("/api/automation/memory-review/run", async (req, res, next) => {
      try {
        const result = await runRuntimeApiCommand(runtime, req, "automation.memory_review.run", {});
        res.status(201).json(result);
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
        const result = await runRuntimeApiCommand(runtime, req, "memory.archive", { memory_id: req.params.id }, { sessionId });
        res.json(archiveMemoryPayload(result));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/settings", async (_req, res, next) => {
      try {
        res.json(settingsPayload(await store.getSettings()));
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
        const settings = await runRuntimeApiCommand(runtime, req, "settings.patch", patch);
        io.emit("settings.updated", settings);
        res.json(settingsPayload(settings));
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/approval-requests/:id/approve", async (req, res, next) => {
      res.status(410).json({ error: "deprecated_operation", operation_id: "approval.approve", replacement: { kind: "effective_inventory", target: "/api/domain/commands/effective" } });
    });

    app.post("/api/approval-requests/:id/deny", async (req, res, next) => {
      res.status(410).json({ error: "deprecated_operation", operation_id: "approval.deny", replacement: { kind: "effective_inventory", target: "/api/domain/commands/effective" } });
    });

    app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api/domain/")) {
        const status = error instanceof RuntimeRequestError
          ? runtimeRequestHttpStatus(error.code)
          : 500;
        const code = error instanceof RuntimeRequestError ? error.code : "internal_error";
        const message = error instanceof Error ? redactSecretLikeString(error.message) : "Unknown error";
        res.status(status).json({
          ok: false,
          error: {
            code,
            message,
            retryable: error instanceof RuntimeRequestError ? error.code === "provider_failed" : false,
            ...(error instanceof RuntimeRequestError && error.payload ? { details: redactApiObject(runtimeErrorPayload(error.payload)) } : {})
          }
        });
        return;
      }
      if (error instanceof RuntimeRequestError) {
        const status = runtimeRequestHttpStatus(error.code);
        if (error.code === "provider_not_configured" || error.code === "provider_failed") {
          res.status(status).json(providerErrorPayload(error));
          return;
        }
        res.status(status).json({
          error: error.code,
          message: redactSecretLikeString(error.message),
          ...(error.payload ? redactApiObject(runtimeErrorPayload(error.payload)) : {})
        });
        return;
      }

      console.error(redactErrorForLog(error));
      res.status(500).json({
        error: "internal_error",
        message: error instanceof Error ? redactSecretLikeString(error.message) : "Unknown error"
      });
    });

  httpServer.once("close", () => {
    if (scheduler) {
      clearInterval(scheduler.timer);
    }
  });

  return {
    app,
    httpServer,
    io,
    store,
    runtime,
    lifecycle,
    temporaryContexts,
    shutdown,
    pluginRegistry,
    pluginCatalogIssues: pluginCatalog.issues,
    pluginEntrypointLoad,
    ...(scheduler ? { scheduler } : {})
  };
}

export async function startServer(port?: number): Promise<ApiServer> {
  loadServerEnv();
  const resolvedPort = port ?? Number(process.env.PORT ?? defaultPort);
  const server = await createApiServer();
  try {
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
  } catch (error) {
    try {
      await closeApiServer(server);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "server_startup_cleanup_failed");
    }
    throw error;
  }
  console.log(`Samurai Agent API listening on http://127.0.0.1:${resolvedPort}`);
  return server;
}

async function waitForActiveRequestsToDrain(shutdown: ApiServerShutdownState, deadlineAt: number): Promise<boolean> {
  if (shutdown.activeRequests.size === 0) return true;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    let check: () => void;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shutdown.drainWaiters.delete(check);
      resolve(drained);
    };
    check = () => {
      if (shutdown.activeRequests.size === 0) finish(true);
    };
    shutdown.drainWaiters.add(check);
    timer = setTimeout(() => finish(shutdown.activeRequests.size === 0), Math.max(0, deadlineAt - Date.now()));
  });
}

async function awaitBeforeDeadline(task: Promise<unknown>, deadlineAt: number): Promise<{ completed: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ completed: false });
    }, Math.max(0, deadlineAt - Date.now()));
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error === undefined ? { completed: true } : { completed: true, error });
    };
    task.then(() => done(), (error) => done(error));
  });
}

export function closeApiServer(server: ApiServer): Promise<void> {
  const existing = apiServerClosePromises.get(server);
  if (existing) {
    return existing;
  }
  if (!server.lifecycle.closing && !server.lifecycle.closed_at) {
    server.lifecycle.closing = true;
    server.lifecycle.close_started_at = nowIso();
  }
  const closePromise = (async () => {
    const errors: unknown[] = [];
    const shutdown = server.shutdown ?? {
      acceptingRequests: true,
      abortController: new AbortController(),
      activeRequests: new Set<Promise<void>>(),
      drainWaiters: new Set<() => void>(),
      timeoutMs: defaultServerShutdownTimeoutMs
    };
    server.shutdown = shutdown;
    if (shutdown.abortController.signal.aborted) shutdown.abortController = new AbortController();
    shutdown.acceptingRequests = false;
    const deadlineAt = Date.now() + shutdown.timeoutMs;
    const abortTimer = setTimeout(() => {
      shutdown.abortController.abort();
      server.httpServer.closeAllConnections?.();
    }, Math.max(0, deadlineAt - Date.now()));
    const ioCloseTask = Promise.resolve().then(() => server.io.close());
    const httpCloseTask = new Promise<void>((resolve, reject) => {
      if (!server.httpServer.listening) {
        resolve();
        return;
      }
      server.httpServer.close((error) => error ? reject(error) : resolve());
    });
    let safeToCloseStore = true;
    if (server.scheduler) {
      try {
        if (typeof server.scheduler.stop === "function") {
          await server.scheduler.stop({ signal: shutdown.abortController.signal, deadlineAt });
        } else {
          clearInterval(server.scheduler.timer);
        }
      } catch (error) {
        errors.push(error);
        safeToCloseStore = false;
      }
    }
    if (!(await waitForActiveRequestsToDrain(shutdown, deadlineAt))) {
      errors.push(new Error("api_server_active_requests_shutdown_timeout"));
      safeToCloseStore = false;
    }
    const ioClosed = await awaitBeforeDeadline(ioCloseTask, deadlineAt);
    if (!ioClosed.completed) errors.push(new Error("api_server_socket_io_shutdown_timeout"));
    else if (ioClosed.error) errors.push(ioClosed.error);
    const httpClosed = await awaitBeforeDeadline(httpCloseTask, deadlineAt);
    if (!httpClosed.completed) errors.push(new Error("api_server_http_shutdown_timeout"));
    else if (httpClosed.error) errors.push(httpClosed.error);
    try {
      const runtimeClosed = await awaitBeforeDeadline(Promise.resolve().then(() => server.runtime.shutdown()), deadlineAt);
      if (!runtimeClosed.completed) {
        errors.push(new Error("api_server_runtime_shutdown_timeout"));
        safeToCloseStore = false;
      } else if (runtimeClosed.error) {
        errors.push(runtimeClosed.error);
        safeToCloseStore = false;
      }
    } catch (error) {
      errors.push(error);
      safeToCloseStore = false;
    }
    try {
      const temporaryClosed = await awaitBeforeDeadline(Promise.resolve().then(() => server.temporaryContexts.close()), deadlineAt);
      if (!temporaryClosed.completed) {
        errors.push(new Error("api_server_temporary_context_shutdown_timeout"));
        safeToCloseStore = false;
      } else if (temporaryClosed.error) {
        errors.push(temporaryClosed.error);
      }
    } catch (error) {
      errors.push(error);
      safeToCloseStore = false;
    }
    if (safeToCloseStore) try {
      // WorkspaceStore is the final cleanup step: Runtime/MCP and temporary files
      // must no longer need to read from it when it is closed.
      await server.store.close();
    } catch (error) {
      errors.push(error);
    }
    else errors.push(new Error("workspace_store_close_deferred_active_shutdown"));
    clearTimeout(abortTimer);
    if (errors.length > 0) {
      server.lifecycle.closing = true;
      server.lifecycle.close_error = "api_server_close_failed";
      throw new AggregateError(errors, "api_server_close_failed");
    }
    delete server.lifecycle.close_error;
    server.lifecycle.closed_at = nowIso();
    server.lifecycle.closing = false;
  })();
  apiServerClosePromises.set(server, closePromise);
  void closePromise.catch(() => {
    if (apiServerClosePromises.get(server) === closePromise) apiServerClosePromises.delete(server);
  });
  return closePromise;
}

function asSupportedLocale(value: unknown): SupportedLocale | undefined {
  return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? (value as SupportedLocale) : undefined;
}

function parseDomainCommandInputSource(value: unknown): DomainCommandInputSource | undefined {
  return typeof value === "string" && domainCommandInputSources.includes(value as DomainCommandInputSource)
    ? value as DomainCommandInputSource
    : undefined;
}

function warnIgnoredDomainInputSource(req: Request, res: Response): void {
  if (req.body?.input_source !== undefined) {
    res.setHeader("Warning", '299 - "input_source is ignored; the server determines the ingress source"');
  }
}

export async function trustedRuntimeApiPayload(
  store: WorkspaceStore,
  payload: Record<string, JsonValue>
): Promise<Record<string, JsonValue>> {
  return assertTrustedRuntimePayload(store, payload, (code, message) => new RuntimeRequestError(code, message));
}

export async function trustedRuntimeApiInput(
  store: WorkspaceStore,
  payload: Record<string, JsonValue>,
  transport: { sessionId?: unknown; backendRunId?: unknown } = {}
) {
  return resolveTrustedRuntimeApiInput(store, payload, transport, (code, message) => new RuntimeRequestError(code, message));
}

function domainBadRequest(res: Response, code: string): void {
  res.status(400).json({
    ok: false,
    error: { code, message: code, retryable: false }
  });
}

function runtimeRequestHttpStatus(code: RuntimeRequestError["code"]): number {
  if (code === "bad_request" || code === "validation") return 400;
  if (code === "gone") return 410;
  if (code === "not_found") return 404;
  if (code === "forbidden") return 403;
  if (code === "provider_failed") return 502;
  if (code === "internal") return 500;
  return 409;
}

function domainCommandIdempotencyKey(req: Request, required = false): string | undefined {
  const header = req.get("Idempotency-Key");
  const body = typeof req.body?.idempotency_key === "string" ? req.body.idempotency_key : undefined;
  const key = header ?? body;
  if (key === undefined) {
    if (required) {
      throw new RuntimeRequestError("conflict", "idempotency_key_required");
    }
    return undefined;
  }
  const normalized = key.trim();
  if (!normalized || normalized.length > 200) {
    throw new RuntimeRequestError("conflict", "invalid_domain_command_idempotency_key");
  }
  return normalized;
}

function publicDomainCommandResult(result: {
  result: unknown;
}) {
  return {
    ok: true,
    value: result.result
  };
}

function gatewayInboundRequestKey(req: Request): string {
  return `gateway:${stableHash({ path: req.path, body: jsonSafe(req.body) })}`;
}

function gatewayInboundPayloadKey(adapter: string, payload: unknown, query: Record<string, unknown>): string {
  return `gateway:${stableHash({ adapter, payload: jsonSafe(payload), query: jsonSafe(query) })}`;
}

async function runRuntimeApiCommand<Id extends DomainCommandId>(
  runtime: AgentRuntime,
  req: Request,
  commandId: Id,
  payload: unknown,
  context: TrustedRuntimeApiContext = {},
  options: { requireIdempotencyKey?: boolean } = {}
): Promise<DomainOperationOutput<Id>> {
  const input = parseDomainOperationInput(commandId, payload);
  const result = await runtime.runDomainCommand({
    command_id: commandId,
    input_source: "runtime_api",
    idempotency_key: domainCommandIdempotencyKey(req, options.requireIdempotencyKey === true),
    payload: input
  }, runtimeRequestContext(req, context));
  return result.result as DomainOperationOutput<Id>;
}

async function runRuntimeApiQuery<Id extends DomainQueryId>(
  runtime: AgentRuntime,
  req: Request,
  queryId: Id,
  payload: unknown,
  context: TrustedRuntimeApiContext = {}
): Promise<DomainOperationOutput<Id>> {
  const input = parseDomainOperationInput(queryId, payload);
  const result = await runtime.runDomainQuery({
    query_id: queryId,
    input_source: "runtime_api",
    payload: input
  }, runtimeRequestContext(req, context));
  return result.result as DomainOperationOutput<Id>;
}

interface RuntimeWriteValue {
  resource: unknown;
  operation: unknown;
  policyDecision?: unknown;
  auditRecord?: unknown;
  rollbackPoint?: unknown;
  activity: unknown;
}

type DomainWriteCommandId = {
  [Id in DomainCommandId]: DomainOperationOutput<Id> extends RuntimeWriteValue ? Id : never;
}[DomainCommandId];

function requireRuntimeWriteValue(value: unknown, commandId: string): RuntimeWriteValue {
  if (!isRecord(value) || !("resource" in value) || !("operation" in value) || !("activity" in value)) {
    throw new Error(`domain_command_write_result_invalid:${commandId}`);
  }
  return {
    resource: value.resource,
    operation: value.operation,
    ...(value.policyDecision === undefined ? {} : { policyDecision: value.policyDecision }),
    ...(value.auditRecord === undefined ? {} : { auditRecord: value.auditRecord }),
    ...(value.rollbackPoint === undefined ? {} : { rollbackPoint: value.rollbackPoint }),
    activity: value.activity
  };
}

async function runRuntimeApiWriteCommand<Id extends DomainWriteCommandId>(
  runtime: AgentRuntime,
  req: Request,
  commandId: Id,
  payload: DomainOperationInput<Id>
) {
  return runtimeWritePayload(requireRuntimeWriteValue(
    await runRuntimeApiCommand(runtime, req, commandId, payload),
    commandId
  ));
}

/** Dynamic legacy tool selection is parsed before it crosses the Registry boundary. */
async function runDynamicRuntimeApiWriteCommand(
  runtime: AgentRuntime,
  req: Request,
  commandId: string,
  payload: unknown
) {
  if (!isDomainCommandId(commandId)) {
    throw new RuntimeRequestError("not_found", `domain_command_not_found:${commandId}`);
  }
  const input = parseDomainOperationInput(commandId, payload);
  const result = await runtime.runDomainCommand({
    command_id: commandId,
    input_source: "runtime_api",
    idempotency_key: domainCommandIdempotencyKey(req),
    payload: input
  }, runtimeRequestContext(req));
  return runtimeWritePayload(requireRuntimeWriteValue(result.result, commandId));
}

/** Dynamic legacy query selection is parsed before it crosses the Registry boundary. */
async function runDynamicRuntimeApiQuery(
  runtime: AgentRuntime,
  req: Request,
  queryId: string,
  payload: unknown
): Promise<unknown> {
  if (!isDomainQueryId(queryId)) {
    throw new RuntimeRequestError("not_found", `domain_query_not_found:${queryId}`);
  }
  const input = parseDomainOperationInput(queryId, payload);
  return (await runtime.runDomainQuery({
    query_id: queryId,
    input_source: "runtime_api",
    payload: input
  }, runtimeRequestContext(req))).result;
}

function runtimeRequestContext(req: Request, context: TrustedRuntimeApiContext = {}): TrustedRuntimeApiContext {
  const signal = (req as Request & { signal?: AbortSignal }).signal;
  return {
    ...context,
    ...(signal ? { signal } : {})
  };
}

function asToolRunStatus(value: unknown): ToolRunStatus | undefined {
  return typeof value === "string" && toolRunStatuses.includes(value as ToolRunStatus)
    ? value as ToolRunStatus
    : undefined;
}

function parseClientTargetKind(value: unknown): ClientTargetKind | undefined {
  return typeof value === "string" && clientTargetKinds.includes(value as ClientTargetKind)
    ? value as ClientTargetKind
    : undefined;
}

function parseClientEventStatus(value: unknown): ClientEventStatus | undefined {
  return typeof value === "string" && clientEventStatuses.includes(value as ClientEventStatus)
    ? value as ClientEventStatus
    : undefined;
}

function parseClientEventType(value: unknown): ClientEventType | undefined {
  return typeof value === "string" && clientEventTypes.includes(value as ClientEventType)
    ? value as ClientEventType
    : undefined;
}

function gatewayWebhookBodyExtraction(input: unknown): { body: string; field: string } | undefined {
  const body = isRecord(input) ? input : {};
  const direct = firstStringField(body, ["body", "text", "message", "content", "user_intent", "prompt"]);
  if (direct) {
    return direct;
  }
  for (const key of ["event", "payload", "data"]) {
    const nested = isRecord(body[key]) ? firstStringField(body[key], ["body", "text", "message", "content", "user_intent", "prompt"]) : undefined;
    if (nested) {
      return {
        body: nested.body,
        field: `${key}.${nested.field}`
      };
    }
  }
  return undefined;
}

interface GatewaySlackEventExtraction {
  body: string;
  body_field: string;
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  team_id?: string;
  channel_id?: string;
  user_id?: string;
  envelope_type?: string;
  event_type?: string;
  event_subtype?: string;
  event_ts?: string;
  thread_ts?: string;
}

interface GatewaySlackSignatureVerification {
  ok: boolean;
  status: "not_configured" | "verified" | "missing_headers" | "timestamp_out_of_range" | "raw_body_missing" | "invalid";
  reason?: string;
  timestamp?: string;
}

const slackSignatureVersion = "v0";
const slackSignatureMaxSkewSeconds = 5 * 60;

function isSlackUrlVerification(input: unknown): input is { type: "url_verification"; challenge: string } {
  return isRecord(input)
    && input.type === "url_verification"
    && typeof input.challenge === "string"
    && Boolean(input.challenge.trim());
}

function verifySlackRequestSignature(req: Request): GatewaySlackSignatureVerification {
  const secret = slackSigningSecret();
  if (!secret) {
    return { ok: true, status: "not_configured" };
  }
  const signature = req.get("x-slack-signature")?.trim();
  const timestamp = req.get("x-slack-request-timestamp")?.trim();
  if (!signature || !timestamp) {
    return {
      ok: false,
      status: "missing_headers",
      reason: "slack_signature_headers_missing"
    };
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > slackSignatureMaxSkewSeconds) {
    return {
      ok: false,
      status: "timestamp_out_of_range",
      reason: "slack_signature_timestamp_out_of_range",
      timestamp
    };
  }
  const rawBody = rawBodyForRequest(req);
  if (!rawBody) {
    return {
      ok: false,
      status: "raw_body_missing",
      reason: "slack_signature_raw_body_missing",
      timestamp
    };
  }
  const expected = `${slackSignatureVersion}=${createHmac("sha256", secret)
    .update(`${slackSignatureVersion}:${timestamp}:`)
    .update(rawBody)
    .digest("hex")}`;
  return timingSafeStringEqual(signature, expected)
    ? { ok: true, status: "verified", timestamp }
    : {
      ok: false,
      status: "invalid",
      reason: "slack_signature_invalid",
      timestamp
    };
}

function slackSigningSecret(): string | undefined {
  const secret = process.env.SAMURAI_SLACK_SIGNING_SECRET?.trim();
  return secret ? secret : undefined;
}

function slackSigningSecretConfigured(): boolean {
  return Boolean(slackSigningSecret());
}

function rawBodyForRequest(req: Request): Buffer | undefined {
  return (req as Request & { rawBody?: Buffer }).rawBody;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

interface GatewayTelegramSecretVerification {
  ok: boolean;
  status: "not_configured" | "verified" | "missing_header" | "invalid";
  reason?: string;
}

function verifyTelegramWebhookSecret(req: Request): GatewayTelegramSecretVerification {
  const secret = telegramWebhookSecret();
  if (!secret) {
    return { ok: true, status: "not_configured" };
  }
  const token = req.get("x-telegram-bot-api-secret-token")?.trim();
  if (!token) {
    return {
      ok: false,
      status: "missing_header",
      reason: "telegram_secret_header_missing"
    };
  }
  return timingSafeStringEqual(token, secret)
    ? { ok: true, status: "verified" }
    : {
      ok: false,
      status: "invalid",
      reason: "telegram_secret_invalid"
    };
}

function telegramWebhookSecret(): string | undefined {
  const secret = process.env.SAMURAI_TELEGRAM_WEBHOOK_SECRET?.trim();
  return secret ? secret : undefined;
}

function telegramWebhookSecretConfigured(): boolean {
  return Boolean(telegramWebhookSecret());
}

interface GatewayLineSignatureVerification {
  ok: boolean;
  status: "not_configured" | "verified" | "missing_header" | "raw_body_missing" | "invalid";
  reason?: string;
}

function verifyLineRequestSignature(req: Request): GatewayLineSignatureVerification {
  const secret = lineChannelSecret();
  if (!secret) {
    return { ok: true, status: "not_configured" };
  }
  const signature = req.get("x-line-signature")?.trim();
  if (!signature) {
    return {
      ok: false,
      status: "missing_header",
      reason: "line_signature_header_missing"
    };
  }
  const rawBody = rawBodyForRequest(req);
  if (!rawBody) {
    return {
      ok: false,
      status: "raw_body_missing",
      reason: "line_signature_raw_body_missing"
    };
  }
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return timingSafeStringEqual(signature, expected)
    ? { ok: true, status: "verified" }
    : {
      ok: false,
      status: "invalid",
      reason: "line_signature_invalid"
    };
}

function lineChannelSecret(): string | undefined {
  const secret = process.env.SAMURAI_LINE_CHANNEL_SECRET?.trim();
  return secret ? secret : undefined;
}

function lineChannelSecretConfigured(): boolean {
  return Boolean(lineChannelSecret());
}

function gatewaySlackEventExtraction(input: unknown, query: Record<string, unknown>): GatewaySlackEventExtraction | undefined {
  const body = isRecord(input) ? input : {};
  const event = isRecord(body.event) ? body.event : {};
  const nested = firstStringField(event, ["text", "body", "message", "content", "user_intent", "prompt"]);
  const direct = nested
    ? { body: nested.body, field: `event.${nested.field}` }
    : firstStringField(body, ["text", "body", "message", "content", "user_intent", "prompt"]);
  if (!direct) {
    return undefined;
  }

  const teamId = stringFromRecord(body, "team_id") ?? stringFromRecord(event, "team") ?? stringFromRecord(body, "team");
  const channelId = stringFromRecord(event, "channel") ?? stringFromRecord(body, "channel_id") ?? stringFromRecord(body, "channel");
  const userId = stringFromRecord(event, "user") ?? stringFromRecord(body, "user_id") ?? stringFromRecord(body, "user") ?? stringFromRecord(event, "bot_id") ?? stringFromRecord(body, "bot_id");
  const eventTs = stringFromRecord(event, "ts") ?? stringFromRecord(body, "event_ts") ?? stringFromRecord(body, "ts");
  const threadTs = stringFromRecord(event, "thread_ts") ?? stringFromRecord(body, "thread_ts") ?? eventTs;
  const sourceIdentity = stringFromRequest(body, query, "source_identity") ?? slackSourceIdentity(teamId, channelId, userId);
  if (!sourceIdentity) {
    return undefined;
  }
  const accountId = stringFromRequest(body, query, "account_id") ?? (teamId ? `team:${teamId}` : undefined);
  const threadId = stringFromRequest(body, query, "thread_id") ?? slackThreadId(channelId, threadTs);
  return {
    body: direct.body,
    body_field: direct.field,
    source_identity: sourceIdentity,
    source_label: stringFromRequest(body, query, "source_label") ?? slackSourceLabel(teamId, channelId, userId),
    account_id: accountId,
    thread_id: threadId,
    team_id: teamId,
    channel_id: channelId,
    user_id: userId,
    envelope_type: stringFromRecord(body, "type"),
    event_type: stringFromRecord(event, "type"),
    event_subtype: stringFromRecord(event, "subtype"),
    event_ts: eventTs,
    thread_ts: threadTs
  };
}

function slackSourceIdentity(teamId: string | undefined, channelId: string | undefined, userId: string | undefined): string | undefined {
  if (teamId && userId) {
    return `team:${teamId}/user:${userId}`;
  }
  if (teamId && channelId) {
    return `team:${teamId}/channel:${channelId}`;
  }
  if (userId) {
    return `user:${userId}`;
  }
  return undefined;
}

function slackThreadId(channelId: string | undefined, threadTs: string | undefined): string | undefined {
  if (channelId && threadTs) {
    return `channel:${channelId}/thread:${threadTs}`;
  }
  if (channelId) {
    return `channel:${channelId}`;
  }
  return threadTs ? `thread:${threadTs}` : undefined;
}

function slackSourceLabel(teamId: string | undefined, channelId: string | undefined, userId: string | undefined): string | undefined {
  if (teamId && channelId && userId) {
    return `Slack ${teamId} / ${channelId} / ${userId}`;
  }
  if (teamId && userId) {
    return `Slack ${teamId} / ${userId}`;
  }
  return teamId ? `Slack ${teamId}` : undefined;
}

function firstStringField(input: Record<string, unknown>, fields: string[]): { body: string; field: string } | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return {
        body: value.trim(),
        field
      };
    }
  }
  return undefined;
}

function stringFromRequest(body: unknown, query: Record<string, unknown>, key: string): string | undefined {
  const bodyRecord = isRecord(body) ? body : {};
  const bodyValue = bodyRecord[key];
  if (typeof bodyValue === "string" && bodyValue.trim()) {
    return bodyValue.trim();
  }
  const queryValue = query[key];
  return typeof queryValue === "string" && queryValue.trim() ? queryValue.trim() : undefined;
}

function stringFromRecord(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromRecord(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function queryStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFromRecord(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return undefined;
}

function clampPositiveInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringLikeFromRecord(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function firstRecordField(input: Record<string, unknown>, fields: string[]): { record: Record<string, unknown>; field: string } | undefined {
  for (const field of fields) {
    const value = input[field];
    if (isRecord(value)) {
      return { record: value, field };
    }
  }
  return undefined;
}

function gatewayWebhookMetadata(input: unknown, bodyField: string): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_webhook_adapter: true,
    gateway_webhook_body_field: bodyField,
    gateway_webhook_payload_keys: Object.keys(body).filter((key) => key !== "metadata").slice(0, 20)
  };
}

function gatewaySlackMetadata(input: unknown, extraction: GatewaySlackEventExtraction, signature: GatewaySlackSignatureVerification): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_slack_adapter: true,
    gateway_slack_signature_status: signature.status,
    gateway_slack_body_field: extraction.body_field,
    gateway_slack_payload_keys: Object.keys(body)
      .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
      .slice(0, 20),
    ...(signature.timestamp ? { gateway_slack_signature_timestamp: signature.timestamp } : {}),
    ...(extraction.envelope_type ? { gateway_slack_envelope_type: extraction.envelope_type } : {}),
    ...(extraction.event_type ? { gateway_slack_event_type: extraction.event_type } : {}),
    ...(extraction.event_subtype ? { gateway_slack_event_subtype: extraction.event_subtype } : {}),
    ...(extraction.team_id ? { gateway_slack_team_id: extraction.team_id } : {}),
    ...(extraction.channel_id ? { gateway_slack_channel_id: extraction.channel_id } : {}),
    ...(extraction.user_id ? { gateway_slack_user_id: extraction.user_id } : {}),
    ...(extraction.event_ts ? { gateway_slack_event_ts: extraction.event_ts } : {}),
    ...(extraction.thread_ts ? { gateway_slack_thread_ts: extraction.thread_ts } : {})
  };
}

interface GatewayTelegramUpdateExtraction {
  body: string;
  body_field: string;
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  update_id?: string;
  message_id?: string;
  message_thread_id?: string;
  chat_id?: string;
  chat_type?: string;
  chat_title?: string;
  user_id?: string;
  username?: string;
}

function gatewayTelegramUpdateExtraction(input: unknown, query: Record<string, unknown>): GatewayTelegramUpdateExtraction | undefined {
  const body = isRecord(input) ? input : {};
  const messageEntry = firstRecordField(body, ["message", "edited_message", "channel_post", "edited_channel_post"]);
  const message = messageEntry?.record ?? {};
  const nested = messageEntry
    ? firstStringField(message, ["text", "caption", "body", "message", "content", "user_intent", "prompt"])
    : undefined;
  const direct = nested && messageEntry
    ? { body: nested.body, field: `${messageEntry.field}.${nested.field}` }
    : firstStringField(body, ["text", "body", "message", "content", "user_intent", "prompt"]);
  if (!direct) {
    return undefined;
  }

  const chat = isRecord(message.chat) ? message.chat : {};
  const from = isRecord(message.from) ? message.from : {};
  const updateId = stringLikeFromRecord(body, "update_id");
  const messageId = stringLikeFromRecord(message, "message_id");
  const messageThreadId = stringLikeFromRecord(message, "message_thread_id");
  const chatId = stringLikeFromRecord(chat, "id") ?? stringLikeFromRecord(body, "chat_id");
  const chatType = stringFromRecord(chat, "type") ?? stringFromRecord(body, "chat_type");
  const chatTitle = stringFromRecord(chat, "title") ?? stringFromRecord(chat, "username") ?? stringFromRecord(body, "chat_title");
  const userId = stringLikeFromRecord(from, "id") ?? stringLikeFromRecord(body, "user_id");
  const username = stringFromRecord(from, "username") ?? stringFromRecord(body, "username");
  const sourceIdentity = stringFromRequest(body, query, "source_identity") ?? telegramSourceIdentity(userId, chatId);
  if (!sourceIdentity) {
    return undefined;
  }
  return {
    body: direct.body,
    body_field: direct.field,
    source_identity: sourceIdentity,
    source_label: stringFromRequest(body, query, "source_label") ?? telegramSourceLabel(chatTitle, chatId, userId, username),
    account_id: stringFromRequest(body, query, "account_id") ?? telegramAccountId(chatId),
    thread_id: stringFromRequest(body, query, "thread_id") ?? telegramThreadId(messageThreadId, chatId),
    update_id: updateId,
    message_id: messageId,
    message_thread_id: messageThreadId,
    chat_id: chatId,
    chat_type: chatType,
    chat_title: chatTitle,
    user_id: userId,
    username
  };
}

function telegramSourceIdentity(userId: string | undefined, chatId: string | undefined): string | undefined {
  if (userId) {
    return `user:${userId}`;
  }
  return chatId ? `chat:${chatId}` : undefined;
}

function telegramAccountId(chatId: string | undefined): string | undefined {
  return chatId ? `chat:${chatId}` : undefined;
}

function telegramThreadId(messageThreadId: string | undefined, chatId: string | undefined): string | undefined {
  if (messageThreadId) {
    return `thread:${messageThreadId}`;
  }
  return chatId ? "main" : undefined;
}

function telegramSourceLabel(chatTitle: string | undefined, chatId: string | undefined, userId: string | undefined, username: string | undefined): string | undefined {
  if (chatTitle && userId) {
    return `Telegram ${chatTitle} / ${username ?? userId}`;
  }
  if (chatTitle) {
    return `Telegram ${chatTitle}`;
  }
  if (chatId && userId) {
    return `Telegram ${chatId} / ${username ?? userId}`;
  }
  return chatId ? `Telegram ${chatId}` : userId ? `Telegram ${username ?? userId}` : undefined;
}

function gatewayTelegramMetadata(input: unknown, extraction: GatewayTelegramUpdateExtraction, secret: GatewayTelegramSecretVerification): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_telegram_adapter: true,
    gateway_telegram_verification_status: secret.status,
    gateway_telegram_body_field: extraction.body_field,
    gateway_telegram_payload_keys: Object.keys(body)
      .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
      .slice(0, 20),
    ...(extraction.update_id ? { gateway_telegram_update_id: extraction.update_id } : {}),
    ...(extraction.message_id ? { gateway_telegram_message_id: extraction.message_id } : {}),
    ...(extraction.message_thread_id ? { gateway_telegram_message_thread_id: extraction.message_thread_id } : {}),
    ...(extraction.chat_id ? { gateway_telegram_chat_id: extraction.chat_id } : {}),
    ...(extraction.chat_type ? { gateway_telegram_chat_type: extraction.chat_type } : {}),
    ...(extraction.user_id ? { gateway_telegram_user_id: extraction.user_id } : {}),
    ...(extraction.username ? { gateway_telegram_username: extraction.username } : {})
  };
}

interface GatewayLineEventExtraction {
  body: string;
  body_field: string;
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  event_index: number;
  event_count: number;
  event_type?: string;
  source_type?: string;
  user_id?: string;
  group_id?: string;
  room_id?: string;
  message_id?: string;
}

function gatewayLineEventExtraction(input: unknown, query: Record<string, unknown>): GatewayLineEventExtraction | undefined {
  const body = isRecord(input) ? input : {};
  const events = lineEventRecords(body);
  for (const { event, index } of events) {
    const message = isRecord(event.message) ? event.message : {};
    const nested = firstStringField(message, ["text", "caption", "body", "message", "content", "user_intent", "prompt"]);
    const direct = nested
      ? { body: nested.body, field: `events[${index}].message.${nested.field}` }
      : firstStringField(event, ["text", "body", "message", "content", "user_intent", "prompt"]);
    if (!direct) {
      continue;
    }
    const source = isRecord(event.source) ? event.source : {};
    const sourceType = stringFromRecord(source, "type") ?? stringFromRecord(event, "source_type");
    const userId = stringFromRecord(source, "userId") ?? stringFromRecord(event, "userId");
    const groupId = stringFromRecord(source, "groupId") ?? stringFromRecord(event, "groupId");
    const roomId = stringFromRecord(source, "roomId") ?? stringFromRecord(event, "roomId");
    const messageId = stringLikeFromRecord(message, "id") ?? stringLikeFromRecord(event, "message_id");
    const sourceIdentity = stringFromRequest(body, query, "source_identity") ?? lineSourceIdentity(userId, groupId, roomId);
    if (!sourceIdentity) {
      continue;
    }
    return {
      body: direct.body,
      body_field: direct.field,
      source_identity: sourceIdentity,
      source_label: stringFromRequest(body, query, "source_label") ?? lineSourceLabel(sourceType, userId, groupId, roomId),
      account_id: stringFromRequest(body, query, "account_id") ?? lineAccountId(userId, groupId, roomId),
      thread_id: stringFromRequest(body, query, "thread_id") ?? "main",
      event_index: index,
      event_count: events.length,
      event_type: stringFromRecord(event, "type"),
      source_type: sourceType,
      user_id: userId,
      group_id: groupId,
      room_id: roomId,
      message_id: messageId
    };
  }
  return undefined;
}

function lineEventRecords(body: Record<string, unknown>): Array<{ event: Record<string, unknown>; index: number }> {
  if (Array.isArray(body.events)) {
    return body.events.flatMap((event, index) => isRecord(event) ? [{ event, index }] : []);
  }
  if (isRecord(body.event)) {
    return [{ event: body.event, index: 0 }];
  }
  return [{ event: body, index: 0 }];
}

function lineSourceIdentity(userId: string | undefined, groupId: string | undefined, roomId: string | undefined): string | undefined {
  if (userId) {
    return `user:${userId}`;
  }
  if (groupId) {
    return `group:${groupId}`;
  }
  return roomId ? `room:${roomId}` : undefined;
}

function lineAccountId(userId: string | undefined, groupId: string | undefined, roomId: string | undefined): string | undefined {
  if (groupId) {
    return `group:${groupId}`;
  }
  if (roomId) {
    return `room:${roomId}`;
  }
  return userId ? `user:${userId}` : undefined;
}

function lineSourceLabel(sourceType: string | undefined, userId: string | undefined, groupId: string | undefined, roomId: string | undefined): string | undefined {
  if (sourceType === "group" && groupId) {
    return userId ? `LINE group ${groupId} / ${userId}` : `LINE group ${groupId}`;
  }
  if (sourceType === "room" && roomId) {
    return userId ? `LINE room ${roomId} / ${userId}` : `LINE room ${roomId}`;
  }
  return userId ? `LINE user ${userId}` : groupId ? `LINE group ${groupId}` : roomId ? `LINE room ${roomId}` : undefined;
}

function gatewayLineMetadata(input: unknown, extraction: GatewayLineEventExtraction, signature: GatewayLineSignatureVerification): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_line_adapter: true,
    gateway_line_signature_status: signature.status,
    gateway_line_body_field: extraction.body_field,
    gateway_line_payload_keys: Object.keys(body)
      .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
      .slice(0, 20),
    gateway_line_event_index: extraction.event_index,
    gateway_line_event_count: extraction.event_count,
    ...(extraction.event_type ? { gateway_line_event_type: extraction.event_type } : {}),
    ...(extraction.source_type ? { gateway_line_source_type: extraction.source_type } : {}),
    ...(extraction.user_id ? { gateway_line_user_id: extraction.user_id } : {}),
    ...(extraction.group_id ? { gateway_line_group_id: extraction.group_id } : {}),
    ...(extraction.room_id ? { gateway_line_room_id: extraction.room_id } : {}),
    ...(extraction.message_id ? { gateway_line_message_id: extraction.message_id } : {})
  };
}

interface GatewayEmailMessageExtraction {
  body: string;
  body_field: string;
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  from?: string;
  to?: string;
  subject?: string;
  message_id?: string;
  in_reply_to?: string;
}

interface GatewayMobileMessageExtraction {
  body: string;
  body_field: string;
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  device_id?: string;
  user_id?: string;
  conversation_id?: string;
  platform?: string;
}

function gatewayEmailMessageExtraction(input: unknown, query: Record<string, unknown>): GatewayEmailMessageExtraction | undefined {
  const body = isRecord(input) ? input : {};
  const content = firstStringField(body, ["body", "text", "plain_text", "text_body", "message", "content", "html", "html_body"]);
  const subject = stringFromRecord(body, "subject");
  if (!content && !subject) {
    return undefined;
  }
  const from = stringFromRecord(body, "from") ?? stringFromRecord(body, "sender") ?? stringFromRecord(body, "reply_to");
  const to = stringFromRecord(body, "to") ?? stringFromRecord(body, "recipient") ?? stringFromRecord(body, "mailbox");
  const sourceIdentity = stringFromRequest(body, query, "source_identity") ?? emailSourceIdentity(from);
  if (!sourceIdentity) {
    return undefined;
  }
  const messageId = stringFromRecord(body, "message_id") ?? stringFromRecord(body, "messageId");
  const inReplyTo = stringFromRecord(body, "in_reply_to") ?? stringFromRecord(body, "inReplyTo");
  return {
    body: emailGatewayBody(subject, content?.body),
    body_field: content?.field ?? "subject",
    source_identity: sourceIdentity,
    source_label: stringFromRequest(body, query, "source_label") ?? emailSourceLabel(from),
    account_id: stringFromRequest(body, query, "account_id") ?? emailAccountId(to),
    thread_id: stringFromRequest(body, query, "thread_id") ?? emailThreadId(messageId, inReplyTo, subject),
    from,
    to,
    subject,
    message_id: messageId,
    in_reply_to: inReplyTo
  };
}

function gatewayMobileMessageExtraction(input: unknown, query: Record<string, unknown>): GatewayMobileMessageExtraction | undefined {
  const body = isRecord(input) ? input : {};
  const content = firstStringField(body, ["body", "text", "message", "content"]);
  if (!content?.body) {
    return undefined;
  }
  const deviceId = stringFromRequest(body, query, "device_id") ?? stringFromRequest(body, query, "deviceId");
  const userId = stringFromRequest(body, query, "user_id") ?? stringFromRequest(body, query, "userId");
  const conversationId = stringFromRequest(body, query, "conversation_id")
    ?? stringFromRequest(body, query, "conversationId")
    ?? stringFromRequest(body, query, "thread_id");
  const platform = stringFromRequest(body, query, "platform");
  const sourceIdentity = stringFromRequest(body, query, "source_identity")
    ?? mobileSourceIdentity({ userId, deviceId, conversationId });
  if (!sourceIdentity) {
    return undefined;
  }
  return {
    body: content.body,
    body_field: content.field,
    source_identity: sourceIdentity,
    source_label: stringFromRequest(body, query, "source_label") ?? mobileSourceLabel({ userId, deviceId, platform }),
    account_id: stringFromRequest(body, query, "account_id") ?? (userId ? `mobile-user:${userId}` : undefined),
    thread_id: conversationId ? `conversation:${conversationId}` : undefined,
    device_id: deviceId,
    user_id: userId,
    conversation_id: conversationId,
    platform
  };
}

function mobileSourceIdentity(input: {
  userId?: string;
  deviceId?: string;
  conversationId?: string;
}): string | undefined {
  if (input.userId) {
    return `mobile:user:${input.userId}`;
  }
  if (input.deviceId) {
    return `mobile:device:${input.deviceId}`;
  }
  return input.conversationId ? `mobile:conversation:${input.conversationId}` : undefined;
}

function mobileSourceLabel(input: {
  userId?: string;
  deviceId?: string;
  platform?: string;
}): string | undefined {
  const subject = input.userId ?? input.deviceId;
  if (!subject) {
    return undefined;
  }
  return `${input.platform ? `${input.platform} ` : ""}Mobile ${subject}`;
}

function emailGatewayBody(subject: string | undefined, content: string | undefined): string {
  if (subject && content) {
    return `Subject: ${subject}\n\n${content}`;
  }
  return content ?? subject ?? "";
}

function emailSourceIdentity(from: string | undefined): string | undefined {
  return from ? `email:${from}` : undefined;
}

function emailSourceLabel(from: string | undefined): string | undefined {
  return from ? `Email ${from}` : undefined;
}

function emailAccountId(to: string | undefined): string | undefined {
  return to ? `mailbox:${to}` : undefined;
}

function emailThreadId(messageId: string | undefined, inReplyTo: string | undefined, subject: string | undefined): string | undefined {
  if (messageId) {
    return `message:${messageId}`;
  }
  if (inReplyTo) {
    return `reply:${inReplyTo}`;
  }
  return subject ? `subject:${stableHash(subject)}` : undefined;
}

function gatewayMobileMetadata(input: unknown, extraction: GatewayMobileMessageExtraction): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_mobile_adapter: true,
    gateway_mobile_body_field: extraction.body_field,
    gateway_mobile_payload_keys: Object.keys(body)
      .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
      .slice(0, 20),
    ...(extraction.device_id ? { gateway_mobile_device_id: extraction.device_id } : {}),
    ...(extraction.user_id ? { gateway_mobile_user_id: extraction.user_id } : {}),
    ...(extraction.conversation_id ? { gateway_mobile_conversation_id: extraction.conversation_id } : {}),
    ...(extraction.platform ? { gateway_mobile_platform: extraction.platform } : {})
  };
}

async function routeGatewayMobilePayload(
  runtime: AgentRuntime,
  payload: unknown,
  query: Record<string, unknown>
): Promise<{ extraction: GatewayMobileMessageExtraction; result: GatewayInboundRuntimeResult } | undefined> {
  const extraction = gatewayMobileMessageExtraction(payload, query);
  if (!extraction) {
    return undefined;
  }
  const domainResult = await runtime.runDomainCommand({
    command_id: "gateway.inbound.route",
    input_source: "gateway_inbound",
    idempotency_key: gatewayInboundPayloadKey("mobile", payload, query),
    payload: {
      channel: "mobile",
      source_identity: extraction.source_identity,
      source_label: extraction.source_label,
      body: extraction.body,
      route: stringFromRequest(payload, query, "route"),
      account_id: extraction.account_id,
      thread_id: extraction.thread_id,
      metadata: gatewayMobileMetadata(payload, extraction),
      backend_id: stringFromRequest(payload, query, "backend_id"),
      input_locale: asSupportedLocale(stringFromRequest(payload, query, "input_locale")),
      output_locale: asSupportedLocale(stringFromRequest(payload, query, "output_locale"))
    }
  });
  return { extraction, result: domainResult.result as GatewayInboundRuntimeResult };
}

function gatewayMobileAdapterSummary(extraction: GatewayMobileMessageExtraction) {
  return {
    channel: "mobile",
    source_identity: extraction.source_identity,
    body_field: extraction.body_field,
    ...(extraction.user_id ? { user_id: extraction.user_id } : {}),
    ...(extraction.device_id ? { device_id: extraction.device_id } : {}),
    ...(extraction.conversation_id ? { conversation_id: extraction.conversation_id } : {}),
    ...(extraction.platform ? { platform: extraction.platform } : {})
  };
}

function gatewayEmailMetadata(input: unknown, extraction: GatewayEmailMessageExtraction): Record<string, JsonValue> {
  const body = isRecord(input) ? input : {};
  const safeMetadata = isRecord(body.metadata)
    ? redactApiObject(jsonRecord(body.metadata)) as Record<string, JsonValue>
    : {};
  return {
    ...safeMetadata,
    gateway_email_adapter: true,
    gateway_email_body_field: extraction.body_field,
    gateway_email_payload_keys: Object.keys(body)
      .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
      .slice(0, 20),
    ...(extraction.from ? { gateway_email_from: extraction.from } : {}),
    ...(extraction.to ? { gateway_email_to: extraction.to } : {}),
    ...(extraction.subject ? { gateway_email_subject: extraction.subject } : {}),
    ...(extraction.message_id ? { gateway_email_message_id: extraction.message_id } : {}),
    ...(extraction.in_reply_to ? { gateway_email_in_reply_to: extraction.in_reply_to } : {})
  };
}

async function routeGatewayEmailPayload(
  runtime: AgentRuntime,
  payload: unknown,
  query: Record<string, unknown>
): Promise<{ extraction: GatewayEmailMessageExtraction; result: GatewayInboundRuntimeResult } | undefined> {
  const extraction = gatewayEmailMessageExtraction(payload, query);
  if (!extraction) {
    return undefined;
  }
  const domainResult = await runtime.runDomainCommand({
    command_id: "gateway.inbound.route",
    input_source: "gateway_inbound",
    idempotency_key: gatewayInboundPayloadKey("email", payload, query),
    payload: {
      channel: "email",
      source_identity: extraction.source_identity,
      source_label: extraction.source_label,
      body: extraction.body,
      route: stringFromRequest(payload, query, "route"),
      account_id: extraction.account_id,
      thread_id: extraction.thread_id,
      metadata: gatewayEmailMetadata(payload, extraction),
      backend_id: stringFromRequest(payload, query, "backend_id"),
      input_locale: asSupportedLocale(stringFromRequest(payload, query, "input_locale")),
      output_locale: asSupportedLocale(stringFromRequest(payload, query, "output_locale"))
    }
  });
  return { extraction, result: domainResult.result as GatewayInboundRuntimeResult };
}

function gatewayEmailAdapterSummary(extraction: GatewayEmailMessageExtraction) {
  return {
    channel: "email",
    source_identity: extraction.source_identity,
    body_field: extraction.body_field,
    from: extraction.from,
    to: extraction.to,
    subject: extraction.subject,
    message_id: extraction.message_id
  };
}

type GatewayEmailWebhookProvider = "postmark" | "mailgun" | "sendgrid";

function gatewayEmailWebhookProvider(value: string | undefined): GatewayEmailWebhookProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "postmark" || normalized === "mailgun" || normalized === "sendgrid") {
    return normalized;
  }
  return undefined;
}

interface GatewayEmailProviderWebhookVerification {
  ok: boolean;
  status: "not_configured" | "verified" | "missing_authorization" | "invalid_authorization" | "missing_signature" | "raw_body_missing" | "invalid_public_key" | "invalid_signature";
  reason?: string;
}

function verifyGatewayEmailProviderWebhookRequest(
  req: Request,
  provider: GatewayEmailWebhookProvider
): GatewayEmailProviderWebhookVerification {
  if (provider === "postmark") {
    return verifyGatewayEmailPostmarkWebhookBasicAuth(req);
  }
  if (provider === "mailgun") {
    return verifyGatewayEmailMailgunWebhookSignature(req.body);
  }
  return verifyGatewayEmailSendGridWebhookSignature(req);
}

function verifyGatewayEmailPostmarkWebhookBasicAuth(req: Request): GatewayEmailProviderWebhookVerification {
  const username = serverEnvString("SAMURAI_EMAIL_POSTMARK_WEBHOOK_USERNAME");
  const password = serverEnvString("SAMURAI_EMAIL_POSTMARK_WEBHOOK_PASSWORD");
  if (!username && !password) {
    return { ok: true, status: "not_configured" };
  }
  if (!username || !password) {
    return {
      ok: false,
      status: "missing_authorization",
      reason: "postmark_basic_auth_credentials_incomplete"
    };
  }
  const authorization = req.get("authorization")?.trim();
  if (!authorization) {
    return {
      ok: false,
      status: "missing_authorization",
      reason: "postmark_basic_auth_missing"
    };
  }
  const expected = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  return timingSafeStringEqual(authorization, expected)
    ? { ok: true, status: "verified" }
    : {
      ok: false,
      status: "invalid_authorization",
      reason: "postmark_basic_auth_invalid"
    };
}

function verifyGatewayEmailMailgunWebhookSignature(input: unknown): GatewayEmailProviderWebhookVerification {
  const signingKey = serverEnvString("SAMURAI_EMAIL_MAILGUN_SIGNING_KEY");
  if (!signingKey) {
    return { ok: true, status: "not_configured" };
  }
  const body = isRecord(input) ? input : {};
  const signatureRecord = isRecord(body.signature) ? body.signature : body;
  const timestamp = stringFromRecord(signatureRecord, "timestamp");
  const token = stringFromRecord(signatureRecord, "token");
  const signature = stringFromRecord(signatureRecord, "signature");
  if (!timestamp || !token || !signature) {
    return {
      ok: false,
      status: "missing_signature",
      reason: "mailgun_signature_fields_missing"
    };
  }
  const expected = createHmac("sha256", signingKey)
    .update(`${timestamp}${token}`)
    .digest("hex");
  return timingSafeStringEqual(signature, expected)
    ? { ok: true, status: "verified" }
    : {
      ok: false,
      status: "invalid_signature",
      reason: "mailgun_signature_invalid"
    };
}

function verifyGatewayEmailSendGridWebhookSignature(req: Request): GatewayEmailProviderWebhookVerification {
  const publicKey = serverEnvString("SAMURAI_EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY");
  if (!publicKey) {
    return { ok: true, status: "not_configured" };
  }
  const signature = req.get("x-twilio-email-event-webhook-signature")?.trim();
  const timestamp = req.get("x-twilio-email-event-webhook-timestamp")?.trim();
  if (!signature || !timestamp) {
    return {
      ok: false,
      status: "missing_signature",
      reason: "sendgrid_signature_headers_missing"
    };
  }
  const rawBody = rawBodyForRequest(req);
  if (!rawBody) {
    return {
      ok: false,
      status: "raw_body_missing",
      reason: "sendgrid_signature_raw_body_missing"
    };
  }
  let key: ReturnType<typeof sendGridWebhookPublicKey>;
  try {
    key = sendGridWebhookPublicKey(publicKey);
  } catch {
    return {
      ok: false,
      status: "invalid_public_key",
      reason: "sendgrid_public_key_invalid"
    };
  }
  try {
    const verifier = createVerify("sha256");
    verifier.update(timestamp, "utf8");
    verifier.update(rawBody);
    return verifier.verify(key, signature, "base64")
      ? { ok: true, status: "verified" }
      : {
        ok: false,
        status: "invalid_signature",
        reason: "sendgrid_signature_invalid"
      };
  } catch {
    return {
      ok: false,
      status: "invalid_signature",
      reason: "sendgrid_signature_invalid"
    };
  }
}

function sendGridWebhookPublicKey(value: string) {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  return createPublicKey({
    key: Buffer.from(value, "base64"),
    format: "der",
    type: "spki"
  });
}

function gatewayEmailProviderWebhookVerificationConfigured(): boolean {
  return gatewayEmailProviderWebhookVerificationProviders().length > 0;
}

function gatewayEmailProviderWebhookVerificationProviders(): GatewayEmailWebhookProvider[] {
  const providers: GatewayEmailWebhookProvider[] = [];
  if (serverEnvString("SAMURAI_EMAIL_POSTMARK_WEBHOOK_USERNAME") || serverEnvString("SAMURAI_EMAIL_POSTMARK_WEBHOOK_PASSWORD")) {
    providers.push("postmark");
  }
  if (serverEnvString("SAMURAI_EMAIL_MAILGUN_SIGNING_KEY")) {
    providers.push("mailgun");
  }
  if (serverEnvString("SAMURAI_EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY")) {
    providers.push("sendgrid");
  }
  return providers;
}

function gatewayEmailProviderWebhookPayload(
  provider: GatewayEmailWebhookProvider,
  input: unknown,
  query: Record<string, unknown>,
  verification: GatewayEmailProviderWebhookVerification
): Record<string, unknown> | undefined {
  const body = isRecord(input) ? input : {};
  const headers = provider === "sendgrid" && typeof body.headers === "string"
    ? parseEmailHeaderBlock(`${body.headers}\n\n`).headers
    : {};
  const rawFrom = emailProviderString(body, provider === "postmark" ? ["From", "from", "FromFull.Email"] : provider === "mailgun" ? ["sender", "from", "Sender"] : ["from", "sender"]);
  const rawTo = emailProviderString(body, provider === "postmark" ? ["To", "to", "OriginalRecipient"] : provider === "mailgun" ? ["recipient", "to", "To"] : ["to", "recipient"]);
  const from = emailAddressFromHeader(rawFrom) ?? rawFrom;
  const to = emailAddressListFromHeader(rawTo).join(", ") || emailAddressFromHeader(rawTo) || rawTo;
  const subject = emailProviderString(body, provider === "postmark" ? ["Subject", "subject"] : ["subject", "Subject"]) ?? decodeMimeHeader(emailHeader(headers, "subject"));
  const text = emailProviderString(body, provider === "postmark"
    ? ["TextBody", "text", "body"]
    : provider === "mailgun"
      ? ["stripped-text", "body-plain", "text", "body"]
      : ["text", "body", "plain"]);
  const html = emailProviderString(body, provider === "postmark"
    ? ["HtmlBody", "html"]
    : provider === "mailgun"
      ? ["stripped-html", "body-html", "html"]
      : ["html"]);
  const messageId = emailProviderString(body, provider === "postmark"
    ? ["MessageID", "MessageId", "Message-ID", "message_id"]
    : provider === "mailgun"
      ? ["Message-Id", "message-id", "Message-ID", "message_id"]
      : ["message_id", "Message-ID", "message-id"]) ?? normalizeEmailMessageId(emailHeader(headers, "message-id"));
  const inReplyTo = emailProviderString(body, ["In-Reply-To", "in_reply_to", "inReplyTo"]) ?? normalizeEmailMessageId(emailHeader(headers, "in-reply-to"));
  const content = text ?? (html ? stripHtml(html) : undefined);
  if (!from || (!content && !subject)) {
    return undefined;
  }
  const metadata = isRecord(body.metadata) ? jsonRecord(body.metadata) : {};
  return {
    from,
    to,
    subject,
    text: content,
    html,
    message_id: messageId,
    in_reply_to: inReplyTo,
    source_identity: stringFromRequest(body, query, "source_identity"),
    source_label: stringFromRequest(body, query, "source_label"),
    account_id: stringFromRequest(body, query, "account_id"),
    thread_id: stringFromRequest(body, query, "thread_id"),
    route: stringFromRequest(body, query, "route"),
    backend_id: stringFromRequest(body, query, "backend_id"),
    input_locale: stringFromRequest(body, query, "input_locale"),
    output_locale: stringFromRequest(body, query, "output_locale"),
    metadata: {
      ...metadata,
      gateway_email_provider_webhook: true,
      gateway_email_provider: provider,
      gateway_email_provider_verification_status: verification.status,
      gateway_email_provider_payload_keys: Object.keys(body)
        .filter((key) => key !== "metadata" && !isSecretLikeApiKey(key))
        .slice(0, 20)
    }
  };
}

function emailProviderString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = body[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
    if (key.includes(".")) {
      const nested = nestedRecordValue(body, key.split("."));
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
    }
  }
  return undefined;
}

function nestedRecordValue(body: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = body;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function gatewayEmailImapTransportConfig(input: unknown): GatewayEmailImapTransportConfig | undefined {
  const host = serverEnvString("SAMURAI_EMAIL_IMAP_HOST");
  const username = serverEnvString("SAMURAI_EMAIL_IMAP_USER");
  const password = serverEnvString("SAMURAI_EMAIL_IMAP_PASSWORD");
  if (!host || !username || !password) {
    return undefined;
  }
  const secure = serverEnvBoolean("SAMURAI_EMAIL_IMAP_SECURE", gatewayEmailImapPort() === 993);
  const body = isRecord(input) ? input : {};
  return {
    host,
    port: gatewayEmailImapPort(secure),
    secure,
    username,
    password,
    mailbox: serverEnvString("SAMURAI_EMAIL_IMAP_MAILBOX") ?? "INBOX",
    maxMessages: clampPositiveInt(numberFromRecord(body, "max_messages") ?? serverEnvNumber("SAMURAI_EMAIL_IMAP_MAX_MESSAGES", 10), 1, 50),
    markSeen: booleanFromRecord(body, "mark_seen") ?? serverEnvBoolean("SAMURAI_EMAIL_IMAP_MARK_SEEN", false),
    timeoutMs: serverEnvNumber("SAMURAI_EMAIL_IMAP_TIMEOUT_MS", 10_000)
  };
}

function gatewayEmailImapPort(secure = false): number {
  return serverEnvNumber("SAMURAI_EMAIL_IMAP_PORT", secure ? 993 : 143);
}

function gatewayEmailImapPayload(message: GatewayEmailImapMessage, config: GatewayEmailImapTransportConfig, requestBody: unknown): Record<string, unknown> {
  const body = isRecord(requestBody) ? requestBody : {};
  const metadata = isRecord(body.metadata) ? jsonRecord(body.metadata) : {};
  return {
    from: message.from,
    to: message.to ?? serverEnvString("SAMURAI_EMAIL_ADDRESS") ?? config.username,
    subject: message.subject,
    text: message.text ?? message.html ?? message.raw,
    message_id: message.message_id ?? `imap:${message.uid}`,
    in_reply_to: message.in_reply_to,
    route: stringFromRecord(body, "route"),
    backend_id: stringFromRecord(body, "backend_id"),
    input_locale: stringFromRecord(body, "input_locale"),
    output_locale: stringFromRecord(body, "output_locale"),
    metadata: {
      ...metadata,
      gateway_email_imap_transport: true,
      gateway_email_imap_uid: message.uid,
      gateway_email_imap_mailbox: config.mailbox,
      ...(message.internal_date ? { gateway_email_imap_internal_date: message.internal_date } : {}),
      ...(message.flags?.length ? { gateway_email_imap_flags: message.flags.slice(0, 20) } : {})
    }
  };
}

async function createNodeGatewayEmailImapClient(config: GatewayEmailImapTransportConfig): Promise<GatewayEmailImapClient> {
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });
  const client = new NodeGatewayEmailImapClient(socket, config);
  await client.waitForConnect();
  return client;
}

class NodeGatewayEmailImapClient implements GatewayEmailImapClient {
  private readonly socket: Socket | TLSSocket;
  private readonly config: GatewayEmailImapTransportConfig;
  private buffer = Buffer.alloc(0);
  private tagSequence = 0;
  private pendingData?: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(socket: Socket | TLSSocket, config: GatewayEmailImapTransportConfig) {
    this.socket = socket;
    this.config = config;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.resolvePendingData();
    });
    socket.on("error", (error) => {
      this.rejectPendingData(error);
    });
  }

  async waitForConnect(): Promise<void> {
    if ((this.socket as TLSSocket).encrypted) {
      await this.waitForSocketEvent("secureConnect");
      return;
    }
    if (!this.socket.connecting) {
      return;
    }
    await this.waitForSocketEvent("connect");
  }

  async poll(): Promise<GatewayEmailImapPollResult> {
    await this.expectGreeting();
    await this.commandExpect(`LOGIN ${imapQuoted(this.config.username)} ${imapQuoted(this.config.password)}`, ["OK"], "login");
    await this.commandExpect(`SELECT ${imapQuoted(this.config.mailbox)}`, ["OK"], "select");
    const search = await this.commandExpect("UID SEARCH UNSEEN", ["OK"], "search");
    const uids = parseImapSearchUids(search.raw).slice(-this.config.maxMessages);
    const messages: GatewayEmailImapMessage[] = [];
    for (const uid of uids) {
      const fetched = await this.commandExpect(`UID FETCH ${uid} (BODY.PEEK[])`, ["OK"], "fetch");
      const raw = fetched.literals[0] ?? fetched.raw;
      messages.push(parseRawEmailMessage(raw, uid));
      if (this.config.markSeen) {
        await this.commandExpect(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`, ["OK"], "store");
      }
    }
    try {
      await this.commandExpect("LOGOUT", ["OK"], "logout");
    } catch {
      // The socket is being closed anyway; a logout failure should not hide fetched mail.
    }
    return {
      mailbox: this.config.mailbox,
      scanned: uids.length,
      messages
    };
  }

  close(): void {
    this.rejectPendingData(new Error("imap_connection_closed"));
    this.socket.end();
  }

  private async expectGreeting(): Promise<void> {
    const line = await this.readLine();
    if (!line.startsWith("* OK")) {
      throw new Error("imap_greeting_failed");
    }
  }

  private async commandExpect(command: string, expectedStatuses: string[], stage: string): Promise<{ raw: string; literals: string[] }> {
    const tag = this.nextTag();
    await this.writeRaw(`${tag} ${command}\r\n`);
    const response = await this.readTaggedResponse(tag);
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`imap_${stage}_failed:${response.status}`);
    }
    return response;
  }

  private async readTaggedResponse(tag: string): Promise<{ status: string; raw: string; literals: string[] }> {
    let raw = "";
    const literals: string[] = [];
    while (true) {
      const line = await this.readLine();
      raw += `${line}\r\n`;
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal) {
        const literalBytes = await this.readBytes(Number(literal[1]));
        const literalText = literalBytes.toString("utf8");
        literals.push(literalText);
        raw += literalText;
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).split(/\s+/, 1)[0]?.toUpperCase() ?? "BAD";
        return { status, raw, literals };
      }
    }
  }

  private nextTag(): string {
    this.tagSequence += 1;
    return `A${String(this.tagSequence).padStart(4, "0")}`;
  }

  private waitForSocketEvent(event: "connect" | "secureConnect"): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("imap_connect_timeout"));
      }, this.config.timeoutMs);
      timer.unref?.();
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off(event, onReady);
        this.socket.off("error", onError);
      };
      this.socket.once(event, onReady);
      this.socket.once("error", onError);
    });
  }

  private async readLine(): Promise<string> {
    while (true) {
      const index = this.buffer.indexOf(10);
      if (index >= 0) {
        const rawLine = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + 1);
        const line = rawLine.at(-1) === 13 ? rawLine.subarray(0, -1) : rawLine;
        return line.toString("utf8");
      }
      await this.waitForData();
    }
  }

  private async readBytes(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      await this.waitForData();
    }
    const chunk = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return chunk;
  }

  private waitForData(): Promise<void> {
    if (this.buffer.length > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingData = undefined;
        reject(new Error("imap_response_timeout"));
      }, this.config.timeoutMs);
      timer.unref?.();
      this.pendingData = { resolve, reject, timer };
    });
  }

  private resolvePendingData(): void {
    if (!this.pendingData) {
      return;
    }
    clearTimeout(this.pendingData.timer);
    const pending = this.pendingData;
    this.pendingData = undefined;
    pending.resolve();
  }

  private rejectPendingData(error: Error): void {
    if (!this.pendingData) {
      return;
    }
    clearTimeout(this.pendingData.timer);
    const pending = this.pendingData;
    this.pendingData = undefined;
    pending.reject(error);
  }

  private writeRaw(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function imapQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function parseImapSearchUids(raw: string): string[] {
  const line = raw.split(/\r?\n/).find((item) => item.startsWith("* SEARCH"));
  if (!line) {
    return [];
  }
  return line.replace(/^\* SEARCH\s*/i, "").split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function parseRawEmailMessage(raw: string, uid: string): GatewayEmailImapMessage {
  const parsed = parseEmailHeaderBlock(raw);
  const from = emailAddressFromHeader(emailHeader(parsed.headers, "from"));
  const to = emailAddressListFromHeader(emailHeader(parsed.headers, "to")).join(", ");
  return {
    uid,
    raw,
    from,
    to: to || undefined,
    subject: decodeMimeHeader(emailHeader(parsed.headers, "subject")),
    text: extractEmailTextBody(raw),
    message_id: normalizeEmailMessageId(emailHeader(parsed.headers, "message-id")),
    in_reply_to: normalizeEmailMessageId(emailHeader(parsed.headers, "in-reply-to")),
    internal_date: emailHeader(parsed.headers, "date")
  };
}

function parseEmailHeaderBlock(raw: string): { headers: Record<string, string[]>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /\n\s*\n/.exec(normalized);
  const headerBlock = match ? normalized.slice(0, match.index) : normalized;
  const body = match ? normalized.slice(match.index + match[0].length) : "";
  const unfolded: string[] = [];
  for (const line of headerBlock.split("\n")) {
    if (/^[\t ]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
    } else if (line.trim()) {
      unfolded.push(line);
    }
  }
  const headers: Record<string, string[]> = {};
  for (const line of unfolded) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = [...(headers[key] ?? []), value];
  }
  return { headers, body };
}

function emailHeader(headers: Record<string, string[]>, key: string): string | undefined {
  return headers[key.toLowerCase()]?.[0];
}

function emailAddressFromHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const decoded = decodeMimeHeader(value);
  if (!decoded) {
    return undefined;
  }
  const bracket = /<([^>]+)>/.exec(decoded);
  return (bracket?.[1] ?? decoded.split(",", 1)[0] ?? "").replace(/^mailto:/i, "").replaceAll("\"", "").trim() || undefined;
}

function emailAddressListFromHeader(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => emailAddressFromHeader(item)).filter((item): item is string => Boolean(item));
}

function normalizeEmailMessageId(value: string | undefined): string | undefined {
  return value?.replace(/^<|>$/g, "").trim() || undefined;
}

function extractEmailTextBody(raw: string): string | undefined {
  const parsed = parseEmailHeaderBlock(raw);
  const contentType = emailHeader(parsed.headers, "content-type")?.toLowerCase() ?? "text/plain";
  const transferEncoding = emailHeader(parsed.headers, "content-transfer-encoding");
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary) {
    const plainParts: string[] = [];
    const htmlParts: string[] = [];
    for (const part of parsed.body.split(`--${boundary}`)) {
      const trimmed = part.replace(/^\s+|\s+$/g, "");
      if (!trimmed || trimmed === "--") {
        continue;
      }
      const partParsed = parseEmailHeaderBlock(trimmed.replace(/--$/, ""));
      const partType = emailHeader(partParsed.headers, "content-type")?.toLowerCase() ?? "text/plain";
      const partEncoding = emailHeader(partParsed.headers, "content-transfer-encoding");
      if (partType.includes("text/plain")) {
        plainParts.push(decodeEmailBody(partParsed.body, partEncoding));
      } else if (partType.includes("text/html")) {
        htmlParts.push(stripHtml(decodeEmailBody(partParsed.body, partEncoding)));
      }
    }
    return (plainParts.join("\n\n").trim() || htmlParts.join("\n\n").trim() || undefined);
  }
  const decoded = decodeEmailBody(parsed.body, transferEncoding).trim();
  return contentType.includes("text/html") ? stripHtml(decoded) : decoded || undefined;
}

function decodeEmailBody(body: string, encoding: string | undefined): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const lower = encoding?.toLowerCase();
  if (lower === "base64") {
    return Buffer.from(normalized.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (lower === "quoted-printable") {
    return decodeQuotedPrintable(normalized);
  }
  return normalized;
}

function decodeMimeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, encoded: string) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(encoded, "base64").toString("utf8");
      }
      return decodeQuotedPrintable(encoded.replaceAll("_", " "));
    } catch {
      return encoded;
    }
  }).trim();
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const compact = value.replace(/=\r?\n/g, "");
  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(compact.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(compact.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(compact.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .trim();
}

function numberQuery(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function gatewayEnvelopePreviewContext(input: unknown): GatewayContext | undefined {
  const body = isRecord(input) ? input : {};
  const kind = typeof body.source === "string" ? body.source : typeof body.kind === "string" ? body.kind : "web";
  if (kind === "web") {
    return webGatewayContext;
  }
  if (kind === "cron") {
    return cronMemoryReviewGatewayContext;
  }
  if (kind === "local_cli") {
    return localCliGatewayContext(typeof body.route === "string" ? body.route : "main");
  }
  if (kind !== "paired" && kind !== "external" && kind !== "webhook") {
    return undefined;
  }
  const sourceIdentity = typeof body.source_identity === "string" ? body.source_identity.trim() : "";
  if (!sourceIdentity) {
    return undefined;
  }
  const channel = isGatewayChannel(body.channel) ? body.channel : "webhook";
  const route = typeof body.route === "string" ? body.route : undefined;
  const accountId = typeof body.account_id === "string" ? body.account_id : undefined;
  const threadId = typeof body.thread_id === "string" ? body.thread_id : undefined;
  return {
    source: channel,
    actor_identity: "paired_contact",
    instruction_source: "paired_identity_message",
    channel,
    session_key: sessionKeyForExternalSource({
      channel,
      source_identity: sourceIdentity,
      route,
      account_id: accountId,
      thread_id: threadId
    }),
    source_identity: sourceIdentity,
    source_label: typeof body.source_label === "string" && body.source_label.trim() ? body.source_label.trim() : sourceIdentity
  };
}

function asTranslationStatus(value: unknown): ResourceTranslationRecord["status"] | undefined {
  return typeof value === "string" && translationStatuses.includes(value as ResourceTranslationRecord["status"])
    ? (value as ResourceTranslationRecord["status"])
    : undefined;
}

function resourceRef(value: unknown) {
  const parsed = ResourceRefSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resourceRefFromQuery(query: Record<string, unknown>) {
  if (typeof query.source_kind !== "string" || typeof query.source_id !== "string" || typeof query.source_uri !== "string") {
    return undefined;
  }
  return resourceRef({
    kind: query.source_kind,
    id: query.source_id,
    uri: query.source_uri,
    ...(typeof query.source_label === "string" ? { label: query.source_label } : {})
  });
}

function isGatewayChannel(value: unknown): value is GatewayChannel {
  return typeof value === "string" && gatewayChannels.includes(value as GatewayChannel);
}

function normalizeInjectedExternalAssistProviders(provider?: ExternalAssistProvider | ExternalAssistProvider[]): ExternalAssistProvider[] {
  const providers = Array.isArray(provider) ? provider : provider ? [provider] : [];
  const seen = new Set<string>();
  return providers.filter((item) => {
    const id = item.id.trim();
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function isGatewayPairingStatus(value: unknown): value is "pending" | "approved" | "rejected" | "expired" | "revoked" {
  return value === "pending" || value === "approved" || value === "rejected" || value === "expired" || value === "revoked";
}

function isGatewayInboundStatus(value: unknown): value is "blocked" | "routed" | "processed" | "failed" {
  return value === "blocked" || value === "routed" || value === "processed" || value === "failed";
}

function isGatewayBoundarySource(value: unknown): value is "web" | "telegram" | "slack" | "line" | "email" | "mobile" | "webhook" | "local_cli" | "cron" {
  return value === "web" || value === "telegram" || value === "slack" || value === "line" || value === "email" || value === "mobile" || value === "webhook" || value === "local_cli" || value === "cron";
}

function isGatewayConcurrencyLockStatus(value: unknown): value is "acquired" | "released" | "expired" {
  return value === "acquired" || value === "released" || value === "expired";
}

function isGatewaySandboxInstanceStatus(value: unknown): value is "ready" | "recreated" | "deleted" | "failed" {
  return value === "ready" || value === "recreated" || value === "deleted" || value === "failed";
}

function isGatewaySandboxWorkspaceSyncStatus(value: unknown): value is "planned" | "completed" | "failed" | "skipped" {
  return GatewaySandboxWorkspaceSyncStatusSchema.safeParse(value).success;
}

function isGatewaySandboxWorkspaceSyncDirection(value: unknown): value is "seed_to_sandbox" | "pull_from_sandbox" | "mirror" {
  return GatewaySandboxWorkspaceSyncDirectionSchema.safeParse(value).success;
}

function isSandboxScope(value: unknown): value is "agent" | "session" | "shared" {
  return value === "agent" || value === "session" || value === "shared";
}

function isSandboxBackend(value: unknown): value is "none" | "docker" | "ssh" | "remote" {
  return value === "none" || value === "docker" || value === "ssh" || value === "remote";
}

function countGatewayInboundErrors(messages: Array<{ error?: string }>): Record<string, number> {
  return messages.reduce<Record<string, number>>((counts, message) => {
    const reason = message.error || "unspecified";
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
}

function countByKey<T>(records: T[], key: keyof T): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    const rawValue = record[key];
    const value = typeof rawValue === "string" && rawValue ? rawValue : "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function pluginDiagnosticsPayload(input: {
  plugins: PluginRuntimeStatus[];
  actions: Array<{ id: string; implementation_target?: string }>;
  issues: PluginManifestLoadIssue[];
}): PluginDiagnosticsReport {
  const filesystemPlugins = input.plugins.filter((plugin) => plugin.source === "filesystem");
  const actionById = new Map(input.actions.map((action) => [action.id, action]));
  const issues: PluginDiagnosticsReport["issues"] = input.issues.map((issue) => ({
    code: "plugin_manifest_load_issue",
    severity: pluginManifestLoadIssueSeverity(issue),
    file_path: issue.file_path,
    issue_code: issue.code,
    message: issue.message
  }));

  for (const plugin of filesystemPlugins) {
    if (plugin.action_ids.length === 0) {
      issues.push({
        code: "plugin_without_actions",
        severity: "warning",
        manifest_id: plugin.manifest_id,
        file_path: plugin.manifest_file_path,
        message: "Filesystem plugin declares no actions."
      });
    }
    if (plugin.entrypoint && plugin.entrypoint_status !== "ready") {
      issues.push({
        code: "plugin_entrypoint_not_ready",
        severity: plugin.entrypoint_status === "integrity_mismatch" || plugin.entrypoint_status === "outside_plugin" ? "critical" : "warning",
        manifest_id: plugin.manifest_id,
        file_path: plugin.manifest_file_path,
        entrypoint_status: plugin.entrypoint_status,
        message: `Plugin entrypoint is not ready: ${plugin.entrypoint_status}.`
      });
    }
    if (plugin.entrypoint && plugin.signature_status === "not_declared") {
      issues.push({
        code: "plugin_unsigned_entrypoint",
        severity: "warning",
        manifest_id: plugin.manifest_id,
        file_path: plugin.manifest_file_path,
        signature_status: plugin.signature_status,
        message: "Plugin entrypoint is unsigned. It is not auto-loaded unless unsigned entrypoints are explicitly allowed."
      });
    }
    if (plugin.signature_status === "invalid" || plugin.signature_status === "untrusted_key") {
      issues.push({
        code: "plugin_signature_untrusted",
        severity: "critical",
        manifest_id: plugin.manifest_id,
        file_path: plugin.manifest_file_path,
        signature_status: plugin.signature_status,
        message: `Plugin signature is not trusted: ${plugin.signature_status}.`
      });
    }

    const missingRuntimeHandlers = plugin.missing_handler_ids.filter((handlerId) =>
      plugin.action_ids.some((actionId) => {
        const action = actionById.get(actionId);
        return action?.implementation_target === "plugin" || Boolean(plugin.entrypoint);
      }) && plugin.handler_ids.includes(handlerId)
    );
    if (missingRuntimeHandlers.length > 0) {
      issues.push({
        code: "plugin_missing_handlers",
        severity: "critical",
        manifest_id: plugin.manifest_id,
        file_path: plugin.manifest_file_path,
        missing_handler_ids: missingRuntimeHandlers,
        action_ids: plugin.action_ids,
        message: "Filesystem plugin has action handlers that are not registered."
      });
    }
  }

  const entrypointNotReadyPlugins = filesystemPlugins.filter((plugin) => Boolean(plugin.entrypoint) && plugin.entrypoint_status !== "ready");
  const unsignedEntrypointPlugins = filesystemPlugins.filter((plugin) => Boolean(plugin.entrypoint) && plugin.signature_status === "not_declared");
  const untrustedSignaturePlugins = filesystemPlugins.filter((plugin) => plugin.signature_status === "invalid" || plugin.signature_status === "untrusted_key");
  const pluginsWithMissingHandlers = filesystemPlugins.filter((plugin) =>
    issues.some((issue) => issue.code === "plugin_missing_handlers" && issue.manifest_id === plugin.manifest_id)
  );
  const filesystemActionIds = new Set(filesystemPlugins.flatMap((plugin) => plugin.action_ids));
  const filesystemRendererIds = new Set(filesystemPlugins.flatMap((plugin) => plugin.renderer_ids));

  return PluginDiagnosticsReportSchema.parse({
    ok: !issues.some((issue) => issue.severity === "critical" || issue.severity === "warning"),
    generated_at: nowIso(),
    total_plugins: input.plugins.length,
    built_in_plugins: input.plugins.filter((plugin) => plugin.source === "built_in").length,
    filesystem_plugins: filesystemPlugins.length,
    marketplace_plugins: input.plugins.filter((plugin) => plugin.kind === "marketplace").length,
    total_actions: input.actions.length,
    filesystem_actions: filesystemActionIds.size,
    total_renderers: new Set(input.plugins.flatMap((plugin) => plugin.renderer_ids)).size,
    filesystem_renderers: filesystemRendererIds.size,
    entrypoint_ready_plugins: filesystemPlugins.filter((plugin) => plugin.entrypoint_status === "ready").length,
    entrypoint_not_ready_plugins: entrypointNotReadyPlugins.length,
    unsigned_entrypoint_plugins: unsignedEntrypointPlugins.length,
    untrusted_signature_plugins: untrustedSignaturePlugins.length,
    plugins_with_missing_handlers: pluginsWithMissingHandlers.length,
    registered_handlers: filesystemPlugins.reduce((sum, plugin) => sum + plugin.registered_handler_ids.length, 0),
    missing_handlers: pluginsWithMissingHandlers.reduce((sum, plugin) => sum + plugin.missing_handler_ids.length, 0),
    load_issue_count: input.issues.length,
    status_counts: {
      sources: countByKey(input.plugins, "source"),
      kinds: countByKey(input.plugins, "kind"),
      entrypoints: countByKey(input.plugins, "entrypoint_status"),
      signatures: countByKey(input.plugins, "signature_status")
    },
    issues,
    recommendation: pluginDiagnosticsRecommendation(issues)
  });
}

function pluginManifestLoadIssueSeverity(issue: PluginManifestLoadIssue): "warning" | "critical" {
  if (issue.code === "entrypoint_unsigned" || issue.code === "entrypoint_missing" || issue.code === "read_failed") {
    return "warning";
  }
  return "critical";
}

function pluginDiagnosticsRecommendation(issues: PluginDiagnosticsReport["issues"]): string {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "Fix critical plugin manifest, entrypoint, signature, or handler issues before exposing filesystem plugin actions.";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "Review plugin warnings before treating filesystem plugins as production-ready.";
  }
  return "Plugin catalog and runtime diagnostics are healthy. Filesystem plugins are discovered without load, signature, or handler issues.";
}

async function reflectionDiagnosticsPayload(
  store: WorkspaceStore,
  input: { sessionId?: string; staleAfterHours?: number; limit?: number } = {}
): Promise<ReflectionDiagnosticsReport> {
  const generatedAt = nowIso();
  const staleAfterHours = input.staleAfterHours ?? 72;
  const staleBeforeMs = Date.parse(generatedAt) - staleAfterHours * 60 * 60 * 1000;
  const limit = normalizeDiagnosticsLimit(input.limit);
  const [curatorState, runs, allSuggestions, backendRuns, memories, skills, wikiPages] = await Promise.all([
    store.getCuratorState(),
    store.listReflectionRuns(input.sessionId),
    store.listReflectionSuggestions(),
    store.listBackendRuns(input.sessionId),
    store.listMemory(),
    store.listSkills(),
    store.listWiki({ activeOnly: false })
  ]);
  const reflectionRuns = runs.filter((run) => run.kind !== "curator" && run.kind !== "evaluation");
  const curatorRuns = runs.filter((run) => run.kind === "curator");
  const latestReflectionRun = reflectionRuns[0];
  const latestCuratorRun = curatorRuns[0];
  const reflectionRunIds = new Set(reflectionRuns.map((run) => run.id));
  const curatorRunIds = new Set(curatorRuns.map((run) => run.id));
  const reflectionSuggestions = allSuggestions.filter((suggestion) => reflectionRunIds.has(suggestion.reflection_run_id));
  const curatorSuggestions = allSuggestions.filter((suggestion) => curatorRunIds.has(suggestion.reflection_run_id));
  const trackedSuggestions = [...reflectionSuggestions, ...curatorSuggestions];
  const pendingReflectionSuggestions = reflectionSuggestions.filter((suggestion) => suggestion.status === "proposed");
  const pendingCuratorSuggestions = curatorSuggestions.filter((suggestion) => suggestion.status === "proposed");
  const curatableResourceCount = memories.filter((memory) => memory.state !== "archived").length
    + skills.filter((skill) => skill.state !== "archived").length
    + wikiPages.filter((page) => page.state !== "archived").length;
  const issues: ReflectionDiagnosticsReport["issues"] = [];

  if (backendRuns.length > 0 && reflectionRuns.length === 0) {
    issues.push({
      code: "reflection_run_missing",
      severity: "warning",
      message: "Backend runs exist but no Reflection run has reviewed them yet."
    });
  }
  if (curatableResourceCount > 0 && curatorRuns.length === 0) {
    issues.push({
      code: "curator_run_missing",
      severity: "warning",
      message: "Curatable Memory, Knowledge Wiki, or Skill resources exist but no Curator run has reviewed them yet."
    });
  }

  for (const run of reflectionRuns) {
    if (run.status === "failed") {
      issues.push({
        code: "reflection_run_failed",
        severity: "critical",
        message: "Reflection run failed before producing a completed self-improvement review.",
        reflection_run_id: run.id,
        run_kind: run.kind,
        status: run.status,
        created_at: run.started_at
      });
    }
  }
  for (const run of curatorRuns) {
    if (run.status === "failed") {
      issues.push({
        code: "curator_run_failed",
        severity: "critical",
        message: "Curator run failed before producing lifecycle suggestions.",
        reflection_run_id: run.id,
        run_kind: run.kind,
        status: run.status,
        created_at: run.started_at
      });
    }
  }

  if (latestReflectionRun && Date.parse(latestReflectionRun.completed_at ?? latestReflectionRun.started_at) < staleBeforeMs) {
    issues.push({
      code: "reflection_run_stale",
      severity: "warning",
      message: `Latest Reflection run is older than ${staleAfterHours} hours.`,
      reflection_run_id: latestReflectionRun.id,
      run_kind: latestReflectionRun.kind,
      status: latestReflectionRun.status,
      created_at: latestReflectionRun.completed_at ?? latestReflectionRun.started_at
    });
  }
  if (latestCuratorRun && Date.parse(latestCuratorRun.completed_at ?? latestCuratorRun.started_at) < staleBeforeMs) {
    issues.push({
      code: "curator_run_stale",
      severity: "warning",
      message: `Latest Curator run is older than ${staleAfterHours} hours.`,
      reflection_run_id: latestCuratorRun.id,
      run_kind: "curator",
      status: latestCuratorRun.status,
      created_at: latestCuratorRun.completed_at ?? latestCuratorRun.started_at
    });
  }
  if (curatorState.paused) {
    issues.push({
      code: "curator_paused",
      severity: "warning",
      message: "Curator is paused and will not actively propose lifecycle changes.",
      status: "paused",
      created_at: curatorState.updated_at
    });
  }
  if (latestCuratorRun?.output_summary?.toLowerCase().includes("skipped because workspace activity")) {
    issues.push({
      code: "curator_idle_gate_skipped",
      severity: "info",
      message: "Latest Curator run was skipped by the idle gate because recent workspace activity was detected.",
      reflection_run_id: latestCuratorRun.id,
      run_kind: "curator",
      status: latestCuratorRun.status,
      created_at: latestCuratorRun.completed_at ?? latestCuratorRun.started_at
    });
  }

  for (const suggestion of pendingReflectionSuggestions) {
    issues.push({
      code: "reflection_suggestion_pending",
      severity: "info",
      message: "Reflection suggestion is still pending review.",
      reflection_run_id: suggestion.reflection_run_id,
      suggestion_id: suggestion.id,
      suggestion_type: suggestion.suggestion_type,
      status: suggestion.status,
      resource_ref: suggestion.target_ref,
      created_at: suggestion.created_at
    });
  }
  for (const suggestion of pendingCuratorSuggestions) {
    issues.push({
      code: "curator_suggestion_pending",
      severity: "info",
      message: "Curator suggestion is still pending review.",
      reflection_run_id: suggestion.reflection_run_id,
      suggestion_id: suggestion.id,
      run_kind: "curator",
      suggestion_type: suggestion.suggestion_type,
      status: suggestion.status,
      resource_ref: suggestion.target_ref,
      created_at: suggestion.created_at
    });
  }

  return ReflectionDiagnosticsReportSchema.parse({
    generated_at: generatedAt,
    stale_after_hours: staleAfterHours,
    total_reflection_runs: reflectionRuns.length,
    completed_reflection_runs: reflectionRuns.filter((run) => run.status === "completed").length,
    failed_reflection_runs: reflectionRuns.filter((run) => run.status === "failed").length,
    total_curator_runs: curatorRuns.length,
    completed_curator_runs: curatorRuns.filter((run) => run.status === "completed").length,
    failed_curator_runs: curatorRuns.filter((run) => run.status === "failed").length,
    pending_reflection_suggestions: pendingReflectionSuggestions.length,
    pending_curator_suggestions: pendingCuratorSuggestions.length,
    ...(latestReflectionRun ? { latest_reflection_run: latestReflectionRun } : {}),
    ...(latestCuratorRun ? { latest_curator_run: latestCuratorRun } : {}),
    curator_state: curatorState,
    status_counts: {
      reflection_runs: countByKey(reflectionRuns, "status"),
      curator_runs: countByKey(curatorRuns, "status"),
      suggestions: countByKey(trackedSuggestions, "status"),
      suggestion_types: countByKey(trackedSuggestions, "suggestion_type")
    },
    issues: issues.slice(0, limit),
    recommendation: reflectionDiagnosticsRecommendation(issues)
  });
}

function reflectionDiagnosticsRecommendation(issues: ReflectionDiagnosticsReport["issues"]): string {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "Review failed Reflection or Curator runs before relying on the self-improvement loop.";
  }
  if (issues.some((issue) => issue.code === "curator_paused")) {
    return "Curator is paused. Resume it intentionally before expecting lifecycle suggestions to stay fresh.";
  }
  if (issues.some((issue) => issue.code === "reflection_run_missing" || issue.code === "curator_run_missing" || issue.code === "reflection_run_stale" || issue.code === "curator_run_stale")) {
    return "Run Reflection / Curator jobs so recent backend traces and workspace resources are reviewed.";
  }
  if (issues.some((issue) => issue.code === "reflection_suggestion_pending" || issue.code === "curator_suggestion_pending")) {
    return "Review pending Reflection / Curator suggestions before relying on the self-improvement loop.";
  }
  if (issues.some((issue) => issue.code === "curator_idle_gate_skipped")) {
    return "Curator is respecting the idle gate. Re-run after the workspace is idle or lower the idle threshold intentionally.";
  }
  return "Reflection / Curator diagnostics are healthy for the selected scope.";
}

async function evaluationDiagnosticsPayload(
  store: WorkspaceStore,
  input: { sessionId?: string; staleAfterHours?: number; limit?: number } = {}
): Promise<EvaluationDiagnosticsReport> {
  const generatedAt = nowIso();
  const staleAfterHours = input.staleAfterHours ?? 72;
  const staleBeforeMs = Date.parse(generatedAt) - staleAfterHours * 60 * 60 * 1000;
  const limit = normalizeDiagnosticsLimit(input.limit);
  const [reflectionRuns, allSuggestions, backendRuns, toolRuns, workspaceChanges] = await Promise.all([
    store.listReflectionRuns(input.sessionId),
    store.listReflectionSuggestions(),
    store.listBackendRuns(input.sessionId),
    store.listToolRuns(input.sessionId ? { sessionId: input.sessionId } : {}),
    store.listWorkspaceChanges(input.sessionId)
  ]);
  const evaluationRuns = reflectionRuns.filter((run) => run.kind === "evaluation");
  const latestEvaluationRun = evaluationRuns[0];
  const evaluationRunIds = new Set(evaluationRuns.map((run) => run.id));
  const evaluationSuggestions = allSuggestions.filter((suggestion) => evaluationRunIds.has(suggestion.reflection_run_id));
  const pendingEvaluationSuggestions = evaluationSuggestions.filter((suggestion) => suggestion.status === "proposed");
  const failedBackendRuns = backendRuns.filter((run) => run.status === "failed" || run.status === "cancelled");
  const waitingBackendRuns = backendRuns.filter((run) => run.status === "waiting_for_backend_input");
  const outcomeUnknownBackendRuns = backendRuns.filter((run) => run.status === "outcome_unknown");
  const attentionToolRuns = toolRuns.filter((toolRun) => toolRun.status === "ignored" || toolRun.status === "failed");
  const issues: EvaluationDiagnosticsReport["issues"] = [];

  if (backendRuns.length > 0 && evaluationRuns.length === 0) {
    issues.push({
      code: "evaluation_run_missing",
      severity: "warning",
      message: "Backend traces exist but no evaluation run has reviewed them yet."
    });
  }

  for (const run of evaluationRuns) {
    if (run.status === "failed") {
      issues.push({
        code: "evaluation_run_failed",
        severity: "critical",
        message: "Evaluation run failed before producing a completed trace review.",
        reflection_run_id: run.id,
        status: run.status,
        created_at: run.started_at
      });
    }
  }

  if (latestEvaluationRun && Date.parse(latestEvaluationRun.completed_at ?? latestEvaluationRun.started_at) < staleBeforeMs) {
    issues.push({
      code: "evaluation_run_stale",
      severity: "warning",
      message: `Latest evaluation run is older than ${staleAfterHours} hours.`,
      reflection_run_id: latestEvaluationRun.id,
      status: latestEvaluationRun.status,
      created_at: latestEvaluationRun.completed_at ?? latestEvaluationRun.started_at
    });
  }

  for (const suggestion of pendingEvaluationSuggestions) {
    issues.push({
      code: "evaluation_suggestion_pending",
      severity: "info",
      message: "Evaluation suggestion is still pending review.",
      reflection_run_id: suggestion.reflection_run_id,
      suggestion_id: suggestion.id,
      status: suggestion.status,
      resource_ref: suggestion.target_ref,
      created_at: suggestion.created_at
    });
  }

  for (const run of failedBackendRuns) {
    issues.push({
      code: "backend_run_failed",
      severity: "critical",
      message: "Backend run failed or was cancelled and should be reviewed by the evaluation loop.",
      run_id: run.id,
      status: run.status,
      resource_ref: backendRunDiagnosticsRef(run),
      created_at: run.completed_at ?? run.started_at
    });
  }

  for (const run of waitingBackendRuns) {
    issues.push({
      code: "backend_run_waiting_for_input",
      severity: "warning",
      message: "Backend run is waiting for native input and may need resume or owner action before evaluation is meaningful.",
      run_id: run.id,
      status: run.status,
      resource_ref: backendRunDiagnosticsRef(run),
      created_at: run.started_at
    });
  }

  for (const run of outcomeUnknownBackendRuns) {
    issues.push({
      code: "backend_run_outcome_unknown",
      severity: "critical",
      message: "Backend run outcome is unconfirmed. External processing may still be running; do not retry automatically.",
      run_id: run.id,
      status: run.status,
      resource_ref: backendRunDiagnosticsRef(run),
      created_at: run.completed_at ?? run.started_at
    });
  }

  for (const toolRun of attentionToolRuns) {
    issues.push({
      code: "tool_run_attention_required",
      severity: toolRun.status === "failed" ? "critical" : "warning",
      message: "Tool run was ignored or failed and should be reflected in the next evaluation review.",
      run_id: toolRun.run_id,
      tool_run_id: toolRun.id,
      status: toolRun.status,
      resource_ref: toolRunDiagnosticsRef(toolRun),
      created_at: toolRun.created_at
    });
  }

  return EvaluationDiagnosticsReportSchema.parse({
    generated_at: generatedAt,
    stale_after_hours: staleAfterHours,
    total_evaluation_runs: evaluationRuns.length,
    completed_evaluation_runs: evaluationRuns.filter((run) => run.status === "completed").length,
    failed_evaluation_runs: evaluationRuns.filter((run) => run.status === "failed").length,
    pending_evaluation_suggestions: pendingEvaluationSuggestions.length,
    backend_runs: backendRuns.length,
    failed_backend_runs: failedBackendRuns.length,
    waiting_backend_runs: waitingBackendRuns.length,
    outcome_unknown_backend_runs: outcomeUnknownBackendRuns.length,
    tool_runs: toolRuns.length,
    ignored_or_failed_tool_runs: attentionToolRuns.length,
    workspace_changes: workspaceChanges.length,
    ...(latestEvaluationRun ? { latest_evaluation_run: latestEvaluationRun } : {}),
    status_counts: {
      evaluation_runs: countByKey(evaluationRuns, "status"),
      evaluation_suggestions: countByKey(evaluationSuggestions, "status"),
      backend_runs: countByKey(backendRuns, "status"),
      tool_runs: countByKey(toolRuns, "status")
    },
    issues: issues.slice(0, limit),
    recommendation: evaluationDiagnosticsRecommendation(issues)
  });
}

function backendRunDiagnosticsRef(run: BackendRunRecord): ResourceRef {
  return {
    kind: "backend_run",
    id: run.id,
    uri: `backend-runs/${run.id}`,
    label: run.input_summary
  };
}

function toolRunDiagnosticsRef(toolRun: ToolRunRecord): ResourceRef {
  return {
    kind: "tool_run",
    id: toolRun.id,
    uri: `tool-runs/${toolRun.id}`,
    label: toolRun.action_id ?? toolRun.provider_tool_name
  };
}

function evaluationDiagnosticsRecommendation(issues: EvaluationDiagnosticsReport["issues"]): string {
  if (issues.some((issue) => issue.code === "backend_run_outcome_unknown")) {
    return "Some backend outcomes are unconfirmed. Do not retry them automatically; verify external processing before taking action, while new turns remain available.";
  }
  if (issues.some((issue) => issue.code === "evaluation_run_failed" || issue.code === "backend_run_failed" || issue.severity === "critical")) {
    return "Review failed evaluation, backend, or tool traces before treating backend quality as release-ready.";
  }
  if (issues.some((issue) => issue.code === "evaluation_run_missing" || issue.code === "evaluation_run_stale")) {
    return "Run the evaluation job so recent backend traces are scored before release review.";
  }
  if (issues.some((issue) => issue.code === "evaluation_suggestion_pending")) {
    return "Review pending evaluation suggestions before treating trace quality as closed.";
  }
  return "Evaluation diagnostics are healthy for the selected scope.";
}

const fileToolOperations = new Set(["file.read", "file.inspect", "file.list", "file.write", "file.patch"]);
const browserToolOperations = new Set(["browser.navigate", "browser.extract", "browser.interact", "browser.screenshot", "browser.download_to_workspace"]);

async function fileBrowserActionDiagnosticsPayload(
  store: WorkspaceStore,
  input: { sessionId?: string; limit?: number } = {}
): Promise<FileBrowserActionDiagnosticsReport> {
  const generatedAt = nowIso();
  const limit = normalizeDiagnosticsLimit(input.limit);
  const [operations, toolRuns] = await Promise.all([
    store.listOperations(input.sessionId),
    store.listToolRuns(input.sessionId ? { sessionId: input.sessionId } : {})
  ]);
  const actionOperations = operations.filter((operation) => isFileBrowserOperation(operation.operation));
  const actionToolRuns = toolRuns.filter((toolRun) => isFileBrowserOperation(toolRun.action_id ?? toolRun.provider_tool_name));
  const issues: FileBrowserActionDiagnosticsReport["issues"] = [];

  for (const operation of actionOperations) {
    const actionKind = fileBrowserActionKind(operation.operation);
    if (!actionKind) {
      continue;
    }
    if (isFailedOrBlockedFileBrowserOperation(operation)) {
      issues.push({
        code: operation.status === "failed" ? "file_browser_action_failed" : "file_browser_action_blocked",
        severity: operation.status === "failed" || operation.status === "denied" ? "critical" : "warning",
        action_kind: actionKind,
        operation: operation.operation,
        status: operation.status,
        message: operation.status === "failed"
          ? "File / Browser action failed before completion. Review the operation status and retry from the backend-controlled action API if appropriate."
          : "File / Browser action did not complete automatically and needs approval or policy review.",
        operation_id: operation.id,
        session_id: operation.session_id,
        resource_ref: safeDiagnosticsResourceRef(operation.result_ref),
        created_at: operation.created_at
      });
    }
    if (isBrowserWorkspaceFallback(operation)) {
      issues.push({
        code: "browser_workspace_fallback",
        severity: "info",
        action_kind: "browser",
        operation: operation.operation,
        status: operation.status,
        message: "Browser action saved page content into the workspace fallback. Treat this as an inspectable HTML/text snapshot, not a full browser automation result.",
        operation_id: operation.id,
        session_id: operation.session_id,
        resource_ref: safeDiagnosticsResourceRef(operation.result_ref),
        created_at: operation.created_at
      });
    }
  }

  for (const toolRun of actionToolRuns) {
    if (toolRun.status !== "ignored" && toolRun.status !== "failed") {
      continue;
    }
    const operationName = toolRun.action_id ?? toolRun.provider_tool_name;
    const actionKind = fileBrowserActionKind(operationName) ?? fileBrowserActionKind(toolRun.provider_tool_name);
    if (!actionKind) {
      continue;
    }
    issues.push({
      code: toolRun.status === "failed" ? "file_browser_tool_run_failed" : "file_browser_tool_run_ignored",
      severity: toolRun.status === "failed" ? "critical" : "warning",
      action_kind: actionKind,
      operation: operationName,
      status: toolRun.status,
      message: toolRun.status === "failed"
        ? "Provider requested a File / Browser tool but the backend tool run failed."
        : "Provider requested a File / Browser tool that the backend ignored. Check mapping, policy, and action input shape.",
      tool_run_id: toolRun.id,
      run_id: toolRun.run_id,
      session_id: toolRun.session_id,
      resource_ref: safeDiagnosticsResourceRef(toolRun.resource_refs[0]),
      output_summary: toolRun.output_summary,
      created_at: toolRun.created_at
    });
  }

  return FileBrowserActionDiagnosticsReportSchema.parse({
    generated_at: generatedAt,
    scope: {
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      limit
    },
    total_operations: actionOperations.length,
    total_tool_runs: actionToolRuns.length,
    file_operations: actionOperations.filter((operation) => fileBrowserActionKind(operation.operation) === "file").length,
    browser_operations: actionOperations.filter((operation) => fileBrowserActionKind(operation.operation) === "browser").length,
    completed_file_operations: actionOperations.filter((operation) => fileBrowserActionKind(operation.operation) === "file" && operation.status === "completed").length,
    completed_browser_operations: actionOperations.filter((operation) => fileBrowserActionKind(operation.operation) === "browser" && operation.status === "completed").length,
    failed_or_blocked_operations: actionOperations.filter(isFailedOrBlockedFileBrowserOperation).length,
    ignored_or_failed_tool_runs: actionToolRuns.filter((toolRun) => toolRun.status === "ignored" || toolRun.status === "failed").length,
    browser_workspace_fallbacks: actionOperations.filter(isBrowserWorkspaceFallback).length,
    operation_status_counts: countByKey(actionOperations, "status"),
    tool_run_status_counts: countByKey(actionToolRuns, "status"),
    issues: issues.slice(0, limit),
    recommendation: fileBrowserActionDiagnosticsRecommendation(issues)
  });
}

function normalizeDiagnosticsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

function isFileBrowserOperation(operation: string): boolean {
  return fileToolOperations.has(operation) || browserToolOperations.has(operation);
}

function fileBrowserActionKind(operation: string): "file" | "browser" | undefined {
  if (fileToolOperations.has(operation)) {
    return "file";
  }
  if (browserToolOperations.has(operation)) {
    return "browser";
  }
  return undefined;
}

function isBrowserWorkspaceFallback(operation: OperationRecord): boolean {
  return operation.status === "completed"
    && operation.operation === "browser.download_to_workspace"
    && operation.result_ref?.kind === "file";
}

function isFailedOrBlockedFileBrowserOperation(operation: OperationRecord): boolean {
  return operation.status !== "completed" && operation.status !== "created";
}

function safeDiagnosticsResourceRef(ref: ResourceRef | undefined): ResourceRef | undefined {
  if (!ref || ref.kind !== "file") {
    return undefined;
  }
  return ref;
}

function fileBrowserActionDiagnosticsRecommendation(issues: FileBrowserActionDiagnosticsReport["issues"]): string {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "Review failed or denied File / Browser actions before expanding the generic tool suite.";
  }
  if (issues.some((issue) => issue.code === "file_browser_tool_run_ignored" || issue.code === "file_browser_action_blocked")) {
    return "Check File / Browser action policy, mapping, and approval flow before relying on these tools for unattended backend work.";
  }
  if (issues.some((issue) => issue.code === "browser_workspace_fallback")) {
    return "Browser actions are using inspectable workspace fallback snapshots. This is safe for review, but not a full browser automation suite yet.";
  }
  return "File / Browser action diagnostics are healthy for the selected scope.";
}

async function externalSendDiagnosticsPayload(
  store: WorkspaceStore,
  input: { staleAfterHours?: number } = {}
): Promise<ExternalSendDiagnosticsReport> {
  const generatedAt = nowIso();
  const staleAfterHours = input.staleAfterHours ?? 24;
  const staleBeforeMs = Date.parse(generatedAt) - staleAfterHours * 60 * 60 * 1000;
  const sends = await store.listExternalSends();
  const dispatchEnabled = process.env.SAMURAI_EXTERNAL_SEND_DISPATCH === "true";
  const transportReadiness = externalSendTransportReadiness(dispatchEnabled);
  const issues: ExternalSendDiagnosticsReport["issues"] = [];

  for (const send of sends) {
    const ref = externalSendResourceRef(send);
    if (send.status === "pending_approval") {
      issues.push({
        code: "external_send_pending_approval",
        severity: "warning",
        send_id: send.id,
        channel: send.channel,
        status: send.status,
        title: send.title,
        message: "External send is waiting for explicit owner approval before dispatch.",
        resource_ref: ref
      });
    }
    if (send.status === "approved" && isDryRunDispatch(send.dispatch_result)) {
      issues.push({
        code: "external_send_dry_run_only",
        severity: "info",
        send_id: send.id,
        channel: send.channel,
        status: send.status,
        title: send.title,
        message: "External send was approved but only a dry-run dispatch was recorded.",
        resource_ref: ref
      });
    }
    if (send.status === "failed") {
      issues.push({
        code: "external_send_failed",
        severity: "critical",
        send_id: send.id,
        channel: send.channel,
        status: send.status,
        title: send.title,
        message: "External send dispatch failed. Review the redacted dispatch result and retry through the backend dispatch API if appropriate.",
        resource_ref: ref
      });
    }
    if ((send.status === "draft" || send.status === "pending_approval") && Date.parse(send.updated_at || send.created_at) < staleBeforeMs) {
      issues.push({
        code: "external_send_stale_draft",
        severity: "warning",
        send_id: send.id,
        channel: send.channel,
        status: send.status,
        title: send.title,
        message: `External send has not moved for more than ${staleAfterHours} hours.`,
        resource_ref: ref
      });
    }
    if (externalSendNeedsTargetIssue(send)) {
      issues.push({
        code: "external_send_missing_target_url",
        severity: send.status === "draft" ? "warning" : "critical",
        send_id: send.id,
        channel: send.channel,
        status: send.status,
        title: send.title,
        message: "External send target config is missing. Frontend must not infer or store provider secrets; fix the backend target config.",
        resource_ref: ref
      });
    }
  }

  return ExternalSendDiagnosticsReportSchema.parse({
    generated_at: generatedAt,
    dispatch_enabled: dispatchEnabled,
    dry_run_default: !dispatchEnabled,
    stale_after_hours: staleAfterHours,
    total_sends: sends.length,
    pending_approval_sends: sends.filter((send) => send.status === "pending_approval").length,
    failed_sends: sends.filter((send) => send.status === "failed").length,
    dry_run_approved_sends: sends.filter((send) => send.status === "approved" && isDryRunDispatch(send.dispatch_result)).length,
    stale_draft_sends: sends.filter((send) =>
      (send.status === "draft" || send.status === "pending_approval") && Date.parse(send.updated_at || send.created_at) < staleBeforeMs
    ).length,
    status_counts: countByKey(sends, "status"),
    channel_counts: countByKey(sends, "channel"),
    transport_status_counts: countByKey(transportReadiness, "status"),
    transport_readiness: transportReadiness,
    issues,
    recommendation: externalSendDiagnosticsRecommendation(issues, dispatchEnabled)
  });
}

function externalSendTransportReadiness(dispatchEnabled: boolean): ExternalSendTransportReadiness[] {
  return externalSendChannels.map((channel) => {
    if (channel === "email") {
      return externalSendEmailTransportReadiness(dispatchEnabled);
    }
    if (channel === "telegram") {
      const configured = externalSendEnvConfigured("SAMURAI_TELEGRAM_BOT_TOKEN");
      return externalSendApiTransportReadiness({
        channel,
        configured,
        dispatchEnabled,
        targetLabel: "chat_id"
      });
    }
    if (channel === "line") {
      const configured = externalSendEnvConfigured("SAMURAI_LINE_CHANNEL_ACCESS_TOKEN");
      return externalSendApiTransportReadiness({
        channel,
        configured,
        dispatchEnabled,
        targetLabel: "reply_token or to/user_id/group_id/room_id"
      });
    }
    if (channel === "slack" && externalSendEnvConfigured("SAMURAI_SLACK_BOT_TOKEN")) {
      return externalSendApiTransportReadiness({
        channel,
        configured: true,
        dispatchEnabled,
        targetLabel: "channel_id"
      });
    }
    return {
      channel,
      status: dispatchEnabled ? "ready" : "dry_run_only",
      configured: true,
      dispatch_enabled: dispatchEnabled,
      requires_target_url: true,
      message: dispatchEnabled
        ? `${channel} dispatch is enabled; each send still requires a backend-provided target URL.`
        : `${channel} dispatch is dry-run by default until SAMURAI_EXTERNAL_SEND_DISPATCH=true is set.`
    };
  });
}

function externalSendEmailTransportReadiness(dispatchEnabled: boolean): ExternalSendTransportReadiness {
  const configured = emailSmtpConfigured();
  if (!configured) {
    return {
      channel: "email",
      status: "not_configured",
      configured: false,
      dispatch_enabled: false,
      requires_target_url: false,
      message: "Email SMTP transport is not configured. Set SAMURAI_EMAIL_SMTP_HOST and SAMURAI_EMAIL_FROM or SAMURAI_EMAIL_SMTP_FROM."
    };
  }
  return {
    channel: "email",
    status: dispatchEnabled ? "ready" : "dry_run_only",
    configured: true,
    dispatch_enabled: dispatchEnabled,
    requires_target_url: false,
    message: dispatchEnabled
      ? "Email SMTP dispatch is enabled; each send still requires to/cc/bcc in the backend-provided target."
      : "Email SMTP dispatch is configured but dry-run by default until SAMURAI_EXTERNAL_SEND_DISPATCH=true is set."
  };
}

function externalSendApiTransportReadiness(input: {
  channel: ExternalSendTransportReadiness["channel"];
  configured: boolean;
  dispatchEnabled: boolean;
  targetLabel: string;
}): ExternalSendTransportReadiness {
  if (!input.configured) {
    return {
      channel: input.channel,
      status: "not_configured",
      configured: false,
      dispatch_enabled: false,
      requires_target_url: false,
      message: `${input.channel} API transport is not configured. Set the backend env token and provide ${input.targetLabel} in the send target.`
    };
  }
  return {
    channel: input.channel,
    status: input.dispatchEnabled ? "ready" : "dry_run_only",
    configured: true,
    dispatch_enabled: input.dispatchEnabled,
    requires_target_url: false,
    message: input.dispatchEnabled
      ? `${input.channel} API dispatch is enabled; each send still requires ${input.targetLabel} in the backend-provided target.`
      : `${input.channel} API dispatch is configured but dry-run by default until SAMURAI_EXTERNAL_SEND_DISPATCH=true is set.`
  };
}

function externalSendEnvConfigured(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}

function serverEnvString(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.get("authorization")?.trim();
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : undefined;
  return match?.[1]?.trim() || undefined;
}

function serverEnvBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function serverEnvNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function emailSmtpConfigured(): boolean {
  return externalSendEnvConfigured("SAMURAI_EMAIL_SMTP_HOST")
    && (externalSendEnvConfigured("SAMURAI_EMAIL_FROM") || externalSendEnvConfigured("SAMURAI_EMAIL_SMTP_FROM"));
}

function hasExternalSendTargetUrl(send: ExternalSendRecord): boolean {
  return typeof send.target.url === "string" && send.target.url.trim().length > 0;
}

function hasExternalSendTargetValue(send: ExternalSendRecord, ...keys: string[]): boolean {
  return keys.some((key) => {
    const value = send.target[key];
    if (typeof value === "string") {
      return Boolean(value.trim());
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return Array.isArray(value) && value.some((item) => typeof item === "string" && Boolean(item.trim()));
  });
}

function externalSendNeedsTargetIssue(send: ExternalSendRecord): boolean {
  if (send.channel === "webhook") {
    return !hasExternalSendTargetUrl(send);
  }
  if (send.channel === "slack") {
    return !hasExternalSendTargetUrl(send) && !hasExternalSendTargetValue(send, "channel_id", "channel");
  }
  if (send.channel === "telegram") {
    return !hasExternalSendTargetValue(send, "chat_id", "chatId", "to");
  }
  if (send.channel === "line") {
    return !hasExternalSendTargetValue(send, "reply_token", "replyToken", "to", "user_id", "group_id", "room_id");
  }
  if (send.channel === "email") {
    return emailSmtpConfigured() && !hasExternalSendTargetValue(send, "to", "recipient", "email", "cc", "bcc");
  }
  return false;
}

function isDryRunDispatch(result: ExternalSendRecord["dispatch_result"]): boolean {
  return Boolean(result && result.dry_run === true);
}

function externalSendResourceRef(send: ExternalSendRecord): ResourceRef {
  return {
    kind: "external_send",
    id: send.id,
    uri: `external-sends/${send.id}`,
    label: send.title
  };
}

function externalSendDiagnosticsRecommendation(issues: ExternalSendDiagnosticsReport["issues"], dispatchEnabled: boolean): string {
  if (issues.some((issue) => issue.code === "external_send_failed" || issue.code === "external_send_missing_target_url")) {
    return "Review failed or misconfigured external sends before retrying dispatch through the backend API.";
  }
  if (issues.some((issue) => issue.code === "external_send_pending_approval")) {
    return "Review pending external sends and approve or deny them through the approval flow.";
  }
  if (issues.some((issue) => issue.code === "external_send_dry_run_only")) {
    return dispatchEnabled
      ? "Dry-run sends exist even though dispatch is enabled; verify whether they should be retried."
      : "External send dispatch is currently dry-run by default. Keep using approval flow until a transport is intentionally enabled.";
  }
  return "External send queue is healthy. Continue treating real dispatch as backend-controlled and approval-gated.";
}

async function gatewayDiagnosticsPayload(store: WorkspaceStore): Promise<GatewayDiagnosticsReport> {
  const [
    pairings,
    pairingPolicies,
    routingPolicies,
    inboundMessages,
    boundaryPolicies,
    mcpConfigs,
    concurrencyLocks,
    sandboxInstances,
    sandboxWorkspaceSyncs
  ] = await Promise.all([
    store.listGatewayPairings(),
    store.listGatewayPairingPolicies(),
    store.listGatewayRoutingPolicies(),
    store.listGatewayInboundMessages({ limit: 500 }),
    store.listGatewayBoundaryPolicies(),
    store.listGatewayMcpConfigs(),
    store.listGatewayConcurrencyLocks({ limit: 500 }),
    store.listGatewaySandboxInstances({ limit: 500 }),
    store.listGatewaySandboxWorkspaceSyncs({ limit: 500 })
  ]);
  const nowMs = Date.now();
  const issues: GatewayDiagnosticsReport["issues"] = [];
  const enabledPairingPolicyChannels = new Set(pairingPolicies.filter((policy) => policy.status === "enabled").map((policy) => policy.channel));
  const enabledRoutingPolicyChannels = new Set(routingPolicies.filter((policy) => policy.status === "enabled").map((policy) => policy.channel));

  for (const pairing of pairings.filter((item) => item.status === "pending")) {
    issues.push({
      code: "gateway_pending_pairing",
      severity: "warning",
      resource_kind: "pairing",
      resource_id: pairing.id,
      message: "Gateway pairing is pending approval."
    });
  }

  for (const inbound of inboundMessages.filter((item) => item.status === "blocked")) {
    issues.push({
      code: "gateway_blocked_inbound",
      severity: "warning",
      resource_kind: "inbound_message",
      resource_id: inbound.id,
      message: inbound.error || "Gateway inbound message was blocked."
    });
  }

  for (const inbound of inboundMessages.filter((item) => item.status === "failed")) {
    issues.push({
      code: "gateway_failed_inbound",
      severity: "critical",
      resource_kind: "inbound_message",
      resource_id: inbound.id,
      message: inbound.error || "Gateway inbound message failed."
    });
  }

  for (const lock of concurrencyLocks.filter((item) => item.status === "acquired")) {
    const expired = Date.parse(lock.expires_at) <= nowMs;
    issues.push({
      code: expired ? "gateway_expired_concurrency_lock" : "gateway_active_concurrency_lock",
      severity: expired ? "critical" : "warning",
      resource_kind: "concurrency_lock",
      resource_id: lock.lock_key,
      message: expired
        ? "Gateway concurrency lock is still acquired after its expiry time."
        : "Gateway concurrency lock is currently acquired."
    });
  }

  for (const instance of sandboxInstances.filter((item) => item.status === "failed")) {
    issues.push({
      code: "gateway_failed_sandbox_instance",
      severity: "warning",
      resource_kind: "sandbox_instance",
      resource_id: instance.id,
      message: "Gateway sandbox instance is failed."
    });
  }

  for (const sync of sandboxWorkspaceSyncs.filter((item) => item.status === "failed")) {
    issues.push({
      code: "gateway_failed_sandbox_workspace_sync",
      severity: "warning",
      resource_kind: "sandbox_workspace_sync",
      resource_id: sync.id,
      message: sync.error || "Gateway sandbox workspace sync is failed."
    });
  }

  for (const policy of pairingPolicies.filter((item) => item.status === "enabled" && !enabledRoutingPolicyChannels.has(item.channel))) {
    issues.push({
      code: "gateway_pairing_policy_without_routing_policy",
      severity: "warning",
      resource_kind: "pairing_policy",
      resource_id: policy.channel,
      message: "Gateway pairing policy is enabled without a matching enabled routing policy."
    });
  }

  for (const policy of routingPolicies.filter((item) => item.status === "enabled" && !enabledPairingPolicyChannels.has(item.channel))) {
    issues.push({
      code: "gateway_routing_policy_without_pairing_policy",
      severity: "warning",
      resource_kind: "routing_policy",
      resource_id: policy.channel,
      message: "Gateway routing policy is enabled without a matching enabled pairing policy."
    });
  }

  const expiredActiveLocks = concurrencyLocks.filter((lock) => lock.status === "acquired" && Date.parse(lock.expires_at) <= nowMs);
  const hasCriticalIssue = issues.some((issue) => issue.severity === "critical");
  const recommendation = hasCriticalIssue
    ? "Fix critical Gateway issues before relying on external channel routing."
    : issues.length > 0
      ? "Review Gateway pairing, routing, inbound, lock, and sandbox warnings before expanding external channels."
      : "Gateway control-plane diagnostics are healthy.";

  return GatewayDiagnosticsReportSchema.parse({
    generated_at: nowIso(),
    total_pairings: pairings.length,
    pending_pairings: pairings.filter((item) => item.status === "pending").length,
    approved_pairings: pairings.filter((item) => item.status === "approved").length,
    pairing_policies: pairingPolicies.length,
    routing_policies: routingPolicies.length,
    inbound_messages: inboundMessages.length,
    blocked_inbound_messages: inboundMessages.filter((item) => item.status === "blocked").length,
    failed_inbound_messages: inboundMessages.filter((item) => item.status === "failed").length,
    boundary_policies: boundaryPolicies.length,
    mcp_configs: mcpConfigs.length,
    concurrency_locks: concurrencyLocks.length,
    active_concurrency_locks: concurrencyLocks.filter((item) => item.status === "acquired").length,
    expired_active_concurrency_locks: expiredActiveLocks.length,
    sandbox_instances: sandboxInstances.length,
    failed_sandbox_instances: sandboxInstances.filter((item) => item.status === "failed").length,
    sandbox_workspace_syncs: sandboxWorkspaceSyncs.length,
    failed_sandbox_workspace_syncs: sandboxWorkspaceSyncs.filter((item) => item.status === "failed").length,
    status_counts: {
      pairings: countByKey(pairings, "status"),
      pairing_policies: countByKey(pairingPolicies, "status"),
      routing_policies: countByKey(routingPolicies, "status"),
      inbound_messages: countByKey(inboundMessages, "status"),
      concurrency_locks: countByKey(concurrencyLocks, "status"),
      sandbox_instances: countByKey(sandboxInstances, "status"),
      sandbox_workspace_syncs: countByKey(sandboxWorkspaceSyncs, "status")
    },
    issues,
    recommendation
  });
}

async function knowledgeWikiDiagnosticsPayload(store: WorkspaceStore): Promise<KnowledgeWikiDiagnosticsReport> {
  const pages = await store.listWiki();
  const activePages = pages.filter((page) => page.state === "active");
  const issues: KnowledgeWikiDiagnosticsReport["issues"] = [];
  let activeWithProvenance = 0;
  let activeWithVerifiedProvenance = 0;
  let activeWithSourceRefs = 0;
  let activeEmptyPages = 0;

  for (const page of activePages) {
    const provenance = page.provenance;
    const sourceRefs = Array.isArray(page.source_refs) ? page.source_refs : [];
    const content = await store.readWikiContent(page.id).catch(() => undefined);

    if (!content?.trim()) {
      activeEmptyPages += 1;
      issues.push({
        code: "active_wiki_empty_content",
        severity: "critical",
        wiki_id: page.id,
        slug: page.slug,
        title: page.title,
        state: page.state,
        message: "Active Knowledge Wiki page has no readable markdown content."
      });
    }

    if (provenance) {
      activeWithProvenance += 1;
      if (provenance.verified) {
        activeWithVerifiedProvenance += 1;
      } else {
        issues.push({
          code: "active_wiki_unverified_provenance",
          severity: "warning",
          wiki_id: page.id,
          slug: page.slug,
          title: page.title,
          state: page.state,
          message: "Active Knowledge Wiki page has unverified provenance."
        });
      }
    } else {
      issues.push({
        code: "active_wiki_missing_provenance",
        severity: "critical",
        wiki_id: page.id,
        slug: page.slug,
        title: page.title,
        state: page.state,
        message: "Active Knowledge Wiki page is missing provenance."
      });
    }

    if (sourceRefs.length > 0) {
      activeWithSourceRefs += 1;
    } else {
      issues.push({
        code: "active_wiki_missing_source_refs",
        severity: "warning",
        wiki_id: page.id,
        slug: page.slug,
        title: page.title,
        state: page.state,
        message: "Active Knowledge Wiki page has no source refs."
      });
    }
  }

  const retrievalProbe = await store.searchWiki("", Math.max(pages.length, 1), { activeOnly: true });
  for (const page of retrievalProbe) {
    if (page.state !== "active") {
      issues.push({
        code: "active_wiki_retrieval_includes_non_active",
        severity: "critical",
        wiki_id: page.id,
        slug: page.slug,
        title: page.title,
        state: page.state,
        message: "Active Knowledge Wiki retrieval returned a non-active page."
      });
    }
  }

  const hasCriticalIssue = issues.some((issue) => issue.severity === "critical");
  const recommendation = hasCriticalIssue
    ? "Fix critical Knowledge Wiki issues before treating active pages as backend evidence."
    : issues.length > 0
      ? "Review Knowledge Wiki provenance and source refs before relying on active pages as evidence."
      : "Knowledge Wiki active retrieval is healthy.";

  return KnowledgeWikiDiagnosticsReportSchema.parse({
    generated_at: nowIso(),
    total_pages: pages.length,
    active_pages: activePages.length,
    state_counts: countByKey(pages, "state"),
    active_with_provenance: activeWithProvenance,
    active_with_verified_provenance: activeWithVerifiedProvenance,
    active_with_source_refs: activeWithSourceRefs,
    active_empty_pages: activeEmptyPages,
    issues,
    recommendation
  });
}

async function skillDiagnosticsPayload(store: WorkspaceStore): Promise<SkillDiagnosticsReport> {
  const skills = await store.listSkills();
  const selectableSkills = skills.filter((skill) => isSelectableSkillState(skill.state));
  const [skillUsage, learningUses] = await Promise.all([
    store.listSkillUsage(),
    store.listLearningResourceUses()
  ]);
  const usageBySkillId = new Map(skillUsage.map((usage) => [usage.skill_id, usage]));
  const supportedScopes = supportedSkillScopeSet();
  const issues: SkillDiagnosticsReport["issues"] = [];
  let selectableWithVerifiedProvenance = 0;
  let selectableWithSourceRefs = 0;
  let selectableWithSupportFiles = 0;
  let selectableWithUsage = 0;
  let emptySupportFiles = 0;

  for (const skill of selectableSkills) {
    const markdown = await store.readSkillMarkdown(skill.id).catch(() => undefined);
    const markdownBody = stripSkillMarkdownForDiagnostics(markdown ?? "");
    const supportFiles = await store.listSkillSupportFiles(skill.id);
    const provenanceDetail = skill.frontmatter.provenance_detail;
    const sourceRefs = skill.frontmatter.source_refs ?? [];
    const allowedScopes = skill.allowed_scopes ?? skill.frontmatter.allowed_scopes;
    const unsupportedScopes = allowedScopes.filter((scope) => !supportedScopes.has(scope));
    const usage = usageBySkillId.get(skill.id);

    if (!markdownBody.trim()) {
      issues.push({
        code: "selectable_skill_empty_markdown",
        severity: "critical",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Selectable Skill has no readable markdown body."
      });
    }

    if (provenanceDetail?.verified) {
      selectableWithVerifiedProvenance += 1;
    } else if (provenanceDetail) {
      issues.push({
        code: "selectable_skill_unverified_provenance",
        severity: "warning",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Selectable Skill has unverified provenance detail."
      });
    } else {
      issues.push({
        code: "selectable_skill_missing_provenance_detail",
        severity: "warning",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Selectable Skill is missing provenance detail."
      });
    }

    if (sourceRefs.length > 0) {
      selectableWithSourceRefs += 1;
    } else {
      issues.push({
        code: "selectable_skill_missing_source_refs",
        severity: "warning",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Selectable Skill has no source refs."
      });
    }

    if (allowedScopes.length === 0) {
      issues.push({
        code: "selectable_skill_missing_allowed_scopes",
        severity: "critical",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Selectable Skill has no allowed scopes."
      });
    }
    for (const scope of unsupportedScopes) {
      issues.push({
        code: "selectable_skill_unsupported_scope",
        severity: "critical",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: `Selectable Skill declares unsupported scope: ${scope}.`
      });
    }

    if (supportFiles.length > 0) {
      selectableWithSupportFiles += 1;
    }
    for (const file of supportFiles) {
      if (!file.content.trim()) {
        emptySupportFiles += 1;
        issues.push({
          code: "selectable_skill_empty_support_file",
          severity: "warning",
          skill_id: skill.id,
          title: skill.title,
          state: skill.state,
          message: `Selectable Skill support file is empty: ${file.path}.`
        });
      }
    }

    if (usage?.use_count && usage.use_count > 0) {
      selectableWithUsage += 1;
    } else if (skill.state === "active" || skill.state === "pinned") {
      issues.push({
        code: "selectable_skill_never_used",
        severity: "warning",
        skill_id: skill.id,
        title: skill.title,
        state: skill.state,
        message: "Active or pinned Skill has never been recorded as used."
      });
    }
  }

  const hasCriticalIssue = issues.some((issue) => issue.severity === "critical");
  const recommendation = hasCriticalIssue
    ? "Fix critical Skill issues before relying on selectable Skills in backend context."
    : issues.length > 0
      ? "Review Skill provenance, source refs, support files, and usage before expanding backend automation."
      : "Skill lifecycle diagnostics are healthy.";

  return SkillDiagnosticsReportSchema.parse({
    generated_at: nowIso(),
    total_skills: skills.length,
    selectable_skills: selectableSkills.length,
    state_counts: countByKey(skills, "state"),
    selectable_with_verified_provenance: selectableWithVerifiedProvenance,
    selectable_with_source_refs: selectableWithSourceRefs,
    selectable_with_support_files: selectableWithSupportFiles,
    selectable_with_usage: selectableWithUsage,
    selected_resource_uses: learningUses.filter((use) => use.stage === "selected").length,
    body_loaded_resource_uses: learningUses.filter((use) => use.stage === "body_loaded").length,
    support_loaded_resource_uses: learningUses.filter((use) => use.stage === "support_loaded").length,
    session_search_mode: store.getSessionSearchMode(),
    empty_support_files: emptySupportFiles,
    issues,
    recommendation
  });
}

function isSelectableSkillState(state: string): boolean {
  return state === "active" || state === "pinned" || state === "project";
}

function supportedSkillScopeSet(): Set<string> {
  return new Set([
    ...capabilityManifests.flatMap((manifest) => manifest.operations.map((operation) => operation.scope)),
    "artifact",
    "collection",
    "memory",
    "session",
    "skill",
    "workspace"
  ]);
}

function stripSkillMarkdownForDiagnostics(markdown: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown.trim();
  }
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) {
    return markdown.trim();
  }
  return markdown.slice(end + 4).trim();
}

function pluginTrustedSigningKeysFromEnv(): PluginTrustedSigningKey[] {
  const raw = process.env.SAMURAI_PLUGIN_TRUSTED_KEYS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const record = item as Record<string, unknown>;
      return typeof record.key_id === "string" && typeof record.public_key === "string"
        ? [{ key_id: record.key_id, public_key: record.public_key }]
        : [];
    });
  } catch {
    return [];
  }
}

function createTemporaryContextStore() {
  const items = new Map<string, TemporaryContextRecord>();
  const rootDir = path.join(tmpdir(), "samurai-agent", "temporary-context");
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const cleanupTimer = setInterval(() => {
    void cleanupExpired().catch(() => undefined);
  }, Math.max(60_000, Math.floor(temporaryContextTtlMs / 2)));
  cleanupTimer.unref?.();

  const cleanupExpired = async (now = Date.now()) => {
    const removals: Promise<void>[] = [];
    for (const [id, item] of items) {
      if (Date.parse(item.expires_at) > now) {
        continue;
      }
      items.delete(id);
      removals.push(rm(item.file_path, { force: true }).catch(() => {}));
    }
    await Promise.all(removals);
  };

  return {
    async save(input: TemporaryContextCreateInput): Promise<TemporaryContextRecord> {
      if (closed) {
        throw new Error("temporary_context_store_closed");
      }
      await cleanupExpired();
      const id = createId("temporary_context");
      const createdAt = nowIso();
      const expiresAt = new Date(Date.parse(createdAt) + temporaryContextTtlMs).toISOString();
      await mkdir(rootDir, { recursive: true });
      const filePath = path.join(rootDir, `${id}.png`);
      await writeFile(filePath, input.image_bytes, { flag: "wx" });
      const record: TemporaryContextRecord = {
        id,
        kind: "desktop_screenshot",
        label: input.label,
        ...(input.source_name ? { source_name: input.source_name } : {}),
        mime_type: "image/png",
        data_url: input.data_url,
        file_path: filePath,
        created_at: createdAt,
        expires_at: expiresAt,
        metadata: input.metadata
      };
      items.set(id, record);
      return record;
    },

    async resolve(ref: ResourceRef): Promise<TemporaryContextRecord | undefined> {
      if (closed) {
        return undefined;
      }
      await cleanupExpired();
      const id = temporaryContextIdFromRef(ref);
      if (!id) {
        return undefined;
      }
      const item = items.get(id);
      if (!item || Date.parse(item.expires_at) <= Date.now()) {
        if (item) {
          items.delete(id);
          void rm(item.file_path, { force: true }).catch(() => undefined);
        }
        return undefined;
      }
      return item;
    },

    async close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      clearInterval(cleanupTimer);
      const removals = Array.from(items.values()).map((item) => rm(item.file_path, { force: true }).catch(() => {}));
      items.clear();
      closePromise = Promise.all(removals).then(() => undefined);
      return closePromise;
    }
  };
}

interface TemporaryContextCreateInput {
  label: string;
  source_name?: string;
  data_url: string;
  image_bytes: Buffer;
  metadata: Record<string, JsonValue>;
}

function temporaryContextInput(value: unknown): TemporaryContextCreateInput | undefined {
  const body = isRecord(value) ? value : {};
  if (body.kind !== undefined && body.kind !== "desktop_screenshot") {
    return undefined;
  }
  const dataUrl = typeof body.data_url === "string" ? body.data_url.trim() : "";
  const imageBytes = parseTemporaryContextPngDataUrl(dataUrl);
  if (!imageBytes) {
    return undefined;
  }
  const sourceName = typeof body.source_name === "string" ? body.source_name.trim().slice(0, 160) : "";
  const label = safeTemporaryContextLabel(
    typeof body.label === "string" ? body.label : sourceName || "Desktop screenshot"
  );
  return {
    label,
    ...(sourceName ? { source_name: sourceName } : {}),
    data_url: `data:image/png;base64,${imageBytes.toString("base64")}`,
    image_bytes: imageBytes,
    metadata: jsonRecord(body.metadata)
  };
}

function parseTemporaryContextPngDataUrl(dataUrl: string): Buffer | undefined {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    return undefined;
  }
  const base64 = dataUrl.slice(prefix.length);
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return undefined;
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > temporaryContextMaxBytes) {
    return undefined;
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47];
  if (!pngSignature.every((byte, index) => bytes[index] === byte)) {
    return undefined;
  }
  return bytes;
}

function temporaryContextResponse(record: TemporaryContextRecord): TemporaryContextResponse {
  return {
    id: record.id,
    kind: "temporary_context",
    uri: `samurai://temporary-context/${encodeURIComponent(record.id)}`,
    label: record.label,
    mime_type: record.mime_type,
    created_at: record.created_at,
    expires_at: record.expires_at
  };
}

function temporaryContextIdFromRef(ref: ResourceRef): string | undefined {
  if (ref.kind !== "temporary_context") {
    return undefined;
  }
  if (ref.id) {
    return ref.id;
  }
  try {
    const parsed = new URL(ref.uri);
    if (parsed.protocol === "samurai:" && parsed.hostname === "temporary-context") {
      return parsed.pathname.split("/").filter(Boolean)[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeTemporaryContextLabel(value: string): string {
  const label = value.replace(/\s+/g, " ").trim().slice(0, 160);
  return label || "Desktop screenshot";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
}

function clientEventFromRequestBody(input: unknown): ClientEventRecord | undefined {
  const body = isRecord(input) ? input : {};
  const targetClientKind = body.target_client_kind === undefined ? "desktop" : parseClientTargetKind(body.target_client_kind);
  const eventType = parseClientEventType(body.event_type);
  const status = body.status === undefined ? "pending" : parseClientEventStatus(body.status);
  if (!targetClientKind || !eventType || !status) {
    return undefined;
  }
  const targetClientId = typeof body.target_client_id === "string" && body.target_client_id.trim()
    ? body.target_client_id.trim()
    : undefined;
  const event = {
    id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : createId("client_event"),
    target_client_kind: targetClientKind,
    ...(targetClientId ? { target_client_id: targetClientId } : {}),
    event_type: eventType,
    status,
    payload: jsonRecord(body.payload),
    resource_refs: resourceRefs(body.resource_refs),
    created_at: typeof body.created_at === "string" ? body.created_at : nowIso(),
    ...(typeof body.delivered_at === "string" ? { delivered_at: body.delivered_at } : {}),
    ...(typeof body.acked_at === "string" ? { acked_at: body.acked_at } : {}),
    ...(typeof body.expires_at === "string" ? { expires_at: body.expires_at } : {}),
    ...(typeof body.error_code === "string" ? { error_code: body.error_code } : {})
  };
  const parsed = ClientEventRecordSchema.safeParse(event);
  return parsed.success ? parsed.data : undefined;
}

async function maybeCreateClientEventFromRuntimeEvent(runtime: AgentRuntime, name: string, payload: unknown): Promise<void> {
  if (name !== "backend.run.updated" || !isRecord(payload)) {
    return;
  }
  const event = clientEventForBackendRun(payload as BackendRunRecord);
  if (!event) {
    return;
  }
  await runtime.runDomainCommand({
    command_id: "client.event.save",
    input_source: "runtime_api",
    idempotency_key: event.id,
    payload: event as unknown as Record<string, JsonValue>
  });
}

function clientEventForBackendRun(run: BackendRunRecord): ClientEventRecord | undefined {
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "waiting_for_backend_input" && run.status !== "outcome_unknown") {
    return undefined;
  }
  const createdAt = run.completed_at ?? run.started_at;
  const statusLabel = run.status === "completed" ? "完了" : run.status === "failed" ? "失敗" : run.status === "outcome_unknown" ? "結果未確認" : "確認待ち";
  const notificationKind = run.status === "completed"
    ? "backend_run_completed"
    : run.status === "failed"
      ? "backend_run_failed"
      : run.status === "outcome_unknown"
        ? "backend_run_outcome_unknown"
        : "backend_run_waiting_for_input";
  return {
    id: `client_event_${stableHash({
      kind: "backend_run_status_notification",
      run_id: run.id,
      status: run.status
    }).slice(0, 24)}`,
    target_client_kind: "desktop",
    event_type: "client.notification.requested",
    status: "pending",
    payload: {
      title: `Runが${statusLabel}しました`,
      body: summarizeClientNotificationBody(run),
      deep_link: `samurai://run/${encodeURIComponent(run.id)}`,
      notification_kind: notificationKind,
      run_id: run.id,
      session_id: run.session_id,
      backend_id: run.backend_id,
      backend_status: run.status
    },
    resource_refs: [
      {
        kind: "backend_run",
        id: run.id,
        uri: `backend-runs/${run.id}`,
        label: run.input_summary
      },
      {
        kind: "session",
        id: run.session_id,
        uri: `sessions/${run.session_id}`,
        label: "Session"
      }
    ],
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
}

function summarizeClientNotificationBody(run: BackendRunRecord): string {
  const raw = run.status === "outcome_unknown"
    ? "結果を確認できませんでした。外部処理が続いている可能性があります。自動再試行はしません。新しいTurnは開始できます。"
    : run.status === "failed"
    ? run.error_code ?? run.output_summary ?? run.input_summary
    : run.status === "waiting_for_backend_input"
      ? run.output_summary ?? "続行するには入力が必要です。"
      : run.output_summary ?? run.input_summary;
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function jsonSafe(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveIntegerOrUndefined(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
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
  policyDecision?: unknown;
  auditRecord?: unknown;
  rollbackPoint?: unknown;
  activity: unknown;
}) {
  return {
    resource: result.resource,
    operation: result.operation,
    ...(result.policyDecision ? { policyDecision: result.policyDecision } : {}),
    ...(result.auditRecord ? { auditRecord: result.auditRecord } : {}),
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity
  };
}

function archiveMemoryPayload(result: Awaited<ReturnType<AgentRuntime["archiveMemory"]>>) {
  return {
    memory: result.memory,
    content: result.content,
    operation: result.operation,
    ...(result.auditRecord ? { auditRecord: result.auditRecord } : {}),
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity,
    changed: result.changed,
    ...(result.warning ? { warning: result.warning } : {})
  };
}

function runtimeErrorPayload(payload: NonNullable<RuntimeRequestError["payload"]>) {
  if ("replacement" in payload) return payload;
  if ("conflict" in payload) {
    return payload;
  }
  if ("backendRun" in payload) {
    return {
      session: payload.session,
      messages: payload.messages,
      backendRun: payload.backendRun,
      backendEvents: payload.backendEvents,
      workspaceChanges: payload.workspaceChanges
    };
  }
  return archiveMemoryPayload(payload);
}

function buildSessionResumeState(transcript: SessionTranscriptExport) {
  const runs = [...transcript.backend_runs].sort(compareBackendRunDesc);
  const latestRun = runs[0];
  const resumableRuns = runs.filter((run) => run.status === "waiting_for_backend_input");
  const eventsByRunId = new Map<string, BackendEventRecord[]>();
  for (const event of transcript.backend_events) {
    const events = eventsByRunId.get(event.run_id) ?? [];
    events.push(event);
    eventsByRunId.set(event.run_id, events);
  }
  const runSummary = (run: BackendRunRecord) => summarizeRunForResume(run, eventsByRunId.get(run.id) ?? []);
  return {
    session: transcript.session,
    can_resume: resumableRuns.length > 0,
    next_required_action: resumableRuns.length > 0 ? "submit_backend_native_input" : "none",
    resume_api: "/api/backend-runs/:runId/resume",
    latest_run: latestRun ? runSummary(latestRun) : undefined,
    resumable_runs: resumableRuns.map(runSummary),
    transcript_counts: {
      messages: transcript.messages.length,
      operations: transcript.operations.length,
      backend_runs: transcript.backend_runs.length,
      backend_events: transcript.backend_events.length,
      tool_runs: transcript.tool_runs.length,
      workspace_changes: transcript.workspace_changes.length,
      artifacts: transcript.artifacts.length,
      policy_decisions: transcript.policy_decisions.length,
      audit_records: transcript.audit_records.length
    }
  };
}

function summarizeRunForResume(run: BackendRunRecord, events: BackendEventRecord[]) {
  const orderedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
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
          event_type: lastEvent.event_type,
          sequence: lastEvent.sequence,
          created_at: lastEvent.created_at
        }
      : undefined
  };
}

function compareBackendRunDesc(left: BackendRunRecord, right: BackendRunRecord): number {
  return right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id);
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
    ...(error.payload ? redactApiObject(runtimeErrorPayload(error.payload)) : {})
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
  return redactSecretLikeString(value).slice(0, 80);
}

function redactApiObject<T>(value: T): T {
  return redactApiValue(value) as T;
}

function redactApiValue(value: unknown, key?: string): unknown {
  if (key && isSecretLikeApiKey(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return redactSecretLikeString(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactApiValue(entry));
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactApiValue(entry, entryKey)]));
  }
  return undefined;
}

function isSecretLikeApiKey(key: string): boolean {
  return /secret|token|api[_-]?key|password|credential|authorization|cookie/i.test(key);
}

function redactSecretLikeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bkey\s*=\s*["']?[^"',\s}]+/gi, "key=[redacted]")
    .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b(?=[A-Za-z0-9.-]*(?:secret|token|password|credential))(?=[A-Za-z0-9.-]*[-.])[A-Za-z0-9.-]{12,}\b/gi, "[redacted]");
}

function redactErrorForLog(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecretLikeString(error.message),
      stack: error.stack ? redactSecretLikeString(error.stack) : undefined
    };
  }
  if (typeof error === "string") {
    return redactSecretLikeString(error);
  }
  return redactApiValue(error);
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

function buildBackendReleaseReadinessHealth() {
  const manualGates = [
    {
      id: "external-backend-run-resume",
      label: "External backend run/resume",
      status: "manual_opt_in_required",
      effect: "authenticated_external_service",
      reason: "Requires explicit confirmation because it may use authenticated external services, network, and provider quota.",
      command: "pnpm run backend:external:verify -- --run --confirm-external-effects --resume --require-configured --backend <id>",
      confirmation_flag: "--confirm-external-effects",
      runbook: "plans/backend-external-e2e-runbook.md"
    },
    {
      id: "external-sandbox-run",
      label: "External sandbox run",
      status: "manual_opt_in_required",
      effect: "external_sandbox",
      reason: "Docker, SSH, and remote sandbox runs can create remote or container side effects.",
      command: "pnpm run sandbox:verify -- --run --confirm-external-effects --backend docker|ssh|remote",
      confirmation_flag: "--confirm-external-effects",
      runbook: "plans/backend-external-e2e-runbook.md"
    },
    {
      id: "external-channel-service-e2e",
      label: "External channel service E2E",
      status: "manual_opt_in_required",
      effect: "external_channel_service",
      reason: "Requires real Slack, Telegram, LINE, or Email provider credentials and may send or receive live messages.",
      command: "manual: run the channel service E2E checklist in plans/backend-external-e2e-runbook.md",
      confirmation_flag: "--confirm-external-effects",
      runbook: "plans/backend-external-e2e-runbook.md"
    }
  ];
  return BackendReleaseReadinessHealthSchema.parse({
    non_destructive: {
      status: "available",
      command: "CI=true pnpm run backend:release:verify -- --json"
    },
    external_effects_confirmed: false,
    manual_gate_count: manualGates.length,
    manual_gates: manualGates,
    profiles: backendReleaseProfiles(manualGates)
  });
}

function backendReleaseProfiles(manualGates: Array<{ id: string }>) {
  const nonDestructiveGateIds = [
    "typecheck",
    "full-tests",
    "i18n-check",
    "web-build",
    "doctor",
    "doctor-syntax",
    "public-naming-scan",
    "external-channel-probe",
    "external-backend-probe",
    "sandbox-capabilities",
    "sandbox-host-run"
  ];
  return [
    {
      id: "local_oss",
      label: "Local OSS Release",
      status: "available",
      non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
      required_gate_ids: nonDestructiveGateIds,
      manual_gate_ids: [],
      runbook: "plans/backend-external-e2e-runbook.md",
      notes: [
        "No authenticated external service calls are started by this profile.",
        "Use this before publishing local backend changes or opening a release PR."
      ]
    },
    {
      id: "production_ops",
      label: "Production Operations",
      status: "manual_opt_in_required",
      non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
      required_gate_ids: nonDestructiveGateIds,
      manual_gate_ids: manualGates.map((gate) => gate.id),
      runbook: "plans/backend-external-e2e-runbook.md",
      notes: [
        "Run the manual gates only after credentials, quotas, remote targets, and message side effects are approved.",
        "The health API lists this profile but does not start authenticated external runs by itself."
      ]
    }
  ];
}

function toolRunDiagnosticsPayload(report: ToolRunDiagnosticsReport): ToolRunDiagnosticsReport {
  return {
    ...report,
    adapter_recommendations: report.groups.map(toolRunAdapterRecommendation)
  };
}

function toolRunAdapterRecommendation(group: ToolRunDiagnosticsGroup): NonNullable<ToolRunDiagnosticsReport["adapter_recommendations"]>[number] {
  const providerCommand = getDomainCommandForProviderToolName(group.provider_tool_name);
  const actionCommand = group.action_id ? listDomainCommandEntries().find((entry) => entry.id === group.action_id) : undefined;
  const command = providerCommand ?? actionCommand;
  const mappingStatus = providerCommand
    ? "mapped_provider_tool"
    : actionCommand
      ? "action_id_only"
      : "unmapped_provider_tool";
  const suggestedNextStep = providerCommand
    ? group.status === "failed" ? "inspect_failed_domain_command" : "route_through_domain_command"
    : "add_provider_tool_mapping";
  return {
    provider_tool_name: group.provider_tool_name,
    ...(group.action_id ? { action_id: group.action_id } : {}),
    status: group.status,
    count: group.count,
    mapping_status: mappingStatus,
    ...(command ? { domain_command_id: command.id } : {}),
    suggested_next_step: suggestedNextStep,
    reason: toolRunAdapterRecommendationReason(group, mappingStatus, suggestedNextStep, command?.id)
  };
}

function toolRunAdapterRecommendationReason(
  group: ToolRunDiagnosticsGroup,
  mappingStatus: "mapped_provider_tool" | "action_id_only" | "unmapped_provider_tool",
  suggestedNextStep: "route_through_domain_command" | "add_provider_tool_mapping" | "inspect_failed_domain_command",
  domainCommandId?: string
): string {
  if (mappingStatus === "mapped_provider_tool") {
    return suggestedNextStep === "inspect_failed_domain_command"
      ? `Provider tool is mapped to ${domainCommandId}; inspect the failed Domain Command execution path.`
      : `Provider tool is mapped to ${domainCommandId}; ensure this call is routed through AgentRuntime.runDomainCommand().`;
  }
  if (mappingStatus === "action_id_only") {
    return `Action id ${domainCommandId} exists, but provider tool ${group.provider_tool_name} is not registered as an alias. Add a provider_tool_names mapping or update the adapter to emit the canonical tool name.`;
  }
  return `Provider tool ${group.provider_tool_name} is not mapped to a Domain Command. Add an adapter mapping before retrying this tool automatically.`;
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
      reason: error instanceof Error ? redactSecretLikeString(error.message) : "unknown"
    };
  }
}

type WorkspaceReadinessInspection =
  | { status: "ok"; snapshot: WorkspaceReadinessSnapshot; duration_ms: number }
  | { status: "timeout"; timeout_ms: number; duration_ms: number }
  | { status: "failed"; message: string; duration_ms: number };

interface WorkspaceReadinessSnapshot {
  wiki: {
    indexed: number;
    active: number;
  };
  artifacts: {
    indexed: number;
  };
  memory: {
    indexed: number;
  };
  skills: {
    indexed: number;
  };
  collections: {
    schemas: {
      indexed: number;
    };
    records: {
      indexed: number;
    };
  };
}

async function inspectWorkspaceForReadiness(store: WorkspaceStore): Promise<WorkspaceReadinessInspection> {
  const timeoutMs = workspaceHealthReadinessTimeoutMs();
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const inspection = workspaceReadinessSnapshot(store)
    .then((snapshot): WorkspaceReadinessInspection => ({
      status: "ok",
      snapshot,
      duration_ms: Date.now() - startedAt
    }))
    .catch((error): WorkspaceReadinessInspection => ({
      status: "failed",
      message: error instanceof Error ? redactSecretLikeString(error.message) : "unknown",
      duration_ms: Date.now() - startedAt
    }));

  const timeoutInspection = new Promise<WorkspaceReadinessInspection>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: "timeout",
        timeout_ms: timeoutMs,
        duration_ms: Date.now() - startedAt
      });
    }, timeoutMs);
    timeout.unref?.();
  });

  const result = await Promise.race([inspection, timeoutInspection]);
  if (result.status !== "timeout" && timeout) {
    clearTimeout(timeout);
  }
  return result;
}

function workspaceHealthReadinessTimeoutMs(): number {
  const configured = Number(process.env.SAMURAI_HEALTH_WORKSPACE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : defaultWorkspaceHealthReadinessTimeoutMs;
}

function workspaceHealthReadinessPayload(inspection: WorkspaceReadinessInspection) {
  if (inspection.status !== "ok") {
    return {
      ok: false,
      status: inspection.status,
      duration_ms: inspection.duration_ms,
      ...(inspection.status === "timeout"
        ? {
          timed_out: true,
          timeout_ms: inspection.timeout_ms,
          reason: "workspace_health_timeout"
        }
        : {
          reason: inspection.message
        })
    };
  }

  const snapshot = inspection.snapshot;
  return {
    ok: true,
    status: "ok",
    source: "sqlite_index",
    duration_ms: inspection.duration_ms,
    full_inspection: "/api/workspace/health",
    wiki: {
      indexed: snapshot.wiki.indexed,
      active: snapshot.wiki.active
    },
    artifacts: {
      indexed: snapshot.artifacts.indexed
    },
    memory: {
      indexed: snapshot.memory.indexed
    },
    skills: {
      indexed: snapshot.skills.indexed
    },
    collections: {
      schemas: {
        indexed: snapshot.collections.schemas.indexed
      },
      records: {
        indexed: snapshot.collections.records.indexed
      }
    }
  };
}

async function workspaceReadinessSnapshot(store: WorkspaceStore): Promise<WorkspaceReadinessSnapshot> {
  const [wiki, activeWiki, artifacts, memory, skills, collectionSchemas, collectionRecords] = await Promise.all([
    store.listWiki(),
    store.listWiki({ activeOnly: true }),
    store.listArtifacts(),
    store.listMemory({ includeArchived: true }),
    store.listSkills(),
    store.listCollectionSchemas(),
    store.listCollectionRecords()
  ]);

  return {
    wiki: {
      indexed: wiki.length,
      active: activeWiki.length
    },
    artifacts: {
      indexed: artifacts.length
    },
    memory: {
      indexed: memory.length
    },
    skills: {
      indexed: skills.length
    },
    collections: {
      schemas: {
        indexed: collectionSchemas.length
      },
      records: {
        indexed: collectionRecords.length
      }
    }
  };
}

function generatedSurfaceAssetContentType(assetPath: string): string {
  const extension = assetPath.toLowerCase().split(".").pop();
  return extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "gif" ? "image/gif"
        : extension === "webp" ? "image/webp"
          : extension === "svg" ? "image/svg+xml"
            : extension === "css" ? "text/css"
              : "application/octet-stream";
}

function generatedSurfaceDocument(bundle: { html: string; css?: string; script?: string }, actions: Array<{ id: string }> = []): string {
  const bridge = JSON.stringify({ actions: actions.map((action) => action.id) }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${bundle.css ?? ""}</style></head><body>${bundle.html}<script>${bundle.script ?? ""}</script><script>window.samuraiGeneratedSurface=${bridge};window.dispatchSamuraiAction=function(actionId,payload){window.parent.postMessage({type:"samurai.generated_surface.action",action_id:actionId,payload:payload||{}},"*")};</script></body></html>`;
}

function createStoredZip(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralData, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("vitest")));
if (!isTestRuntime && import.meta.url === entry) {
  startServer().catch((error) => {
    console.error(redactErrorForLog(error));
    process.exitCode = 1;
  });
}
