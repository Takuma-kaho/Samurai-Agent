import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eventPayloadSchemaFor } from "@samurai-agent/domain-api";
import { publicAgentBackendRecord, publicOperationResult, publicWorkspaceDirectory, publicWorkspaceOrganizationAssociationResult, publicWorkspaceTransferStatus, roomWorkEventFor } from "./domain-api-v1";

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

  it("converts the legacy chat turn through the Room-work lifecycle", () => {
    const start = domainSource.indexOf('if (operationId === "chat.turn.run")');
    const end = domainSource.indexOf('if (operationId === "artifact.create")', start);
    const source = domainSource.slice(start, end);
    expect(source).toContain("migrateLegacyChatTurn");
    expect(source).toContain("normalizeLegacyChatTurnResult");
    expect(source).toContain("room.work.reply");
    expect(source).toContain("room.work.create");
    expect(source).not.toContain("runtimeFor(req)");
    expect(source).not.toContain("runPostgresChatTurnThroughDomainOperation");
  });

  it("forwards explicit Room default or new-Agent configuration during Room creation", () => {
    const start = domainSource.indexOf('if (operationId === "room.create")');
    const end = domainSource.indexOf('if (operationId === "room.patch")', start);
    const source = domainSource.slice(start, end);
    expect(source).toContain("defaultAgentId");
    expect(source).toContain("defaultAgentVersion");
    expect(source).toContain("newAgent");
    expect(source).toContain("agentPermission");
    expect(source).toContain("roomAgentPermissionInput");
    expect(source).not.toContain("expectedWorkspaceVersion: workspace.version");
    expect(source).not.toContain("store.getWorkspace({ workspaceId, accountId })");
  });

  it("projects Room kind/default Agent fields and keeps the authorized Agent list query", () => {
    const start = domainSource.indexOf("function roomRecord(");
    const end = domainSource.indexOf("function agentRecord(", start);
    const roomProjection = domainSource.slice(start, end);
    expect(roomProjection).toContain("kind: room.kind");
    expect(roomProjection).toContain("default_agent_id: room.defaultAgentId");
    expect(roomProjection).toContain("default_agent_version: room.defaultAgentVersion");
    expect(roomProjection).toContain("can_manage: room.canManage");
    expect(roomProjection).toContain("can_execute: room.canExecute");

    const agentQuery = domainSource.slice(domainSource.indexOf('if (queryId === "agent.list")'), domainSource.indexOf('if (queryId === "agent.view")'));
    expect(agentQuery).toContain("store.listAgents");
    expect(agentQuery).toContain("agentRecord");
  });

  it("projects the Store's internal Room work aggregate to the strict public DTO", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const result = publicOperationResult("room.work.create", {
      work: {
        workspaceId: "workspace_1",
        id: "work_1",
        roomId: "room_1",
        requesterAccountId: "account_1",
        defaultAgentId: "agent_1",
        defaultAgentVersion: 2,
        title: "Review",
        objective: "Review the change",
        completionCriteria: ["A decision is recorded"],
        status: "queued",
        stopState: "none",
        instructionVersion: 1,
        controlGeneration: 0,
        operationId: "operation_1",
        resourceRefs: [{
          kind: "knowledge",
          id: "resource_1",
          uri: "knowledge/resource_1/v2.md",
          version: "2",
          label: "Decision"
        }],
        assignments: [{
          workspaceId: "workspace_1",
          id: "assignee_1",
          workId: "work_1",
          roomId: "room_1",
          agentId: "agent_1",
          agentVersion: 2,
          instructionVersion: 1,
          attempt: 0,
          priority: 0,
          status: "queued",
          generation: 0,
          createdAt: timestamp,
          updatedAt: timestamp
        }],
        createdAt: timestamp,
        updatedAt: timestamp
      },
      launchReservation: {
        workspaceId: "workspace_1",
        id: "reservation_1",
        workId: "work_1",
        assignmentId: "assignee_1",
        roomId: "room_1",
        generation: 1,
        status: "reserved",
        operationId: "operation_1",
        scheduledAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("operation_id");
    expect(result.completion_criteria).toEqual(["A decision is recorded"]);
    expect(result.resource_refs).toEqual([{
      kind: "knowledge",
      id: "resource_1",
      uri: "knowledge/resource_1/v2.md",
      version: "2",
      label: "Decision"
    }]);
    expect((result.execution_reservations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("workspace_id");
    expect((result.execution_reservations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("operation_id");
  });

  it("keeps canonical Knowledge/Skill refs in Work instructions and event resources", () => {
    const resourceRef = {
      kind: "skill",
      id: "skill_1",
      uri: "skills/skill_1/v3/SKILL.md",
      version: "3",
      label: "Release skill"
    };
    const instruction = publicOperationResult("room.work.reply", {
      id: "instruction_1",
      workId: "work_1",
      assignmentId: "assignee_1",
      kind: "reply",
      instruction: "Review the referenced resources.",
      attachments: [],
      resourceRefs: [resourceRef],
      version: 2,
      generation: 0,
      status: "accepted",
      createdBy: "account_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }) as Record<string, unknown>;
    expect(instruction.resource_refs).toEqual([resourceRef]);

    const event = roomWorkEventFor("room.work.reply", "room_1", {
      work_id: "work_1",
      resource_refs: [resourceRef]
    }, { work_id: "work_1" });
    expect(event?.resources).toEqual(expect.arrayContaining([resourceRef]));
    expect(() => eventPayloadSchemaFor("workspace.room_work.changed").parse(event?.payload)).not.toThrow();
  });

  it("publishes only the safe Agent Backend availability projection", () => {
    const result = publicAgentBackendRecord({
      id: "codex",
      kind: "codex",
      label: "Codex",
      configured: true,
      enabled: true,
      connection_state: "ready",
      reason: "command_not_configured"
    }) as Record<string, unknown>;
    expect(result).toEqual({
      id: "codex",
      kind: "codex",
      label: "Codex",
      configured: true,
      enabled: true,
      connection_state: "ready",
      reason: "command_not_configured"
    });
    expect(publicAgentBackendRecord({
      id: "codex",
      kind: "codex",
      label: "Codex",
      configured: false,
      enabled: false,
      connection_state: "unconfigured",
      reason: "/private/credentials/token"
    })).toEqual({
      id: "codex",
      kind: "codex",
      label: "Codex",
      configured: false,
      enabled: false,
      connection_state: "unconfigured"
    });
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("capabilities");
    expect(result).not.toHaveProperty("session_policy");
  });

  it("routes the backend availability query through the host registry", () => {
    const queryStart = domainSource.indexOf('if (queryId === "agent.backend.list")');
    const queryEnd = domainSource.indexOf('if (queryId === "agent.list")', queryStart);
    expect(domainSource.slice(queryStart, queryEnd)).toContain("backendRegistry.statuses");
    expect(domainSource).toContain('"agent.backend.list"');
    expect(httpSource).toContain("backendRegistry,");
  });

  it("routes Room-work delegation through the Store and keeps the public assignee DTO Session-free", () => {
    const start = domainSource.indexOf('case "room.work.assignee.delegate"');
    const end = domainSource.indexOf('case "agent.dm.open"', start);
    const source = domainSource.slice(start, end);
    expect(source).toContain("delegateRoomWorkAssignee");
    expect(source).toContain("roomId");
    expect(source).toContain("workId");

    const result = publicOperationResult("room.work.assignee.delegate", {
      assignment: {
        workspaceId: "workspace_1",
        id: "child_assignee_1",
        workId: "work_1",
        roomId: "room_1",
        agentId: "agent_2",
        parentAssigneeId: "parent_assignee_1",
        agentVersion: 3,
        instructionVersion: 2,
        generation: 2,
        attempt: 0,
        priority: 0,
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      id: "child_assignee_1",
      work_id: "work_1",
      agent_id: "agent_2",
      parent_assignee_id: "parent_assignee_1",
      status: "queued"
    });
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("room_id");
  });

  it("does not project a stop control status as an assignee status", () => {
    for (const status of ["accepted", "completed"]) {
      const event = roomWorkEventFor("room.work.assignee.stop", "room_1", {
        id: "control_1",
        work_id: "work_1",
        assignee_id: "assignee_1",
        action: "assignee.stop",
        status,
        generation: 2,
        version: 1
      }, { work_id: "work_1", assignee_id: "assignee_1" });

      expect(event).toBeDefined();
      expect(event?.payload).not.toHaveProperty("status");
      expect(() => eventPayloadSchemaFor("workspace.room_work.assignee.changed").parse(event?.payload)).not.toThrow();
    }
  });

  it("projects stop uncertainty without exposing backend dispatch details", () => {
    const result = publicOperationResult("room.work.stop", {
      control: {
        id: "control_1",
        operationId: "operation_1",
        workId: "work_1",
        action: "stop_request",
        state: "unconfirmed",
        generation: 3,
        version: 1,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
        details: {
          terminal_status: "unconfirmed",
          unconfirmed_assignee_ids: ["assignee_1"],
          lease_owner: "must_not_escape",
          backend_diagnostic: "must_not_escape"
        }
      }
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      id: "control_1",
      action: "stop",
      status: "unconfirmed",
      terminal_status: "unconfirmed",
      unconfirmed_assignee_ids: ["assignee_1"]
    });
    expect(result).not.toHaveProperty("details");
    expect(result).not.toHaveProperty("lease_owner");
    expect(result).not.toHaveProperty("backend_diagnostic");
  });

  it("keeps the legacy compatibility result Session-free", () => {
    const result = publicOperationResult("chat.turn.run", {
      mode: "reply",
      instruction: {
        id: "instruction_1",
        workId: "work_1",
        assignmentId: "assignee_1",
        roomId: "room_1",
        version: 2,
        body: "Continue the review",
        attachments: [],
        sourceKind: "reply",
        state: "accepted",
        createdBy: "account_1",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      sessionId: "session_private_should_not_escape"
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ compatibility: "room_work", mode: "reply" });
    expect(result).not.toHaveProperty("session_id");
    expect(result).not.toHaveProperty("sessionId");
    expect(result.instruction).toMatchObject({ work_id: "work_1", version: 2 });
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

  it("projects Room Agent permission mutations without exposing internal authority", () => {
    const permission = {
      workspaceId: "workspace_1",
      roomId: "room_1",
      agentId: "agent_1",
      canView: false,
      canEdit: false,
      canExecute: false,
      version: 2,
      createdBy: "account_1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z"
    };
    expect(publicOperationResult("room.agent.permission.set", permission)).toEqual({
      id: "room_agent:room_1:agent_1",
      room_id: "room_1",
      agent_id: "agent_1",
      can_view: false,
      can_edit: false,
      can_execute: false,
      version: 2,
      created_by: "account_1",
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
      removed: true
    });
    expect(publicOperationResult("room.member.list", { humans: [], agents: [permission] })).toEqual({
      humans: [],
      agents: [expect.objectContaining({ room_id: "room_1", agent_id: "agent_1", removed: true })]
    });
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
