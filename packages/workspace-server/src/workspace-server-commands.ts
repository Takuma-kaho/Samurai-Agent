import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import {
  readWorkspaceBundleV3Transport,
  verifyWorkspaceBundleV3,
  WorkspaceBundleV3Service,
  writeWorkspaceBundleV3Transport
} from "./workspace-bundle-v3";
import {
  readWorkspaceBundleV4Transport,
  verifyWorkspaceBundleV4,
  WorkspaceBundleV4Service,
  writeWorkspaceBundleV4Transport,
  type StageWorkspaceBundleV4Input
} from "./workspace-completion-bundle-v4";
import { WorkspaceFileStore } from "./workspace-files";
import { WorkspaceCompletionService } from "./workspace-completion-service";
import { WorkspaceCompletionMigrationService } from "./workspace-completion-migration";
import { WorkspaceCompletionMaintenanceService } from "./workspace-completion-maintenance";
import { WorkspaceRuntimeActivityService } from "./workspace-runtime-activity";
import { WorkspaceServerStore } from "./workspace-server-store";
import type { OrganizationRequestContext, WorkspaceBundleV3Manifest, WorkspaceExternalRoomAction, WorkspaceExternalRoomPrincipal, WorkspaceRequestContext } from "./types";
import type { ActivityRecord, ResourceUsageRecord } from "@samurai-agent/core-schemas";

export interface WorkspaceServerCommandDependencies {
  store: WorkspaceServerStore;
  files: WorkspaceFileStore;
  bundles: WorkspaceBundleV3Service;
  /** Standard transfer and import path. V3 remains only for compatibility inputs. */
  completionBundles?: WorkspaceBundleV4Service;
  /** Optional while old callers migrate; the running Core always supplies it. */
  completion?: WorkspaceCompletionService;
  completionMigrations?: WorkspaceCompletionMigrationService;
  maintenance?: WorkspaceCompletionMaintenanceService;
  /** Runtime Activity evidence is optional while old callers migrate. */
  runtimeActivities?: WorkspaceRuntimeActivityService;
}

export interface ImportWorkspaceBundleTransportInput {
  transport: unknown;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  /** Restore target is explicit; it is never inferred from Self-host config. */
  targetOrganizationId?: string;
}

/**
 * PostgreSQL Workspace Serverの更新入口。
 *
 * HTTPなどの外部入口はStoreやファイル領域を直接更新せず、必ずこの層を
 * 通す。RLS、版番号、操作ID、監査の実処理は各永続化サービスへ委譲し、
 * ここでは1つのDomain Operationに必要な複数サービスの手順だけを束ねる。
 */
export class WorkspaceServerCommandService {
  private readonly store: WorkspaceServerStore;
  private readonly files: WorkspaceFileStore;
  private readonly bundles: WorkspaceBundleV3Service;
  private readonly completionBundles?: WorkspaceBundleV4Service;
  private readonly completion?: WorkspaceCompletionService;
  private readonly completionMigrations?: WorkspaceCompletionMigrationService;
  private readonly maintenance?: WorkspaceCompletionMaintenanceService;
  private readonly runtimeActivities?: WorkspaceRuntimeActivityService;

  constructor(dependencies: WorkspaceServerCommandDependencies) {
    this.store = dependencies.store;
    this.files = dependencies.files;
    this.bundles = dependencies.bundles;
    this.completionBundles = dependencies.completionBundles;
    this.completion = dependencies.completion;
    this.completionMigrations = dependencies.completionMigrations;
    this.maintenance = dependencies.maintenance;
    this.runtimeActivities = dependencies.runtimeActivities;
  }

  registerAccount(input: Parameters<WorkspaceServerStore["registerAccount"]>[0]) {
    return this.store.registerAccount(input);
  }

  createWorkspace(input: Parameters<WorkspaceServerStore["createWorkspace"]>[0]) {
    return this.store.createWorkspace(input);
  }

  listOrganizations(
    context: Parameters<WorkspaceServerStore["listOrganizations"]>[0],
    input?: Parameters<WorkspaceServerStore["listOrganizations"]>[1]
  ) {
    return this.store.listOrganizations(context, input);
  }

  viewOrganization(context: OrganizationRequestContext, organizationId: string) {
    return this.store.viewOrganization(context, organizationId);
  }

  createOrganization(
    context: Parameters<WorkspaceServerStore["createOrganization"]>[0],
    input: Parameters<WorkspaceServerStore["createOrganization"]>[1]
  ) {
    return this.store.createOrganization(context, input);
  }

  patchOrganization(
    context: Parameters<WorkspaceServerStore["patchOrganization"]>[0],
    input: Parameters<WorkspaceServerStore["patchOrganization"]>[1]
  ) {
    return this.store.patchOrganization(context, input);
  }

  deleteOrganization(
    context: Parameters<WorkspaceServerStore["deleteOrganization"]>[0],
    input: Parameters<WorkspaceServerStore["deleteOrganization"]>[1]
  ) {
    return this.store.deleteOrganization(context, input);
  }

  listOrganizationMembers(
    context: Parameters<WorkspaceServerStore["listOrganizationMembers"]>[0],
    input?: Parameters<WorkspaceServerStore["listOrganizationMembers"]>[1]
  ) {
    return this.store.listOrganizationMembers(context, input);
  }

  inviteOrganizationMember(
    context: Parameters<WorkspaceServerStore["inviteOrganizationMember"]>[0],
    input: Parameters<WorkspaceServerStore["inviteOrganizationMember"]>[1]
  ) {
    return this.store.inviteOrganizationMember(context, input);
  }

  acceptOrganizationInvitation(
    context: Parameters<WorkspaceServerStore["acceptOrganizationInvitation"]>[0],
    input: Parameters<WorkspaceServerStore["acceptOrganizationInvitation"]>[1]
  ) {
    return this.store.acceptOrganizationInvitation(context, input);
  }

