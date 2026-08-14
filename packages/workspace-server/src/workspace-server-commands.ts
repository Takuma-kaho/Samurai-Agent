import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId } from "./config";
import {
  WorkspaceBundleV3Service,
  writeWorkspaceBundleV3Transport
} from "./workspace-bundle-v3";
import { WorkspaceFileStore } from "./workspace-files";
import { WorkspaceServerStore } from "./workspace-server-store";

export interface WorkspaceServerCommandDependencies {
  store: WorkspaceServerStore;
  files: WorkspaceFileStore;
  bundles: WorkspaceBundleV3Service;
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

  constructor(dependencies: WorkspaceServerCommandDependencies) {
    this.store = dependencies.store;
    this.files = dependencies.files;
    this.bundles = dependencies.bundles;
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
