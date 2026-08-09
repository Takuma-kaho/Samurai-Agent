export * from "./profile-registry";
export * from "./workspace-store-contracts";
export { WorkspaceSimulatedCrashError } from "./transactions/workspace-file-transaction-coordinator";
export { ensureWorkspaceLayout } from "./kernel/workspace-paths";
export { renderFrontmatter } from "./repositories/workspace-file-codecs";
export { CollectionRecordVersionConflictError } from "./repositories/collection-errors";
export type {
  AgentWorkspacePermissionRecord,
  ResourceAccessBoundaryRecord,
  RoomAgentPermissionRecord,
  RoomMemberRecord,
  RoomResourceShareRecord,
  WorkspaceMemberRecord
} from "./repositories/room-permission-repository";

import { defaultSettings, type BackendRunRecord, type RoomRecord } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceBundleService } from "./backup/workspace-bundle-service";
import { WorkspaceKernelService } from "./kernel/workspace-kernel-service";
import { WorkspacePaths } from "./kernel/workspace-paths";
import { AccessHistoryRepository } from "./repositories/access-history-repository";
import { ActivityHistoryRepository } from "./repositories/activity-history-repository";
import { ArtifactRepository } from "./repositories/artifact-repository";
import { AutomationRepository } from "./repositories/automation-repository";
import { ClientEventQueueRepository } from "./repositories/client-event-queue-repository";
import { CollectionRepository } from "./repositories/collection-repository";
import { DurableWorkRepository } from "./repositories/durable-work-repository";
import { GatewayRepository } from "./repositories/gateway-repository";
import { GeneratedSurfaceRepository } from "./repositories/generated-surface-repository";
import { KnowledgeWikiRepository } from "./repositories/knowledge-wiki-repository";
import { LearningRepository } from "./repositories/learning-repository";
import { ManagedResourceSynchronizer } from "./repositories/managed-resource-synchronizer";
import { MemoryRepository } from "./repositories/memory-repository";
import { RoomAgentRepository } from "./repositories/room-agent-repository";
import { RoomPermissionRepository } from "./repositories/room-permission-repository";
import { SessionExecutionRepository } from "./repositories/session-execution-repository";
import { SkillRepository } from "./repositories/skill-repository";
import { WorkspaceMetadataRepository } from "./repositories/workspace-metadata-repository";
import { WorkspaceJobRepository } from "./repositories/workspace-job-repository";
import { ManagedResourcePostTurnService } from "./services/managed-resource-post-turn-service";
import { WorkspaceMaintenanceGuard } from "./services/workspace-maintenance-guard";
import { WorkspaceMaintenanceService } from "./services/workspace-maintenance-service";
import { WorkspaceQueryService } from "./services/workspace-query-service";
import { WorkspaceRestoreCoordinator } from "./restore/workspace-restore-coordinator";
import type { Core02SettlementInput, WorkspaceStoreOptions } from "./workspace-store-contracts";

interface WorkspaceComposition {
  session: SessionExecutionRepository;
  clientEvents: ClientEventQueueRepository;
  durableWork: DurableWorkRepository;
  artifacts: ArtifactRepository;
  surfaces: GeneratedSurfaceRepository;
  memory: MemoryRepository;
  wiki: KnowledgeWikiRepository;
  skills: SkillRepository;
  learning: LearningRepository;
  collections: CollectionRepository;
  automation: AutomationRepository;
  gateway: GatewayRepository;
  metadata: WorkspaceMetadataRepository;
  roomAgent: RoomAgentRepository;
  roomPermissions: RoomPermissionRepository;
  accessHistory: AccessHistoryRepository;
  activityHistory: ActivityHistoryRepository;
  workspaceJobs: WorkspaceJobRepository;
  managedResources: ManagedResourceSynchronizer;
  queries: WorkspaceQueryService;
  bundles: WorkspaceBundleService;
  restore: WorkspaceRestoreCoordinator;
  maintenance: WorkspaceMaintenanceService;
  postTurn: ManagedResourcePostTurnService;
}

/**
 * Compatibility façade for existing WorkspaceStore callers.
 *
 * It owns lifecycle and explicit API delegation only. Resource persistence is
 * implemented in the repository that owns its tables and filesystem paths.
 */
export class WorkspaceStore {
  readonly rootDir: string;
  readonly dbPath: string;

  private readonly kernel: WorkspaceKernelService;
  private readonly restoreFailureInjector: WorkspaceStoreOptions["restoreFailureInjector"];
  private readonly maintenanceGuard = new WorkspaceMaintenanceGuard();
  private composition!: WorkspaceComposition;

  constructor(options: WorkspaceStoreOptions) {
    if (WorkspaceRestoreCoordinator.hasPendingRestoreJournal(options.rootDir)) {
      throw new Error("workspace_restore_recovery_required");
    }
    this.kernel = new WorkspaceKernelService(options.rootDir, options.fileTransactionFailureInjector);
    this.rootDir = this.kernel.rootDir;
    this.dbPath = this.kernel.dbPath;
    this.restoreFailureInjector = options.restoreFailureInjector;
    this.rebuildComposition();
  }

  static async create(options: WorkspaceStoreOptions): Promise<WorkspaceStore> {
    await WorkspaceRestoreCoordinator.recoverInterruptedWorkspaceRestore(options.rootDir);
    await WorkspaceBundleService.cleanupIncompleteStages(options.rootDir);
    await new WorkspacePaths(options.rootDir).ensureWorkspaceLayout();
    const store = new WorkspaceStore(options);
    try {
      await store.initializeOpenWorkspace();
      return store;
    } catch (error) {
      await store.kernel.close().catch(() => undefined);
      throw error;
    }
  }

  /** The only terminal write API; filesystem indexing remains outside its transaction. */
  async commitTurnSettlement(input: Core02SettlementInput): Promise<BackendRunRecord> {
    const settled = await this.composition.session.commitTurnSettlement(input);
    await this.composition.postTurn.synchronizeAfterSettlement(settled, input);
    return settled;
  }

  async ensureDefaultSettings(): Promise<void> {
    await this.ensureDefaultRoomAccess();
  }

  private async ensureDefaultRoomAccess(): Promise<void> {
    await this.composition.metadata.ensureDefaultSettings(defaultSettings());
    const settings = await this.composition.metadata.getSettings();
    const { room, agent, createdRoom, createdAgent } = await this.composition.roomAgent.ensureDefaults(settings, {
      createRoomWithOwner: (room) => this.composition.roomPermissions.createRoomWithOwner(room, localOwnerParticipantId)
    });
    // Migration 009 seeds existing Workspaces once.  On later opens we do not
    // scan or repair Room ownership; only a newly-created default pair gets
    // its explicit initial Agent permission here.
    if (createdRoom || createdAgent) {
      await this.composition.roomPermissions.grantInitialDefaultAgentAccess({
        roomId: room.id,
        agentId: agent.id,
        ownerParticipantId: localOwnerParticipantId
      });
    }
  }

  async synchronizeManagedResources(): ReturnType<ManagedResourceSynchronizer["synchronizeAll"]> {
    return this.composition.managedResources.synchronizeAll();
  }

  async reindexMemory() {
    return this.composition.managedResources.synchronizeMemory();
  }

  async reindexWiki() {
    return this.composition.managedResources.synchronizeWiki();
  }

  async reindexSkills() {
    return this.composition.managedResources.synchronizeSkills();
  }

  async reindexCollections() {
    return this.composition.managedResources.synchronizeCollections();
  }

  private async initializeOpenWorkspace(): Promise<void> {
    await this.kernel.migrate();
    await this.kernel.recoverWorkspaceFileTransactions();
    await this.ensureDefaultRoomAccess();
    await this.composition.managedResources.synchronizeAll();
    await this.composition.queries.initializeSessionSearch();
  }

  private async initializeRestoreStage(stageRoot: string): Promise<void> {
    const stagedStore = await WorkspaceStore.create({ rootDir: stageRoot });
    try {
      await stagedStore.close();
    } catch (error) {
      await stagedStore.close().catch(() => undefined);
      throw error;
    }
  }

  private async restartCurrentWorkspace(): Promise<void> {
    this.rebuildComposition();
    await this.initializeOpenWorkspace();
  }

