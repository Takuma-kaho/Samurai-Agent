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
      if (!config.initialAdminId || !config.initialAdminPublicKey || !config.selfHostWorkspaceId) {
        throw new WorkspaceServerError("samurai_initial_admin_identity_required_for_self_host", 500);
      }
      if (config.selfHostBootstrapMode === "create") {
        await store.ensureInitialSelfHostedWorkspace({
          workspaceId: config.selfHostWorkspaceId,
          ownerAccountId: config.initialAdminId,
          ownerPublicKey: config.initialAdminPublicKey,
          ownerDisplayName: config.initialAdminDisplayName
        });
      } else {
        await store.registerAccount({
          id: config.initialAdminId,
          publicKey: config.initialAdminPublicKey,
          displayName: config.initialAdminDisplayName
        });
      }
    }
    await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
    const files = new WorkspaceFileStore(store);
    // Hosted recovery is explicitly invoked for one Workspace through the
    // short-lived CLI. The running Server must not enumerate Workspaces with
    // an admin connection. Self-host has one pinned Workspace and recovers it
    // through its normal RLS-scoped Account context.
    if (config.mode === "self_host" && config.selfHostWorkspaceId && config.initialAdminId) {
      const recovery = await files.recover({ workspaceId: config.selfHostWorkspaceId, accountId: config.initialAdminId });
      if (recovery.failed.length > 0) {
        throw new WorkspaceServerError("workspace_file_recovery_required", 503);
      }
    }
    const bundles = new WorkspaceBundleV3Service(store);
    const completion = new WorkspaceCompletionService(store, undefined, options.attestationPort);
    const completionBundles = new WorkspaceBundleV4Service(store);
    if (config.mode === "self_host" && config.selfHostWorkspaceId && config.initialAdminId) {
      const recovery = await completion.recoverFileBatches({ workspaceId: config.selfHostWorkspaceId, accountId: config.initialAdminId });
      if (recovery.failed.length > 0) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503);
    }
    const learning = new WorkspaceLearningService(store);
    const completionJobs = new WorkspaceCompletionJobService(completion);
    const curator = new WorkspaceCompletionCuratorService(completion);
    const maintenance = new WorkspaceCompletionMaintenanceService(completion, completionJobs, curator);
    const completionMigrations = new WorkspaceCompletionMigrationService(completion);
    const commands = new WorkspaceServerCommandService({ store, files, bundles, completion, completionMigrations, maintenance });
    return {
      config,
      database,
      store,
      files,
      bundles,
      completionBundles,
      commands,
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