  changeOrganizationMemberRole(
    context: Parameters<WorkspaceServerStore["changeOrganizationMemberRole"]>[0],
    input: Parameters<WorkspaceServerStore["changeOrganizationMemberRole"]>[1]
  ) {
    return this.store.changeOrganizationMemberRole(context, input);
  }

  removeOrganizationMember(
    context: Parameters<WorkspaceServerStore["removeOrganizationMember"]>[0],
    input: Parameters<WorkspaceServerStore["removeOrganizationMember"]>[1]
  ) {
    return this.store.removeOrganizationMember(context, input);
  }

  leaveOrganization(
    context: Parameters<WorkspaceServerStore["leaveOrganization"]>[0],
    input?: Parameters<WorkspaceServerStore["leaveOrganization"]>[1]
  ) {
    return this.store.leaveOrganization(context, input);
  }

  listOrganizationInvitations(
    context: Parameters<WorkspaceServerStore["listOrganizationInvitations"]>[0],
    input?: Parameters<WorkspaceServerStore["listOrganizationInvitations"]>[1]
  ) {
    return this.store.listOrganizationInvitations(context, input);
  }

  revokeOrganizationInvitation(
    context: Parameters<WorkspaceServerStore["revokeOrganizationInvitation"]>[0],
    input: Parameters<WorkspaceServerStore["revokeOrganizationInvitation"]>[1]
  ) {
    return this.store.revokeOrganizationInvitation(context, input);
  }

  reissueOrganizationInvitation(
    context: Parameters<WorkspaceServerStore["reissueOrganizationInvitation"]>[0],
    input: Parameters<WorkspaceServerStore["reissueOrganizationInvitation"]>[1]
  ) {
    return this.store.reissueOrganizationInvitation(context, input);
  }

  extendOrganizationInvitation(
    context: Parameters<WorkspaceServerStore["extendOrganizationInvitation"]>[0],
    input: Parameters<WorkspaceServerStore["extendOrganizationInvitation"]>[1]
  ) {
    return this.store.extendOrganizationInvitation(context, input);
  }

  listOrganizationWorkspaces(
    context: Parameters<WorkspaceServerStore["listOrganizationWorkspaces"]>[0],
    input?: Parameters<WorkspaceServerStore["listOrganizationWorkspaces"]>[1]
  ) {
    return this.store.listOrganizationWorkspaces(context, input);
  }

  createOrganizationWorkspace(
    context: Parameters<WorkspaceServerStore["createOrganizationWorkspace"]>[0],
    input: Parameters<WorkspaceServerStore["createOrganizationWorkspace"]>[1]
  ) {
    return this.store.createOrganizationWorkspace(context, input);
  }

  grantOrganizationWorkspaceMembership(
    context: Parameters<WorkspaceServerStore["grantOrganizationWorkspaceMembership"]>[0],
    input: Parameters<WorkspaceServerStore["grantOrganizationWorkspaceMembership"]>[1]
  ) {
    return this.store.grantOrganizationWorkspaceMembership(context, input);
  }

  revokeOrganizationWorkspaceMembership(
    context: Parameters<WorkspaceServerStore["revokeOrganizationWorkspaceMembership"]>[0],
    input: Parameters<WorkspaceServerStore["revokeOrganizationWorkspaceMembership"]>[1]
  ) {
    return this.store.revokeOrganizationWorkspaceMembership(context, input);
  }

  archiveOrganizationWorkspace(
    context: Parameters<WorkspaceServerStore["archiveOrganizationWorkspace"]>[0],
    input: Parameters<WorkspaceServerStore["archiveOrganizationWorkspace"]>[1]
  ) {
    return this.store.archiveOrganizationWorkspace(context, input);
  }

  restoreOrganizationWorkspace(
    context: Parameters<WorkspaceServerStore["restoreOrganizationWorkspace"]>[0],
    input: Parameters<WorkspaceServerStore["restoreOrganizationWorkspace"]>[1]
  ) {
    return this.store.restoreOrganizationWorkspace(context, input);
  }

  deleteOrganizationWorkspace(
    context: Parameters<WorkspaceServerStore["deleteOrganizationWorkspace"]>[0],
    input: Parameters<WorkspaceServerStore["deleteOrganizationWorkspace"]>[1]
  ) {
    return this.store.deleteOrganizationWorkspace(context, input);
  }

  exportWorkspaceBundle(
    context: Parameters<WorkspaceServerStore["exportWorkspaceBundle"]>[0],
    input: Parameters<WorkspaceServerStore["exportWorkspaceBundle"]>[1]
  ) {
    return this.exportWorkspaceBundleThroughService(context, input);
  }

  restoreWorkspaceBundle(
    context: Parameters<WorkspaceServerStore["restoreWorkspaceBundle"]>[0],
    input: Parameters<WorkspaceServerStore["restoreWorkspaceBundle"]>[1]
  ) {
    return this.restoreWorkspaceBundleThroughService(context, input);
  }

  preflightWorkspaceOrganizationMove(
    context: Parameters<WorkspaceServerStore["preflightWorkspaceOrganizationMove"]>[0],
    input: Parameters<WorkspaceServerStore["preflightWorkspaceOrganizationMove"]>[1]
  ) {
    return this.store.preflightWorkspaceOrganizationMove(context, input);
  }

  commitWorkspaceOrganizationMove(
    context: Parameters<WorkspaceServerStore["commitWorkspaceOrganizationMove"]>[0],
    input: Parameters<WorkspaceServerStore["commitWorkspaceOrganizationMove"]>[1]
  ) {
    return this.store.commitWorkspaceOrganizationMove(context, input);
  }

  attachWorkspaceToOrganization(
    context: Parameters<WorkspaceServerStore["attachWorkspaceToOrganization"]>[0],
    input: Parameters<WorkspaceServerStore["attachWorkspaceToOrganization"]>[1]
  ) {
    return this.store.attachWorkspaceToOrganization(context, input);
  }