  private rebuildComposition(): void {
    const db = this.kernel.db;
    const session = new SessionExecutionRepository(db, this.rootDir, this.kernel.sessionSearchIndex);
    const clientEvents = new ClientEventQueueRepository(db);
    const durableWork = new DurableWorkRepository(db);
    const artifacts = new ArtifactRepository(db, this.rootDir, {
      getOperation: (operationId) => session.getOperation(operationId),
      upsert: (entry) => this.kernel.sessionSearchIndex.upsert(entry)
    });
    const surfaces = new GeneratedSurfaceRepository(db, this.rootDir);
    const memory = new MemoryRepository(db, this.rootDir, {
      listMessages: (sessionId) => session.listMessages(sessionId)
    });
    const wiki = new KnowledgeWikiRepository(db, this.rootDir);
    const skills = new SkillRepository(db, this.rootDir);
    const automation = new AutomationRepository(db);
    const gateway = new GatewayRepository(db);
    const metadata = new WorkspaceMetadataRepository(db);
    const roomAgent = new RoomAgentRepository(db);
    const roomPermissions = new RoomPermissionRepository(db);
    const accessHistory = new AccessHistoryRepository(db, this.rootDir);
    const activityHistory = new ActivityHistoryRepository(db);
    const workspaceJobs = new WorkspaceJobRepository(db, activityHistory);
    const collections = new CollectionRepository(
      db,
      this.rootDir,
      this.kernel.fileTransactions,
      this.kernel.collectionRecordRecoveryHandler,
      { listAutomationJobs: (input) => automation.listAutomationJobs(input) }
    );
    const managedResources = new ManagedResourceSynchronizer(memory, wiki, skills, collections);
    const learning = new LearningRepository(
      db,
      this.rootDir,
      {
        listMemory: (options) => memory.listMemory(options),
        listSkills: (options) => skills.listSkills(options),
        listWiki: (options) => wiki.listWiki(options),
        listSkillUsage: (input) => skills.listSkillUsage(input),
        listSkillSupportFiles: (skillId) => skills.listSkillSupportFiles(skillId),
        synchronizeManagedResources: () => managedResources.synchronizeAll()
      },
      { deleteWorkspaceChangesBySummaryLike: (summaryPattern) => session.deleteWorkspaceChangesBySummaryLike(summaryPattern) }
    );
    const queries = new WorkspaceQueryService(
      this.kernel.sessionSearchIndex,
      session,
      artifacts,
      memory,
      wiki,
      skills,
      collections,
      accessHistory,
      durableWork,
      learning
    );
    const bundles = new WorkspaceBundleService(this.kernel, {
      inspectWorkspace: () => this.composition.maintenance.inspectWorkspace(),
      restoreImportedBundle: (backupId) => this.composition.restore.restoreWorkspaceBackup(backupId)
    });
    const restore = new WorkspaceRestoreCoordinator(
      this.kernel,
      bundles,
      {
        initializeStage: (stageRoot) => this.initializeRestoreStage(stageRoot),
        restartCurrentWorkspace: () => this.restartCurrentWorkspace(),
        inspectWorkspace: () => this.composition.maintenance.inspectWorkspace(),
        checkIntegrity: () => this.composition.maintenance.checkIntegrity()
      },
      this.restoreFailureInjector
    );
    const maintenance = new WorkspaceMaintenanceService(
      this.kernel,
      () => ({
        wiki: this.composition.wiki,
        collection: this.composition.collections,
        artifacts: this.composition.artifacts,
        memory: this.composition.memory,
        skills: this.composition.skills,
        gateway: this.composition.gateway,
        session: this.composition.session,
        learning: this.composition.learning,
        metadata: this.composition.metadata,
        queries: this.composition.queries,
        managedResources: this.composition.managedResources
      }),
      bundles
    );

    this.composition = {
      session,
      clientEvents,
      durableWork,
      artifacts,
      surfaces,
      memory,
      wiki,
      skills,
      learning,
      collections,
      automation,
      gateway,
      metadata,
      roomAgent,
      roomPermissions,
      accessHistory,
      activityHistory,
      workspaceJobs,
      managedResources,
      queries,
      bundles,
      restore,
      maintenance,
      postTurn: new ManagedResourcePostTurnService(managedResources, session)
    };
    this.bindCompatibilityApi();
  }

