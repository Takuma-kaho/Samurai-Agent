import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActivityIngestRequestSchema,
  DomainApiRequestSchema,
  DomainApiTransportRequest,
  DomainApiClient,
  PublicEventEnvelopeSchema,
  PublicWorkspaceDirectorySchema,
  PublicWorkspaceTransferManifestSchema,
  PublicWorkspaceTransferReceiptSchema,
  eventCatalog,
  eventPayloadSchemaFor,
  isApiVersionCompatible,
  isEventVersionCompatible,
  parsePublicEventPayload,
  publicDomainOperationIds,
  publicOperationOutputSchemaFor,
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

    expect(requests).toEqual([
      { method: "GET", path: "/api/account/workspaces" },
      { method: "POST", path: "/api/workspaces", body: { workspace_id: "workspace_1", name: "Personal" }, operationId: "create_1" },
      { method: "POST", path: "/api/workspaces/imports", body: { target_workspace_id: "workspace_2", bundle: { format: "samurai-workspace-bundle-v4" } }, operationId: "restore_1", idempotencyKey: "idem_1" },
      { method: "POST", path: "/api/workspaces/bundles/restore", body: { bundle_id: "bundle_1", confirm: true }, operationId: "restore_managed_1", idempotencyKey: "restore_managed_1" },
      { method: "POST", path: "/api/workspaces/workspace_1/bundle/export", body: { expected_workspace_version: 2 }, operationId: "export_1", idempotencyKey: "export_1" },
      { method: "POST", path: "/api/organizations/organization_1/workspaces/workspace_1/attach", body: { expected_workspace_version: 3, confirm_guest_memberships: true }, operationId: "attach_1", idempotencyKey: "attach_1" },
      { method: "POST", path: "/api/organizations/organization_1/workspaces/workspace_1/detach", body: {}, operationId: "detach_1", idempotencyKey: "detach_1" }
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
