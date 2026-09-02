import { mkdir } from "node:fs/promises";
import {
  PostgresWorkspaceDatabase,
  WorkspaceBundleV3Service,
  WorkspaceBundleV4Service,
  WorkspaceCompletionCuratorService,
  WorkspaceCompletionJobService,
  WorkspaceCompletionMaintenanceService,
  WorkspaceCompletionMigrationService,
  WorkspaceCompletionService,
  WorkspaceFileStore,
  WorkspaceLearningService,
  WorkspaceLearningWorker,
  WorkspaceServerCommandService,
  WorkspaceServerError,
  WorkspaceServerStore,
  WorkspaceRuntimeActivityService,
  loadWorkspaceServerConfig,
  type WorkspaceCompletionAttestationPort,
  type WorkspaceKnowledgeReviewPort,
  type WorkspaceServerConfig
} from "@samurai-agent/workspace-server";

export interface WorkspaceServerCore {
  config: WorkspaceServerConfig;
  database: PostgresWorkspaceDatabase;
  store: WorkspaceServerStore;
  files: WorkspaceFileStore;
  bundles: WorkspaceBundleV3Service;
  completionBundles: WorkspaceBundleV4Service;
  commands: WorkspaceServerCommandService;
  runtimeActivities: WorkspaceRuntimeActivityService;
  learning: WorkspaceLearningService;
  completion: WorkspaceCompletionService;
  completionJobs: WorkspaceCompletionJobService;
  curator: WorkspaceCompletionCuratorService;
  maintenance: WorkspaceCompletionMaintenanceService;
  completionMigrations: WorkspaceCompletionMigrationService;
  /** The host process chooses a Backend cassette; this Core never passes DB or
   * file capabilities to it. */
  createLearningWorker(reviewPort: WorkspaceKnowledgeReviewPort): WorkspaceLearningWorker;
  close(): Promise<void>;
}

export interface WorkspaceServerCoreOptions {
  /** A process-owned verification cassette, never transport configuration. */
  attestationPort?: WorkspaceCompletionAttestationPort;
}