  /** Keep every legacy entry point explicit; no Proxy or string dispatch is used. */
  private bindCompatibilityApi(): void {
    const facade = this as WorkspaceStore;
    const { session, clientEvents, durableWork, artifacts, surfaces, memory, wiki, skills, learning, collections, automation, gateway, metadata, roomAgent, roomPermissions, accessHistory, activityHistory, workspaceJobs, queries, bundles, restore, maintenance } = this.composition;

    facade.migrate = this.kernel.migrate.bind(this.kernel);
    facade.listSchemaMigrations = this.kernel.listSchemaMigrations.bind(this.kernel);
    facade.getSqliteRuntimeSettings = this.kernel.getSqliteRuntimeSettings.bind(this.kernel);
    facade.recoverWorkspaceFileTransactions = this.kernel.recoverWorkspaceFileTransactions.bind(this.kernel);
    facade.countPendingWorkspaceFileTransactions = this.kernel.countPendingWorkspaceFileTransactions.bind(this.kernel);
    facade.close = this.kernel.close.bind(this.kernel);

    // Legacy Store callers have no actor parameter. They remain a local-owner
    // compatibility path, but still use the same atomic Room+Owner write as
    // the Core 06 Domain operation.
    facade.createRoom = (room) => roomPermissions.createRoomWithOwner(room, localOwnerParticipantId);
    facade.getRoom = roomAgent.getRoom.bind(roomAgent);
    facade.listRooms = roomAgent.listRooms.bind(roomAgent);
    facade.patchRoom = roomAgent.patchRoom.bind(roomAgent);
    facade.createAgent = roomAgent.createAgent.bind(roomAgent);
    facade.getAgent = roomAgent.getAgent.bind(roomAgent);
    facade.listAgents = roomAgent.listAgents.bind(roomAgent);
    facade.patchAgent = roomAgent.patchAgent.bind(roomAgent);
    facade.bindAgentBackend = roomAgent.bindAgentBackend.bind(roomAgent);

    facade.createRoomWithOwner = roomPermissions.createRoomWithOwner.bind(roomPermissions);
    facade.getWorkspaceMember = roomPermissions.getWorkspaceMember.bind(roomPermissions);
    facade.listWorkspaceMembers = roomPermissions.listWorkspaceMembers.bind(roomPermissions);
    facade.addWorkspaceMember = roomPermissions.addWorkspaceMember.bind(roomPermissions);
    facade.changeWorkspaceMemberRole = roomPermissions.changeWorkspaceMemberRole.bind(roomPermissions);
    facade.removeWorkspaceMember = roomPermissions.removeWorkspaceMember.bind(roomPermissions);
    facade.transferWorkspaceOwnership = roomPermissions.transferWorkspaceOwnership.bind(roomPermissions);
    facade.getRoomMember = roomPermissions.getRoomMember.bind(roomPermissions);
    facade.listRoomMembers = roomPermissions.listRoomMembers.bind(roomPermissions);
    facade.addRoomMember = roomPermissions.addRoomMember.bind(roomPermissions);
    facade.changeRoomMemberRole = roomPermissions.changeRoomMemberRole.bind(roomPermissions);
    facade.removeRoomMember = roomPermissions.removeRoomMember.bind(roomPermissions);
    facade.transferRoomOwnership = roomPermissions.transferRoomOwnership.bind(roomPermissions);
    facade.recoverOwnerlessRoom = roomPermissions.recoverOwnerlessRoom.bind(roomPermissions);
    facade.listOwnerlessRoomIds = roomPermissions.listOwnerlessRoomIds.bind(roomPermissions);
    facade.getRoomAgent = roomPermissions.getRoomAgent.bind(roomPermissions);
    facade.listRoomAgents = roomPermissions.listRoomAgents.bind(roomPermissions);
    facade.setRoomAgentPermissions = roomPermissions.setRoomAgentPermissions.bind(roomPermissions);
    facade.removeRoomAgent = roomPermissions.removeRoomAgent.bind(roomPermissions);
    facade.getAgentWorkspacePermission = roomPermissions.getAgentWorkspacePermission.bind(roomPermissions);
    facade.setAgentWorkspacePermission = roomPermissions.setAgentWorkspacePermission.bind(roomPermissions);
    facade.getResourceAccessBoundary = roomPermissions.getResourceAccessBoundary.bind(roomPermissions);
    facade.ensureResourceAccessBoundary = roomPermissions.ensureResourceAccessBoundary.bind(roomPermissions);
    facade.listRoomResourceShares = roomPermissions.listRoomResourceShares.bind(roomPermissions);
    facade.shareResource = roomPermissions.shareResource.bind(roomPermissions);
    facade.revokeRoomResourceShare = roomPermissions.revokeRoomResourceShare.bind(roomPermissions);
    facade.getResourceAccessMode = roomPermissions.getResourceAccessMode.bind(roomPermissions);
    facade.isResourceAvailableInRoom = roomPermissions.isResourceAvailableInRoom.bind(roomPermissions);
    facade.listResourceIdsAvailableInRoom = roomPermissions.listResourceIdsAvailableInRoom.bind(roomPermissions);
    facade.listRoomIdsForHuman = roomPermissions.listRoomIdsForHuman.bind(roomPermissions);
    facade.listRoomIdsForAgent = roomPermissions.listRoomIdsForAgent.bind(roomPermissions);

    facade.createSession = session.createSession.bind(session);
    facade.listSessions = session.listSessions.bind(session);
    facade.getSession = session.getSession.bind(session);
    facade.saveSessionCompaction = session.saveSessionCompaction.bind(session);
    facade.getSessionCompaction = session.getSessionCompaction.bind(session);
    facade.touchSession = session.touchSession.bind(session);
    facade.saveMessage = session.saveMessage.bind(session);
    facade.updateMessageContent = session.updateMessageContent.bind(session);
    facade.deleteMessage = session.deleteMessage.bind(session);
    facade.listMessages = session.listMessages.bind(session);
    facade.saveMessagePresentation = session.saveMessagePresentation.bind(session);
    facade.getMessagePresentation = session.getMessagePresentation.bind(session);
    facade.updateMessagePresentationViewState = session.updateMessagePresentationViewState.bind(session);
    facade.listMessagePresentations = session.listMessagePresentations.bind(session);
    facade.saveOperation = session.saveOperation.bind(session);
    facade.updateOperation = session.updateOperation.bind(session);
    facade.getOperation = session.getOperation.bind(session);
    facade.listOperations = session.listOperations.bind(session);
    facade.listOperationsForRoom = session.listOperationsForRoom.bind(session);
    facade.saveBackendRun = session.saveBackendRun.bind(session);
    facade.admitWorkspaceRun = session.admitWorkspaceRun.bind(session);
    facade.releaseRunLease = session.releaseRunLease.bind(session);
    facade.commitWorkspaceRunSettlement = session.commitWorkspaceRunSettlement.bind(session);
    facade.admitTurn = session.admitTurn.bind(session);
    facade.releaseReservation = session.releaseReservation.bind(session);
    facade.getSessionRunReservation = session.getSessionRunReservation.bind(session);
    facade.commitCore02RunTransition = session.commitCore02RunTransition.bind(session);
    facade.commitCore02BackendSession = session.commitCore02BackendSession.bind(session);
    facade.updateBackendRun = session.updateBackendRun.bind(session);
    facade.getBackendRun = session.getBackendRun.bind(session);
    facade.listBackendRuns = session.listBackendRuns.bind(session);
    facade.listCore02RecoveryCandidates = session.listCore02RecoveryCandidates.bind(session);
    facade.listRunHistoryEntries = session.listRunHistoryEntries.bind(session);
    facade.saveBackendEvent = session.saveBackendEvent.bind(session);
    facade.appendCore02Event = session.appendCore02Event.bind(session);
    facade.appendHostDiagnostic = session.appendHostDiagnostic.bind(session);
    facade.commitCore02LifecycleEvent = session.commitCore02LifecycleEvent.bind(session);
    facade.listBackendEvents = session.listBackendEvents.bind(session);
    facade.saveWorkspaceChange = session.saveWorkspaceChange.bind(session);
    facade.setWorkspaceChangeCorrelation = session.setWorkspaceChangeCorrelation.bind(session);
    facade.listWorkspaceChanges = session.listWorkspaceChanges.bind(session);
    facade.listWorkspaceChangesForOperation = session.listWorkspaceChangesForOperation.bind(session);
    facade.listChangeHistoryEntries = session.listChangeHistoryEntries.bind(session);
    facade.saveToolRun = session.saveToolRun.bind(session);
    facade.listToolRuns = session.listToolRuns.bind(session);
    facade.getToolRunDiagnostics = session.getToolRunDiagnostics.bind(session);

    facade.createActivity = activityHistory.createActivity.bind(activityHistory);
    facade.getActivity = activityHistory.getActivity.bind(activityHistory);
    facade.getActivityByIdempotency = activityHistory.getActivityByIdempotency.bind(activityHistory);
    facade.getActivityByBackendRunId = activityHistory.getActivityByBackendRunId.bind(activityHistory);
    facade.listActivities = activityHistory.listActivities.bind(activityHistory);
    facade.linkActivityBackendRun = activityHistory.linkActivityBackendRun.bind(activityHistory);
    facade.finalizeActivity = activityHistory.finalizeActivity.bind(activityHistory);
    facade.ingestFinalizedActivity = activityHistory.ingestFinalizedActivity.bind(activityHistory);
    facade.recordResourceUsage = activityHistory.recordResourceUsage.bind(activityHistory);
    facade.getResourceUsage = activityHistory.getResourceUsage.bind(activityHistory);
    facade.listResourceUsage = activityHistory.listResourceUsage.bind(activityHistory);
    facade.enqueueWorkspaceJob = workspaceJobs.enqueueWorkspaceJob.bind(workspaceJobs);
    facade.getWorkspaceJob = workspaceJobs.getWorkspaceJob.bind(workspaceJobs);
    facade.getWorkspaceJobByIdempotency = workspaceJobs.getWorkspaceJobByIdempotency.bind(workspaceJobs);
    facade.listWorkspaceJobs = workspaceJobs.listWorkspaceJobs.bind(workspaceJobs);
    facade.getWorkspaceJobAttempt = workspaceJobs.getWorkspaceJobAttempt.bind(workspaceJobs);
    facade.listWorkspaceJobAttempts = workspaceJobs.listWorkspaceJobAttempts.bind(workspaceJobs);
    facade.claimWorkspaceJob = workspaceJobs.claimWorkspaceJob.bind(workspaceJobs);
    facade.prepareWorkspaceJobAttempt = workspaceJobs.prepareWorkspaceJobAttempt.bind(workspaceJobs);
    facade.heartbeatWorkspaceJob = workspaceJobs.heartbeatWorkspaceJob.bind(workspaceJobs);
    facade.isWorkspaceJobCancellationRequested = workspaceJobs.isWorkspaceJobCancellationRequested.bind(workspaceJobs);
    facade.requestWorkspaceJobCancel = workspaceJobs.requestWorkspaceJobCancel.bind(workspaceJobs);
    facade.completeWorkspaceJob = workspaceJobs.completeWorkspaceJob.bind(workspaceJobs);
    facade.failWorkspaceJob = workspaceJobs.failWorkspaceJob.bind(workspaceJobs);
    facade.reconcileExpiredWorkspaceJobs = workspaceJobs.reconcileExpiredWorkspaceJobs.bind(workspaceJobs);

    facade.saveClientEvent = clientEvents.saveClientEvent.bind(clientEvents);
    facade.getClientEvent = clientEvents.getClientEvent.bind(clientEvents);
    facade.listClientEvents = clientEvents.listClientEvents.bind(clientEvents);
    facade.markClientEventDelivered = clientEvents.markClientEventDelivered.bind(clientEvents);
    facade.ackClientEvent = clientEvents.ackClientEvent.bind(clientEvents);
    facade.failClientEvent = clientEvents.failClientEvent.bind(clientEvents);
    facade.expireClientEvents = clientEvents.expireClientEvents.bind(clientEvents);

    facade.saveObjective = durableWork.saveObjective.bind(durableWork);
    facade.getObjective = durableWork.getObjective.bind(durableWork);
    facade.listObjectives = durableWork.listObjectives.bind(durableWork);
    facade.updateObjective = durableWork.updateObjective.bind(durableWork);
    facade.saveWorkItem = durableWork.saveWorkItem.bind(durableWork);
    facade.getWorkItem = durableWork.getWorkItem.bind(durableWork);
    facade.listWorkItems = durableWork.listWorkItems.bind(durableWork);
    facade.saveWorkDependency = durableWork.saveWorkDependency.bind(durableWork);
    facade.listWorkDependencies = durableWork.listWorkDependencies.bind(durableWork);
    facade.claimWorkItem = durableWork.claimWorkItem.bind(durableWork);
    facade.heartbeatWorkItem = durableWork.heartbeatWorkItem.bind(durableWork);
    facade.completeWorkItem = durableWork.completeWorkItem.bind(durableWork);
    facade.failWorkItem = durableWork.failWorkItem.bind(durableWork);
    facade.cancelObjective = durableWork.cancelObjective.bind(durableWork);
    facade.reconcileExpiredWorkItems = durableWork.reconcileExpiredWorkItems.bind(durableWork);
    facade.saveRunCheckpoint = durableWork.saveRunCheckpoint.bind(durableWork);
    facade.listRunCheckpoints = durableWork.listRunCheckpoints.bind(durableWork);
    facade.claimDomainCommandExecution = durableWork.claimDomainCommandExecution.bind(durableWork);
    facade.getDomainCommandExecution = durableWork.getDomainCommandExecution.bind(durableWork);
    facade.listDomainCommandExecutions = durableWork.listDomainCommandExecutions.bind(durableWork);
    facade.updateDomainCommandExecution = durableWork.updateDomainCommandExecution.bind(durableWork);
    facade.compareAndSetDomainCommandExecution = durableWork.compareAndSetDomainCommandExecution.bind(durableWork);
    facade.heartbeatDomainCommandExecution = durableWork.heartbeatDomainCommandExecution.bind(durableWork);

    facade.saveArtifactMetadata = artifacts.saveArtifactMetadata.bind(artifacts);
    facade.getArtifact = artifacts.getArtifact.bind(artifacts);
    facade.listArtifacts = artifacts.listArtifacts.bind(artifacts);
    facade.listArtifactsForSession = artifacts.listArtifactsForSession.bind(artifacts);
    facade.createArtifactRevision = artifacts.createArtifactRevision.bind(artifacts);
    facade.listArtifactRevisions = artifacts.listArtifactRevisions.bind(artifacts);
    facade.getArtifactRevision = artifacts.getArtifactRevision.bind(artifacts);
    facade.readArtifactRevisionContent = artifacts.readArtifactRevisionContent.bind(artifacts);
    facade.repairArtifactRevisionSource = artifacts.repairArtifactRevisionSource.bind(artifacts);
    facade.readArtifactContent = artifacts.readArtifactContent.bind(artifacts);
    facade.readArtifactBinaryContent = artifacts.readArtifactBinaryContent.bind(artifacts);
    facade.writeArtifactContent = artifacts.writeArtifactContent.bind(artifacts);

    facade.saveGeneratedSurfaceRevision = surfaces.saveGeneratedSurfaceRevision.bind(surfaces);
    facade.getGeneratedSurface = surfaces.getGeneratedSurface.bind(surfaces);
    facade.listGeneratedSurfaces = surfaces.listGeneratedSurfaces.bind(surfaces);
    facade.getGeneratedSurfaceRevision = surfaces.getGeneratedSurfaceRevision.bind(surfaces);
    facade.listGeneratedSurfaceRevisions = surfaces.listGeneratedSurfaceRevisions.bind(surfaces);
    facade.readGeneratedSurfaceBundle = surfaces.readGeneratedSurfaceBundle.bind(surfaces);
    facade.readGeneratedSurfaceAssets = surfaces.readGeneratedSurfaceAssets.bind(surfaces);
    facade.updateGeneratedSurfaceState = surfaces.updateGeneratedSurfaceState.bind(surfaces);
    facade.saveSurfaceInteraction = surfaces.saveSurfaceInteraction.bind(surfaces);
    facade.listSurfaceInteractions = surfaces.listSurfaceInteractions.bind(surfaces);

    facade.saveMemory = memory.saveMemory.bind(memory);
    facade.replaceMemoryContent = memory.replaceMemoryContent.bind(memory);
    facade.patchMemoryLearningMetadata = memory.patchMemoryLearningMetadata.bind(memory);
    facade.listMemory = memory.listMemory.bind(memory);
    facade.listMemoryForSession = memory.listMemoryForSession.bind(memory);
    facade.searchMemory = memory.searchMemory.bind(memory);
    facade.getMemory = memory.getMemory.bind(memory);
    facade.readMemoryContent = memory.readMemoryContent.bind(memory);
    facade.readMemoryMarkdown = memory.readMemoryMarkdown.bind(memory);
    facade.restoreMemoryVersionMarkdown = memory.restoreMemoryVersionMarkdown.bind(memory);
    facade.archiveMemory = memory.archiveMemory.bind(memory);

    facade.saveWikiPage = wiki.saveWikiPage.bind(wiki);
    facade.listWiki = wiki.listWiki.bind(wiki);
    facade.searchWiki = wiki.searchWiki.bind(wiki);
    facade.getWiki = wiki.getWiki.bind(wiki);
    facade.readWikiContent = wiki.readWikiContent.bind(wiki);
    facade.readWikiMarkdown = wiki.readWikiMarkdown.bind(wiki);
    facade.updateWikiPage = wiki.updateWikiPage.bind(wiki);
    facade.patchWikiLearningMetadata = wiki.patchWikiLearningMetadata.bind(wiki);
    facade.restoreWikiVersionMarkdown = wiki.restoreWikiVersionMarkdown.bind(wiki);
    facade.setWikiState = wiki.setWikiState.bind(wiki);

    facade.saveSkillOptimizationRun = skills.saveSkillOptimizationRun.bind(skills);
    facade.getSkillOptimizationRun = skills.getSkillOptimizationRun.bind(skills);
    facade.listSkillOptimizationRuns = skills.listSkillOptimizationRuns.bind(skills);
    facade.saveSkillOptimizationDataset = skills.saveSkillOptimizationDataset.bind(skills);
    facade.getSkillOptimizationDataset = skills.getSkillOptimizationDataset.bind(skills);
    facade.saveOptimizationCandidate = skills.saveOptimizationCandidate.bind(skills);
    facade.getOptimizationCandidate = skills.getOptimizationCandidate.bind(skills);
    facade.listOptimizationCandidates = skills.listOptimizationCandidates.bind(skills);
    facade.saveOptimizationEvaluation = skills.saveOptimizationEvaluation.bind(skills);
    facade.listOptimizationEvaluations = skills.listOptimizationEvaluations.bind(skills);
    facade.saveSkillOptimizationSnapshot = skills.saveSkillOptimizationSnapshot.bind(skills);
    facade.getSkillOptimizationSnapshot = skills.getSkillOptimizationSnapshot.bind(skills);
    facade.saveOptimizationPromotion = skills.saveOptimizationPromotion.bind(skills);
    facade.listOptimizationPromotions = skills.listOptimizationPromotions.bind(skills);
    facade.acquireSkillOptimizationLock = skills.acquireSkillOptimizationLock.bind(skills);
    facade.getSkillOptimizationLock = skills.getSkillOptimizationLock.bind(skills);
    facade.releaseSkillOptimizationLock = skills.releaseSkillOptimizationLock.bind(skills);
    facade.saveSkillMarkdown = skills.saveSkillMarkdown.bind(skills);
    facade.listSkills = skills.listSkills.bind(skills);
    facade.listSkillIndexReadModel = skills.listSkillIndexReadModel.bind(skills);
    facade.getSkill = skills.getSkill.bind(skills);
    facade.readSkillMarkdown = skills.readSkillMarkdown.bind(skills);
    facade.patchSkill = skills.patchSkill.bind(skills);
    facade.updateSkillState = skills.updateSkillState.bind(skills);
    facade.replaceSkillContent = skills.replaceSkillContent.bind(skills);
    facade.patchSkillLearningMetadata = skills.patchSkillLearningMetadata.bind(skills);
    facade.restoreSkillVersionMarkdown = skills.restoreSkillVersionMarkdown.bind(skills);
    facade.replaceSkillContentIfUnchanged = skills.replaceSkillContentIfUnchanged.bind(skills);
    facade.recordSkillUsage = skills.recordSkillUsage.bind(skills);
    facade.getSkillUsage = skills.getSkillUsage.bind(skills);
    facade.listSkillUsage = skills.listSkillUsage.bind(skills);
    facade.writeSkillSupportFile = skills.writeSkillSupportFile.bind(skills);
    facade.readSkillSupportFile = skills.readSkillSupportFile.bind(skills);
    facade.listSkillSupportFiles = skills.listSkillSupportFiles.bind(skills);
    facade.listSkillSupportFileRefs = skills.listSkillSupportFileRefs.bind(skills);
    facade.searchSkills = skills.searchSkills.bind(skills);

    facade.recordLearningResourceUse = learning.recordLearningResourceUse.bind(learning);
    facade.listLearningResourceUses = learning.listLearningResourceUses.bind(learning);
    facade.saveLearningEvaluation = learning.saveLearningEvaluation.bind(learning);
    facade.listLearningEvaluations = learning.listLearningEvaluations.bind(learning);
    facade.saveLearningResourceVersion = learning.saveLearningResourceVersion.bind(learning);
    facade.getLearningResourceVersion = learning.getLearningResourceVersion.bind(learning);
    facade.getCurrentLearningResourceVersion = learning.getCurrentLearningResourceVersion.bind(learning);
    facade.listLearningResourceVersions = learning.listLearningResourceVersions.bind(learning);
    facade.readLearningResourceVersionContent = learning.readLearningResourceVersionContent.bind(learning);
    facade.saveLearningResourceEdge = learning.saveLearningResourceEdge.bind(learning);
    facade.listLearningResourceEdges = learning.listLearningResourceEdges.bind(learning);
    facade.createLearningSnapshot = learning.createLearningSnapshot.bind(learning);
    facade.listLearningSnapshots = learning.listLearningSnapshots.bind(learning);
    facade.pruneLearningSnapshots = learning.pruneLearningSnapshots.bind(learning);
    facade.restoreLearningSnapshot = learning.restoreLearningSnapshot.bind(learning);
    facade.saveBackgroundReviewChange = learning.saveBackgroundReviewChange.bind(learning);
    facade.rollbackBackgroundReviewMetadata = learning.rollbackBackgroundReviewMetadata.bind(learning);
    facade.listBackgroundReviewChanges = learning.listBackgroundReviewChanges.bind(learning);
    facade.saveLearningJobReport = learning.saveLearningJobReport.bind(learning);
    facade.listLearningJobReports = learning.listLearningJobReports.bind(learning);
    facade.getCuratorState = learning.getCuratorState.bind(learning);
    facade.saveCuratorState = learning.saveCuratorState.bind(learning);
    facade.createReflectionRun = learning.createReflectionRun.bind(learning);
    facade.createLearningReviewCandidate = learning.createLearningReviewCandidate.bind(learning);
    facade.updateReflectionRun = learning.updateReflectionRun.bind(learning);
    facade.getReflectionRun = learning.getReflectionRun.bind(learning);
    facade.getReflectionRunByCandidateKey = learning.getReflectionRunByCandidateKey.bind(learning);
    facade.listReflectionRuns = learning.listReflectionRuns.bind(learning);
    facade.saveReflectionSuggestion = learning.saveReflectionSuggestion.bind(learning);
    facade.updateReflectionSuggestion = learning.updateReflectionSuggestion.bind(learning);
    facade.listReflectionSuggestions = learning.listReflectionSuggestions.bind(learning);
    facade.saveExternalAssistRecord = learning.saveExternalAssistRecord.bind(learning);
    facade.listExternalAssistRecords = learning.listExternalAssistRecords.bind(learning);
    facade.getExternalAssistDiagnostics = learning.getExternalAssistDiagnostics.bind(learning);

    facade.saveCollectionSchema = collections.saveCollectionSchema.bind(collections);
    facade.getCollectionSchema = collections.getCollectionSchema.bind(collections);
    facade.listCollectionSchemas = collections.listCollectionSchemas.bind(collections);
    facade.updateCollectionSchema = collections.updateCollectionSchema.bind(collections);
    facade.saveCollectionRecord = collections.saveCollectionRecord.bind(collections);
    facade.upsertCollectionRecord = collections.upsertCollectionRecord.bind(collections);
    facade.deleteCollectionRecord = collections.deleteCollectionRecord.bind(collections);
    facade.getCollectionRecord = collections.getCollectionRecord.bind(collections);
    facade.listCollectionRecords = collections.listCollectionRecords.bind(collections);
    facade.listCollectionPatches = collections.listCollectionPatches.bind(collections);
    facade.getCollectionPatch = collections.getCollectionPatch.bind(collections);
    facade.resolveCollectionRecordRefs = collections.resolveCollectionRecordRefs.bind(collections);
    facade.evaluateCollectionTriggers = collections.evaluateCollectionTriggers.bind(collections);
    facade.listCollectionTriggerStates = collections.listCollectionTriggerStates.bind(collections);
    facade.applyCollectionRecordPatch = collections.applyCollectionRecordPatch.bind(collections);
    facade.listCollectionNotes = collections.listCollectionNotes.bind(collections);

    facade.saveAutomationJob = automation.saveAutomationJob.bind(automation);
    facade.getAutomationJob = automation.getAutomationJob.bind(automation);
    facade.listAutomationJobs = automation.listAutomationJobs.bind(automation);
    facade.acquireAutomationJobLock = automation.acquireAutomationJobLock.bind(automation);
    facade.heartbeatAutomationJobLock = automation.heartbeatAutomationJobLock.bind(automation);
    facade.releaseAutomationJobLock = automation.releaseAutomationJobLock.bind(automation);
    facade.requeueAutomationJob = automation.requeueAutomationJob.bind(automation);
    facade.getAutomationQueueSummary = automation.getAutomationQueueSummary.bind(automation);
    facade.createAutomationRun = automation.createAutomationRun.bind(automation);
    facade.updateAutomationRun = automation.updateAutomationRun.bind(automation);
    facade.getAutomationRun = automation.getAutomationRun.bind(automation);
    facade.listAutomationRuns = automation.listAutomationRuns.bind(automation);

    facade.saveExternalSend = gateway.saveExternalSend.bind(gateway);
    facade.getExternalSend = gateway.getExternalSend.bind(gateway);
    facade.listExternalSends = gateway.listExternalSends.bind(gateway);
    facade.saveGatewayPairingPolicy = gateway.saveGatewayPairingPolicy.bind(gateway);
    facade.getGatewayPairingPolicy = gateway.getGatewayPairingPolicy.bind(gateway);
    facade.listGatewayPairingPolicies = gateway.listGatewayPairingPolicies.bind(gateway);
    facade.saveGatewayRoutingPolicy = gateway.saveGatewayRoutingPolicy.bind(gateway);
    facade.getGatewayRoutingPolicy = gateway.getGatewayRoutingPolicy.bind(gateway);
    facade.listGatewayRoutingPolicies = gateway.listGatewayRoutingPolicies.bind(gateway);
    facade.saveGatewayPairing = gateway.saveGatewayPairing.bind(gateway);
    facade.getGatewayPairing = gateway.getGatewayPairing.bind(gateway);
    facade.findGatewayPairing = gateway.findGatewayPairing.bind(gateway);
    facade.listGatewayPairings = gateway.listGatewayPairings.bind(gateway);
    facade.expireGatewayPairings = gateway.expireGatewayPairings.bind(gateway);
    facade.saveGatewayInboundMessage = gateway.saveGatewayInboundMessage.bind(gateway);
    facade.listGatewayInboundMessages = gateway.listGatewayInboundMessages.bind(gateway);
    facade.enqueueGatewayDelivery = gateway.enqueueGatewayDelivery.bind(gateway);
    facade.getGatewayDelivery = gateway.getGatewayDelivery.bind(gateway);
    facade.listGatewayDeliveries = gateway.listGatewayDeliveries.bind(gateway);
    facade.claimGatewayDelivery = gateway.claimGatewayDelivery.bind(gateway);
    facade.completeGatewayDelivery = gateway.completeGatewayDelivery.bind(gateway);
    facade.failGatewayDelivery = gateway.failGatewayDelivery.bind(gateway);
    facade.reconcileExpiredGatewayDeliveries = gateway.reconcileExpiredGatewayDeliveries.bind(gateway);
    facade.saveGatewayBoundaryPolicy = gateway.saveGatewayBoundaryPolicy.bind(gateway);
    facade.getGatewayBoundaryPolicy = gateway.getGatewayBoundaryPolicy.bind(gateway);
    facade.listGatewayBoundaryPolicies = gateway.listGatewayBoundaryPolicies.bind(gateway);
    facade.saveGatewayMcpConfig = gateway.saveGatewayMcpConfig.bind(gateway);
    facade.getGatewayMcpConfig = gateway.getGatewayMcpConfig.bind(gateway);
    facade.getGatewayMcpConfigByServerName = gateway.getGatewayMcpConfigByServerName.bind(gateway);
    facade.listGatewayMcpConfigs = gateway.listGatewayMcpConfigs.bind(gateway);
    facade.acquireGatewayConcurrencyLock = gateway.acquireGatewayConcurrencyLock.bind(gateway);
    facade.getGatewayConcurrencyLock = gateway.getGatewayConcurrencyLock.bind(gateway);
    facade.releaseGatewayConcurrencyLock = gateway.releaseGatewayConcurrencyLock.bind(gateway);
    facade.expireGatewayConcurrencyLocks = gateway.expireGatewayConcurrencyLocks.bind(gateway);
    facade.reclaimExpiredGatewayConcurrencyLocks = gateway.reclaimExpiredGatewayConcurrencyLocks.bind(gateway);
    facade.listGatewayConcurrencyLocks = gateway.listGatewayConcurrencyLocks.bind(gateway);
    facade.saveGatewaySandboxInstance = gateway.saveGatewaySandboxInstance.bind(gateway);
    facade.getGatewaySandboxInstance = gateway.getGatewaySandboxInstance.bind(gateway);
    facade.listGatewaySandboxInstances = gateway.listGatewaySandboxInstances.bind(gateway);
    facade.saveGatewaySandboxWorkspaceSync = gateway.saveGatewaySandboxWorkspaceSync.bind(gateway);
    facade.listGatewaySandboxWorkspaceSyncs = gateway.listGatewaySandboxWorkspaceSyncs.bind(gateway);

    facade.getSettings = metadata.getSettings.bind(metadata);
    facade.patchSettings = metadata.patchSettings.bind(metadata);
    facade.savePluginState = metadata.savePluginState.bind(metadata);
    facade.listPluginStates = metadata.listPluginStates.bind(metadata);
    facade.saveResourceTranslation = metadata.saveResourceTranslation.bind(metadata);
    facade.listResourceTranslations = metadata.listResourceTranslations.bind(metadata);
    facade.resolveResourceTranslation = metadata.resolveResourceTranslation.bind(metadata);

    facade.savePolicyDecision = accessHistory.savePolicyDecision.bind(accessHistory);
    facade.listPolicyDecisions = accessHistory.listPolicyDecisions.bind(accessHistory);
    facade.listPolicyDecisionsForOperationIds = accessHistory.listPolicyDecisionsForOperationIds.bind(accessHistory);
    facade.getPolicyDecision = accessHistory.getPolicyDecision.bind(accessHistory);
    facade.saveApprovalRequest = accessHistory.saveApprovalRequest.bind(accessHistory);
    facade.updateApprovalRequest = accessHistory.updateApprovalRequest.bind(accessHistory);
    facade.getApprovalRequest = accessHistory.getApprovalRequest.bind(accessHistory);
    facade.listApprovalRequests = accessHistory.listApprovalRequests.bind(accessHistory);
    facade.listApprovalRequestsForOperationIds = accessHistory.listApprovalRequestsForOperationIds.bind(accessHistory);
    facade.saveAuditRecord = accessHistory.saveAuditRecord.bind(accessHistory);
    facade.updateAuditRecord = accessHistory.updateAuditRecord.bind(accessHistory);
    facade.listAuditRecords = accessHistory.listAuditRecords.bind(accessHistory);
    facade.listAuditRecordsForRoom = accessHistory.listAuditRecordsForRoom.bind(accessHistory);
    facade.listAuditRecordsForOperation = accessHistory.listAuditRecordsForOperation.bind(accessHistory);
    facade.saveRollbackPoint = accessHistory.saveRollbackPoint.bind(accessHistory);
    facade.listRollbackPoints = accessHistory.listRollbackPoints.bind(accessHistory);
    facade.listRollbackPointsForOperationIds = accessHistory.listRollbackPointsForOperationIds.bind(accessHistory);
    facade.getRollbackPoint = accessHistory.getRollbackPoint.bind(accessHistory);
    facade.getRollbackPointForOperationIds = accessHistory.getRollbackPointForOperationIds.bind(accessHistory);
    facade.listGrants = accessHistory.listGrants.bind(accessHistory);
    facade.getGrant = accessHistory.getGrant.bind(accessHistory);
    facade.saveGrant = accessHistory.saveGrant.bind(accessHistory);
    facade.revokeGrant = accessHistory.revokeGrant.bind(accessHistory);

    facade.exportSessionTranscript = queries.exportSessionTranscript.bind(queries);
    facade.getCorrelationTrace = queries.getCorrelationTrace.bind(queries);
    facade.reindexSessionSearch = queries.reindexSessionSearch.bind(queries);
    facade.getSessionSearchMode = queries.getSessionSearchMode.bind(queries);
    facade.search = queries.search.bind(queries);
    facade.readActivityInputs = queries.readActivityInputs.bind(queries);

    facade.inspectWorkspace = maintenance.inspectWorkspace.bind(maintenance);
    facade.checkIntegrity = maintenance.checkIntegrity.bind(maintenance);
    facade.listMigrationJournal = maintenance.listMigrationJournal.bind(maintenance);
    facade.repairWorkspace = (options) => this.maintenanceGuard.run(() => maintenance.repairWorkspace(options));
    facade.createWorkspaceBackup = () => this.maintenanceGuard.run(() => bundles.createWorkspaceBackup());
    facade.listWorkspaceBackups = bundles.listWorkspaceBackups.bind(bundles);
    facade.applyResourceRetention = (policy) => this.maintenanceGuard.run(() => maintenance.applyResourceRetention(policy));
    facade.exportWorkspaceBundle = (destinationRoot) => this.maintenanceGuard.run(() => bundles.exportWorkspaceBundle(destinationRoot));
    facade.importWorkspaceBundle = (bundlePath) => this.maintenanceGuard.run(() => bundles.importWorkspaceBundle(bundlePath));
    facade.restoreWorkspaceBackup = (backupId) => this.maintenanceGuard.run(() => restore.restoreWorkspaceBackup(backupId));
  }
}