  detachWorkspaceFromOrganization(
    context: Parameters<WorkspaceServerStore["detachWorkspaceFromOrganization"]>[0],
    input: Parameters<WorkspaceServerStore["detachWorkspaceFromOrganization"]>[1]
  ) {
    return this.store.detachWorkspaceFromOrganization(context, input);
  }

  getWorkspaceOrganizationMoveStatus(context: OrganizationRequestContext, operationId: string) {
    return this.store.getWorkspaceOrganizationMoveStatus(context, operationId);
  }

  registerAgent(
    context: Parameters<WorkspaceServerStore["registerAgent"]>[0],
    input: Parameters<WorkspaceServerStore["registerAgent"]>[1]
  ) {
    return this.store.registerAgent(context, input);
  }

  patchRoom(
    context: Parameters<WorkspaceServerStore["patchRoom"]>[0],
    input: Parameters<WorkspaceServerStore["patchRoom"]>[1]
  ) {
    return this.store.patchRoom(context, input);
  }

  patchAgent(
    context: Parameters<WorkspaceServerStore["patchAgent"]>[0],
    input: Parameters<WorkspaceServerStore["patchAgent"]>[1]
  ) {
    return this.store.patchAgent(context, input);
  }

  bindAgentBackend(
    context: Parameters<WorkspaceServerStore["bindAgentBackend"]>[0],
    input: Parameters<WorkspaceServerStore["bindAgentBackend"]>[1]
  ) {
    return this.store.bindAgentBackend(context, input);
  }

  appendPublicEvent(
    context: Parameters<WorkspaceServerStore["appendPublicEvent"]>[0],
    input: Parameters<WorkspaceServerStore["appendPublicEvent"]>[1]
  ) {
    return this.store.appendPublicEvent(context, input);
  }

  setAgentRoomPermission(
    context: Parameters<WorkspaceServerStore["setAgentRoomPermission"]>[0],
    input: Parameters<WorkspaceServerStore["setAgentRoomPermission"]>[1]
  ) {
    return this.store.setAgentRoomPermission(context, input);
  }

  upsertConnectionDescriptor(
    context: Parameters<WorkspaceServerStore["upsertConnectionDescriptor"]>[0],
    input: Parameters<WorkspaceServerStore["upsertConnectionDescriptor"]>[1]
  ) {
    return this.store.upsertConnectionDescriptor(context, input);
  }

  getWorkspace(context: Parameters<WorkspaceServerStore["getWorkspace"]>[0]) {
    return this.store.getWorkspace(context);
  }

  listRooms(context: Parameters<WorkspaceServerStore["listRooms"]>[0]) {
    return this.store.listRooms(context);
  }

  getExternalConnectionDescriptor(input: Parameters<WorkspaceServerStore["getExternalConnectionDescriptor"]>[0]) {
    return this.store.getExternalConnectionDescriptor(input);
  }

  canExternalRoomAccess(input: {
    workspaceId: string;
    roomId: string;
    principal: WorkspaceExternalRoomPrincipal;
    action: WorkspaceExternalRoomAction;
  }) {
    return this.store.canExternalRoomAccess(input);
  }

