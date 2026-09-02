import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicOperationResult } from "./domain-api-v1";

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
      '"/api/organizations/:organizationId/workspaces/:workspaceId/move/preflight"',
      '"/api/organizations/:organizationId/workspaces/:workspaceId/move/commit"',
      '"/api/organizations/:organizationId/bundles/restore"'
    ]) expect(httpSource).toContain(route);
    expect(httpSource).toContain("authenticateAccount: authenticate");
    expect(httpSource).toContain("organizationRequestContext");
    expect(httpSource).toContain("organization_operation_idempotency_mismatch");
  });

  it("keeps organization operations outside the workspace content catalog", () => {
    expect(domainSource).toContain("!organizationOperationIds.has(definition.id)");
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

  it("requires an explicit target Organization for one-shot and staged Bundle imports", () => {
    const oneShotStart = httpSource.indexOf('app.post("/api/workspaces/imports"');
    const stagingStart = httpSource.indexOf('app.post("/api/workspaces/imports/staging"');
    const oneShotSource = httpSource.slice(oneShotStart, stagingStart);
    const stagingSource = httpSource.slice(stagingStart, httpSource.indexOf('app.put("/api/workspaces/imports/staging/:operationId/entries', stagingStart));
    expect(oneShotSource).toContain('targetOrganizationId: stringField(body, "target_organization_id")');
    expect(stagingSource).toContain('targetOrganizationId: stringField(body, "target_organization_id")');
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
});