/** Type-level public surface retained for current Store callers. */
export interface WorkspaceStore {
  migrate: WorkspaceKernelService["migrate"];
  listSchemaMigrations: WorkspaceKernelService["listSchemaMigrations"];
  getSqliteRuntimeSettings: WorkspaceKernelService["getSqliteRuntimeSettings"];
  recoverWorkspaceFileTransactions: WorkspaceKernelService["recoverWorkspaceFileTransactions"];
  countPendingWorkspaceFileTransactions: WorkspaceKernelService["countPendingWorkspaceFileTransactions"];
  close: WorkspaceKernelService["close"];

  createRoom: (record: RoomRecord) => Promise<RoomRecord>;
  getRoom: RoomAgentRepository["getRoom"];
  listRooms: RoomAgentRepository["listRooms"];
  patchRoom: RoomAgentRepository["patchRoom"];
  createAgent: RoomAgentRepository["createAgent"];
  getAgent: RoomAgentRepository["getAgent"];
  listAgents: RoomAgentRepository["listAgents"];
  patchAgent: RoomAgentRepository["patchAgent"];
  bindAgentBackend: RoomAgentRepository["bindAgentBackend"];

  createRoomWithOwner: RoomPermissionRepository["createRoomWithOwner"];
  getWorkspaceMember: RoomPermissionRepository["getWorkspaceMember"];
  listWorkspaceMembers: RoomPermissionRepository["listWorkspaceMembers"];
  addWorkspaceMember: RoomPermissionRepository["addWorkspaceMember"];
  changeWorkspaceMemberRole: RoomPermissionRepository["changeWorkspaceMemberRole"];
  removeWorkspaceMember: RoomPermissionRepository["removeWorkspaceMember"];
  transferWorkspaceOwnership: RoomPermissionRepository["transferWorkspaceOwnership"];
  getRoomMember: RoomPermissionRepository["getRoomMember"];
  listRoomMembers: RoomPermissionRepository["listRoomMembers"];
  addRoomMember: RoomPermissionRepository["addRoomMember"];
  changeRoomMemberRole: RoomPermissionRepository["changeRoomMemberRole"];
  removeRoomMember: RoomPermissionRepository["removeRoomMember"];
  transferRoomOwnership: RoomPermissionRepository["transferRoomOwnership"];
  recoverOwnerlessRoom: RoomPermissionRepository["recoverOwnerlessRoom"];
  listOwnerlessRoomIds: RoomPermissionRepository["listOwnerlessRoomIds"];
  getRoomAgent: RoomPermissionRepository["getRoomAgent"];
  listRoomAgents: RoomPermissionRepository["listRoomAgents"];
  setRoomAgentPermissions: RoomPermissionRepository["setRoomAgentPermissions"];
  removeRoomAgent: RoomPermissionRepository["removeRoomAgent"];
  getAgentWorkspacePermission: RoomPermissionRepository["getAgentWorkspacePermission"];
  setAgentWorkspacePermission: RoomPermissionRepository["setAgentWorkspacePermission"];
  getResourceAccessBoundary: RoomPermissionRepository["getResourceAccessBoundary"];
  ensureResourceAccessBoundary: RoomPermissionRepository["ensureResourceAccessBoundary"];
  listRoomResourceShares: RoomPermissionRepository["listRoomResourceShares"];
  shareResource: RoomPermissionRepository["shareResource"];
  revokeRoomResourceShare: RoomPermissionRepository["revokeRoomResourceShare"];
  getResourceAccessMode: RoomPermissionRepository["getResourceAccessMode"];
  isResourceAvailableInRoom: RoomPermissionRepository["isResourceAvailableInRoom"];
  listResourceIdsAvailableInRoom: RoomPermissionRepository["listResourceIdsAvailableInRoom"];
  listRoomIdsForHuman: RoomPermissionRepository["listRoomIdsForHuman"];
  listRoomIdsForAgent: RoomPermissionRepository["listRoomIdsForAgent"];