  async importWorkspaceBundleTransport(
    context: Parameters<WorkspaceBundleV3Service["importNew"]>[0],
    input: ImportWorkspaceBundleTransportInput
  ) {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    const staging = path.join(
      this.store.storageRoot,
      ".uploads",
      context.accountId,
      `bundle_${context.operationId}`
    );
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    try {
      const format = input.transport && typeof input.transport === "object" && !Array.isArray(input.transport)
        ? (input.transport as { format?: unknown }).format
        : undefined;
      if (format === "samurai-workspace-bundle-v4") {
        if (!this.completionBundles) throw new WorkspaceServerError("workspace_completion_bundle_service_unavailable", 503);
        const bundle = await writeWorkspaceBundleV4Transport({ transport: input.transport, destination: staging });
        return await this.completionBundles.importNew(context, {
          sourceDirectory: bundle.directory,
          targetWorkspaceId: input.targetWorkspaceId,
          targetOrganizationId: input.targetOrganizationId,
          ...(input.targetWorkspaceName ? { targetWorkspaceName: input.targetWorkspaceName } : {})
        });
      }
      const bundle = await writeWorkspaceBundleV3Transport({ transport: input.transport, destination: staging });
      return await this.bundles.importNew(context, {
        sourceDirectory: bundle.directory,
        targetWorkspaceId: input.targetWorkspaceId,
        targetOrganizationId: input.targetOrganizationId,
        ...(input.targetWorkspaceName ? { targetWorkspaceName: input.targetWorkspaceName } : {})
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  stageWorkspaceBundle(
    context: Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[0],
    input: Omit<Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[1], "manifest"> & { manifest: WorkspaceBundleV3Manifest | StageWorkspaceBundleV4Input["manifest"] }
  ) {
    if (isV4StageInput(input)) {
      if (!this.completionBundles) throw new WorkspaceServerError("workspace_completion_bundle_service_unavailable", 503);
      return this.completionBundles.stageIncomingBundle(context, input);
    }
    return this.bundles.stageIncomingBundle(context, input as Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[1]);
  }

  writeWorkspaceBundleEntry(
    context: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[0],
    entryPath: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[1],
    content: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[2]
  ) {
    if (this.completionBundles) {
      return this.completionBundles.hasIncomingBundle(context).then((isV4) =>
        isV4
          ? this.completionBundles!.putIncomingBundleEntry(context, entryPath, content)
          : this.bundles.putIncomingBundleEntry(context, entryPath, content)
      );
    }
    return this.bundles.putIncomingBundleEntry(context, entryPath, content);
  }

  completeWorkspaceBundleImport(
    context: Parameters<WorkspaceBundleV3Service["completeIncomingBundle"]>[0]
  ): Promise<Awaited<ReturnType<WorkspaceBundleV3Service["completeIncomingBundle"]>> | Awaited<ReturnType<WorkspaceBundleV4Service["completeIncomingBundle"]>>> {
    if (this.completionBundles) {
      return this.completionBundles.hasIncomingBundle(context).then<
        Awaited<ReturnType<WorkspaceBundleV3Service["completeIncomingBundle"]>> | Awaited<ReturnType<WorkspaceBundleV4Service["completeIncomingBundle"]>>
      >(async (isV4) => isV4
        ? this.completionBundles!.completeIncomingBundle(context)
        : this.bundles.completeIncomingBundle(context)
      );
    }
    return this.bundles.completeIncomingBundle(context);
  }

  createRoom(
    context: Parameters<WorkspaceServerStore["createRoom"]>[0],
    input: Parameters<WorkspaceServerStore["createRoom"]>[1]
  ) {
    return this.store.createRoom(context, input);
  }

  moveRoom(
    context: Parameters<WorkspaceServerStore["moveRoom"]>[0],
    input: Parameters<WorkspaceServerStore["moveRoom"]>[1]
  ) {
    return this.store.moveRoom(context, input);
  }

  setWorkspaceMember(
    context: Parameters<WorkspaceServerStore["setWorkspaceMember"]>[0],
    input: Parameters<WorkspaceServerStore["setWorkspaceMember"]>[1]
  ) {
    return this.store.setWorkspaceMember(context, input);
  }

  setRoomMember(
    context: Parameters<WorkspaceServerStore["setRoomMember"]>[0],
    input: Parameters<WorkspaceServerStore["setRoomMember"]>[1]
  ) {
    return this.store.setRoomMember(context, input);
  }

  createInvitation(
    context: Parameters<WorkspaceServerStore["createInvitation"]>[0],
    input: Parameters<WorkspaceServerStore["createInvitation"]>[1]
  ) {
    return this.store.createInvitation(context, input);
  }

  acceptInvitation(
    context: Parameters<WorkspaceServerStore["acceptInvitation"]>[0],
    token: Parameters<WorkspaceServerStore["acceptInvitation"]>[1]
  ) {
    return this.store.acceptInvitation(context, token);
  }

  revokeInvitation(
    context: Parameters<WorkspaceServerStore["revokeInvitation"]>[0],
    invitationId: Parameters<WorkspaceServerStore["revokeInvitation"]>[1],
    expectedVersion: Parameters<WorkspaceServerStore["revokeInvitation"]>[2]
  ) {
    return this.store.revokeInvitation(context, invitationId, expectedVersion);
  }

  putRecord(
    context: Parameters<WorkspaceServerStore["putRecord"]>[0],
    input: Parameters<WorkspaceServerStore["putRecord"]>[1]
  ) {
    return this.store.putRecord(context, input);
  }

  deleteRecord(
    context: Parameters<WorkspaceServerStore["deleteRecord"]>[0],
    input: Parameters<WorkspaceServerStore["deleteRecord"]>[1]
  ) {
    return this.store.deleteRecord(context, input);
  }

  getRecord(
    context: Parameters<WorkspaceServerStore["getRecord"]>[0],
    input: Parameters<WorkspaceServerStore["getRecord"]>[1]
  ) {
    return this.store.getRecord(context, input);
  }

  listRecords(
    context: Parameters<WorkspaceServerStore["listRecords"]>[0],
    input: Parameters<WorkspaceServerStore["listRecords"]>[1]
  ) {
    return this.store.listRecords(context, input);
  }

  assertRoomExecutable(
    context: Parameters<WorkspaceServerStore["assertRoomExecutable"]>[0],
    roomId: Parameters<WorkspaceServerStore["assertRoomExecutable"]>[1]
  ) {
    return this.store.assertRoomExecutable(context, roomId);
  }

  putJob(
    context: Parameters<WorkspaceServerStore["putJob"]>[0],
    input: Parameters<WorkspaceServerStore["putJob"]>[1]
  ) {
    return this.store.putJob(context, input);
  }

  writeFile(
    context: Parameters<WorkspaceFileStore["write"]>[0],
    input: Parameters<WorkspaceFileStore["write"]>[1]
  ) {
    return this.files.write(context, input);
  }

  ingestCompletionActivity(
    context: Parameters<WorkspaceCompletionService["ingestActivity"]>[0],
    input: Parameters<WorkspaceCompletionService["ingestActivity"]>[1]
  ) {
    return this.requireCompletion().ingestActivity(context, input);
  }

  listCompletionActivities(
    context: Parameters<WorkspaceCompletionService["listActivities"]>[0],
    input: Parameters<WorkspaceCompletionService["listActivities"]>[1]
  ) {
    return this.requireCompletion().listActivities(context, input);
  }

  startRuntimeActivity(context: WorkspaceRequestContext, record: ActivityRecord) {
    return this.requireRuntimeActivities().createActivity(context, record);
  }

  getRuntimeActivity(context: WorkspaceRequestContext, activityId: string) {
    return this.requireRuntimeActivities().getActivity(context, activityId);
  }

  getRuntimeActivityOperation(context: WorkspaceRequestContext, operationId: string) {
    return this.requireRuntimeActivities().getOperation(context, operationId);
  }

  linkRuntimeActivityBackendRun(
    context: WorkspaceRequestContext,
    input: Parameters<WorkspaceRuntimeActivityService["linkActivityBackendRun"]>[1]
  ) {
    return this.requireRuntimeActivities().linkActivityBackendRun(context, input);
  }

  recordRuntimeResourceUsage(context: WorkspaceRequestContext, record: ResourceUsageRecord) {
    return this.requireRuntimeActivities().recordResourceUsage(context, record);
  }

  ingestFinalizedRuntimeActivity(
    context: WorkspaceRequestContext,
    input: Parameters<WorkspaceRuntimeActivityService["ingestFinalizedActivity"]>[1]
  ) {
    return this.requireRuntimeActivities().ingestFinalizedActivity(context, input);
  }

  ingestFinalizedRuntimeActivityWithReplay(
    context: WorkspaceRequestContext,
    input: Parameters<WorkspaceRuntimeActivityService["ingestFinalizedActivity"]>[1]
  ) {
    return this.requireRuntimeActivities().ingestFinalizedActivityWithReplay(context, input);
  }

  finalizeRuntimeActivity(
    context: WorkspaceRequestContext,
    input: Parameters<WorkspaceRuntimeActivityService["finalizeActivity"]>[1]
  ) {
    return this.requireRuntimeActivities().finalizeActivity(context, input);
  }

  listRuntimeResourceUsage(
    context: WorkspaceRequestContext,
    input: Parameters<WorkspaceRuntimeActivityService["listResourceUsage"]>[1]
  ) {
    return this.requireRuntimeActivities().listResourceUsage(context, input);
  }

  createCompletionEpisode(
    context: Parameters<WorkspaceCompletionService["createEpisode"]>[0],
    input: Parameters<WorkspaceCompletionService["createEpisode"]>[1]
  ) {
    return this.requireCompletion().createEpisode(context, input);
  }

  createCompletionResource(
    context: Parameters<WorkspaceCompletionService["createResource"]>[0],
    input: Parameters<WorkspaceCompletionService["createResource"]>[1]
  ) {
    return this.requireCompletion().createResource(context, input);
  }

  updateCompletionResource(
    context: Parameters<WorkspaceCompletionService["updateResource"]>[0],
    resourceId: Parameters<WorkspaceCompletionService["updateResource"]>[1],
    input: Parameters<WorkspaceCompletionService["updateResource"]>[2]
  ) {
    return this.requireCompletion().updateResource(context, resourceId, input);
  }

  setCompletionResourceFixed(
    context: Parameters<WorkspaceCompletionService["setResourceFixed"]>[0],
    input: Parameters<WorkspaceCompletionService["setResourceFixed"]>[1]
  ) {
    return this.requireCompletion().setResourceFixed(context, input);
  }

  setCompletionResourceArchived(
    context: Parameters<WorkspaceCompletionService["setResourceArchived"]>[0],
    input: Parameters<WorkspaceCompletionService["setResourceArchived"]>[1]
  ) {
    return this.requireCompletion().setResourceArchived(context, input);
  }

  redactCompletionResource(
    context: Parameters<WorkspaceCompletionService["redactResource"]>[0],
    input: Parameters<WorkspaceCompletionService["redactResource"]>[1]
  ) {
    return this.requireCompletion().redactResource(context, input);
  }

  redactCompletionRawJobOutput(
    context: Parameters<WorkspaceCompletionService["redactRawJobOutput"]>[0],
    input: Parameters<WorkspaceCompletionService["redactRawJobOutput"]>[1]
  ) {
    return this.requireCompletion().redactRawJobOutput(context, input);
  }

  promoteCompletionCandidate(
    context: Parameters<WorkspaceCompletionService["promoteCandidate"]>[0],
    input: Parameters<WorkspaceCompletionService["promoteCandidate"]>[1]
  ) {
    return this.requireCompletion().promoteCandidate(context, input);
  }

  copyCompletionResource(
    context: Parameters<WorkspaceCompletionService["copyResource"]>[0],
    input: Parameters<WorkspaceCompletionService["copyResource"]>[1]
  ) {
    return this.requireCompletion().copyResource(context, input);
  }

  promoteCompletionResourceToWorkspace(
    context: Parameters<WorkspaceCompletionService["promoteToWorkspace"]>[0],
    input: Parameters<WorkspaceCompletionService["promoteToWorkspace"]>[1]
  ) {
    return this.requireCompletion().promoteToWorkspace(context, input);
  }

  moveCompletionResource(
    context: Parameters<WorkspaceCompletionService["moveResource"]>[0],
    input: Parameters<WorkspaceCompletionService["moveResource"]>[1]
  ) {
    return this.requireCompletion().moveResource(context, input);
  }

  applyCompletionPolicy(
    context: Parameters<WorkspaceCompletionService["applyPolicy"]>[0],
    input: Parameters<WorkspaceCompletionService["applyPolicy"]>[1]
  ) {
    return this.requireCompletion().applyPolicy(context, input);
  }

  requestCompletionPolicyChange(
    context: Parameters<WorkspaceCompletionService["requestPolicyChange"]>[0],
    input: Parameters<WorkspaceCompletionService["requestPolicyChange"]>[1]
  ) {
    return this.requireCompletion().requestPolicyChange(context, input);
  }

  recordCompletionUse(
    context: Parameters<WorkspaceCompletionService["recordUse"]>[0],
    input: Parameters<WorkspaceCompletionService["recordUse"]>[1]
  ) {
    return this.requireCompletion().recordUse(context, input);
  }

  recordCompletionEvaluation(
    context: Parameters<WorkspaceCompletionService["recordEvaluation"]>[0],
    input: Parameters<WorkspaceCompletionService["recordEvaluation"]>[1]
  ) {
    return this.requireCompletion().recordEvaluation(context, input);
  }

  updateCompletionConfiguration(
    context: Parameters<WorkspaceCompletionService["updateConfiguration"]>[0],
    input: Parameters<WorkspaceCompletionService["updateConfiguration"]>[1]
  ) {
    return this.requireCompletion().updateConfiguration(context, input);
  }

  migrateCompletionLegacy(
    context: Parameters<WorkspaceCompletionMigrationService["migrateLegacy"]>[0],
    input: Parameters<WorkspaceCompletionMigrationService["migrateLegacy"]>[1]
  ) {
    if (!this.completionMigrations) throw new WorkspaceServerError("workspace_completion_migration_service_unavailable", 503);
    return this.completionMigrations.migrateLegacy(context, input);
  }

  configureCompletionMaintenanceIdentity(
    context: Parameters<WorkspaceCompletionMaintenanceService["configureIdentity"]>[0],
    input: Parameters<WorkspaceCompletionMaintenanceService["configureIdentity"]>[1]
  ) {
    return this.requireMaintenance().configureIdentity(context, input);
  }

  writeCompletionWorkspaceDocument(
    context: Parameters<WorkspaceCompletionService["writeWorkspaceDocument"]>[0],
    input: Parameters<WorkspaceCompletionService["writeWorkspaceDocument"]>[1]
  ) {
    return this.requireCompletion().writeWorkspaceDocument(context, input);
  }

  private requireCompletion(): WorkspaceCompletionService {
    if (!this.completion) throw new WorkspaceServerError("workspace_completion_service_unavailable", 503);
    return this.completion;
  }

  private requireMaintenance(): WorkspaceCompletionMaintenanceService {
    if (!this.maintenance) throw new WorkspaceServerError("workspace_completion_maintenance_unavailable", 503);
    return this.maintenance;
  }

  private requireRuntimeActivities(): WorkspaceRuntimeActivityService {
    if (!this.runtimeActivities) throw new WorkspaceServerError("workspace_runtime_activity_service_unavailable", 503);
    return this.runtimeActivities;
  }

  /**
   * Organization commands own the public Bundle contract.  The Store only
   * checks Organization/workspace authorization; the Bundle service writes and
   * verifies the actual portable snapshot.
   */
  private async exportWorkspaceBundleThroughService(
    context: OrganizationRequestContext,
    input: Parameters<WorkspaceServerStore["exportWorkspaceBundle"]>[1]
  ): Promise<Record<string, unknown>> {
    const accountId = assertOpaqueId(context.accountId, "account_id_invalid");
    const operationId = assertOpaqueId(context.operationId, "organization_operation_id_invalid");
    const requestedOrganizationId = optionalOrganizationId(
      input.organizationId ?? input.organization_id ?? context.organizationId
    );
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");

    // This call is intentionally retained as the Store's Organization-scoped
    // authorization/ownership check.  It does not supply the public result.
    const authorized = await this.store.exportWorkspaceBundle(context, input);
    const authorizedSource = authorized.sourceOrganizationId ?? authorized.source_organization_id;
    if (requestedOrganizationId !== undefined && authorizedSource !== requestedOrganizationId) {
      throw new WorkspaceServerError("workspace_bundle_source_organization_mismatch", 409);
    }

    const bundleId = managedWorkspaceBundleId(operationId);
    const destination = managedWorkspaceBundlePath(this.store.storageRoot, workspaceId, bundleId);
    const bundleContext: WorkspaceRequestContext = { workspaceId, accountId, operationId };
    const exported = this.completionBundles
      ? await this.completionBundles.export(bundleContext, { destination })
      : await this.bundles.export(bundleContext, { destination });
    if (path.resolve(exported.directory) !== destination) {
      throw new WorkspaceServerError("workspace_bundle_destination_invalid", 500);
    }

    // Re-read through the same verified transport used by the HTTP transfer
    // path.  This both calculates real byte/file counts and prevents metadata
    // stubs from being returned as a successful export result.
    const transport = this.completionBundles
      ? await readWorkspaceBundleV4Transport(exported.directory)
      : await readWorkspaceBundleV3Transport(exported.directory);
    const manifest = transport.manifest as unknown as BundleManifestMetadata;
    const metadata = publicBundleMetadata(manifest, { requireSourceOrganization: false });
    if (metadata.workspaceId !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
    }
    // New portable V3/V4 exports intentionally omit the source Organization
    // affiliation.  Validate provenance when an older Bundle still carries
    // it, but do not turn the intentional absence into a false 409.  The
    // Store check above remains the Organization authorization/ownership
    // boundary for the export request.
    if (metadata.sourceOrganizationId !== undefined
      && requestedOrganizationId !== undefined
      && metadata.sourceOrganizationId !== requestedOrganizationId) {
      throw new WorkspaceServerError("workspace_bundle_source_organization_mismatch", 409);
    }
    if (metadata.sourceOrganizationId !== undefined
      && authorizedSource !== undefined
      && metadata.sourceOrganizationId !== authorizedSource) {
      throw new WorkspaceServerError("workspace_bundle_source_organization_mismatch", 409);
    }

    return {
      bundle_id: bundleId,
      workspace_id: metadata.workspaceId,
      ...(metadata.sourceOrganizationId ? { source_organization_id: metadata.sourceOrganizationId } : {}),
      schema_version: metadata.schemaVersion,
      integrity_hash: metadata.integrityHash,
      file_count: transport.entries.length,
      byte_size: transport.entries.reduce((total, entry) => total + Buffer.from(entry.content_base64, "base64").byteLength, 0),
      manifest: {
        schema_version: metadata.schemaVersion,
        workspace_id: metadata.workspaceId,
        ...(metadata.sourceOrganizationId ? { source_organization_id: metadata.sourceOrganizationId } : {}),
        integrity_hash: metadata.integrityHash,
        record_counts: metadata.recordCounts
      },
      created_at: metadata.createdAt
    };
  }

  /**
   * Restore resolves only a server-created export directory.  No filesystem
   * path is accepted from the request, and the verified Bundle is then handed
   * to the normal V3/V4 import protocol.  The default import target is a
   * standalone Workspace; an Organization is optional explicit metadata.
   */
  private async restoreWorkspaceBundleThroughService(
    context: OrganizationRequestContext,
    input: Parameters<WorkspaceServerStore["restoreWorkspaceBundle"]>[1]
  ): Promise<Record<string, unknown>> {
    const accountId = assertOpaqueId(context.accountId, "account_id_invalid");
    const operationId = assertOpaqueId(context.operationId, "organization_operation_id_invalid");
    const bundleId = assertOpaqueId(input.bundleId ?? input.bundle_id ?? "", "workspace_bundle_id_invalid");
    const targetOrganizationId = optionalOrganizationId(
      input.targetOrganizationId ?? input.target_organization_id ?? context.organizationId
    );
    if (input.confirm !== true) throw new WorkspaceServerError("workspace_bundle_restore_confirmation_required", 400);

    // Organization admin authorization happens before reading any source
    // Bundle bytes.  The Store response is authorization metadata only.
    await this.store.restoreWorkspaceBundle(context, input);
    const source = await findManagedWorkspaceBundle(this.store.storageRoot, bundleId);
    const sourceMetadata = publicBundleMetadata(source.manifest, { requireSourceOrganization: false });
    // A restore is a new Workspace creation.  Keep this ID stable for
    // idempotent retries, but scope it to the target Organization/account and
    // restore operation rather than reusing the source Workspace ID.
    const targetWorkspaceId = restoredWorkspaceId(targetOrganizationId, accountId, operationId);
    const importContext: Pick<WorkspaceRequestContext, "accountId" | "operationId"> = { accountId, operationId };
    const imported = source.format === "v4"
      ? this.completionBundles
        ? await this.completionBundles.importNew(importContext, {
          sourceDirectory: source.directory,
          targetWorkspaceId,
          ...(targetOrganizationId ? { targetOrganizationId } : {})
        })
        : (() => { throw new WorkspaceServerError("workspace_completion_bundle_service_unavailable", 503); })()
      : await this.bundles.importNew(importContext, {
        sourceDirectory: source.directory,
        targetWorkspaceId,
        ...(targetOrganizationId ? { targetOrganizationId } : {})
      });
    const importedMetadata = publicBundleMetadata(imported.manifest as unknown as BundleManifestMetadata, { requireSourceOrganization: false });
    if (imported.workspaceId !== targetWorkspaceId
      || importedMetadata.workspaceId !== sourceMetadata.workspaceId
      || importedMetadata.integrityHash !== sourceMetadata.integrityHash) {
      throw new WorkspaceServerError("workspace_bundle_import_mismatch", 409);
    }
    const schemaVersion = sourceMetadata.schemaVersion ?? importedMetadata.schemaVersion;
    if (schemaVersion === undefined) throw new WorkspaceServerError("workspace_bundle_schema_revision_missing", 400);

    return {
      bundle_id: bundleId,
      workspace_id: targetWorkspaceId,
      ...(sourceMetadata.sourceOrganizationId ? { source_organization_id: sourceMetadata.sourceOrganizationId } : {}),
      ...(targetOrganizationId ? { target_organization_id: targetOrganizationId } : {}),
      schema_version: schemaVersion,
      integrity_hash: sourceMetadata.integrityHash,
      status: "restored",
      restored_at: new Date().toISOString()
    };
  }

  beginTransfer(context: Parameters<WorkspaceBundleV3Service["beginTransfer"]>[0]) {
    assertOpaqueId(context.workspaceId, "workspace_id_invalid");
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    const destination = path.join(
      this.store.storageRoot,
      "exports",
      context.workspaceId,
      `transfer_${context.operationId}`
    );
    return this.completionBundles
      ? this.completionBundles.beginTransfer(context, destination)
      : this.bundles.beginTransfer(context, destination);
  }

  recordTransferReceipt(
    context: Parameters<WorkspaceBundleV3Service["recordTransferReceipt"]>[0],
    input: Parameters<WorkspaceBundleV3Service["recordTransferReceipt"]>[1]
  ) {
    return this.completionBundles
      ? this.completionBundles.recordTransferReceipt(context, input)
      : this.bundles.recordTransferReceipt(context, input);
  }

  rollbackTransfer(
    context: Parameters<WorkspaceBundleV3Service["rollbackTransfer"]>[0],
    transferId: Parameters<WorkspaceBundleV3Service["rollbackTransfer"]>[1]
  ) {
    return this.completionBundles
      ? this.completionBundles.rollbackTransfer(context, transferId)
      : this.bundles.rollbackTransfer(context, transferId);
  }

  completeTransfer(
    context: Parameters<WorkspaceBundleV3Service["completeTransfer"]>[0],
    transferId: Parameters<WorkspaceBundleV3Service["completeTransfer"]>[1]
  ) {
    return this.completionBundles
      ? this.completionBundles.completeTransfer(context, transferId)
      : this.bundles.completeTransfer(context, transferId);
  }
}

function isV4StageInput(
  input: Omit<Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[1], "manifest"> & { manifest: WorkspaceBundleV3Manifest | StageWorkspaceBundleV4Input["manifest"] }
): input is StageWorkspaceBundleV4Input {
  return input.manifest.format_version === 4;
}

interface BundleManifestMetadata {
  format_version: number;
  workspace_id: string;
  exported_at: string;
  source?: { organization_id?: unknown };
  source_organization_id?: unknown;
  schema_version?: unknown;
  schema_revision?: unknown;
  integrity_hash: string;
  record_counts: Record<string, unknown>;
}

interface PublicBundleMetadata {
  workspaceId: string;
  sourceOrganizationId?: string;
  schemaVersion: number;
  integrityHash: string;
  recordCounts: Record<string, number>;
  createdAt: string;
}

interface ManagedWorkspaceBundle {
  directory: string;
  format: "v3" | "v4";
  manifest: BundleManifestMetadata;
}

function managedWorkspaceBundleId(operationId: string): string {
  const candidate = `bundle_${operationId}`;
  if (candidate.length <= 128) return assertOpaqueId(candidate, "workspace_bundle_id_invalid");
  return `bundle_${createHash("sha256").update(operationId).digest("hex")}`;
}

function restoredWorkspaceId(targetOrganizationId: string | undefined, accountId: string, operationId: string): string {
  const digest = createHash("sha256")
    .update(`workspace_restore|${targetOrganizationId ?? "standalone"}|${accountId}|${operationId}`)
    .digest("hex")
    .slice(0, 40);
  return assertOpaqueId(`workspace_restore_${digest}`, "workspace_id_invalid");
}

function optionalOrganizationId(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return assertOpaqueId(value, "organization_id_invalid");
}

function managedWorkspaceBundlePath(storageRoot: string, workspaceId: string, bundleId: string): string {
  // Both path components have already passed assertOpaqueId.  Keeping the
  // root server-owned makes the command independent of client filesystem
  // input while retaining Workspace IDs in the directory layout.
  return path.join(path.resolve(storageRoot), "exports", workspaceId, bundleId);
}

function publicBundleMetadata(
  manifest: BundleManifestMetadata,
  options: { requireSourceOrganization: boolean }
): PublicBundleMetadata {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new WorkspaceServerError("workspace_bundle_manifest_invalid", 400);
  }
  const workspaceId = assertOpaqueId(manifest.workspace_id, "workspace_id_invalid");
  const topSource = manifest.source_organization_id;
  const nestedSource = manifest.source?.organization_id;
  if (topSource !== undefined && typeof topSource !== "string") {
    throw new WorkspaceServerError("workspace_bundle_source_organization_invalid", 400);
  }
  if (nestedSource !== undefined && typeof nestedSource !== "string") {
    throw new WorkspaceServerError("workspace_bundle_source_organization_invalid", 400);
  }
  if (topSource !== undefined && nestedSource !== undefined && topSource !== nestedSource) {
    throw new WorkspaceServerError("workspace_bundle_source_organization_mismatch", 409);
  }
  const sourceOrganizationId = topSource ?? nestedSource;
  if (sourceOrganizationId === undefined && options.requireSourceOrganization) {
    throw new WorkspaceServerError("workspace_bundle_source_organization_missing", 400);
  }
  if (sourceOrganizationId !== undefined) assertOpaqueId(sourceOrganizationId, "organization_id_invalid");

  const schemaRevision = manifest.schema_revision;
  const schemaVersion = manifest.schema_version;
  if (schemaRevision !== undefined && (!Number.isSafeInteger(schemaRevision) || Number(schemaRevision) < 1)) {
    throw new WorkspaceServerError("workspace_bundle_schema_revision_invalid", 400);
  }
  if (schemaVersion !== undefined && (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1)) {
    throw new WorkspaceServerError("workspace_bundle_schema_revision_invalid", 400);
  }
  if (schemaRevision !== undefined && schemaVersion !== undefined && schemaRevision !== schemaVersion) {
    throw new WorkspaceServerError("workspace_bundle_schema_revision_mismatch", 400);
  }
  const revision = schemaRevision ?? schemaVersion;
  if (revision === undefined) throw new WorkspaceServerError("workspace_bundle_schema_revision_missing", 400);

  if (typeof manifest.integrity_hash !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.integrity_hash)) {
    throw new WorkspaceServerError("workspace_bundle_integrity_invalid", 400);
  }
  if (!manifest.record_counts || typeof manifest.record_counts !== "object" || Array.isArray(manifest.record_counts)) {
    throw new WorkspaceServerError("workspace_bundle_record_counts_invalid", 400);
  }
  const recordCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(manifest.record_counts)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new WorkspaceServerError("workspace_bundle_record_counts_invalid", 400);
    }
    recordCounts[key] = value as number;
  }
  if (typeof manifest.exported_at !== "string" || !Number.isFinite(new Date(manifest.exported_at).getTime())) {
    throw new WorkspaceServerError("workspace_bundle_created_at_invalid", 400);
  }
  return {
    workspaceId,
    ...(sourceOrganizationId !== undefined ? { sourceOrganizationId } : {}),
    schemaVersion: Number(revision),
    integrityHash: manifest.integrity_hash,
    recordCounts,
    createdAt: new Date(manifest.exported_at).toISOString()
  };
}

