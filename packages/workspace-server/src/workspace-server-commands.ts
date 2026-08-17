import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import {
  WorkspaceBundleV3Service,
  writeWorkspaceBundleV3Transport
} from "./workspace-bundle-v3";
import { WorkspaceFileStore } from "./workspace-files";
import { WorkspaceCompletionService } from "./workspace-completion-service";
import { WorkspaceCompletionMigrationService } from "./workspace-completion-migration";
import { WorkspaceCompletionMaintenanceService } from "./workspace-completion-maintenance";
import { WorkspaceServerStore } from "./workspace-server-store";

export interface WorkspaceServerCommandDependencies {
  store: WorkspaceServerStore;
  files: WorkspaceFileStore;
  bundles: WorkspaceBundleV3Service;
  /** Optional while old callers migrate; the running Core always supplies it. */
  completion?: WorkspaceCompletionService;
  completionMigrations?: WorkspaceCompletionMigrationService;
  maintenance?: WorkspaceCompletionMaintenanceService;
}

export interface ImportWorkspaceBundleTransportInput {
  transport: unknown;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
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
  private readonly completion?: WorkspaceCompletionService;
  private readonly completionMigrations?: WorkspaceCompletionMigrationService;
  private readonly maintenance?: WorkspaceCompletionMaintenanceService;

  constructor(dependencies: WorkspaceServerCommandDependencies) {
    this.store = dependencies.store;
    this.files = dependencies.files;
    this.bundles = dependencies.bundles;
    this.completion = dependencies.completion;
    this.completionMigrations = dependencies.completionMigrations;
    this.maintenance = dependencies.maintenance;
  }

  registerAccount(input: Parameters<WorkspaceServerStore["registerAccount"]>[0]) {
    return this.store.registerAccount(input);
  }

  createWorkspace(input: Parameters<WorkspaceServerStore["createWorkspace"]>[0]) {
    return this.store.createWorkspace(input);
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
      const bundle = await writeWorkspaceBundleV3Transport({
        transport: input.transport,
        destination: staging
      });
      return await this.bundles.importNew(context, {
        sourceDirectory: bundle.directory,
        targetWorkspaceId: input.targetWorkspaceId,
        ...(input.targetWorkspaceName ? { targetWorkspaceName: input.targetWorkspaceName } : {})
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  stageWorkspaceBundle(
    context: Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[0],
    input: Parameters<WorkspaceBundleV3Service["stageIncomingBundle"]>[1]
  ) {
    return this.bundles.stageIncomingBundle(context, input);
  }

  writeWorkspaceBundleEntry(
    context: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[0],
    entryPath: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[1],
    content: Parameters<WorkspaceBundleV3Service["putIncomingBundleEntry"]>[2]
  ) {
    return this.bundles.putIncomingBundleEntry(context, entryPath, content);
  }

  completeWorkspaceBundleImport(
    context: Parameters<WorkspaceBundleV3Service["completeIncomingBundle"]>[0]
  ) {
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
    return this.bundles.beginTransfer(context, destination);
  }

  recordTransferReceipt(
    context: Parameters<WorkspaceBundleV3Service["recordTransferReceipt"]>[0],
    input: Parameters<WorkspaceBundleV3Service["recordTransferReceipt"]>[1]
  ) {
    return this.bundles.recordTransferReceipt(context, input);
  }

  rollbackTransfer(
    context: Parameters<WorkspaceBundleV3Service["rollbackTransfer"]>[0],
    transferId: Parameters<WorkspaceBundleV3Service["rollbackTransfer"]>[1]
  ) {
    return this.bundles.rollbackTransfer(context, transferId);
  }

  completeTransfer(
    context: Parameters<WorkspaceBundleV3Service["completeTransfer"]>[0],
    transferId: Parameters<WorkspaceBundleV3Service["completeTransfer"]>[1]
  ) {
    return this.bundles.completeTransfer(context, transferId);
  }
}