  createSession: SessionExecutionRepository["createSession"];
  listSessions: SessionExecutionRepository["listSessions"];
  getSession: SessionExecutionRepository["getSession"];
  saveSessionCompaction: SessionExecutionRepository["saveSessionCompaction"];
  getSessionCompaction: SessionExecutionRepository["getSessionCompaction"];
  touchSession: SessionExecutionRepository["touchSession"];
  saveMessage: SessionExecutionRepository["saveMessage"];
  updateMessageContent: SessionExecutionRepository["updateMessageContent"];
  deleteMessage: SessionExecutionRepository["deleteMessage"];
  listMessages: SessionExecutionRepository["listMessages"];
  saveMessagePresentation: SessionExecutionRepository["saveMessagePresentation"];
  getMessagePresentation: SessionExecutionRepository["getMessagePresentation"];
  updateMessagePresentationViewState: SessionExecutionRepository["updateMessagePresentationViewState"];
  listMessagePresentations: SessionExecutionRepository["listMessagePresentations"];
  saveOperation: SessionExecutionRepository["saveOperation"];
  updateOperation: SessionExecutionRepository["updateOperation"];
  getOperation: SessionExecutionRepository["getOperation"];
  listOperations: SessionExecutionRepository["listOperations"];
  listOperationsForRoom: SessionExecutionRepository["listOperationsForRoom"];
  saveBackendRun: SessionExecutionRepository["saveBackendRun"];
  admitWorkspaceRun: SessionExecutionRepository["admitWorkspaceRun"];
  releaseRunLease: SessionExecutionRepository["releaseRunLease"];
  commitWorkspaceRunSettlement: SessionExecutionRepository["commitWorkspaceRunSettlement"];
  admitTurn: SessionExecutionRepository["admitTurn"];
  releaseReservation: SessionExecutionRepository["releaseReservation"];
  getSessionRunReservation: SessionExecutionRepository["getSessionRunReservation"];
  commitCore02RunTransition: SessionExecutionRepository["commitCore02RunTransition"];
  commitCore02BackendSession: SessionExecutionRepository["commitCore02BackendSession"];
  updateBackendRun: SessionExecutionRepository["updateBackendRun"];
  getBackendRun: SessionExecutionRepository["getBackendRun"];
  listBackendRuns: SessionExecutionRepository["listBackendRuns"];
  listCore02RecoveryCandidates: SessionExecutionRepository["listCore02RecoveryCandidates"];
  listRunHistoryEntries: SessionExecutionRepository["listRunHistoryEntries"];
  saveBackendEvent: SessionExecutionRepository["saveBackendEvent"];
  appendCore02Event: SessionExecutionRepository["appendCore02Event"];
  appendHostDiagnostic: SessionExecutionRepository["appendHostDiagnostic"];
  commitCore02LifecycleEvent: SessionExecutionRepository["commitCore02LifecycleEvent"];
  listBackendEvents: SessionExecutionRepository["listBackendEvents"];
  saveWorkspaceChange: SessionExecutionRepository["saveWorkspaceChange"];
  setWorkspaceChangeCorrelation: SessionExecutionRepository["setWorkspaceChangeCorrelation"];
  listWorkspaceChanges: SessionExecutionRepository["listWorkspaceChanges"];
  listWorkspaceChangesForOperation: SessionExecutionRepository["listWorkspaceChangesForOperation"];
  listChangeHistoryEntries: SessionExecutionRepository["listChangeHistoryEntries"];
  saveToolRun: SessionExecutionRepository["saveToolRun"];
  listToolRuns: SessionExecutionRepository["listToolRuns"];
  getToolRunDiagnostics: SessionExecutionRepository["getToolRunDiagnostics"];

