import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicOperationResult, publicWorkspaceDirectory, publicWorkspaceOrganizationAssociationResult, publicWorkspaceTransferStatus } from "./domain-api-v1";

const here = path.dirname(fileURLToPath(import.meta.url));
const httpSource = await readFile(path.join(here, "http-server.ts"), "utf8");
const domainSource = await readFile(path.join(here, "domain-api-v1.ts"), "utf8");

describe("Organization HTTP boundary", () => {
  it("mounts account-signed organization metadata and lifecycle routes", () => {
    for (const route of [
      '"/api/organizations"',
      '"/api/organizations/:organizationId"',
      '"/api/organizations/:organizationId/members"',
      '"/api/organizations/:organizationId/invitations"',
      '"/api/organizations/:organizationId/workspaces"',
      '"/api/organizations/:organizationId/workspaces/:workspaceId/attach"',
      '"/api/organizations/:organizationId/workspaces/:workspaceId/detach"',
      '"/api/organizations/:organizationId/workspaces/:workspaceId/move/preflight"',
      '"/api/organizations/:organizationId/workspaces/:workspaceId/move/commit"',
      '"/api/organizations/:organizationId/bundles/restore"'
    ]) expect(httpSource).toContain(route);
    expect(httpSource).toContain('"/api/account/workspaces"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/bundle/export"');
    expect(httpSource).toContain('"/api/workspaces/bundles/restore"');
    expect(httpSource).toContain('"/api/workspaces/imports"');
    expect(httpSource).toContain("authenticateAccount: authenticate");
    expect(httpSource).toContain("organizationRequestContext");
    expect(httpSource).toContain("organization_operation_idempotency_mismatch");
  });

  it("mounts an owner-only transfer status query without exposing bundle internals", () => {
    expect(httpSource).toContain('app.get("/api/workspaces/:workspaceId/transfers/:transferId/status"');
    const start = httpSource.indexOf('app.get("/api/workspaces/:workspaceId/transfers/:transferId/status"');
    const end = httpSource.indexOf('app.get("/api/workspaces/:workspaceId/transfers/:transferId/bundle"', start);
    const source = httpSource.slice(start, end);
    expect(source).toContain("authenticateWorkspace");
    expect(source).toContain("samurai_can_workspace($1, 'owner')");
    expect(source).toContain("workspace_transfer_not_found");
    expect(source).toContain("res.json(publicWorkspaceTransferStatus(status))");

    const hash = "a".repeat(64);
    const result = publicWorkspaceTransferStatus({
      id: "transfer_1",
      state: "imported",
      source_integrity_hash: hash,
      target_integrity_hash: hash,
      target_workspace_id: "workspace_2",
      receipt_present: true,
      source_workspace_state: "read_only",
      bundle_path: "/private/transfer/bundle",
      target_receipt: { imported_at: "private" }
    }) as Record<string, unknown>;
    expect(result).toEqual({
      transfer_id: "transfer_1",
      state: "imported",
      source_integrity_hash: hash,
      target_integrity_hash: hash,
      target_workspace_id: "workspace_2",
      receipt_present: true,
      source_workspace_state: "read_only",
      source_archived: false
    });
    expect(result).not.toHaveProperty("bundle_path");
    expect(result).not.toHaveProperty("target_receipt");
  });

  it("keeps organization operations outside the workspace content catalog", () => {
    expect(domainSource).toContain("!organizationOperationIds.has(definition.id)");
    expect(domainSource).toContain("organizationCatalogOperationIds.has(definition.id)");
    expect(domainSource).toContain("organizationCompatibilityOperationIds");
    expect(domainSource).toContain("commands.createOrganization");
    expect(domainSource).toContain("commands.restoreWorkspaceBundle");
    expect(domainSource).not.toContain("commands as unknown as OrganizationCommandService");
    expect(domainSource).toContain("one_time_token");
  });

  it("does not restore the retired self-host fixed workspace identity", () => {
    expect(httpSource).not.toContain('self_host_accepts_one_workspace');
    expect(httpSource).not.toContain('workspace_id: config.selfHostWorkspaceId');
  });

  it("resolves self-host worker contexts from active workspaces and maintenance identities", () => {
    const start = httpSource.indexOf("const resolveWorkerContexts");
    const end = httpSource.indexOf("const app = express()", start);
    const workerSource = httpSource.slice(start, end);
    expect(workerSource).toContain("store.listActiveWorkspaceIds()");
    expect(workerSource).toContain("maintenance.listConfiguredIdentities()");
    expect(workerSource).not.toContain("maintenance.getIdentity");
    expect(workerSource).not.toContain("config.selfHostWorkspaceId");
  });

  it("allows standalone one-shot and staged Bundle imports", () => {
    const oneShotStart = httpSource.indexOf('app.post("/api/workspaces/imports"');
    const stagingStart = httpSource.indexOf('app.post("/api/workspaces/imports/staging"');
    const oneShotSource = httpSource.slice(oneShotStart, stagingStart);
    const stagingSource = httpSource.slice(stagingStart, httpSource.indexOf('app.put("/api/workspaces/imports/staging/:operationId/entries', stagingStart));
    expect(oneShotSource).toContain("assertStandaloneBundleTarget(body)");
    expect(stagingSource).toContain("assertStandaloneBundleTarget(body)");
    expect(oneShotSource).not.toContain("targetOrganizationId");
    expect(stagingSource).not.toContain("targetOrganizationId");
  });

  it("keeps direct Workspace invitations and membership management Workspace-scoped", () => {
    const inviteStart = httpSource.indexOf('app.post("/api/workspaces/:workspaceId/invitations"');
    const inviteEnd = httpSource.indexOf('app.post("/api/workspaces/:workspaceId/invitations/accept"', inviteStart);
    const inviteSource = httpSource.slice(inviteStart, inviteEnd);
    expect(inviteSource).toContain("authenticateWorkspace");
    expect(inviteSource).toContain("commands.createInvitation");
    expect(inviteSource).not.toContain("organizationContext");

    const membershipStart = httpSource.indexOf('app.put("/api/workspaces/:workspaceId/members/:accountId"');
    const membershipEnd = httpSource.indexOf('app.put("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId"', membershipStart);
    const membershipSource = httpSource.slice(membershipStart, membershipEnd);
    expect(membershipSource).toContain("authenticateWorkspace");
    expect(membershipSource).toContain("commands.setWorkspaceMember");
    expect(membershipSource).not.toContain("organizationContext");
  });

  it("keeps Organization restore compatibility as restore-then-attach", () => {
    const start = httpSource.indexOf('app.post("/api/organizations/:organizationId/bundles/restore"');
    const source = httpSource.slice(start, httpSource.indexOf("  }));", start) + 6);
    expect(source).toContain("executeOrganizationBundleRestoreCompatibility");
    expect(source).not.toContain("target_organization_id: pathParam(req, \"organizationId\")");
    expect(domainSource).toContain("organizationBundleAttachOperationId");
    expect(domainSource).toContain("assertStandaloneBundleOperationInput");

    const genericStart = httpSource.indexOf('app.post("/api/workspaces/bundles/restore"');
    const genericSource = httpSource.slice(genericStart, httpSource.indexOf('app.get("/api/workspaces/:workspaceId"', genericStart));
    expect(genericSource).toContain("assertStandaloneBundleTarget(body)");
    expect(genericSource).not.toContain("targetOrganizationId");
  });

  it("does not treat the preflight write freeze requirement as a blocked move", () => {
    const start = domainSource.indexOf("function workspaceMovePreflight");
    const end = domainSource.indexOf("function workspaceMoveResult", start);
    const preflightSource = domainSource.slice(start, end);
    expect(preflightSource).toContain("write_blocked: typeof body.write_blocked === \"boolean\"");
    expect(preflightSource).not.toContain("writeFreezeRequired");
  });

  it("projects Core preflight versions and blocked state into the public contract", () => {
    const result = publicOperationResult("workspace.organization.move.preflight", {
      allowed: true,
      operationId: "move_preflight_1",
      sourceOrganizationId: "organization_1",
      targetOrganizationId: "organization_2",
      workspaceId: "workspace_1",
      expectedWorkspaceVersion: 7,
      workspaceState: "active",
      members: [{ accountId: "account_1", currentWorkspaceRole: "member", targetOrganizationRole: "member" }],
      missingTargetMemberships: [],
      requiresGuestConfirmation: false,
      writeFreezeRequired: true,
      failureConditions: [],
      expiresAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-31T00:00:00.000Z"
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ workspace_version: 7, write_blocked: false });

    const blocked = publicOperationResult("workspace.organization.move.preflight", {
      allowed: false,
      operationId: "move_preflight_2",
      sourceOrganizationId: "organization_1",
      targetOrganizationId: "organization_2",
      workspaceId: "workspace_1",
      expectedWorkspaceVersion: 7,
      workspaceState: "active",
      members: [],
      missingTargetMemberships: [],
      requiresGuestConfirmation: false,
      failureConditions: ["organization_owner_permission_required"],
      expiresAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-31T00:00:00.000Z"
    }) as Record<string, unknown>;
    expect(blocked.write_blocked).toBe(true);
  });

  it("projects invitation acceptance grants into workspace membership records", () => {
    const result = publicOperationResult("organization.member.accept", {
      organizationId: "organization_1",
      accountId: "account_2",
      role: "member",
      workspaceGrants: [{
        id: "grant_1",
        organizationId: "organization_1",
        invitationId: "invitation_1",
        workspaceId: "workspace_1",
        workspaceRole: "guest"
      }]
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      membership: { organization_id: "organization_1", account_id: "account_2", version: 1 },
      workspace_grants: [{
        organization_id: "organization_1",
        workspace_id: "workspace_1",
        account_id: "account_2",
        role: "guest",
        state: "active",
        version: 1
      }]
    });
  });

  it("keeps lifecycle, move status, and bundle results public-schema compatible", () => {
    for (const [operationId, state] of [
      ["organization.workspace.archive", "archived"],
      ["organization.workspace.restore", "active"],
      ["organization.workspace.delete", "deleted"]
    ] as const) {
      expect(() => publicOperationResult(operationId, {
        organizationId: "organization_1",
        workspaceId: "workspace_1",
        name: "Workspace",
        state,
        hasAccess: true,
        workspaceRole: "owner",
        version: 2,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z"
      }, "account_1")).not.toThrow();
    }

    expect(() => publicOperationResult("workspace.organization.move.status", {
      operationId: "move_1",
      workspaceId: "workspace_1",
      sourceOrganizationId: "organization_1",
      targetOrganizationId: "organization_2",
      status: "committed",
      guestMembershipAccountIds: [],
      updatedAt: "2026-08-31T00:00:00.000Z"
    })).not.toThrow();

    const hash = "a".repeat(64);
    expect(() => publicOperationResult("workspace.bundle.export", {
      bundle_id: "bundle_1",
      workspace_id: "workspace_1",
      source_organization_id: "organization_1",
      schema_version: 4,
      integrity_hash: hash,
      file_count: 1,
      byte_size: 10,
      manifest: {
        schema_version: 4,
        workspace_id: "workspace_1",
        source_organization_id: "organization_1",
        integrity_hash: hash,
        record_counts: { workspaces: 1 }
      },
      created_at: "2026-08-31T00:00:00.000Z"
    })).not.toThrow();
    expect(() => publicOperationResult("workspace.bundle.restore", {
      bundle_id: "bundle_1",
      workspace_id: "workspace_1",
      source_organization_id: "organization_1",
      target_organization_id: "organization_2",
      schema_version: 4,
      integrity_hash: hash,
      status: "restored",
      restored_at: "2026-08-31T00:00:00.000Z"
    })).not.toThrow();
  });

  it("keeps standalone directory and detach projections free of empty Organization IDs", () => {
    expect(publicWorkspaceDirectory([{
      id: "workspace_1",
      name: "Personal",
      state: "active",
      hostingMode: "hosted",
      databasePlacement: "shared",
      storageNamespace: "must-not-leak",
      version: 1,
      role: "owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    }], "account_1")).toEqual({
      workspaces: [{
        id: "workspace_1",
        name: "Personal",
        state: "active",
        version: 1,
        hosting_mode: "hosted",
        database_placement: "shared",
        role: "owner",
        access: "granted",
        created_by: "account_1",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z"
      }]
    });

    const detached = publicWorkspaceOrganizationAssociationResult({
      workspace: {
        id: "workspace_1",
        name: "Personal",
        state: "active",
        version: 2,
        createdBy: "account_1",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        canAccess: true,
        role: "owner"
      },
      previousOrganizationId: "organization_1",
      addedGuestAccountIds: []
    }, "account_1");
    expect(detached).toMatchObject({
      workspace: { id: "workspace_1" },
      previous_organization_id: "organization_1",
      added_guest_account_ids: []
    });
    expect(detached).not.toHaveProperty("organization_id", "");
    expect((detached as Record<string, unknown>).workspace).not.toHaveProperty("organization_id", "");
  });

  it("exposes transfer stages through standalone Workspace routes", () => {
    const start = httpSource.indexOf('app.post("/api/workspaces/:workspaceId/transfers"');
    const end = httpSource.indexOf("const socketRateGuard", start);
    const transferSource = httpSource.slice(start, end);
    for (const marker of [
      '"/api/workspaces/:workspaceId/transfers"',
      '"/api/workspaces/:workspaceId/transfers/:transferId/bundle"',
      '"/api/workspaces/:workspaceId/transfers/:transferId/manifest"',
      '"/api/workspaces/:workspaceId/transfers/:transferId/receipt"',
      '"/api/workspaces/:workspaceId/transfers/:transferId/rollback"',
      '"/api/workspaces/:workspaceId/transfers/:transferId/complete"'
    ]) expect(transferSource).toContain(marker);
    expect(transferSource).toContain("getTransferBundle");
    expect(transferSource).toContain("recordTransferReceipt");
    expect(transferSource).toContain("completeTransfer");
    expect(transferSource).toContain("PublicWorkspaceTransferManifestResultSchema");
    expect(transferSource).toContain("PublicWorkspaceTransferStartResultSchema");
  });
});
