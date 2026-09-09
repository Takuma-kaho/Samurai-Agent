import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActivityIngestRequestSchema,
  DomainApiRequestSchema,
  DomainApiTransportRequest,
  DomainApiClient,
  PublicRoomCreateInputSchema,
  PublicRoomAgentPermissionSetInputSchema,
  PublicRoomAgentRemoveInputSchema,
  PublicRoomAgentPermissionRecordSchema,
  PublicAgentBackendRecordSchema,
  PublicRoomMemberListRecordSchema,
  PublicRoomDomainApiRequestSchema,
  PublicRoomWorkCommentCreateInputSchema,
  PublicRoomWorkCreateInputSchema,
  PublicRoomWorkReplyInputSchema,
  PublicRoomWorkResourceRefInputSchema,
  PublicRoomWorkResourceRefSchema,
  PublicEventEnvelopeSchema,
  PublicWorkspaceDirectorySchema,
  PublicWorkspaceTransferManifestSchema,
  PublicWorkspaceTransferReceiptSchema,
  eventCatalog,
  eventPayloadSchemaFor,
  isApiVersionCompatible,
  isEventVersionCompatible,
  publicLegacyDomainOperationCompatibility,
  legacyPublicDomainOperationIds,
  parsePublicEventPayload,
  publicDomainOperationIds,
  publicOperationOutputSchemaFor,
  publicOperationInputSchemaFor,
  runControlRequestSchemaFor
} from "./index";

const activityBase = {
  context: { room_id: "room_1" },
  source_event_id: "source_1",
  payload_hash: "a".repeat(64),
  dedupe_key: "dedupe_1",
  occurred_at: "2026-08-30T00:00:00.000Z",
  instruction_summary: "Record the completed work.",
  verification: [],
  domain_operation_ids: [],
  resource_usage: []
};