  createActivity: ActivityHistoryRepository["createActivity"];
  getActivity: ActivityHistoryRepository["getActivity"];
  getActivityByIdempotency: ActivityHistoryRepository["getActivityByIdempotency"];
  getActivityByBackendRunId: ActivityHistoryRepository["getActivityByBackendRunId"];
  listActivities: ActivityHistoryRepository["listActivities"];
  linkActivityBackendRun: ActivityHistoryRepository["linkActivityBackendRun"];
  finalizeActivity: ActivityHistoryRepository["finalizeActivity"];
  ingestFinalizedActivity: ActivityHistoryRepository["ingestFinalizedActivity"];
  recordResourceUsage: ActivityHistoryRepository["recordResourceUsage"];
  getResourceUsage: ActivityHistoryRepository["getResourceUsage"];
  listResourceUsage: ActivityHistoryRepository["listResourceUsage"];
  enqueueWorkspaceJob: WorkspaceJobRepository["enqueueWorkspaceJob"];
  getWorkspaceJob: WorkspaceJobRepository["getWorkspaceJob"];
  getWorkspaceJobByIdempotency: WorkspaceJobRepository["getWorkspaceJobByIdempotency"];
  listWorkspaceJobs: WorkspaceJobRepository["listWorkspaceJobs"];
  getWorkspaceJobAttempt: WorkspaceJobRepository["getWorkspaceJobAttempt"];
  listWorkspaceJobAttempts: WorkspaceJobRepository["listWorkspaceJobAttempts"];
  claimWorkspaceJob: WorkspaceJobRepository["claimWorkspaceJob"];
  prepareWorkspaceJobAttempt: WorkspaceJobRepository["prepareWorkspaceJobAttempt"];
  heartbeatWorkspaceJob: WorkspaceJobRepository["heartbeatWorkspaceJob"];
  isWorkspaceJobCancellationRequested: WorkspaceJobRepository["isWorkspaceJobCancellationRequested"];
  requestWorkspaceJobCancel: WorkspaceJobRepository["requestWorkspaceJobCancel"];
  completeWorkspaceJob: WorkspaceJobRepository["completeWorkspaceJob"];
  failWorkspaceJob: WorkspaceJobRepository["failWorkspaceJob"];
  reconcileExpiredWorkspaceJobs: WorkspaceJobRepository["reconcileExpiredWorkspaceJobs"];

  saveClientEvent: ClientEventQueueRepository["saveClientEvent"];
  getClientEvent: ClientEventQueueRepository["getClientEvent"];
  listClientEvents: ClientEventQueueRepository["listClientEvents"];
  markClientEventDelivered: ClientEventQueueRepository["markClientEventDelivered"];
  ackClientEvent: ClientEventQueueRepository["ackClientEvent"];
  failClientEvent: ClientEventQueueRepository["failClientEvent"];
  expireClientEvents: ClientEventQueueRepository["expireClientEvents"];

  saveObjective: DurableWorkRepository["saveObjective"];
  getObjective: DurableWorkRepository["getObjective"];
  listObjectives: DurableWorkRepository["listObjectives"];
  updateObjective: DurableWorkRepository["updateObjective"];
  saveWorkItem: DurableWorkRepository["saveWorkItem"];
  getWorkItem: DurableWorkRepository["getWorkItem"];
  listWorkItems: DurableWorkRepository["listWorkItems"];
  saveWorkDependency: DurableWorkRepository["saveWorkDependency"];
  listWorkDependencies: DurableWorkRepository["listWorkDependencies"];
  claimWorkItem: DurableWorkRepository["claimWorkItem"];
  heartbeatWorkItem: DurableWorkRepository["heartbeatWorkItem"];
  completeWorkItem: DurableWorkRepository["completeWorkItem"];
  failWorkItem: DurableWorkRepository["failWorkItem"];
  cancelObjective: DurableWorkRepository["cancelObjective"];
  reconcileExpiredWorkItems: DurableWorkRepository["reconcileExpiredWorkItems"];
  saveRunCheckpoint: DurableWorkRepository["saveRunCheckpoint"];
  listRunCheckpoints: DurableWorkRepository["listRunCheckpoints"];
  claimDomainCommandExecution: DurableWorkRepository["claimDomainCommandExecution"];
  getDomainCommandExecution: DurableWorkRepository["getDomainCommandExecution"];
  listDomainCommandExecutions: DurableWorkRepository["listDomainCommandExecutions"];
  updateDomainCommandExecution: DurableWorkRepository["updateDomainCommandExecution"];
  compareAndSetDomainCommandExecution: DurableWorkRepository["compareAndSetDomainCommandExecution"];
  heartbeatDomainCommandExecution: DurableWorkRepository["heartbeatDomainCommandExecution"];