export async function createWorkspaceServerCore(
  config = loadWorkspaceServerConfig(),
  options: WorkspaceServerCoreOptions = {}
): Promise<WorkspaceServerCore> {
  const database = new PostgresWorkspaceDatabase({
    databaseUrl: config.databaseUrl,
    runtimeRole: config.databaseRuntimeRole
  });
  try {
    await database.assertReady();
    const store = new WorkspaceServerStore({
      database,
      mode: config.mode,
      ...(config.selfHostWorkspaceId ? { selfHostWorkspaceId: config.selfHostWorkspaceId } : {}),
      ...(config.initialAdminId ? { selfHostInitialAdminId: config.initialAdminId } : {}),
      storageRoot: config.storageRoot,
      invitationTokenSecret: config.invitationTokenSecret
    });
    if (config.mode === "self_host") {
      // The initial Account is optional for an already provisioned server.
      // When supplied, registering it also lets the Organization layer ensure
      // its normal Organization.  The legacy Workspace ID is consulted only
      // for one-time bootstrap of old deployments; it is never a runtime
      // routing or recovery boundary.
      if (config.initialAdminId && config.initialAdminPublicKey && config.selfHostWorkspaceId && config.selfHostBootstrapMode === "create") {
        await store.ensureInitialSelfHostedWorkspace({
          workspaceId: config.selfHostWorkspaceId,
          ownerAccountId: config.initialAdminId,
          ownerPublicKey: config.initialAdminPublicKey,
          ownerDisplayName: config.initialAdminDisplayName
        });
      } else if (config.initialAdminId && config.initialAdminPublicKey) {
        await store.registerAccount({
          id: config.initialAdminId,
          publicKey: config.initialAdminPublicKey,
          displayName: config.initialAdminDisplayName
        });
      }
    }
    await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
    const files = new WorkspaceFileStore(store);
    const bundles = new WorkspaceBundleV3Service(store);
    const completion = new WorkspaceCompletionService(store, undefined, options.attestationPort);
    const completionBundles = new WorkspaceBundleV4Service(store);
    // Recovery is a server-side maintenance action. Enumerate every active
    // Workspace through the store's tenant-aware API and run each recovery in
    // its own RLS context. Do not return transaction/batch IDs or client data.
    if (config.mode === "self_host") {
      await recoverActiveSelfHostedWorkspaces(store, files, completion, config.initialAdminId);
    }
    const learning = new WorkspaceLearningService(store);
    const completionJobs = new WorkspaceCompletionJobService(completion);
    const curator = new WorkspaceCompletionCuratorService(completion);
    const maintenance = new WorkspaceCompletionMaintenanceService(completion, completionJobs, curator);
    const completionMigrations = new WorkspaceCompletionMigrationService(completion);
    const runtimeActivities = new WorkspaceRuntimeActivityService(database);
    const commands = new WorkspaceServerCommandService({ store, files, bundles, completionBundles, completion, completionMigrations, maintenance, runtimeActivities });
    return {
      config,
      database,
      store,
      files,
      bundles,
      completionBundles,
      commands,
      runtimeActivities,
      learning,
      completion,
      completionJobs,
      curator,
      maintenance,
      completionMigrations,
      createLearningWorker: (reviewPort) => new WorkspaceLearningWorker(learning, reviewPort),
      close: () => database.close()
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

type WorkspaceStoreRecoveryApi = WorkspaceServerStore & {
  listActiveWorkspaceIds?: (accountId?: string) => Promise<unknown>;
};

interface RecoveryWorkspace {
  workspaceId: string;
  /** A tenant-local recovery identity, when the store can provide one. */
  accountId?: string;
}

async function recoverActiveSelfHostedWorkspaces(
  store: WorkspaceServerStore,
  files: WorkspaceFileStore,
  completion: WorkspaceCompletionService,
  fallbackAccountId?: string
): Promise<void> {
  const workspaces = await activeWorkspaces(store, fallbackAccountId);
  let failures = 0;
  for (const workspace of workspaces) {
    const accountId = workspace.accountId ?? fallbackAccountId;
    // A worker-backed store should return a tenant-local identity for every
    // Workspace. If it cannot, do not guess an Account and accidentally run
    // recovery under another tenant's RLS context.
    if (!accountId) {
      failures += 1;
      continue;
    }
    try {
      const recovery = await files.recover({ workspaceId: workspace.workspaceId, accountId });
      if (recovery.failed.length > 0) failures += 1;
    } catch {
      failures += 1;
    }
    try {
      const recovery = await completion.recoverFileBatches({ workspaceId: workspace.workspaceId, accountId });
      if (recovery.failed.length > 0) failures += 1;
    } catch {
      failures += 1;
    }
  }
  if (failures > 0) {
    throw new WorkspaceServerError("workspace_recovery_required", 503);
  }
}

async function activeWorkspaces(store: WorkspaceServerStore, fallbackAccountId?: string): Promise<RecoveryWorkspace[]> {
  const recoveryStore = store as WorkspaceStoreRecoveryApi;
  const listActiveWorkspaceIds = recoveryStore.listActiveWorkspaceIds;
  const workerListing = typeof listActiveWorkspaceIds === "function";
  const listed = workerListing
    // The worker API must enumerate tenants without a client-provided scope.
    // Its optional argument remains for compatibility with an early store
    // implementation that accepted the bootstrap Account as a hint.
    ? await listActiveWorkspaceIds!()
    : fallbackAccountId ? await store.listWorkspaces(fallbackAccountId) : [];
  const rows: unknown[] = Array.isArray(listed) ? listed as unknown[] : [];
  const workspaces = rows.map((value): RecoveryWorkspace | undefined => {
    if (typeof value === "string") {
      const workspaceId = value.trim();
      return workspaceId
        ? { workspaceId, ...(!workerListing && fallbackAccountId ? { accountId: fallbackAccountId } : {}) }
        : undefined;
    }
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as { id?: unknown; workspaceId?: unknown; workspace_id?: unknown; accountId?: unknown; account_id?: unknown };
    const workspaceId = typeof candidate.workspaceId === "string"
      ? candidate.workspaceId.trim()
      : typeof candidate.workspace_id === "string"
        ? candidate.workspace_id.trim()
        : typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!workspaceId) return undefined;
    const accountId = typeof candidate.accountId === "string"
      ? candidate.accountId.trim()
      : typeof candidate.account_id === "string"
        ? candidate.account_id.trim()
        : workerListing ? undefined : fallbackAccountId;
    return { workspaceId, ...(accountId ? { accountId } : {}) };
  }).filter((value): value is RecoveryWorkspace => Boolean(value));
  const unique = new Map<string, RecoveryWorkspace>();
  for (const workspace of workspaces) unique.set(workspace.workspaceId, workspace);
  return [...unique.values()];
}