describe("public Domain API contract", () => {
  it("keeps authority out of the public request context", () => {
    expect(DomainApiRequestSchema.safeParse({
      context: { room_id: "room_1", actor_id: "spoofed" },
      input: {}
    }).success).toBe(false);
  });

  it("publishes Room-first work inputs and keeps legacy Session IDs compatibility-only", () => {
    expect(publicDomainOperationIds).not.toContain("session.create");
    expect(publicDomainOperationIds).not.toContain("chat.turn.run");
    expect(legacyPublicDomainOperationIds).toEqual(["session.create", "chat.turn.run"]);
    expect(publicLegacyDomainOperationCompatibility).toEqual([
      expect.objectContaining({ id: "session.create", availability: "deprecated_command", replacement_operation_ids: ["room.work.create"] }),
      expect.objectContaining({ id: "chat.turn.run", availability: "deprecated_command", replacement_operation_ids: ["room.work.create", "room.work.reply"] })
    ]);

    expect(PublicRoomDomainApiRequestSchema.safeParse({
      context: { room_id: "room_1" },
      input: { instruction: "Use the Room work contract." }
    }).success).toBe(true);
    const resourceSelector = { kind: "knowledge", id: "resource_1", version: 2 } as const;
    expect(PublicRoomWorkCreateInputSchema.safeParse({ resource_refs: [resourceSelector] }).success).toBe(true);
    expect(PublicRoomWorkReplyInputSchema.safeParse({ work_id: "work_1", resource_refs: [resourceSelector] }).success).toBe(true);
    expect(publicOperationInputSchemaFor("room.work.create", z.any()).safeParse({ resource_refs: [resourceSelector] }).success).toBe(true);
    expect(PublicRoomWorkResourceRefInputSchema.safeParse({ ...resourceSelector, uri: "client://must-be-rejected" }).success).toBe(false);
    expect(PublicRoomWorkResourceRefInputSchema.safeParse({ kind: "policy", id: "resource_1", version: 2 }).success).toBe(false);
    expect(PublicRoomWorkResourceRefInputSchema.safeParse({ kind: "knowledge", id: "resource_1" }).success).toBe(false);
    expect(PublicRoomWorkResourceRefSchema.safeParse({
      kind: "skill",
      id: "resource_2",
      uri: "skills/resource_2/SKILL.md",
      version: "3",
      label: "A Skill"
    }).success).toBe(true);
    expect(PublicRoomWorkCreateInputSchema.safeParse({ instruction: "Use the Room work contract.", session_id: "session_1" }).success).toBe(false);
    expect(PublicRoomWorkCommentCreateInputSchema.safeParse({ work_id: "work_1", body: "A comment", actor_id: "spoofed" }).success).toBe(false);
    expect(PublicRoomWorkCommentCreateInputSchema.safeParse({ work_id: "work_1", resource_refs: [resourceSelector] }).success).toBe(false);

    expect(PublicRoomCreateInputSchema.safeParse({
      name: "Product",
      default_agent_id: "agent_1",
      agent_permission: { can_view: true, can_edit: true, can_execute: true }
    }).success).toBe(true);
    expect(PublicRoomCreateInputSchema.safeParse({
      name: "Product",
      new_agent: {
        name: "Builder",
        role: "builder",
        instructions: "Build the requested result.",
        backend_id: "samurai-native",
        permission: { can_view: true, can_edit: false, can_execute: true }
      }
    }).success).toBe(true);
    expect(PublicRoomCreateInputSchema.safeParse({
      name: "Invalid",
      default_agent_id: "agent_1",
      new_agent: {
        name: "Builder",
        role: "builder",
        instructions: "Build the requested result.",
        backend_id: "samurai-native"
      }
    }).success).toBe(false);
    expect(publicDomainOperationIds).toEqual(expect.arrayContaining([
      "room.member.list",
      "room.agent.permission.set",
      "room.agent.remove",
      "agent.backend.list"
    ]));
    expect(PublicAgentBackendRecordSchema.safeParse({
      id: "samurai-native",
      kind: "samurai_native",
      label: "Samurai Native",
      configured: true,
      enabled: true,
      connection_state: "ready"
    }).success).toBe(true);
    expect(PublicAgentBackendRecordSchema.safeParse({
      id: "samurai-native",
      kind: "samurai_native",
      label: "Samurai Native",
      configured: true,
      enabled: true,
      connection_state: "ready",
      metadata: { command: "/private/secret" }
    }).success).toBe(false);
    expect(PublicRoomAgentPermissionSetInputSchema.safeParse({
      agent_id: "agent_1",
      can_view: true,
      can_edit: false,
      can_execute: true
    }).success).toBe(true);
    expect(PublicRoomAgentPermissionSetInputSchema.safeParse({
      agent_id: "agent_1",
      can_view: false,
      can_edit: false,
      can_execute: true
    }).success).toBe(false);
    expect(PublicRoomAgentRemoveInputSchema.safeParse({ agent_id: "agent_1" }).success).toBe(true);
    expect(PublicRoomMemberListRecordSchema.safeParse({ humans: [], agents: [] }).success).toBe(true);
    expect(PublicRoomAgentPermissionRecordSchema.safeParse({
      id: "room_agent:room_1:agent_1",
      room_id: "room_1",
      agent_id: "agent_1",
      can_view: false,
      can_edit: false,
      can_execute: false,
      version: 2,
      created_by: "account_1",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
      removed: true
    }).success).toBe(true);
    expect(PublicRoomCreateInputSchema.safeParse({
      name: "Invalid default permission",
      default_agent_id: "agent_1",
      agent_permission: { can_view: true, can_edit: false, can_execute: false }
    }).success).toBe(false);
  });

  it("does not turn incomplete or unknown Activity outcomes into success", () => {
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "completed"
    }).success).toBe(false);
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "unknown",
      failure: { code: "success", summary: "not actually verified" }
    }).success).toBe(false);
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "unknown",
      failure: { code: "transport_lost", summary: "The result was not confirmed." }
    }).success).toBe(true);
  });

  it("gives each Run Control action its own input schema", () => {
    expect(runControlRequestSchemaFor("cancel").safeParse({ context: {}, input: {} }).success).toBe(true);
    expect(runControlRequestSchemaFor("cancel").safeParse({ context: {}, input: { confirm_unknown: true } }).success).toBe(false);
    expect(runControlRequestSchemaFor("retry").safeParse({ context: {}, input: { confirm_unknown: true } }).success).toBe(true);
  });

  it("strictly validates known Event payloads while retaining a legacy fallback", () => {
    expect(eventPayloadSchemaFor("workspace.room.changed").safeParse({ room_id: "room_1", action: "created" }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.room.changed").safeParse({ room_id: "room_1", action: "created", secret: "hidden" }).success).toBe(false);
    expect(eventPayloadSchemaFor("legacy.event").safeParse({ legacy: true }).success).toBe(true);
    expect(parsePublicEventPayload("legacy.event", {
      legacy: true,
      token: "must-not-leak",
      content: "full body must not leak",
      nested: { api_key: "also-hidden", keep: "ok" }
    })).toEqual({ legacy: true, nested: { keep: "ok" } });
    expect(PublicEventEnvelopeSchema.safeParse({
      event_id: "event_1",
      event_type: "workspace.room.changed",
      event_version: "1.0",
      cursor: "cursor_1",
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { kind: "system" },
      scope: { workspace_id: "workspace_1", room_id: "room_1" },
      resources: [],
      payload: { room_id: "room_1", action: "created" }
    }).success).toBe(true);
    expect(PublicEventEnvelopeSchema.safeParse({
      event_id: "event_organization_1",
      event_type: "organization.created",
      event_version: "1.0",
      cursor: "cursor_organization_1",
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { kind: "human", id: "account_1" },
      scope: { organization_id: "organization_1" },
      resources: [],
      payload: { organization_id: "organization_1", name: "Acme" }
    }).success).toBe(true);
  });

  it("publishes Room work events as safe state projections", () => {
    expect(eventCatalog.map((entry) => entry.event_type)).toEqual(expect.arrayContaining([
      "workspace.room_work.changed",
      "workspace.room_work.comment.changed",
      "workspace.room_work.assignee.changed",
      "workspace.room_default_agent.changed",
      "workspace.agent_dm.changed"
    ]));
    expect(eventPayloadSchemaFor("workspace.room_work.changed").safeParse({
      room_id: "room_1",
      work_id: "work_1",
      action: "created",
      status: "running",
      generation: 1,
      version: 1
    }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.room_work.changed").safeParse({
      room_id: "room_1",
      work_id: "work_1",
      action: "updated",
      status: "backend_error"
    }).success).toBe(false);
    expect(eventPayloadSchemaFor("workspace.room_work.assignee.changed").safeParse({
      room_id: "room_1",
      work_id: "work_1",
      assignee_id: "assignment_child",
      action: "delegated",
      delegated: true,
      agent_id: "agent_child",
      parent_assignee_id: "assignment_parent",
      status: "waiting",
      generation: 1,
      version: 2
    }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.room_work.comment.changed").safeParse({
      room_id: "room_1",
      work_id: "work_1",
      comment_id: "comment_1",
      action: "created",
      body: "private body"
    }).success).toBe(false);
    expect(eventPayloadSchemaFor("workspace.agent_dm.changed").safeParse({
      room_id: "room_dm",
      agent_id: "agent_1",
      action: "opened",
      session_id: "session_private"
    }).success).toBe(false);
  });

  it("publishes Artifact revision and Generated Surface public contracts", () => {
    expect(publicDomainOperationIds).toEqual(expect.arrayContaining([
      "artifact.list",
      "artifact.view",
      "artifact.create",
      "artifact.revise",
      "artifact.restore_revision",
      "generated_surface.create",
      "generated_surface.revise",
      "generated_surface.action.run",
      "generated_surface.state",
      "generated_surface.export"
    ]));
    expect(eventCatalog.map((entry) => entry.event_type)).toEqual(expect.arrayContaining([
      "workspace.artifact.changed",
      "workspace.generated_surface.changed",
      "workspace.interaction_request.changed"
    ]));
    expect(eventPayloadSchemaFor("workspace.artifact.changed").safeParse({
      artifact_id: "artifact_1",
      action: "revised",
      revision_id: "revision_2"
    }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.generated_surface.changed").safeParse({
      surface_id: "surface_1",
      action: "state_changed"
    }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.interaction_request.changed").safeParse({
      request_id: "request_1",
      kind: "approval",
      status: "pending",
      action: "created"
    }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.interaction_request.changed").safeParse({
      request_id: "request_1",
      kind: "backend_input",
      status: "accepted",
      action: "responded",
      values: { answer: "must not be public" }
    }).success).toBe(false);
  });

  it("publishes Organization events and keeps sensitive fields outside payloads", () => {
    const eventTypes = [
      "organization.created",
      "organization.member.invited",
      "organization.member.accepted",
      "organization.member.role_changed",
      "organization.member.removed",
      "workspace.organization.moved",
      "workspace.archived",
      "workspace.restored",
      "workspace.deleted"
    ];
    expect(eventCatalog.map((entry) => entry.event_type)).toEqual(expect.arrayContaining(eventTypes));
    expect(publicDomainOperationIds).toEqual(expect.arrayContaining([
      "organization.list",
      "organization.member.invite",
      "workspace.organization.move.commit",
      "workspace.bundle.export",
      "workspace.bundle.restore"
    ]));
    expect(publicDomainOperationIds).not.toContain("organization.workspace.list");
    expect(publicOperationOutputSchemaFor("organization.invitation.list", z.any()).safeParse([{
      id: "invitation_1",
      organization_id: "organization_1",
      role: "member",
      status: "pending",
      expires_at: "2026-09-01T00:00:00.000Z",
      issued_by: "account_1",
      version: 1,
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z"
    }]).success).toBe(true);

    expect(eventPayloadSchemaFor("organization.member.invited").safeParse({
      organization_id: "organization_1",
      invitation_id: "invitation_1",
      role: "member",
      token: "raw-token"
    }).success).toBe(false);
    expect(eventPayloadSchemaFor("organization.member.accepted").safeParse({
      organization_id: "organization_1",
      membership_id: "membership_1",
      email: "member@example.test",
      room_content: "private"
    }).success).toBe(false);
    expect(parsePublicEventPayload("workspace.organization.moved", {
      workspace_id: "workspace_1",
      source_organization_id: "organization_1",
      target_organization_id: "organization_2",
      operation_id: "move_1"
    })).toEqual({
      workspace_id: "workspace_1",
      source_organization_id: "organization_1",
      target_organization_id: "organization_2",
      operation_id: "move_1"
    });
  });

  it("keeps API and Event version compatibility independent", () => {
    expect(isApiVersionCompatible("1")).toBe(true);
    expect(isApiVersionCompatible("2")).toBe(false);
    expect(isEventVersionCompatible("1.7")).toBe(true);
    expect(isEventVersionCompatible("2.0")).toBe(false);
  });

  it("publishes an Organization-optional Workspace directory contract", () => {
    const directory = PublicWorkspaceDirectorySchema.parse({
      workspaces: [{
        id: "workspace_1",
        name: "Personal",
        state: "active",
        version: 1,
        hosting_mode: "self_host",
        database_placement: "dedicated",
        role: "owner",
        access: "granted",
        created_by: "account_1",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z"
      }, {
        id: "workspace_2",
        organization_id: "organization_1",
        name: "Team",
        state: "active",
        version: 2,
        role: "member",
        access: "granted"
      }]
    });
    expect(directory.workspaces[0]?.organization_id).toBeUndefined();
    expect(directory.workspaces[1]?.organization_id).toBe("organization_1");
    expect(() => PublicWorkspaceDirectorySchema.parse({
      workspaces: [{ id: "workspace_1", name: "Personal", state: "active", version: 1, storage_namespace: "private" }]
    })).toThrow();
  });

  it("routes Workspace-first client calls without forcing Organization IDs", async () => {
    const requests: DomainApiTransportRequest[] = [];
    const transport = async <T>(request: DomainApiTransportRequest): Promise<T> => {
      requests.push(request);
      return {} as T;
    };
    const client = new DomainApiClient(transport);
    await client.listAccountWorkspaces();
    await client.createWorkspace({ workspace_id: "workspace_1", name: "Personal" }, { operationId: "create_1" });
    await client.importWorkspaceBundle({ target_workspace_id: "workspace_2", bundle: { format: "samurai-workspace-bundle-v4" } }, { operationId: "restore_1", idempotencyKey: "idem_1" });
    await client.restoreWorkspaceBundle({ bundle_id: "bundle_1", confirm: true }, { operationId: "restore_managed_1" });
    await client.exportWorkspaceBundle("workspace_1", { operationId: "export_1", expectedWorkspaceVersion: 2 });
    await client.attachWorkspaceToOrganization("organization_1", "workspace_1", { operationId: "attach_1", expectedWorkspaceVersion: 3, confirmGuestMemberships: true });
    await client.detachWorkspaceFromOrganization("organization_1", "workspace_1", { operationId: "detach_1" });
    await client.listAgentBackends("workspace_1");

    expect(requests).toEqual([
      { method: "GET", path: "/api/account/workspaces" },
      { method: "POST", path: "/api/workspaces", body: { workspace_id: "workspace_1", name: "Personal" }, operationId: "create_1" },
      { method: "POST", path: "/api/workspaces/imports", body: { target_workspace_id: "workspace_2", bundle: { format: "samurai-workspace-bundle-v4" } }, operationId: "restore_1", idempotencyKey: "idem_1" },
      { method: "POST", path: "/api/workspaces/bundles/restore", body: { bundle_id: "bundle_1", confirm: true }, operationId: "restore_managed_1", idempotencyKey: "restore_managed_1" },
      { method: "POST", path: "/api/workspaces/workspace_1/bundle/export", body: { expected_workspace_version: 2 }, operationId: "export_1", idempotencyKey: "export_1" },
      { method: "POST", path: "/api/organizations/organization_1/workspaces/workspace_1/attach", body: { expected_workspace_version: 3, confirm_guest_memberships: true }, operationId: "attach_1", idempotencyKey: "attach_1" },
      { method: "POST", path: "/api/organizations/organization_1/workspaces/workspace_1/detach", body: {}, operationId: "detach_1", idempotencyKey: "detach_1" },
      { method: "POST", path: "/api/v1/workspaces/workspace_1/domain/queries/agent.backend.list", body: { context: {}, input: {} } }
    ]);
  });

  it("uses fixed Room-scoped Artifact and Generated Surface v1 routes", async () => {
    const requests: DomainApiTransportRequest[] = [];
    const client = new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
      requests.push(request);
      return {} as T;
    });

    await client.listArtifactRevisions("workspace_1", "room_1", "artifact_1");
    await client.getArtifactRevision("workspace_1", "room_1", "artifact_1", "revision_1");
    await client.listGeneratedSurfaces("workspace_1", "room_1");
    await client.getGeneratedSurface("workspace_1", "room_1", "surface_1");
    await client.getGeneratedSurfaceBundle("workspace_1", "room_1", "surface_1", "surface_revision_1");
    await client.runGeneratedSurfaceAction("workspace_1", "room_1", "surface_1", "refresh", {}, { operationId: "surface_action_1" });
    await client.runGeneratedSurfaceState("workspace_1", "room_1", "surface_1", { action: "pin" }, { operationId: "surface_state_1" });
    await client.exportGeneratedSurface("workspace_1", "room_1", "surface_1", { format: "html" });
    await client.runArtifactSurfaceOperation("workspace_1", "room_1", { id: "surface_op_1", kind: "artifact.request", action: "create" }, { operationId: "artifact_surface_1" });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/workspaces/workspace_1/artifacts/artifact_1/revisions?room_id=room_1",
      "GET /api/v1/workspaces/workspace_1/artifacts/artifact_1/revisions/revision_1?room_id=room_1",
      "GET /api/v1/workspaces/workspace_1/generated-surfaces?room_id=room_1",
      "GET /api/v1/workspaces/workspace_1/generated-surfaces/surface_1?room_id=room_1",
      "GET /api/v1/workspaces/workspace_1/generated-surfaces/surface_1/revisions/surface_revision_1/bundle?room_id=room_1",
      "POST /api/v1/workspaces/workspace_1/generated-surfaces/surface_1/actions/refresh/run",
      "POST /api/v1/workspaces/workspace_1/generated-surfaces/surface_1/state",
      "GET /api/v1/workspaces/workspace_1/generated-surfaces/surface_1/export?room_id=room_1&format=html",
      "POST /api/v1/workspaces/workspace_1/artifacts/surface/operations"
    ]);
  });

  it("validates transfer proof and keeps cutover stages explicit", () => {
    const hash = "a".repeat(64);
    expect(PublicWorkspaceTransferManifestSchema.parse({
      format_version: 4,
      workspace_id: "workspace_1",
      exported_at: "2026-09-01T00:00:00.000Z",
      transfer_id: "transfer_1",
      base_v3_integrity_hash: hash,
      excluded_maintenance_account_ids: [],
      files: { "workspace/core.jsonl": hash },
      record_counts: { workspaces: 1 },
      integrity_hash: hash
    }).transfer_id).toBe("transfer_1");
    expect(PublicWorkspaceTransferReceiptSchema.safeParse({
      format_version: 1,
      transfer_id: "transfer_1",
      source_workspace_id: "workspace_1",
      source_integrity_hash: hash,
      target_workspace_id: "workspace_1",
      imported_at: "2026-09-01T00:00:00.000Z",
      target_integrity_hash: hash
    }).success).toBe(true);
    expect(PublicWorkspaceTransferReceiptSchema.safeParse({
      format_version: 1,
      transfer_id: "transfer_1",
      source_workspace_id: "workspace_1",
      source_integrity_hash: hash,
      target_workspace_id: "workspace_1",
      imported_at: "2026-09-01T00:00:00.000Z",
      target_integrity_hash: "b".repeat(64)
    }).success).toBe(false);
  });
});