  saveArtifactMetadata: ArtifactRepository["saveArtifactMetadata"];
  getArtifact: ArtifactRepository["getArtifact"];
  listArtifacts: ArtifactRepository["listArtifacts"];
  listArtifactsForSession: ArtifactRepository["listArtifactsForSession"];
  createArtifactRevision: ArtifactRepository["createArtifactRevision"];
  listArtifactRevisions: ArtifactRepository["listArtifactRevisions"];
  getArtifactRevision: ArtifactRepository["getArtifactRevision"];
  readArtifactRevisionContent: ArtifactRepository["readArtifactRevisionContent"];
  repairArtifactRevisionSource: ArtifactRepository["repairArtifactRevisionSource"];
  readArtifactContent: ArtifactRepository["readArtifactContent"];
  readArtifactBinaryContent: ArtifactRepository["readArtifactBinaryContent"];
  writeArtifactContent: ArtifactRepository["writeArtifactContent"];

  saveGeneratedSurfaceRevision: GeneratedSurfaceRepository["saveGeneratedSurfaceRevision"];
  getGeneratedSurface: GeneratedSurfaceRepository["getGeneratedSurface"];
  listGeneratedSurfaces: GeneratedSurfaceRepository["listGeneratedSurfaces"];
  getGeneratedSurfaceRevision: GeneratedSurfaceRepository["getGeneratedSurfaceRevision"];
  listGeneratedSurfaceRevisions: GeneratedSurfaceRepository["listGeneratedSurfaceRevisions"];
  readGeneratedSurfaceBundle: GeneratedSurfaceRepository["readGeneratedSurfaceBundle"];
  readGeneratedSurfaceAssets: GeneratedSurfaceRepository["readGeneratedSurfaceAssets"];
  updateGeneratedSurfaceState: GeneratedSurfaceRepository["updateGeneratedSurfaceState"];
  saveSurfaceInteraction: GeneratedSurfaceRepository["saveSurfaceInteraction"];
  listSurfaceInteractions: GeneratedSurfaceRepository["listSurfaceInteractions"];

  saveMemory: MemoryRepository["saveMemory"];
  replaceMemoryContent: MemoryRepository["replaceMemoryContent"];
  patchMemoryLearningMetadata: MemoryRepository["patchMemoryLearningMetadata"];
  listMemory: MemoryRepository["listMemory"];
  listMemoryForSession: MemoryRepository["listMemoryForSession"];
  searchMemory: MemoryRepository["searchMemory"];
  getMemory: MemoryRepository["getMemory"];
  readMemoryContent: MemoryRepository["readMemoryContent"];
  readMemoryMarkdown: MemoryRepository["readMemoryMarkdown"];
  restoreMemoryVersionMarkdown: MemoryRepository["restoreMemoryVersionMarkdown"];
  archiveMemory: MemoryRepository["archiveMemory"];

  saveWikiPage: KnowledgeWikiRepository["saveWikiPage"];
  listWiki: KnowledgeWikiRepository["listWiki"];
  searchWiki: KnowledgeWikiRepository["searchWiki"];
  getWiki: KnowledgeWikiRepository["getWiki"];
  readWikiContent: KnowledgeWikiRepository["readWikiContent"];
  readWikiMarkdown: KnowledgeWikiRepository["readWikiMarkdown"];
  updateWikiPage: KnowledgeWikiRepository["updateWikiPage"];
  patchWikiLearningMetadata: KnowledgeWikiRepository["patchWikiLearningMetadata"];
  restoreWikiVersionMarkdown: KnowledgeWikiRepository["restoreWikiVersionMarkdown"];
  setWikiState: KnowledgeWikiRepository["setWikiState"];

  saveSkillOptimizationRun: SkillRepository["saveSkillOptimizationRun"];
  getSkillOptimizationRun: SkillRepository["getSkillOptimizationRun"];
  listSkillOptimizationRuns: SkillRepository["listSkillOptimizationRuns"];
  saveSkillOptimizationDataset: SkillRepository["saveSkillOptimizationDataset"];
  getSkillOptimizationDataset: SkillRepository["getSkillOptimizationDataset"];
  saveOptimizationCandidate: SkillRepository["saveOptimizationCandidate"];
  getOptimizationCandidate: SkillRepository["getOptimizationCandidate"];
  listOptimizationCandidates: SkillRepository["listOptimizationCandidates"];
  saveOptimizationEvaluation: SkillRepository["saveOptimizationEvaluation"];
  listOptimizationEvaluations: SkillRepository["listOptimizationEvaluations"];
  saveSkillOptimizationSnapshot: SkillRepository["saveSkillOptimizationSnapshot"];
  getSkillOptimizationSnapshot: SkillRepository["getSkillOptimizationSnapshot"];
  saveOptimizationPromotion: SkillRepository["saveOptimizationPromotion"];
  listOptimizationPromotions: SkillRepository["listOptimizationPromotions"];
  acquireSkillOptimizationLock: SkillRepository["acquireSkillOptimizationLock"];
  getSkillOptimizationLock: SkillRepository["getSkillOptimizationLock"];
  releaseSkillOptimizationLock: SkillRepository["releaseSkillOptimizationLock"];
  saveSkillMarkdown: SkillRepository["saveSkillMarkdown"];
  listSkills: SkillRepository["listSkills"];
  listSkillIndexReadModel: SkillRepository["listSkillIndexReadModel"];
  getSkill: SkillRepository["getSkill"];
  readSkillMarkdown: SkillRepository["readSkillMarkdown"];
  patchSkill: SkillRepository["patchSkill"];
  updateSkillState: SkillRepository["updateSkillState"];
  replaceSkillContent: SkillRepository["replaceSkillContent"];
  patchSkillLearningMetadata: SkillRepository["patchSkillLearningMetadata"];
  restoreSkillVersionMarkdown: SkillRepository["restoreSkillVersionMarkdown"];
  replaceSkillContentIfUnchanged: SkillRepository["replaceSkillContentIfUnchanged"];
  recordSkillUsage: SkillRepository["recordSkillUsage"];
  getSkillUsage: SkillRepository["getSkillUsage"];
  listSkillUsage: SkillRepository["listSkillUsage"];
  writeSkillSupportFile: SkillRepository["writeSkillSupportFile"];
  readSkillSupportFile: SkillRepository["readSkillSupportFile"];
  listSkillSupportFiles: SkillRepository["listSkillSupportFiles"];
  listSkillSupportFileRefs: SkillRepository["listSkillSupportFileRefs"];
  searchSkills: SkillRepository["searchSkills"];

  recordLearningResourceUse: LearningRepository["recordLearningResourceUse"];
  listLearningResourceUses: LearningRepository["listLearningResourceUses"];
  saveLearningEvaluation: LearningRepository["saveLearningEvaluation"];
  listLearningEvaluations: LearningRepository["listLearningEvaluations"];
  saveLearningResourceVersion: LearningRepository["saveLearningResourceVersion"];
  getLearningResourceVersion: LearningRepository["getLearningResourceVersion"];
  getCurrentLearningResourceVersion: LearningRepository["getCurrentLearningResourceVersion"];
  listLearningResourceVersions: LearningRepository["listLearningResourceVersions"];
  readLearningResourceVersionContent: LearningRepository["readLearningResourceVersionContent"];
  saveLearningResourceEdge: LearningRepository["saveLearningResourceEdge"];
  listLearningResourceEdges: LearningRepository["listLearningResourceEdges"];
  createLearningSnapshot: LearningRepository["createLearningSnapshot"];
  listLearningSnapshots: LearningRepository["listLearningSnapshots"];
  pruneLearningSnapshots: LearningRepository["pruneLearningSnapshots"];
  restoreLearningSnapshot: LearningRepository["restoreLearningSnapshot"];
  saveBackgroundReviewChange: LearningRepository["saveBackgroundReviewChange"];
  rollbackBackgroundReviewMetadata: LearningRepository["rollbackBackgroundReviewMetadata"];
  listBackgroundReviewChanges: LearningRepository["listBackgroundReviewChanges"];
  saveLearningJobReport: LearningRepository["saveLearningJobReport"];
  listLearningJobReports: LearningRepository["listLearningJobReports"];
  getCuratorState: LearningRepository["getCuratorState"];
  saveCuratorState: LearningRepository["saveCuratorState"];
  createReflectionRun: LearningRepository["createReflectionRun"];
  createLearningReviewCandidate: LearningRepository["createLearningReviewCandidate"];
  updateReflectionRun: LearningRepository["updateReflectionRun"];
  getReflectionRun: LearningRepository["getReflectionRun"];
  getReflectionRunByCandidateKey: LearningRepository["getReflectionRunByCandidateKey"];
  listReflectionRuns: LearningRepository["listReflectionRuns"];
  saveReflectionSuggestion: LearningRepository["saveReflectionSuggestion"];
  updateReflectionSuggestion: LearningRepository["updateReflectionSuggestion"];
  listReflectionSuggestions: LearningRepository["listReflectionSuggestions"];
  saveExternalAssistRecord: LearningRepository["saveExternalAssistRecord"];
  listExternalAssistRecords: LearningRepository["listExternalAssistRecords"];
  getExternalAssistDiagnostics: LearningRepository["getExternalAssistDiagnostics"];