async function findManagedWorkspaceBundle(storageRoot: string, bundleId: string): Promise<ManagedWorkspaceBundle> {
  const exportRoot = path.join(path.resolve(storageRoot), "exports");
  let workspaceDirectories;
  try {
    workspaceDirectories = await readdir(exportRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceServerError("workspace_bundle_not_found", 404);
    }
    throw error;
  }

  const matches: ManagedWorkspaceBundle[] = [];
  let invalidCandidate: unknown;
  for (const workspaceDirectory of workspaceDirectories) {
    if (!workspaceDirectory.isDirectory() || !isOpaquePathSegment(workspaceDirectory.name)) continue;
    const directory = path.join(exportRoot, workspaceDirectory.name, bundleId);
    let candidateStat;
    try {
      candidateStat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // A symlink is not a server-managed Bundle directory.
    if (!candidateStat.isDirectory()) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as { format_version?: unknown };
      if (parsed?.format_version === 4) {
        const verified = await verifyWorkspaceBundleV4(directory);
        if (verified.manifest.workspace_id !== workspaceDirectory.name) {
          throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
        }
        matches.push({ directory: verified.directory, format: "v4", manifest: verified.manifest as unknown as BundleManifestMetadata });
      } else if (parsed?.format_version === 3) {
        const verified = await verifyWorkspaceBundleV3(directory);
        if (verified.manifest.workspace_id !== workspaceDirectory.name) {
          throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
        }
        matches.push({ directory: verified.directory, format: "v3", manifest: verified.manifest as unknown as BundleManifestMetadata });
      } else {
        throw new WorkspaceServerError("workspace_bundle_manifest_invalid", 400);
      }
    } catch (error) {
      invalidCandidate ??= error;
    }
  }
  if (matches.length > 1) throw new WorkspaceServerError("workspace_bundle_ambiguous", 409);
  if (matches.length === 1) return matches[0]!;
  if (invalidCandidate) throw invalidCandidate;
  throw new WorkspaceServerError("workspace_bundle_not_found", 404);
}

function isOpaquePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
