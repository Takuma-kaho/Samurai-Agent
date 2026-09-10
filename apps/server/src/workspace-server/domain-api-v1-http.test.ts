import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  accountIdFromPublicKey,
  createAccountSignaturePayload,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  WorkspaceInteractionRequestService,
  workspaceInteractionExecutionOperationId,
  WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import { PostgresArtifact } from "../adapters/runtime/postgres-artifact";
import { PostgresGeneratedSurface } from "../adapters/runtime/postgres-generated-surface";
import { WorkspaceInteractionRequestMaintenanceWorker } from "../workers/workspace-interaction-request-maintenance-worker";
import { createWorkspaceServerCore } from "./core";
import { createWorkspaceServerHttp } from "./http-server";
import { createWorkspaceInteractionRequestWorkflow } from "./interaction-request-workflow";

type R15DatabaseConfig = {
  databaseUrl: string;
  databaseAdminUrl: string;
  runtimeRole: string;
};

type R15Account = {
  id: string;
  publicKey: string;
  privateKey: string;
};

type HttpResult = {
  status: number;
  body: unknown;
};

// Only the disposable/CI fixture used by the existing Server verification
// scripts is accepted. Never fall back to a developer or production database.
const r15Database = readR15DatabaseConfig();

describe.skipIf(!r15Database)("R15 V1 Generated Surface HTTP integration", () => {
  it("persists a confirmation request, exposes it over GET, and rejects forged responses", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_http_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-http-"));
    const account = accountIdentity();
    const database = new PostgresWorkspaceDatabase({
      databaseUrl: databaseConfig.databaseUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    let server: Awaited<ReturnType<typeof createWorkspaceServerHttp>> | undefined;
    let cleanupError: unknown;

    try {
      await adminDatabase.migrate();
      await database.assertReady();
      const store = new WorkspaceServerStore({
        database,
        mode: "hosted",
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      });
      await store.registerAccount({ id: account.id, publicKey: account.publicKey, displayName: "R15 HTTP owner" });
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 HTTP integration",
        ownerAccountId: account.id,
        operationId: `r15_http_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;

      server = await createWorkspaceServerHttp({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "server"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 HTTP owner",
        port: 0,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      const port = await listenOnEphemeralPort(server.httpServer);
      const serverUrl = `http://127.0.0.1:${port}`;

      const interactionListPath = `/api/v1/workspaces/${workspaceId}/interaction-requests?room_id=${encodeURIComponent(roomId)}`;
      const unsigned = await fetch(new URL(interactionListPath, serverUrl), {
        signal: AbortSignal.timeout(15_000)
      });
      expect(unsigned.status).toBe(401);

      const surfaceCreated = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_surface_create_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/domain/operations/generated_surface.create`,
        body: {
          context: { room_id: roomId },
          input: confirmationSurfaceInput()
        }
      });
      expect(surfaceCreated.status, JSON.stringify(surfaceCreated.body)).toBe(201);
      const surfaceCreatedBody = objectValue(surfaceCreated.body, "surface create response");
      const surfaceResult = objectValue(surfaceCreatedBody.result, "surface create result");
      const surface = objectValue(surfaceResult.definition, "surface definition");
      const revision = objectValue(surfaceResult.revision, "surface revision");
      const surfaceId = stringValue(surface, "id");
      const revisionId = stringValue(revision, "id");

      const genericConfirmation = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_generic_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/domain/operations/generated_surface.action.run`,
        body: {
          context: { room_id: roomId },
          input: {
            surface_id: surfaceId,
            revision_id: revisionId,
            action_id: "approve-artifact",
            action_payload: {}
          }
        }
      });
      expect(genericConfirmation.status, JSON.stringify(genericConfirmation.body)).toBe(202);
      const genericConfirmationBody = objectValue(genericConfirmation.body, "generic confirmation response");
      expect(genericConfirmationBody).toMatchObject({
        result: { status: "approval_required", request: { status: "pending", surfaceId, revisionId } },
        replayed: false
      });
      const genericRequest = objectValue(
        objectValue(genericConfirmationBody.result, "generic confirmation result").request,
        "generic confirmation request"
      );
      const genericRequestId = stringValue(genericRequest, "id");
      const genericAccepted = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_generic_surface_approve_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${genericRequestId}/respond`,
        body: {
          room_id: roomId,
          expected_version: 1,
          option_id: "approve"
        }
      });
      expect(genericAccepted.status, JSON.stringify(genericAccepted.body)).toBe(200);
      expect(genericAccepted.body).toMatchObject({
        replayed: false,
        request: { id: genericRequestId, status: "completed" },
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });
      const genericReplay = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_generic_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/domain/operations/generated_surface.action.run`,
        body: {
          context: { room_id: roomId },
          input: {
            surface_id: surfaceId,
            revision_id: revisionId,
            action_id: "approve-artifact",
            action_payload: {}
          }
        }
      });
      expect(genericReplay.status, JSON.stringify(genericReplay.body)).toBe(200);
      expect(genericReplay.body).toMatchObject({
        replayed: true,
        result: {
          status: "completed",
          target_result: { artifact: { title: "R15 approved Surface Artifact" } }
        }
      });

      const directArtifactAction = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        // Desktop generates UUID operation IDs. The Generated Surface target
        // must scope that UI identity before passing it to Completion.
        operationId: randomUUID(),
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/save-artifact/run`,
        body: {
          room_id: roomId,
          revision_id: revisionId,
          action_payload: {}
        }
      });
      expect(directArtifactAction.status, JSON.stringify(directArtifactAction.body)).toBe(201);
      const directArtifactBody = objectValue(directArtifactAction.body, "direct artifact action response");
      expect(objectValue(directArtifactBody.interaction, "direct artifact interaction")).toMatchObject({
        kind: "action",
        command_id: "artifact.create"
      });
      expect(objectValue(directArtifactBody.target_result, "direct artifact target result")).toMatchObject({
        artifact: { title: "R15 direct Surface Artifact" }
      });

      const actionResponse = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/approve/run`,
        body: {
          room_id: roomId,
          revision_id: revisionId,
          action_payload: {}
        }
      });
      expect(actionResponse.status).toBe(202);
      const actionBody = objectValue(actionResponse.body, "surface action response");
      expect(actionBody.status).toBe("approval_required");
      expect(actionBody.replayed).toBe(false);
      const request = objectValue(actionBody.request, "interaction request");
      const requestId = stringValue(request, "id");
      expect(request).toMatchObject({
        workspaceId,
        roomId,
        version: 1,
        kind: "approval",
        status: "pending",
        surfaceId,
        revisionId,
        requestedAccountId: account.id,
        options: [
          { id: "approve", decision: "approve" },
          { id: "deny", decision: "deny" }
        ]
      });
      expect(objectValue(request.actionTarget, "interaction action target")).toMatchObject({
        kind: "generated_surface_action",
        room_id: roomId,
        surface_id: surfaceId,
        revision_id: revisionId,
        action_id: "approve",
        command_id: "collection.action.run"
      });

      const listed = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: interactionListPath
      });
      expect(listed.status).toBe(200);
      const listedBody = objectValue(listed.body, "interaction list response");
      expect(listedBody.requests).toEqual([request]);

      const detailPath = `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}?room_id=${encodeURIComponent(roomId)}`;
      const detail = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: detailPath
      });
      expect(detail.status).toBe(200);
      expect(objectValue(detail.body, "interaction detail response").request).toEqual(request);

      const missingExpectedVersion = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_missing_expected_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, option_id: "deny" }
      });
      expect(missingExpectedVersion.status).toBe(400);
      expect(errorCode(missingExpectedVersion)).toBe("expected_version_invalid");

      const missingOptionId = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_missing_option_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1 }
      });
      expect(missingOptionId.status).toBe(400);
      expect(errorCode(missingOptionId)).toBe("option_id_required");

      const unknownConfirmed = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_unknown_confirmed_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1, option_id: "deny", confirmed: true }
      });
      expect(unknownConfirmed.status).toBe(400);
      expect(errorCode(unknownConfirmed)).toBe("workspace_interaction_request_response_invalid");

      const stillPending = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: detailPath
      });
      expect(stillPending.status).toBe(200);
      expect(objectValue(objectValue(stillPending.body, "pending detail response").request, "pending request")).toMatchObject({
        id: requestId,
        version: 1,
        status: "pending"
      });

      const denied = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_deny_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1, option_id: "deny" }
      });
      expect(denied.status).toBe(200);
      expect(objectValue(denied.body, "denied response")).toMatchObject({
        replayed: false,
        request: { id: requestId, version: 2, status: "denied", outcome: { optionId: "deny", decision: "deny" } }
      });

      const acceptedAction = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_accepted_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/approve-artifact/run`,
        body: { room_id: roomId, revision_id: revisionId, action_payload: {} }
      });
      expect(acceptedAction.status, JSON.stringify(acceptedAction.body)).toBe(202);
      expect(acceptedAction.body).toMatchObject({
        status: "approval_required",
        request: { id: expect.any(String) }
      });
      const acceptedActionBody = objectValue(acceptedAction.body, "accepted action response");
      const acceptedRequest = objectValue(acceptedActionBody.request, "accepted request");
      const acceptedRequestId = stringValue(acceptedRequest, "id");

      const forgedResponse = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_forged_response_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${acceptedRequestId}/respond`,
        body: {
          room_id: roomId,
          expected_version: 1,
          option_id: "approve",
          values: { target_result: { forged: true } }
        }
      });
      expect(forgedResponse.status, JSON.stringify(forgedResponse.body)).toBe(400);
      expect(errorCode(forgedResponse)).toBe("workspace_interaction_request_input_not_allowed");

      const pendingAfterForge = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${acceptedRequestId}?room_id=${encodeURIComponent(roomId)}`
      });
      expect(pendingAfterForge.status).toBe(200);
      expect(objectValue(objectValue(pendingAfterForge.body, "pending accepted detail response").request, "pending accepted request")).toMatchObject({
        id: acceptedRequestId,
        version: 1,
        status: "pending"
      });

      const accepted = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_accept_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${acceptedRequestId}/respond`,
        body: {
          room_id: roomId,
          expected_version: 1,
          option_id: "approve"
        }
      });
      expect(accepted.status).toBe(200);
      const acceptedBody = objectValue(accepted.body, "accepted response");
      expect(acceptedBody).toMatchObject({
        replayed: false,
        request: { id: acceptedRequestId, version: 4, status: "completed" },
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });

      const acceptedReplay = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        // Reusing the response operation must return the saved target result;
        // it must not dispatch another artifact.create command.
        operationId: `r15_http_accept_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${acceptedRequestId}/respond`,
        body: {
          room_id: roomId,
          expected_version: 1,
          option_id: "approve"
        }
      });
      expect(acceptedReplay.status, JSON.stringify(acceptedReplay.body)).toBe(200);
      expect(acceptedReplay.body).toMatchObject({
        replayed: true,
        request: { id: acceptedRequestId, version: 4, status: "completed" },
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });

      const completedResult = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_read_surface_result_${suffix}`,
        method: "GET",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${acceptedRequestId}/result?room_id=${encodeURIComponent(roomId)}`
      });
      expect(completedResult.status, JSON.stringify(completedResult.body)).toBe(200);
      expect(objectValue(completedResult.body, "completed result response")).toMatchObject({
        request: { id: acceptedRequestId, status: "completed" },
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });
   } finally {
      if (server) await server.close().catch((error) => { cleanupError ??= error; });
      await cleanupWorkspace(adminDatabase, workspaceId, account.id).catch((error) => { cleanupError ??= error; });
      await database.close().catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });

  it("re-authorizes the requester before executing an approval after Room access is revoked", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_http_reauth_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-http-reauth-"));
    const requester = accountIdentity();
    const approver = accountIdentity();
    const database = new PostgresWorkspaceDatabase({
      databaseUrl: databaseConfig.databaseUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    let server: Awaited<ReturnType<typeof createWorkspaceServerHttp>> | undefined;
    let cleanupError: unknown;

    try {
      await adminDatabase.migrate();
      await database.assertReady();
      const store = new WorkspaceServerStore({
        database,
        mode: "hosted",
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      });
      await store.registerAccount({ id: requester.id, publicKey: requester.publicKey, displayName: "R15 HTTP requester" });
      await store.registerAccount({ id: approver.id, publicKey: approver.publicKey, displayName: "R15 HTTP approver" });
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 HTTP reauthorization",
        ownerAccountId: approver.id,
        operationId: `r15_http_reauth_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;
      const approverContext = {
        workspaceId,
        accountId: approver.id,
        operationId: `r15_http_reauth_membership_${suffix}`
      };
      await store.setWorkspaceMember(approverContext, {
        accountId: requester.id,
        role: "member",
        state: "active",
        expectedVersion: 0
      });
      await store.setRoomMember({
        ...approverContext,
        operationId: `r15_http_reauth_room_membership_${suffix}`
      }, {
        roomId,
        accountId: requester.id,
        role: "member",
        state: "active",
        expectedVersion: 0
      });

      server = await createWorkspaceServerHttp({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "server"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 HTTP approver",
        port: 0,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      const port = await listenOnEphemeralPort(server.httpServer);
      const serverUrl = `http://127.0.0.1:${port}`;

      const surfaceCreated = await signedJsonRequest({
        serverUrl,
        account: requester,
        workspaceId,
        operationId: `r15_http_reauth_surface_create_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/domain/operations/generated_surface.create`,
        body: { context: { room_id: roomId }, input: confirmationSurfaceInput() }
      });
      expect(surfaceCreated.status, JSON.stringify(surfaceCreated.body)).toBe(201);
      const surfaceCreatedBody = objectValue(surfaceCreated.body, "surface create response");
      const surfaceResult = objectValue(surfaceCreatedBody.result, "surface create result");
      const surface = objectValue(surfaceResult.definition, "surface definition");
      const revision = objectValue(surfaceResult.revision, "surface revision");
      const surfaceId = stringValue(surface, "id");
      const revisionId = stringValue(revision, "id");

      const requested = await signedJsonRequest({
        serverUrl,
        account: requester,
        workspaceId,
        operationId: `r15_http_reauth_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/approve-artifact/run`,
        body: { room_id: roomId, revision_id: revisionId, action_payload: {} }
      });
      expect(requested.status, JSON.stringify(requested.body)).toBe(202);
      const requestedBody = objectValue(requested.body, "requested action response");
      const request = objectValue(requestedBody.request, "requested interaction");
      const requestId = stringValue(request, "id");

      const requesterMembership = await store.getRoomMember(approverContext, roomId, requester.id);
      if (!requesterMembership) throw new Error("requester_room_membership_missing");
      await store.setRoomMember({
        ...approverContext,
        operationId: `r15_http_reauth_revoke_${suffix}`
      }, {
        roomId,
        accountId: requester.id,
        role: "member",
        state: "revoked",
        expectedVersion: requesterMembership.version
      });

      const accepted = await signedJsonRequest({
        serverUrl,
        account: approver,
        workspaceId,
        operationId: `r15_http_reauth_approve_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1, option_id: "approve" }
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const acceptedBody = objectValue(accepted.body, "accepted response");
      expect(acceptedBody).toMatchObject({
        replayed: false,
        request: {
          id: requestId,
          status: "failed",
          execution: { status: "failed", errorCode: "room_not_executable_or_access_denied" }
        }
      });

      const artifacts = await signedJsonRequest({
        serverUrl,
        account: approver,
        workspaceId,
        method: "GET",
        path: `/api/v1/workspaces/${workspaceId}/artifacts?room_id=${encodeURIComponent(roomId)}`
      });
      expect(artifacts.status, JSON.stringify(artifacts.body)).toBe(200);
      const artifactList = objectValue(artifacts.body, "artifact list response");
      expect(artifactList.artifacts).toEqual([]);
    } finally {
      if (server) await server.close().catch((error) => { cleanupError ??= error; });
      await cleanupWorkspace(adminDatabase, workspaceId, [requester.id, approver.id]).catch((error) => { cleanupError ??= error; });
      await database.close().catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });

  it("checks requester and approver revocation independently during accepted recovery in PostgreSQL", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_pg_reauth_both_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-pg-reauth-both-"));
    const requester = accountIdentity();
    const approver = accountIdentity();
    const operator = accountIdentity();
    const database = new PostgresWorkspaceDatabase({
      databaseUrl: databaseConfig.databaseUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    let cleanupError: unknown;

    try {
      await adminDatabase.migrate();
      await database.assertReady();
      const store = new WorkspaceServerStore({
        database,
        mode: "hosted",
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      });
      for (const account of [requester, approver, operator]) {
        await store.registerAccount({ id: account.id, publicKey: account.publicKey, displayName: "R15 PostgreSQL reauthorization" });
      }
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 PostgreSQL accepted recovery",
        ownerAccountId: operator.id,
        operationId: `r15_pg_both_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;
      const operatorContext = {
        workspaceId,
        accountId: operator.id,
        operationId: `r15_pg_both_operator_${suffix}`
      };
      for (const [index, account] of [requester, approver].entries()) {
        await store.setWorkspaceMember({
          ...operatorContext,
          operationId: `r15_pg_both_workspace_member_${index}_${suffix}`
        }, {
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
        await store.setRoomMember({
          ...operatorContext,
          operationId: `r15_pg_both_room_member_${index}_${suffix}`
        }, {
          roomId,
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
      }

      const interactionRequests = new WorkspaceInteractionRequestService(store);
      let externalExecutions = 0;
      const workflow = createWorkspaceInteractionRequestWorkflow({
        authorization: store,
        interactionRequests,
        generatedSurfaces: {
          executeActionTarget: async () => {
            externalExecutions += 1;
            return { target_result: { should_not_execute: true } };
          },
          getActionTargetResult: async () => undefined,
          prepareAction: async () => { throw new Error("prepareAction_not_used"); },
          runActionWithReplay: async () => { throw new Error("runActionWithReplay_not_used"); }
        } as never
      });
      const createAccepted = async (operationSuffix: string) => {
        const created = await interactionRequests.create({
          workspaceId,
          accountId: requester.id,
          operationId: `r15_pg_both_create_${operationSuffix}_${suffix}`
        }, {
          roomId,
          kind: "approval",
          surfaceId: "surface_r15_pg_both",
          revisionId: "revision_r15_pg_both",
          actionTarget: {
            kind: "generated_surface_action",
            room_id: roomId,
            surface_id: "surface_r15_pg_both",
            revision_id: "revision_r15_pg_both",
            action_id: "approve",
            command_id: "artifact.create",
            payload: {}
          },
          options: [{ id: "approve", label: "許可", decision: "approve" }]
        });
        return interactionRequests.respond({
          workspaceId,
          accountId: approver.id,
          operationId: `r15_pg_both_response_${operationSuffix}_${suffix}`
        }, {
          roomId,
          requestId: created.request.id,
          expectedVersion: created.request.version,
          optionId: "approve"
        });
      };
      const setRoomState = async (accountId: string, state: "active" | "revoked", operationSuffix: string) => {
        const member = await store.getRoomMember(operatorContext, roomId, accountId);
        if (!member) throw new Error(`room_member_missing:${accountId}`);
        await store.setRoomMember({
          ...operatorContext,
          operationId: `r15_pg_both_${operationSuffix}_${suffix}`
        }, {
          roomId,
          accountId,
          role: member.role,
          state,
          expectedVersion: member.version
        });
      };
      const recoverWithRevocation = async (revokedAccountId: string, operationSuffix: string) => {
        const accepted = await createAccepted(operationSuffix);
        await setRoomState(revokedAccountId, "revoked", `${operationSuffix}_revoke`);
        const result = await workflow.executeAccepted({
          ...operatorContext,
          operationId: `r15_pg_both_${operationSuffix}_recover_${suffix}`
        }, accepted.request, () => {
          throw new Error("revoked actor must stop before the external action");
        }, `r15_pg_both_execution_${operationSuffix}_${suffix}`);
        expect(result.request.status).toBe("failed");
        expect(result.request.execution?.errorCode).toBe("room_not_executable_or_access_denied");
        expect(await interactionRequests.get(operatorContext, { roomId, requestId: accepted.request.id })).toMatchObject({
          status: "failed",
          execution: { status: "failed", errorCode: "room_not_executable_or_access_denied" }
        });
      };

      await recoverWithRevocation(requester.id, "requester");
      expect(externalExecutions).toBe(0);
      await setRoomState(requester.id, "active", "requester_restore");
      await recoverWithRevocation(approver.id, "approver");
      expect(externalExecutions).toBe(0);
    } finally {
      await cleanupWorkspace(adminDatabase, workspaceId, [requester.id, approver.id, operator.id]).catch((error) => { cleanupError ??= error; });
      await database.close().catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });

  it("persists an exhausted stale Surface recovery as failed in PostgreSQL", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_pg_terminal_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-pg-terminal-"));
    const operator = accountIdentity();
    let serviceNow = new Date("2026-09-10T00:00:00.000Z");
    let cleanupError: unknown;
    const database = new PostgresWorkspaceDatabase({
      databaseUrl: databaseConfig.databaseUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });

    try {
      await adminDatabase.migrate();
      await database.assertReady();
      const store = new WorkspaceServerStore({
        database,
        mode: "hosted",
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      });
      await store.registerAccount({
        id: operator.id,
        publicKey: operator.publicKey,
        displayName: "R15 PostgreSQL stale terminalization"
      });
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 PostgreSQL stale terminalization",
        ownerAccountId: operator.id,
        operationId: `r15_pg_terminal_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;
      const context = (operationId: string) => ({ workspaceId, accountId: operator.id, operationId });
      const interactions = new WorkspaceInteractionRequestService(store, {
        clock: () => serviceNow,
        executionLeaseMs: 1_000
      });
      const created = await interactions.create(context(`r15_pg_terminal_create_${suffix}`), {
        roomId,
        kind: "approval",
        surfaceId: `surface_r15_terminal_${suffix}`,
        revisionId: `revision_r15_terminal_${suffix}`,
        actionTarget: {
          kind: "generated_surface_action",
          room_id: roomId,
          surface_id: `surface_r15_terminal_${suffix}`,
          revision_id: `revision_r15_terminal_${suffix}`,
          action_id: "save",
          command_id: "artifact.create",
          payload: {}
        },
        options: [{ id: "approve", label: "許可", decision: "approve" }]
      });
      const accepted = await interactions.respond(context(`r15_pg_terminal_respond_${suffix}`), {
        roomId,
        requestId: created.request.id,
        expectedVersion: created.request.version,
        optionId: "approve"
      });
      const ownerId = "workspace-server-interaction-executor";
      let active = await interactions.claimExecution(context(`r15_pg_terminal_claim_${suffix}`), {
        roomId,
        requestId: accepted.request.id,
        expectedVersion: accepted.request.version,
        ownerId,
        executionOperationId: `execution_r15_terminal_initial_${suffix}`
      });

      // Fill the immutable provenance with real recovery transitions. Once
      // full, recovery must fail closed rather than discard older result IDs.
      for (let attempt = 1; attempt < 32; attempt += 1) {
        serviceNow = new Date(serviceNow.getTime() + 2_000);
        active = await interactions.recoverExecution(context(`r15_pg_terminal_recover_${attempt}_${suffix}`), {
          roomId,
          requestId: active.request.id,
          expectedVersion: active.request.version,
          ownerId,
          executionOperationId: `execution_r15_terminal_recovery_${attempt}_${suffix}`
        });
      }
      expect(active.executionTargetResultLookup.operationIds).toHaveLength(32);
      serviceNow = new Date(serviceNow.getTime() + 2_000);
      await expect(interactions.recoverExecution(context(`r15_pg_terminal_overflow_${suffix}`), {
        roomId,
        requestId: active.request.id,
        expectedVersion: active.request.version,
        ownerId,
        executionOperationId: `execution_r15_terminal_overflow_${suffix}`
      })).rejects.toMatchObject({ code: "workspace_interaction_execution_provenance_limit_exceeded", status: 409 });

      const failed = await interactions.failStaleExecution(context(`r15_pg_terminal_fail_${suffix}`), {
        roomId,
        requestId: active.request.id,
        expectedVersion: active.request.version,
        executionOperationId: active.claim.executionOperationId,
        errorCode: "workspace_interaction_execution_provenance_limit_exceeded"
      });
      expect(failed).toMatchObject({
        replayed: false,
        request: {
          status: "failed",
          execution: {
            status: "failed",
            errorCode: "workspace_interaction_execution_provenance_limit_exceeded"
          }
        }
      });

      const restarted = new WorkspaceInteractionRequestService(store, {
        clock: () => serviceNow,
        executionLeaseMs: 1_000
      });
      await expect(restarted.get(context(`r15_pg_terminal_read_${suffix}`), {
        roomId,
        requestId: active.request.id
      })).resolves.toMatchObject({
        status: "failed",
        execution: { errorCode: "workspace_interaction_execution_provenance_limit_exceeded" }
      });
      await expect(restarted.listAcceptedForRecovery(context(`r15_pg_terminal_scan_${suffix}`), {
        roomId,
        limit: 10
      })).resolves.toEqual([]);
    } finally {
      await cleanupWorkspace(adminDatabase, workspaceId, operator.id).catch((error) => { cleanupError ??= error; });
      await database.close().catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });

  it("settles a stale Generated Surface execution from its durable result without replaying the target", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_pg_stale_result_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-pg-stale-result-"));
    const requester = accountIdentity();
    const approver = accountIdentity();
    const operator = accountIdentity();
    let serviceNow = new Date(Date.now() - 10_000);
    let core: Awaited<ReturnType<typeof createWorkspaceServerCore>> | undefined;
    let cleanupError: unknown;

    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });

    try {
      await adminDatabase.migrate();
      const serverCore = await createWorkspaceServerCore({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "core"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 stale recovery operator",
        port: 4317,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      core = serverCore;
      const { store } = serverCore;
      for (const account of [requester, approver, operator]) {
        await store.registerAccount({
          id: account.id,
          publicKey: account.publicKey,
          displayName: "R15 PostgreSQL stale recovery"
        });
      }

      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 PostgreSQL stale Generated Surface result",
        ownerAccountId: operator.id,
        operationId: `r15_pg_stale_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;
      const operatorContext = {
        workspaceId,
        accountId: operator.id,
        operationId: `r15_pg_stale_operator_${suffix}`
      };
      for (const [index, account] of [requester, approver].entries()) {
        await store.setWorkspaceMember({
          ...operatorContext,
          operationId: `r15_pg_stale_workspace_member_${index}_${suffix}`
        }, {
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
        await store.setRoomMember({
          ...operatorContext,
          operationId: `r15_pg_stale_room_member_${index}_${suffix}`
        }, {
          roomId,
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
      }

      const artifacts = new PostgresArtifact(
        serverCore.commands,
        serverCore.files,
        (context, input) => serverCore.commands.ingestCompletionActivity(context, input)
      );
      const targetCommandAccounts: string[] = [];
      const generatedSurfaces = new PostgresGeneratedSurface(
        serverCore.commands,
        serverCore.files,
        async (context, input) => {
          targetCommandAccounts.push(context.accountId);
          if (input.commandId !== "artifact.create") throw new Error(`unexpected_target_command:${input.commandId}`);
          const title = input.payload.title;
          const content = input.payload.content;
          if (typeof title !== "string" || typeof content !== "string") throw new Error("target_artifact_payload_invalid");
          const created = await artifacts.create(context, {
            roomId: input.roomId,
            title,
            content,
            kind: "markdown",
            metadata: { source: "r15-pg-stale-recovery" }
          });
          return { result: created as never };
        },
        { assertRoomWritable: (context, targetRoomId) => store.assertRoomWritable(context, targetRoomId) }
      );
      const interactionRequests = new WorkspaceInteractionRequestService(store, {
        clock: () => serviceNow,
        executionLeaseMs: 1_000
      });
      let executeActionTargetCalls = 0;
      const executeActionTarget = async (context: Parameters<PostgresGeneratedSurface["executeActionTarget"]>[0], target: Parameters<PostgresGeneratedSurface["executeActionTarget"]>[1]) => {
        executeActionTargetCalls += 1;
        return generatedSurfaces.executeActionTarget(context, target);
      };
      const workflow = createWorkspaceInteractionRequestWorkflow({
        authorization: store,
        interactionRequests,
        generatedSurfaces: {
          prepareAction: generatedSurfaces.prepareAction.bind(generatedSurfaces),
          runActionWithReplay: generatedSurfaces.runActionWithReplay.bind(generatedSurfaces),
          executeActionTarget,
          getActionTargetResult: generatedSurfaces.getActionTargetResult.bind(generatedSurfaces)
        } as never
      });

      const surfaceCreated = await generatedSurfaces.create(
        {
          workspaceId,
          accountId: requester.id,
          operationId: `r15_pg_stale_surface_create_${suffix}`
        },
        roomId,
        confirmationSurfaceInput() as Parameters<PostgresGeneratedSurface["create"]>[2]
      );
      const submitted = await workflow.submitGeneratedSurfaceAction(
        {
          workspaceId,
          accountId: requester.id,
          operationId: `r15_pg_stale_surface_action_${suffix}`
        },
        {
          room_id: roomId,
          surface_id: surfaceCreated.definition.id,
          revision_id: surfaceCreated.revision.id,
          action_id: "approve-artifact",
          action_payload: {}
        }
      );
      expect(submitted.kind).toBe("approval_required");
      if (submitted.kind !== "approval_required") throw new Error("stale_recovery_request_not_created");

      const response = await interactionRequests.respond(
        {
          workspaceId,
          accountId: approver.id,
          operationId: `r15_pg_stale_approve_${suffix}`
        },
        {
          roomId,
          requestId: submitted.request.id,
          expectedVersion: submitted.request.version,
          optionId: "approve"
        }
      );
      expect(response.request).toMatchObject({
        id: submitted.request.id,
        requestedAccountId: requester.id,
        decidedAccountId: approver.id,
        status: "accepted"
      });

      const executionOperationId = workspaceInteractionExecutionOperationId(
        workspaceId,
        response.request.id,
        "initial"
      );
      const ownerId = "workspace-server-interaction-executor";
      const initialClaim = await interactionRequests.claimExecution(
        {
          ...operatorContext,
          operationId: `r15_pg_stale_claim_${suffix}`
        },
        {
          roomId,
          requestId: response.request.id,
          expectedVersion: response.request.version,
          ownerId,
          executionOperationId,
          leaseMs: 1_000
        }
      );
      const actionTarget = initialClaim.executionTarget.actionTarget as never;
      const initialExecution = await executeActionTarget(
        { workspaceId, accountId: approver.id, operationId: executionOperationId },
        actionTarget
      );
      expect(initialExecution).toMatchObject({
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });

      serviceNow = new Date();
      const interrupted = await interactionRequests.get(
        operatorContext,
        { roomId, requestId: response.request.id }
      );
      expect(interrupted).toMatchObject({
        id: response.request.id,
        status: "executing",
        execution: { status: "executing" }
      });
      const durableTargetResult = await generatedSurfaces.getActionTargetResult(
        { workspaceId, accountId: approver.id, operationId: executionOperationId },
        actionTarget,
        executionOperationId
      );
      expect(durableTargetResult).toMatchObject({
        artifact: { title: "R15 approved Surface Artifact" }
      });

      const executeActionTargetCallsBeforeRecovery = executeActionTargetCalls;
      let recovered: Awaited<ReturnType<typeof workflow.executeAccepted>> | undefined;
      const maintenanceWorker = new WorkspaceInteractionRequestMaintenanceWorker({
        store,
        interactionRequests,
        onReconciled: async () => undefined,
        recoverAcceptedInteraction: async (context, candidate) => {
          expect(context.accountId).toBe(operator.id);
          expect(candidate.executionOperationId).toBe(executionOperationId);
          recovered = await workflow.executeAccepted(
            context,
            candidate.request,
            () => { throw new Error("runtime_not_used_for_generated_surface_recovery"); },
            candidate.executionOperationId
          );
        }
      });
      const maintenance = await maintenanceWorker.runTick(
        {
          ...operatorContext,
          operationId: `r15_pg_stale_maintenance_${suffix}`
        },
        {
          workerId: `r15_pg_stale_worker_${suffix}`,
          maxRuns: 10,
          signal: new AbortController().signal
        }
      );
      expect(maintenance).toEqual({ reconciled: 1, delivered: 0 });
      expect(recovered?.request).toMatchObject({
        id: response.request.id,
        status: "completed",
        execution: { status: "completed" }
      });
      expect(recovered?.targetResult).toMatchObject({
        artifact: { title: "R15 approved Surface Artifact" }
      });

      const completed = await interactionRequests.get(
        operatorContext,
        { roomId, requestId: response.request.id }
      );
      expect(completed).toMatchObject({
        status: "completed",
        execution: { status: "completed" }
      });
      const completedTargetResult = await generatedSurfaces.getActionTargetResult(
        { workspaceId, accountId: approver.id, operationId: executionOperationId },
        actionTarget,
        executionOperationId
      );
      expect(completedTargetResult).toMatchObject({
        artifact: { title: "R15 approved Surface Artifact" }
      });
      const createdArtifacts = await artifacts.list({ workspaceId, accountId: approver.id }, roomId);
      expect(createdArtifacts).toHaveLength(1);
      expect(createdArtifacts[0]?.title).toBe("R15 approved Surface Artifact");
      expect(targetCommandAccounts).toEqual([approver.id]);
      expect(executeActionTargetCalls).toBe(executeActionTargetCallsBeforeRecovery);
      expect(executeActionTargetCalls).toBe(1);
    } finally {
      await core?.close().catch((error) => { cleanupError ??= error; });
      await cleanupWorkspace(adminDatabase, workspaceId, [requester.id, approver.id, operator.id]).catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });

  it("routes stale Generated Surface recovery through the real HTTP server worker composition", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_pg_composed_recovery_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-pg-composed-recovery-"));
    const requester = accountIdentity();
    const approver = accountIdentity();
    const operator = accountIdentity();
    const maintenanceAccount = accountIdentity();
    let serviceNow = new Date(Date.now() - 20_000);
    let setupCore: Awaited<ReturnType<typeof createWorkspaceServerCore>> | undefined;
    let setupCoreClosed = false;
    let server: Awaited<ReturnType<typeof createWorkspaceServerHttp>> | undefined;
    let cleanupError: unknown;
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });

    try {
      await adminDatabase.migrate();
      setupCore = await createWorkspaceServerCore({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "setup"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 composed recovery operator",
        port: 4317,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      const { store } = setupCore;
      for (const account of [requester, approver, operator, maintenanceAccount]) {
        await store.registerAccount({
          id: account.id,
          publicKey: account.publicKey,
          displayName: "R15 PostgreSQL composed recovery"
        });
      }
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 PostgreSQL composed Generated Surface recovery",
        ownerAccountId: operator.id,
        operationId: `r15_pg_composed_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;
      const operatorContext = {
        workspaceId,
        accountId: operator.id,
        operationId: `r15_pg_composed_operator_${suffix}`
      };
      for (const [index, account] of [requester, approver].entries()) {
        await store.setWorkspaceMember({
          ...operatorContext,
          operationId: `r15_pg_composed_workspace_member_${index}_${suffix}`
        }, {
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
        await store.setRoomMember({
          ...operatorContext,
          operationId: `r15_pg_composed_room_member_${index}_${suffix}`
        }, {
          roomId,
          accountId: account.id,
          role: "member",
          state: "active",
          expectedVersion: 0
        });
      }
      // The real Server worker can only start after an owner explicitly
      // configures its ordinary member identity. It is deliberately distinct
      // from the Workspace owner and from both saved human actors.
      await setupCore.maintenance.configureIdentity(operatorContext, { accountId: maintenanceAccount.id });

      const artifacts = new PostgresArtifact(
        setupCore.commands,
        setupCore.files,
        (context, input) => setupCore!.commands.ingestCompletionActivity(context, input)
      );
      const generatedSurfaces = new PostgresGeneratedSurface(
        setupCore.commands,
        setupCore.files,
        async (context, input) => {
          if (input.commandId !== "artifact.create") throw new Error(`unexpected_target_command:${input.commandId}`);
          const title = input.payload.title;
          const content = input.payload.content;
          if (typeof title !== "string" || typeof content !== "string") throw new Error("target_artifact_payload_invalid");
          const created = await artifacts.create(context, {
            roomId: input.roomId,
            title,
            content,
            kind: "markdown",
            metadata: { source: "r15-pg-composed-recovery" }
          });
          return { result: created as never };
        },
        { assertRoomWritable: (context, targetRoomId) => store.assertRoomWritable(context, targetRoomId) }
      );
      const interactionRequests = new WorkspaceInteractionRequestService(store, {
        clock: () => serviceNow,
        executionLeaseMs: 1_000
      });
      const setupWorkflow = createWorkspaceInteractionRequestWorkflow({
        authorization: store,
        interactionRequests,
        generatedSurfaces: {
          prepareAction: generatedSurfaces.prepareAction.bind(generatedSurfaces),
          runActionWithReplay: generatedSurfaces.runActionWithReplay.bind(generatedSurfaces),
          executeActionTarget: generatedSurfaces.executeActionTarget.bind(generatedSurfaces),
          getActionTargetResult: generatedSurfaces.getActionTargetResult.bind(generatedSurfaces)
        } as never
      });

      const surfaceCreated = await generatedSurfaces.create(
        {
          workspaceId,
          accountId: requester.id,
          operationId: `r15_pg_composed_surface_create_${suffix}`
        },
        roomId,
        confirmationSurfaceInput() as Parameters<PostgresGeneratedSurface["create"]>[2]
      );
      const submitted = await setupWorkflow.submitGeneratedSurfaceAction(
        {
          workspaceId,
          accountId: requester.id,
          operationId: `r15_pg_composed_surface_action_${suffix}`
        },
        {
          room_id: roomId,
          surface_id: surfaceCreated.definition.id,
          revision_id: surfaceCreated.revision.id,
          action_id: "approve-artifact",
          action_payload: {}
        }
      );
      expect(submitted.kind).toBe("approval_required");
      if (submitted.kind !== "approval_required") throw new Error("composed_recovery_request_not_created");

      const response = await interactionRequests.respond(
        {
          workspaceId,
          accountId: approver.id,
          operationId: `r15_pg_composed_approve_${suffix}`
        },
        {
          roomId,
          requestId: submitted.request.id,
          expectedVersion: submitted.request.version,
          optionId: "approve"
        }
      );
      expect(response.request.status).toBe("accepted");
      const executionOperationId = workspaceInteractionExecutionOperationId(workspaceId, response.request.id, "initial");
      const initialClaim = await interactionRequests.claimExecution(
        {
          ...operatorContext,
          operationId: `r15_pg_composed_claim_${suffix}`
        },
        {
          roomId,
          requestId: response.request.id,
          expectedVersion: response.request.version,
          ownerId: "workspace-server-interaction-executor",
          executionOperationId,
          leaseMs: 1_000
        }
      );
      const initialExecution = await generatedSurfaces.executeActionTarget(
        { workspaceId, accountId: approver.id, operationId: executionOperationId },
        initialClaim.executionTarget.actionTarget as never
      );
      expect(initialExecution).toMatchObject({
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });
      expect(await interactionRequests.get(operatorContext, { roomId, requestId: response.request.id })).toMatchObject({
        id: response.request.id,
        status: "executing",
        execution: { status: "executing" }
      });
      // Model the narrow failure window after a recovery lease was persisted
      // but before it was settled. The restarted HTTP Server must discover
      // the initial durable target result through the retained lookup
      // provenance rather than dispatching the target again.
      serviceNow = new Date(Date.now() - 10_000);
      const firstRecoveryOperationId = workspaceInteractionExecutionOperationId(
        workspaceId,
        response.request.id,
        `recovery:${executionOperationId}`
      );
      const interruptedRecovery = await interactionRequests.recoverExecution(
        {
          ...operatorContext,
          operationId: `r15_pg_composed_recovery_claim_${suffix}`
        },
        {
          roomId,
          requestId: response.request.id,
          expectedVersion: initialClaim.request.version,
          ownerId: "workspace-server-interaction-executor",
          executionOperationId: firstRecoveryOperationId,
          leaseMs: 1_000
        }
      );
      expect(interruptedRecovery).toMatchObject({
        request: { status: "executing" },
        claim: { executionOperationId: firstRecoveryOperationId },
        executionTargetResultLookup: {
          operationIds: [executionOperationId, firstRecoveryOperationId]
        }
      });

      // Closing the setup Core models a process restart. The following server
      // owns the only recovery call in this test; its worker callback is wired
      // by createWorkspaceServerHttp and is not constructed here.
      await setupCore.close();
      setupCoreClosed = true;
      server = await createWorkspaceServerHttp({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "server"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 composed recovery operator",
        port: 0,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      expect(server.workerSupervisor.status()).toMatchObject({ enabled: true, state: "running" });
      const port = await listenOnEphemeralPort(server.httpServer);
      const serverUrl = `http://127.0.0.1:${port}`;
      const detailPath = `/api/v1/workspaces/${workspaceId}/interaction-requests/${response.request.id}?room_id=${encodeURIComponent(roomId)}`;
      let completedRequest: Record<string, unknown> | undefined;
      const deadline = Date.now() + 30_000;
      while (!completedRequest && Date.now() < deadline) {
        const detail = await signedJsonRequest({
          serverUrl,
          account: operator,
          workspaceId,
          method: "GET",
          path: detailPath
        });
        if (detail.status !== 200) throw new Error(`composed_recovery_detail_failed:${detail.status}`);
        const current = objectValue(objectValue(detail.body, "composed recovery detail response").request, "composed recovery request");
        if (current.status === "completed") completedRequest = current;
        if (!completedRequest) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(completedRequest).toMatchObject({
        id: response.request.id,
        status: "completed",
        execution: { status: "completed" }
      });

      const completedResult = await signedJsonRequest({
        serverUrl,
        account: operator,
        workspaceId,
        operationId: `r15_pg_composed_result_read_${suffix}`,
        method: "GET",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${response.request.id}/result?room_id=${encodeURIComponent(roomId)}`
      });
      expect(completedResult.status, JSON.stringify(completedResult.body)).toBe(200);
      expect(completedResult.body).toMatchObject({
        request: { id: response.request.id, status: "completed" },
        target_result: { artifact: { title: "R15 approved Surface Artifact" } }
      });

      const listedArtifacts = await signedJsonRequest({
        serverUrl,
        account: operator,
        workspaceId,
        method: "GET",
        path: `/api/workspaces/${workspaceId}/artifacts?room_id=${encodeURIComponent(roomId)}`
      });
      expect(listedArtifacts.status, JSON.stringify(listedArtifacts.body)).toBe(200);
      const artifactList = objectValue(listedArtifacts.body, "composed recovery artifact list response");
      expect(artifactList.artifacts).toHaveLength(1);
      expect(artifactList.artifacts).toEqual([
        expect.objectContaining({ title: "R15 approved Surface Artifact" })
      ]);
    } finally {
      await server?.close().catch((error) => { cleanupError ??= error; });
      if (!setupCoreClosed) await setupCore?.close().catch((error) => { cleanupError ??= error; });
      await cleanupWorkspace(adminDatabase, workspaceId, [requester.id, approver.id, operator.id, maintenanceAccount.id]).catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });
});

function readR15DatabaseConfig(): R15DatabaseConfig | undefined {
  const databaseUrl = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL?.trim();
  const databaseAdminUrl = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL?.trim();
  const runtimeRole = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE?.trim();
  if (!databaseUrl || !databaseAdminUrl || !runtimeRole) return undefined;
  return { databaseUrl, databaseAdminUrl, runtimeRole };
}

function accountIdentity(): R15Account {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    id: accountIdFromPublicKey(publicKeyPem),
    publicKey: publicKeyPem,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}

function confirmationSurfaceInput(): Record<string, unknown> {
  return {
    bundle: {
      title: "R15 confirmation surface",
      html: '<main><button type="button" data-action-id="approve">Approve</button></main>',
      actions: [{
        id: "save-artifact",
        label: "Save artifact",
        command_id: "artifact.create",
        input_schema: {},
        payload_template: {
          title: "R15 direct Surface Artifact",
          content: "Created by a direct Generated Surface action.",
          kind: "markdown",
          input_locale: "en",
          output_locale: "en",
          metadata: { source: "r15-http" }
        },
        requires_confirmation: false
      }, {
        id: "approve",
        label: "Approve",
        command_id: "collection.action.run",
        input_schema: {},
        payload_template: {
          collection_id: "r15_collection",
          action_id: "publish",
          payload: {}
        },
        requires_confirmation: true
      }, {
        id: "approve-artifact",
        label: "Approve artifact",
        command_id: "artifact.create",
        input_schema: {},
        payload_template: {
          title: "R15 approved Surface Artifact",
          content: "Created by an accepted Generated Surface approval.",
          kind: "markdown",
          input_locale: "en",
          output_locale: "en",
          metadata: { source: "r15-http-approved" }
        },
        requires_confirmation: true
      }]
    },
    request: {
      user_intent: "R15 HTTP confirmation request",
      source_resource_refs: [],
      allowed_domain_commands: ["artifact.create", "collection.action.run"],
      selected_knowledge_refs: [],
      selected_skill_refs: [],
      client_capabilities: { generated_surface: true },
      expected_lifetime: "pinned",
      fallback_chain: ["built_in_surface", "artifact", "text"]
    }
  };
}

async function signedJsonRequest(input: {
  serverUrl: string;
  account: R15Account;
  workspaceId: string;
  operationId?: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}): Promise<HttpResult> {
  const url = new URL(input.path, input.serverUrl);
  const requestId = `r15_request_${randomUUID()}`;
  const timestamp = String(Date.now());
  const body = input.body === undefined
    ? {}
    : JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const payload = createAccountSignaturePayload({
    method: input.method,
    path: url.pathname,
    workspaceId: input.workspaceId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    requestId,
    timestamp,
    body
  });
  const signature = sign(null, Buffer.from(payload), createPrivateKey(input.account.privateKey)).toString("base64url");
  const response = await fetch(url, {
    method: input.method,
    headers: {
      "x-samurai-account-id": input.account.id,
      "x-samurai-request-id": requestId,
      "x-samurai-timestamp": timestamp,
      "x-samurai-signature": signature,
      "x-samurai-workspace-id": input.workspaceId,
      ...(input.operationId ? { "x-samurai-operation-id": input.operationId } : {}),
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let bodyValue: unknown;
  if (text) {
    try {
      bodyValue = JSON.parse(text);
    } catch {
      bodyValue = { invalid_json: text };
    }
  }
  return { status: response.status, body: bodyValue };
}

async function listenOnEphemeralPort(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("r15_http_ephemeral_port_unavailable");
  return address.port;
}

async function cleanupWorkspace(adminDatabase: PostgresWorkspaceAdminDatabase, workspaceId: string, accountIds: string | readonly string[]): Promise<void> {
  const accounts = Array.isArray(accountIds) ? [...accountIds] : [accountIds];
  await adminDatabase.withAdmin(async (sql) => {
    const tables = (await sql.query<{ table_name: string }>(`
      SELECT DISTINCT columns.table_name
      FROM information_schema.columns AS columns
      JOIN information_schema.tables AS tables
        ON tables.table_schema = columns.table_schema AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND columns.column_name = 'workspace_id'
        AND tables.table_type = 'BASE TABLE'
        AND columns.table_name <> 'workspaces'
      ORDER BY columns.table_name
    `)).rows.map((row) => row.table_name);

    await sql.query("BEGIN");
    try {
      for (let pass = 0; pass <= tables.length; pass += 1) {
        let deleted = false;
        for (const table of tables) {
          const quotedTable = `"${table.replaceAll('"', '""')}"`;
          await sql.query("SAVEPOINT r15_cleanup");
          try {
            const result = await sql.query(`DELETE FROM ${quotedTable} WHERE workspace_id = $1`, [workspaceId]);
            deleted ||= (result.rowCount ?? 0) > 0;
            await sql.query("RELEASE SAVEPOINT r15_cleanup");
          } catch {
            await sql.query("ROLLBACK TO SAVEPOINT r15_cleanup");
            await sql.query("RELEASE SAVEPOINT r15_cleanup");
          }
        }
        if (!deleted) break;
      }
      await sql.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await sql.query("DELETE FROM account_operations WHERE account_id = ANY($1::TEXT[])", [accounts]);
      await sql.query("DELETE FROM accounts WHERE id = ANY($1::TEXT[])", [accounts]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as Record<string, unknown>;
}

function stringValue(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key}_missing`);
  return value[key] as string;
}

function errorCode(response: HttpResult): unknown {
  return objectValue(objectValue(response.body, "error response").error, "error payload").code;
}