  saveCollectionSchema: CollectionRepository["saveCollectionSchema"];
  getCollectionSchema: CollectionRepository["getCollectionSchema"];
  listCollectionSchemas: CollectionRepository["listCollectionSchemas"];
  updateCollectionSchema: CollectionRepository["updateCollectionSchema"];
  saveCollectionRecord: CollectionRepository["saveCollectionRecord"];
  upsertCollectionRecord: CollectionRepository["upsertCollectionRecord"];
  deleteCollectionRecord: CollectionRepository["deleteCollectionRecord"];
  getCollectionRecord: CollectionRepository["getCollectionRecord"];
  listCollectionRecords: CollectionRepository["listCollectionRecords"];
  listCollectionPatches: CollectionRepository["listCollectionPatches"];
  getCollectionPatch: CollectionRepository["getCollectionPatch"];
  resolveCollectionRecordRefs: CollectionRepository["resolveCollectionRecordRefs"];
  evaluateCollectionTriggers: CollectionRepository["evaluateCollectionTriggers"];
  listCollectionTriggerStates: CollectionRepository["listCollectionTriggerStates"];
  applyCollectionRecordPatch: CollectionRepository["applyCollectionRecordPatch"];
  listCollectionNotes: CollectionRepository["listCollectionNotes"];

  saveAutomationJob: AutomationRepository["saveAutomationJob"];
  getAutomationJob: AutomationRepository["getAutomationJob"];
  listAutomationJobs: AutomationRepository["listAutomationJobs"];
  acquireAutomationJobLock: AutomationRepository["acquireAutomationJobLock"];
  heartbeatAutomationJobLock: AutomationRepository["heartbeatAutomationJobLock"];
  releaseAutomationJobLock: AutomationRepository["releaseAutomationJobLock"];
  requeueAutomationJob: AutomationRepository["requeueAutomationJob"];
  getAutomationQueueSummary: AutomationRepository["getAutomationQueueSummary"];
  createAutomationRun: AutomationRepository["createAutomationRun"];
  updateAutomationRun: AutomationRepository["updateAutomationRun"];
  getAutomationRun: AutomationRepository["getAutomationRun"];
  listAutomationRuns: AutomationRepository["listAutomationRuns"];

  saveExternalSend: GatewayRepository["saveExternalSend"];
  getExternalSend: GatewayRepository["getExternalSend"];
  listExternalSends: GatewayRepository["listExternalSends"];
  saveGatewayPairingPolicy: GatewayRepository["saveGatewayPairingPolicy"];
  getGatewayPairingPolicy: GatewayRepository["getGatewayPairingPolicy"];
  listGatewayPairingPolicies: GatewayRepository["listGatewayPairingPolicies"];
  saveGatewayRoutingPolicy: GatewayRepository["saveGatewayRoutingPolicy"];
  getGatewayRoutingPolicy: GatewayRepository["getGatewayRoutingPolicy"];
  listGatewayRoutingPolicies: GatewayRepository["listGatewayRoutingPolicies"];
  saveGatewayPairing: GatewayRepository["saveGatewayPairing"];
  getGatewayPairing: GatewayRepository["getGatewayPairing"];
  findGatewayPairing: GatewayRepository["findGatewayPairing"];
  listGatewayPairings: GatewayRepository["listGatewayPairings"];
  expireGatewayPairings: GatewayRepository["expireGatewayPairings"];
  saveGatewayInboundMessage: GatewayRepository["saveGatewayInboundMessage"];
  listGatewayInboundMessages: GatewayRepository["listGatewayInboundMessages"];
  enqueueGatewayDelivery: GatewayRepository["enqueueGatewayDelivery"];
  getGatewayDelivery: GatewayRepository["getGatewayDelivery"];
  listGatewayDeliveries: GatewayRepository["listGatewayDeliveries"];
  claimGatewayDelivery: GatewayRepository["claimGatewayDelivery"];
  completeGatewayDelivery: GatewayRepository["completeGatewayDelivery"];
  failGatewayDelivery: GatewayRepository["failGatewayDelivery"];
  reconcileExpiredGatewayDeliveries: GatewayRepository["reconcileExpiredGatewayDeliveries"];
  saveGatewayBoundaryPolicy: GatewayRepository["saveGatewayBoundaryPolicy"];
  getGatewayBoundaryPolicy: GatewayRepository["getGatewayBoundaryPolicy"];
  listGatewayBoundaryPolicies: GatewayRepository["listGatewayBoundaryPolicies"];
  saveGatewayMcpConfig: GatewayRepository["saveGatewayMcpConfig"];
  getGatewayMcpConfig: GatewayRepository["getGatewayMcpConfig"];
  getGatewayMcpConfigByServerName: GatewayRepository["getGatewayMcpConfigByServerName"];
  listGatewayMcpConfigs: GatewayRepository["listGatewayMcpConfigs"];
  acquireGatewayConcurrencyLock: GatewayRepository["acquireGatewayConcurrencyLock"];
  getGatewayConcurrencyLock: GatewayRepository["getGatewayConcurrencyLock"];
  releaseGatewayConcurrencyLock: GatewayRepository["releaseGatewayConcurrencyLock"];
  expireGatewayConcurrencyLocks: GatewayRepository["expireGatewayConcurrencyLocks"];
  reclaimExpiredGatewayConcurrencyLocks: GatewayRepository["reclaimExpiredGatewayConcurrencyLocks"];
  listGatewayConcurrencyLocks: GatewayRepository["listGatewayConcurrencyLocks"];
  saveGatewaySandboxInstance: GatewayRepository["saveGatewaySandboxInstance"];
  getGatewaySandboxInstance: GatewayRepository["getGatewaySandboxInstance"];
  listGatewaySandboxInstances: GatewayRepository["listGatewaySandboxInstances"];
  saveGatewaySandboxWorkspaceSync: GatewayRepository["saveGatewaySandboxWorkspaceSync"];
  listGatewaySandboxWorkspaceSyncs: GatewayRepository["listGatewaySandboxWorkspaceSyncs"];

  getSettings: WorkspaceMetadataRepository["getSettings"];
  patchSettings: WorkspaceMetadataRepository["patchSettings"];
  savePluginState: WorkspaceMetadataRepository["savePluginState"];
  listPluginStates: WorkspaceMetadataRepository["listPluginStates"];
  saveResourceTranslation: WorkspaceMetadataRepository["saveResourceTranslation"];
  listResourceTranslations: WorkspaceMetadataRepository["listResourceTranslations"];
  resolveResourceTranslation: WorkspaceMetadataRepository["resolveResourceTranslation"];

  savePolicyDecision: AccessHistoryRepository["savePolicyDecision"];
  listPolicyDecisions: AccessHistoryRepository["listPolicyDecisions"];
  listPolicyDecisionsForOperationIds: AccessHistoryRepository["listPolicyDecisionsForOperationIds"];
  getPolicyDecision: AccessHistoryRepository["getPolicyDecision"];
  saveApprovalRequest: AccessHistoryRepository["saveApprovalRequest"];
  updateApprovalRequest: AccessHistoryRepository["updateApprovalRequest"];
  getApprovalRequest: AccessHistoryRepository["getApprovalRequest"];
  listApprovalRequests: AccessHistoryRepository["listApprovalRequests"];
  listApprovalRequestsForOperationIds: AccessHistoryRepository["listApprovalRequestsForOperationIds"];
  saveAuditRecord: AccessHistoryRepository["saveAuditRecord"];
  updateAuditRecord: AccessHistoryRepository["updateAuditRecord"];
  listAuditRecords: AccessHistoryRepository["listAuditRecords"];
  listAuditRecordsForRoom: AccessHistoryRepository["listAuditRecordsForRoom"];
  listAuditRecordsForOperation: AccessHistoryRepository["listAuditRecordsForOperation"];
  saveRollbackPoint: AccessHistoryRepository["saveRollbackPoint"];
  listRollbackPoints: AccessHistoryRepository["listRollbackPoints"];
  listRollbackPointsForOperationIds: AccessHistoryRepository["listRollbackPointsForOperationIds"];
  getRollbackPoint: AccessHistoryRepository["getRollbackPoint"];
  getRollbackPointForOperationIds: AccessHistoryRepository["getRollbackPointForOperationIds"];
  listGrants: AccessHistoryRepository["listGrants"];
  getGrant: AccessHistoryRepository["getGrant"];
  saveGrant: AccessHistoryRepository["saveGrant"];
  revokeGrant: AccessHistoryRepository["revokeGrant"];

  exportSessionTranscript: WorkspaceQueryService["exportSessionTranscript"];
  getCorrelationTrace: WorkspaceQueryService["getCorrelationTrace"];
  reindexSessionSearch: WorkspaceQueryService["reindexSessionSearch"];
  getSessionSearchMode: WorkspaceQueryService["getSessionSearchMode"];
  search: WorkspaceQueryService["search"];
  readActivityInputs: WorkspaceQueryService["readActivityInputs"];

  inspectWorkspace: WorkspaceMaintenanceService["inspectWorkspace"];
  checkIntegrity: WorkspaceMaintenanceService["checkIntegrity"];
  listMigrationJournal: WorkspaceMaintenanceService["listMigrationJournal"];
  repairWorkspace: WorkspaceMaintenanceService["repairWorkspace"];
  createWorkspaceBackup: WorkspaceBundleService["createWorkspaceBackup"];
  listWorkspaceBackups: WorkspaceBundleService["listWorkspaceBackups"];
  applyResourceRetention: WorkspaceMaintenanceService["applyResourceRetention"];
  exportWorkspaceBundle: WorkspaceBundleService["exportWorkspaceBundle"];
  importWorkspaceBundle: WorkspaceBundleService["importWorkspaceBundle"];
  restoreWorkspaceBackup: WorkspaceRestoreCoordinator["restoreWorkspaceBackup"];
}
