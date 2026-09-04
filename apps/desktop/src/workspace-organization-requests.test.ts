import { describe, expect, it } from "vitest";
import {
  workspaceEvidenceRequest,
  workspaceOrganizationCreateRequest,
  workspaceOrganizationDeleteRequest,
  workspaceOrganizationInvitationAcceptRequest,
  workspaceOrganizationInvitationCreateRequest,
  workspaceOrganizationWorkspaceLifecycleRequest,
  workspaceOrganizationWorkspaceAttachRequest,
  workspaceOrganizationWorkspaceDetachRequest,
  workspaceOrganizationWorkspaceMoveRequest,
  workspaceOrganizationWorkspaceMovePreviewRequest,
  workspaceOrganizationWorkspaceMoveStatusRequest,
  workspaceOrganizationListRequest,
  workspaceOrganizationWorkspacesRequest,
  workspaceCreateRequest,
  workspaceStandaloneBundleExportRequest,
  workspaceStandaloneBundleRestoreRequest
} from "./workspace-organization-requests";

describe("Desktop Organization request boundary", () => {
  it("keeps Organization list/create and Workspace navigation under the account route prefix", () => {
    expect(workspaceOrganizationListRequest()).toMatchObject({
      method: "GET",
      path: "/api/organizations",
      workspaceScoped: false
    });
    expect(workspaceOrganizationCreateRequest({ name: "Team", operationId: "organization_create_1" })).toMatchObject({
      method: "POST",
      path: "/api/organizations",
      operationId: "organization_create_1",
      idempotencyKey: "organization_create_1",
      body: { name: "Team" },
      workspaceScoped: false
    });
    expect(workspaceOrganizationWorkspacesRequest({ organizationId: "organization_team" }).path)
      .toBe("/api/organizations/organization_team/workspaces");
  });

  it("builds standalone Workspace creation under the account route", () => {
    expect(workspaceCreateRequest({ workspaceId: "workspace_personal", name: "Personal", operationId: "workspace_create_1" })).toEqual({
      method: "POST",
      path: "/api/workspaces",
      body: { workspace_id: "workspace_personal", name: "Personal" },
      operationId: "workspace_create_1",
      idempotencyKey: "workspace_create_1",
      workspaceScoped: false
    });
  });

  it("builds standalone Bundle export and restore without Organization context", () => {
    expect(workspaceStandaloneBundleExportRequest({
      workspaceId: "workspace_personal",
      expectedWorkspaceVersion: 4,
      operationId: "bundle_export_1"
    })).toEqual({
      method: "POST",
      path: "/api/workspaces/workspace_personal/bundle/export",
      body: { expected_workspace_version: 4 },
      operationId: "bundle_export_1",
      idempotencyKey: "bundle_export_1",
      workspaceScoped: false
    });
    expect(workspaceStandaloneBundleRestoreRequest({
      bundleId: "bundle_1",
      targetWorkspaceId: "workspace_restored",
      operationId: "bundle_restore_1"
    })).toEqual({
      method: "POST",
      path: "/api/workspaces/bundles/restore",
      body: { bundle_id: "bundle_1", confirm: true, target_workspace_id: "workspace_restored" },
      operationId: "bundle_restore_1",
      idempotencyKey: "bundle_restore_1",
      workspaceScoped: false
    });
  });

  it("builds signed mutation descriptors without embedding Workspace permissions", () => {
    const invitation = workspaceOrganizationInvitationCreateRequest({
      organizationId: "organization_team",
      accountId: "account_guest",
      role: "guest",
      operationId: "invite_1",
      workspaceGrants: [{ workspaceId: "workspace_team", role: "member", roomIds: ["room_a"] }]
    });
    expect(invitation.body).toEqual({
      target_account_id: "account_guest",
      role: "guest",
      workspace_grants: [{ workspace_id: "workspace_team", role: "member", room_ids: ["room_a"] }]
    });
    expect(invitation).toMatchObject({ workspaceScoped: false, operationId: "invite_1", idempotencyKey: "invite_1" });
    expect(invitation).not.toHaveProperty("credentialRef");
  });

  it("keeps invitation token handling and lifecycle/move routes explicit", () => {
    expect(workspaceOrganizationInvitationAcceptRequest({ token: "one-time-token", operationId: "accept_1" })).toMatchObject({
      method: "POST",
      path: "/api/organization-invitations/one-time-token/accept",
      body: {},
      workspaceScoped: false
    });
    expect(workspaceOrganizationWorkspaceLifecycleRequest({
      organizationId: "organization_team",
      workspaceId: "workspace_team",
      lifecycle: "archive",
      operationId: "archive_1",
      confirm: true
    }).path).toBe("/api/organizations/organization_team/workspaces/workspace_team/archive");
    expect(workspaceOrganizationWorkspaceMoveRequest({
      organizationId: "organization_a",
      workspaceId: "workspace_team",
      targetOrganizationId: "organization_b",
      operationId: "move_1",
      preflightId: "preflight_1",
      confirmGuestMembership: true,
      expectedWorkspaceVersion: 3
    }).body).toEqual({ preflight_id: "preflight_1", target_organization_id: "organization_b", confirm_guest_membership: true, expected_workspace_version: 3 });
    expect(workspaceOrganizationWorkspaceMovePreviewRequest({
      organizationId: "organization_a",
      workspaceId: "workspace_team",
      targetOrganizationId: "organization_b",
      operationId: "preflight_1",
      expectedWorkspaceVersion: 3
    })).toMatchObject({
      path: "/api/organizations/organization_a/workspaces/workspace_team/move/preflight",
      body: { target_organization_id: "organization_b", expected_workspace_version: 3 }
    });
    expect(workspaceOrganizationDeleteRequest({ organizationId: "organization_team", operationId: "delete_1", confirm: true }).body)
      .toEqual({ confirm: true });
    expect(workspaceOrganizationWorkspaceMoveStatusRequest({ organizationId: "organization_a", workspaceId: "workspace_team", operationId: "move_1" })).toMatchObject({
      method: "GET",
      path: "/api/organizations/organization_a/workspaces/workspace_team/move/move_1",
      workspaceScoped: false
    });
  });

  it("keeps Workspace attach and detach bounded to Organization and Workspace IDs", () => {
    expect(workspaceOrganizationWorkspaceAttachRequest({
      organizationId: "organization_team",
      workspaceId: "workspace_team",
      operationId: "attach_1",
      expectedWorkspaceVersion: 3,
      confirmGuestMemberships: true
    })).toMatchObject({
      method: "POST",
      path: "/api/organizations/organization_team/workspaces/workspace_team/attach",
      operationId: "attach_1",
      idempotencyKey: "attach_1",
      body: { expected_workspace_version: 3, confirm_guest_memberships: true },
      workspaceScoped: false
    });
    expect(workspaceOrganizationWorkspaceDetachRequest({
      organizationId: "organization_team",
      workspaceId: "workspace_team",
      operationId: "detach_1"
    })).toMatchObject({
      method: "POST",
      path: "/api/organizations/organization_team/workspaces/workspace_team/detach",
      operationId: "detach_1",
      idempotencyKey: "detach_1",
      body: {},
      workspaceScoped: false
    });
  });

  it("rejects malformed ids, tokens, grants, and evidence targets", () => {
    expect(() => workspaceOrganizationCreateRequest({ name: "Team", operationId: "bad id" })).toThrow("operation_id_invalid");
    expect(() => workspaceOrganizationInvitationAcceptRequest({ token: "", operationId: "accept_1" })).toThrow("invitation_token_invalid");
    expect(() => workspaceOrganizationInvitationCreateRequest({ organizationId: "organization_team", role: "guest", operationId: "invite_1", workspaceGrants: [{ workspaceId: "workspace_team", role: "bad" }] })).toThrow("workspace_grant_role_invalid");
    expect(() => workspaceEvidenceRequest({ workspaceId: "workspace_team", roomId: "room team" })).toThrow("roomId_invalid");
  });

  it("keeps evidence reads to the selected Workspace and its Room projection", () => {
    expect(workspaceEvidenceRequest({ workspaceId: "workspace_team", roomId: "room_a" })).toEqual({
      workspaceId: "workspace_team",
      roomId: "room_a",
      activityPath: "/api/workspaces/workspace_team/chat/activity?room_id=room_a",
      runsPath: "/api/workspaces/workspace_team/chat/runs",
      artifactsPath: "/api/workspaces/workspace_team/artifacts?room_id=room_a",
      memoriesPath: "/api/workspaces/workspace_team/knowledge-memory?room_id=room_a"
    });
  });
});
