import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextSnapshotService, RoomBindingService } from "@samurai-agent/external-integration";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import type { WikiFrontmatter } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, createRuntimeContextSnapshotSource, ExternalAppContextError, RuntimeMcpWorkspacePort } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core09 formal External App ingress", () => {
  it("uses one resolver for read, Activity, and Domain Operation without creating a Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-ingress-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;

    const created = await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:create-connection",
      payload: {
        connector_id: "connector-core09-test",
        app_id: "app-core09-test",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId],
        ingress_classes: ["query", "domain_operation", "activity_ingest"],
        non_secret_metadata: { label: "Core09 fixture" }
      }
    });
    const connection = created.result as { resource: { id: string } };
    const adapter = runtime.createReferenceExternalAppAdapter();
    const evidence = { connector_id: "connector-core09-test", app_id: "app-core09-test" };
    const target = {
      requested_room_id: roomId,
      correlation_id: "core09-external-flow",
      idempotency_key: "core09:artifact:1",
      session_ref: { session_id: "external-session-1" }
    };

    const before = {
      sessions: await store.listSessions(),
      operations: await store.listOperations(),
      activities: await store.listActivities({ workspaceId: "workspace", roomId }),
      jobs: await store.listWorkspaceJobs({ workspaceId: "workspace" }),
      audit: await store.listAuditRecords()
    };
    const query = await adapter.query({ evidence, target, query_id: "activity.history.list" });
    const afterQuery = {
      sessions: await store.listSessions(),
      operations: await store.listOperations(),
      activities: await store.listActivities({ workspaceId: "workspace", roomId }),
      jobs: await store.listWorkspaceJobs({ workspaceId: "workspace" }),
      audit: await store.listAuditRecords()
    };

    expect(query.result).toEqual({ items: [] });
    expect(afterQuery).toEqual(before);

    const ingested = await adapter.activityIngest({
      evidence,
      target,
      idempotency_key: "core09:activity:1",
      instruction_summary: "External App verified one result.",
      result_summary: "The result was recorded.",
      status: "completed",
      verification: [{ id: "check-1", kind: "test", status: "passed", summary: "Fixture verification passed.", recorded_at: "2026-08-10T00:00:00.000Z" }]
    });
    const mutation = await adapter.domainOperation({
      evidence,
      target,
      command_id: "artifact.create",
      payload: { title: "External artifact", content: "# External artifact\n\nRecorded through Core09.", kind: "markdown" }
    });
    const artifactResult = mutation.result as { resource: { id: string }; operation: { principal?: { kind: string }; source?: { kind: string; connector_id?: string }; session_id?: string } };
    const activities = await store.listActivities({ workspaceId: "workspace", roomId });
    const afterMutationSessions = await store.listSessions();

    expect(ingested).toMatchObject({
      room_id: roomId,
      principal: { kind: "external_app", app_id: "app-core09-test", connector_id: "connector-core09-test" },
      session_ref: { app_id: "app-core09-test", session_id: "external-session-1" },
      status: "completed"
    });
    expect(artifactResult.resource.id).toBeTruthy();
    expect(artifactResult.operation).toMatchObject({
      principal: { kind: "external_app", app_id: "app-core09-test", connector_id: "connector-core09-test" },
      source: { kind: "external_app", connector_id: "connector-core09-test" }
    });
    expect(artifactResult.operation.session_id).toBeUndefined();
    expect(activities.some((activity) => activity.id === ingested.id)).toBe(true);
    expect(await store.listWorkspaceJobs({ workspaceId: "workspace" })).toEqual(before.jobs);
    expect(afterMutationSessions).toEqual(before.sessions);
    expect(await store.getSession("external-session-1")).toBeUndefined();

    await expect(adapter.domainOperation({
      evidence,
      target,
      command_id: "artifact.create",
      payload: {
        title: "Forged context", content: "must fail",
        principal: { kind: "human", participant_id: localOwnerParticipantId }
      }
    })).rejects.toMatchObject({ code: "bad_request", message: "untrusted_domain_context:principal" });
    await expect(adapter.domainOperation({
      evidence,
      target,
      command_id: "artifact.create",
      payload: {
        title: "Forged connector", content: "must fail", connector_id: "forged-connector"
      }
    })).rejects.toMatchObject({ code: "bad_request", message: "untrusted_domain_context:connector_id" });
    await expect(adapter.domainOperation({
      evidence,
      target,
      command_id: "artifact.create",
      payload: {
        title: "Forged source", content: "must fail", source: { kind: "host" }
      }
    })).rejects.toMatchObject({ code: "bad_request", message: "untrusted_domain_context:source" });
    await expect(adapter.query({
      evidence: { connector_id: evidence.connector_id, app_id: "forged-app" },
      target,
      query_id: "activity.history.list"
    })).rejects.toBeInstanceOf(ExternalAppContextError);
    await expect(adapter.query({
      evidence,
      target: { ...target, requested_room_id: "room-outside-connection" },
      query_id: "activity.history.list"
    })).rejects.toMatchObject({ code: "external_app_connection_room_scope_denied" });

    await runtime.runDomainCommand({
      command_id: "external_app.connection.revoke",
      idempotency_key: "core09:revoke-connection",
      payload: { connection_id: connection.resource.id }
    });
    await expect(adapter.query({ evidence, target, query_id: "activity.history.list" })).rejects.toMatchObject({
      code: "external_app_connection_revoked"
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("rejects app-controlled SessionRef fields before any Runtime dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-session-ref-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:create-session-ref-connection",
      payload: {
        connector_id: "connector-session-ref", app_id: "app-session-ref",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId }, allowed_room_ids: [roomId], ingress_classes: ["query"]
      }
    });

    await expect(runtime.createReferenceExternalAppAdapter().query({
      evidence: { connector_id: "connector-session-ref", app_id: "app-session-ref" },
      target: { requested_room_id: roomId, correlation_id: "core09-bad-session-ref", session_ref: { app_id: "other-app", session_id: "foreign-session" } },
      query_id: "activity.history.list"
    })).rejects.toMatchObject({ code: "external_app_requested_room_invalid" });
    await expect(runtime.createReferenceExternalAppAdapter().activityIngest({
      evidence: { connector_id: "connector-session-ref", app_id: "app-session-ref" },
      target: { requested_room_id: roomId, correlation_id: "core09-ingress-class" },
      idempotency_key: "core09:ingress-class", instruction_summary: "Must not be saved.", status: "completed"
    })).rejects.toMatchObject({ code: "external_app_ingress_class_denied" });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("reads human-owned Workspace and Room Context through the bound formal Query", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-context-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    await store.patchSettings({
      workspace_name: "Core09 Context Workspace",
      workspace_rules: ["Do not mix Context across Rooms."]
    });
    await store.patchRoomContext({
      roomId,
      purpose: "Keep external work in this Room.",
      workGoal: "Verify trusted Context delivery."
    });
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:context:connection",
      payload: {
        connector_id: "connector-context", app_id: "app-context",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId], ingress_classes: ["query"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const request = {
      evidence: { connector_id: "connector-context", app_id: "app-context" },
      target: { requested_room_id: roomId, correlation_id: "core09-context-read" },
      query_id: "workspace.context.get",
      payload: { room_id: roomId }
    } as const;

    await expect(adapter.query(request)).resolves.toMatchObject({
      result: {
        workspace: {
          id: expect.any(String),
          name: "Core09 Context Workspace",
          rules: ["Do not mix Context across Rooms."]
        },
        room: {
          id: roomId,
          purpose: "Keep external work in this Room.",
          work_goal: "Verify trusted Context delivery.",
          permissions: expect.arrayContaining(["room.read", "room.edit", "room.execute"]),
          prohibited: expect.not.arrayContaining(["room.read:room_role_denied"])
        }
      }
    });
    await expect(adapter.query({ ...request, payload: { room_id: "other-room" } })).rejects.toThrow("workspace_context_room_mismatch");

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("returns public MCP reads in the fixed item and page envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-mcp-envelope-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const createdAt = "2026-08-18T00:00:00.000Z";
    const wiki = await store.saveWikiPage({
      id: "wiki-core09-mcp-envelope",
      slug: "core09-mcp-envelope",
      title: "MCP envelope fixture",
      state: "active",
      content_locale: "en",
      tags: [],
      source_refs: [],
      provenance: { kind: "user_authored", summary: "MCP output contract fixture", verified: true },
      usage_scope: { kind: "room", room_id: roomId },
      created_at: createdAt,
      updated_at: createdAt
    }, "# MCP envelope fixture\n\nOnly the data field contains the formal read payload.");
    await store.ensureResourceAccessBoundary({
      resourceKind: "wiki",
      resourceId: wiki.id,
      sourceRoomId: roomId,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:mcp-envelope:connection",
      payload: {
        connector_id: "connector-mcp-envelope",
        app_id: "app-mcp-envelope",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId],
        ingress_classes: ["query"]
      }
    });
    const bindings = new RoomBindingService({
      store: store.externalIntegration,
      connections: store,
      authorization: runtime.externalIntegrationRoomAuthorization()
    });
    const snapshots = new ContextSnapshotService({
      store: store.externalIntegration,
      source: createRuntimeContextSnapshotSource({ runtime })
    });
    const port = new RuntimeMcpWorkspacePort({ integrationStore: store.externalIntegration, runtime, bindings, snapshots });
    const target = {
      workspaceId: "workspace",
      roomId,
      projectRef: "project-mcp-envelope",
      accountId: localOwnerParticipantId,
      connectionId: (await store.getExternalAppConnectionByConnector({ workspaceId: "workspace", connectorId: "connector-mcp-envelope" }))!.id,
      connectorId: "connector-mcp-envelope",
      appId: "app-mcp-envelope",
      bindingVersion: 1,
      externalSessionId: "external-mcp-envelope"
    };
    const startupContext = await port.getContextSnapshot(target);
    expect(startupContext).toMatchObject({
      frozen: true,
      content: expect.stringContaining("Allowed: room.read"),
      omitted_sections: expect.any(Array)
    });
    const page = await port.query(target, "knowledge.search", { query: "MCP envelope", limit: 10 });
    expect(page).toMatchObject({
      items: [expect.objectContaining({
        resource_id: wiki.id,
        room_id: roomId,
        version: wiki.resource_version,
        evidence: { connector_id: "connector-mcp-envelope", app_id: "app-mcp-envelope" },
        provenance: { source: "samurai", access: "ExternalAppIngress", room_id: roomId, resource_id: wiki.id },
        data: expect.any(Object)
      })],
      next_cursor: null
    });
    const read = await port.query(target, "knowledge.read", { knowledge_id: wiki.id });
    expect(read).toMatchObject({
      item: expect.objectContaining({ resource_id: wiki.id, room_id: roomId, data: expect.any(Object) })
    });
    expect(Object.keys((read.item ?? {}) as Record<string, unknown>).sort()).toEqual([
      "data", "evidence", "provenance", "resource_id", "room_id", "updated_at", "version"
    ]);
    await expect(port.query(target, "knowledge.read", { knowledge_id: wiki.id, path: "artifacts/not-the-knowledge.md" })).rejects.toMatchObject({
      code: "mcp_invalid_arguments", message: "knowledge_path_mismatch"
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("ends an external session on the provider session-end event and keeps replay idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-session-end-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const created = await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:session-end:connection",
      payload: {
        connector_id: "connector-session-end", app_id: "app-session-end",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId], ingress_classes: ["activity_ingest"]
      }
    });
    const connection = created.result as { resource: { id: string } };
    await store.externalIntegration.createRecord("connector_manifest", {
      connector_id: "connector-session-end",
      display_name: "Session End Connector",
      provider: "Fixture",
      version: "1.0.0",
      supported_os: ["darwin"],
      required_samurai_version: "0.1.0",
      transport: "streamable_http",
      oauth_redirect_uris: ["https://client.example/callback"],
      requested_scopes: ["activity.ingest"],
      supported_events: ["codex.SessionEnd"],
      context_injection: "startup_tool",
      full_capture: "unsupported",
      url_elicitation: "fallback",
      package_checksum: "sha256:session-end"
    });
    await store.externalIntegration.createRecord("connector_installation", {
      id: "connector-session-end-installation",
      workspace_id: "workspace",
      connector_id: "connector-session-end",
      version: "1.0.0",
      package_checksum: "sha256:session-end",
      enabled: true,
      installed_at: "2026-08-18T00:00:00.000Z"
    });
    await store.externalIntegration.createRecord("external_session", {
      id: "external-session-end-record",
      external_session_id: "client-session-end",
      project_ref: "session-end-project",
      workspace_id: "workspace",
      connection_id: connection.resource.id,
      account_id: localOwnerParticipantId,
      room_id: roomId,
      binding_version: 1,
      connector_id: "connector-session-end",
      connector_version: "1.0.0",
      capabilities: {},
      started_at: "2026-08-18T00:00:00.000Z",
      capture_completeness: "unsupported"
    });
    const bindings = new RoomBindingService({
      store: store.externalIntegration,
      connections: store,
      authorization: runtime.externalIntegrationRoomAuthorization()
    });
    await bindings.bind({
      auth: {
        workspaceId: "workspace",
        accountId: localOwnerParticipantId,
        connectionId: connection.resource.id,
        connectorId: "connector-session-end",
        appId: "app-session-end",
        scopes: ["room.binding.write"],
        tokenVersion: 1,
        expiresAt: "2026-08-19T00:00:00.000Z"
      },
      workspaceId: "workspace",
      accountId: localOwnerParticipantId,
      projectRef: "session-end-project",
      roomId,
      changedBy: localOwnerParticipantId
    });
    const snapshots = new ContextSnapshotService({
      store: store.externalIntegration,
      source: createRuntimeContextSnapshotSource({ runtime })
    });
    const port = new RuntimeMcpWorkspacePort({ integrationStore: store.externalIntegration, runtime, bindings, snapshots });
    const target = {
      workspaceId: "workspace", roomId, projectRef: "session-end-project", accountId: localOwnerParticipantId,
      connectionId: connection.resource.id, connectorId: "connector-session-end", appId: "app-session-end",
      bindingVersion: 1, externalSessionId: "client-session-end"
    };
    const event = {
      connector_id: "connector-session-end", connector_version: "1.0.0", event_id: "session-end-1",
      event_kind: "codex.SessionEnd", external_session_id: "client-session-end", app_id: "app-session-end",
      changed_resources: [], verification: "not_run" as const, outcome: "completed" as const,
      occurred_at: "2026-08-18T00:00:01.000Z", payload: {}
    };
    await expect(port.ingestActivity(target, event)).resolves.toMatchObject({ accepted: true, duplicate: false, activity: { status: "outcome_unknown" } });
    const ended = await store.externalIntegration.getRecord("external_session", "external-session-end-record");
    expect(ended?.ended_at).toBeTruthy();
    await expect(port.ingestActivity(target, event)).resolves.toMatchObject({ accepted: true, duplicate: true });
    await expect(port.ingestActivity(target, { ...event, event_id: "session-after-end", event_kind: "codex.turn.completed" })).rejects.toMatchObject({ code: "external_session_restart_required" });
    await expect(port.resolveTarget({
      workspaceId: "workspace",
      accountId: localOwnerParticipantId,
      connectionId: connection.resource.id,
      connectorId: "connector-session-end",
      appId: "app-session-end",
      scopes: ["activity.ingest"],
      tokenVersion: 1,
      expiresAt: "2026-08-19T00:00:00.000Z"
    }, { workspaceId: "workspace", projectRef: "session-end-project", externalSessionId: "client-session-end" })).rejects.toMatchObject({ code: "external_session_restart_required" });
    expect((await store.externalIntegration.listRecords("audit_event", { workspaceId: "workspace" })).filter((record) => record.event_type === "external.session.ended")).toHaveLength(1);

    const installation = await store.externalIntegration.getRecord("connector_installation", "connector-session-end-installation");
    const installationVersion = await store.externalIntegration.getRecordVersion("connector_installation", "connector-session-end-installation");
    expect(installation && installationVersion).toBeTruthy();
    await store.externalIntegration.updateRecord("connector_installation", "connector-session-end-installation", installationVersion!, { ...installation!, enabled: false, disabled_at: "2026-08-18T00:00:02.000Z" });
    await expect(port.assertTargetCurrent(target)).rejects.toMatchObject({ code: "connector_disabled" });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("copies and moves Room-scoped Knowledge only through the bound formal ingress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-resource-transfer-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const sourceRoomId = (await store.getSettings()).default_room_id!;
    const now = "2026-08-18T00:00:00.000Z";
    const targetRoom = await store.createRoom({
      id: "room-core09-transfer-target",
      name: "Transfer target",
      created_at: now,
      updated_at: now
    });
    const unboundRoom = await store.createRoom({
      id: "room-core09-transfer-unbound",
      name: "Unbound target",
      created_at: now,
      updated_at: now
    });
    const sourceFrontmatter: WikiFrontmatter = {
      id: "wiki-core09-transfer-source",
      slug: "core09-transfer-source",
      title: "Core09 transfer source",
      state: "active",
      content_locale: "en",
      tags: [],
      source_refs: [],
      provenance: { kind: "user_authored", summary: "Core09 transfer fixture", verified: true },
      usage_scope: { kind: "room", room_id: sourceRoomId },
      created_at: now,
      updated_at: now
    };
    const source = await store.saveWikiPage(sourceFrontmatter, "# Source\n\nTransfer fixture.");
    const sourceBoundary = await store.ensureResourceAccessBoundary({
      resourceKind: "wiki",
      resourceId: source.id,
      sourceRoomId,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:transfer:connection",
      payload: {
        connector_id: "connector-transfer",
        app_id: "app-transfer",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [sourceRoomId, targetRoom.id],
        ingress_classes: ["domain_operation"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const evidence = { connector_id: "connector-transfer", app_id: "app-transfer" };
    const target = {
      requested_room_id: sourceRoomId,
      correlation_id: "core09-transfer-copy",
      idempotency_key: "core09:transfer-copy:1"
    };

    const copied = await adapter.domainOperation({
      evidence,
      target,
      command_id: "resource.copy",
      payload: {
        resource_kind: "wiki",
        resource_id: source.id,
        expected_resource_version: source.resource_version,
        target_room_id: targetRoom.id,
        target_resource_id: "wiki-core09-transfer-copy",
        reason: "Create an independent target Room copy."
      }
    });
    const copiedResult = copied.result as { resource: { target: { id: string }; resource_version: number } };
    expect(copiedResult.resource).toMatchObject({
      target: { id: "wiki-core09-transfer-copy" },
      resource_version: 1
    });
    expect(await store.getWiki("wiki-core09-transfer-copy")).toMatchObject({
      usage_scope: { kind: "room", room_id: targetRoom.id },
      resource_version: 1
    });
    await expect(store.getResourceAccessMode({
      resourceKind: "wiki",
      resourceId: "wiki-core09-transfer-copy",
      roomId: targetRoom.id,
      participantId: localOwnerParticipantId
    })).resolves.toBe("source");

    const moved = await adapter.domainOperation({
      evidence,
      target: { ...target, correlation_id: "core09-transfer-move", idempotency_key: "core09:transfer-move:1" },
      command_id: "resource.move",
      payload: {
        resource_kind: "wiki",
        resource_id: source.id,
        expected_resource_version: source.resource_version,
        target_room_id: targetRoom.id,
        reason: "Move the original to the authorized target Room."
      }
    });
    expect((moved.result as { resource: { target: { id: string }; resource_version: number } }).resource).toMatchObject({
      target: { id: source.id },
      resource_version: 2
    });
    await expect(store.getWiki(source.id)).resolves.toMatchObject({
      usage_scope: { kind: "room", room_id: targetRoom.id },
      resource_version: 2
    });

    await store.shareResource({
      resourceAccessBoundaryId: sourceBoundary.id,
      sourceRoomId: targetRoom.id,
      targetRoomId: sourceRoomId,
      actorId: localOwnerParticipantId
    });
    await expect(adapter.domainOperation({
      evidence,
      target: { requested_room_id: targetRoom.id, correlation_id: "core09-transfer-share-history", idempotency_key: "core09:transfer-share-history:1" },
      command_id: "resource.move",
      payload: {
        resource_kind: "wiki",
        resource_id: source.id,
        expected_resource_version: 2,
        target_room_id: sourceRoomId,
        reason: "A shared Resource cannot be silently rehomed."
      }
    })).rejects.toThrow("wiki_scope_transfer_conflict:wiki-core09-transfer-source:boundary_has_shares");

    const redactFrontmatter: WikiFrontmatter = {
      ...sourceFrontmatter,
      id: "wiki-core09-redact-source",
      slug: "core09-redact-source",
      title: "Core09 redact source",
      usage_scope: { kind: "room", room_id: targetRoom.id },
      created_at: "2026-08-18T00:01:00.000Z",
      updated_at: "2026-08-18T00:01:00.000Z"
    };
    const redactSource = await store.saveWikiPage(redactFrontmatter, "# Secret fixture\n\napi_key=sk_test_secret_123456789012\n");
    await store.ensureResourceAccessBoundary({
      resourceKind: "wiki",
      resourceId: redactSource.id,
      sourceRoomId: targetRoom.id,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    const redacted = await adapter.domainOperation({
      evidence,
      target: { requested_room_id: targetRoom.id, correlation_id: "core09-resource-redact", idempotency_key: "core09:resource-redact:1" },
      command_id: "resource.redact",
      payload: {
        resource_kind: "wiki",
        resource_id: redactSource.id,
        expected_resource_version: redactSource.resource_version,
        reason: "Remove detected credentials before this Knowledge is reused."
      }
    });
    expect((redacted.result as { resource: { redacted_resource: { id: string }; resource_version: number; redaction_mode: string }; rollbackPoint?: unknown }).resource).toMatchObject({
      redacted_resource: { id: redactSource.id },
      resource_version: 2,
      redaction_mode: "known_secret_patterns"
    });
    expect((redacted.result as { rollbackPoint?: unknown }).rollbackPoint).toBeUndefined();
    await expect(store.readWikiContent(redactSource.id)).resolves.not.toContain("sk_test_secret_123456789012");
    await expect(adapter.domainOperation({
      evidence,
      target: { requested_room_id: targetRoom.id, correlation_id: "core09-resource-redact-secret-input", idempotency_key: "core09:resource-redact-secret-input:1" },
      command_id: "resource.redact",
      payload: {
        resource_kind: "wiki",
        resource_id: redactSource.id,
        expected_resource_version: 2,
        reason: "token=must-not-enter-operation-evidence"
      }
    })).rejects.toMatchObject({ code: "validation" });

    await expect(adapter.domainOperation({
      evidence,
      target: { requested_room_id: targetRoom.id, correlation_id: "core09-transfer-unbound", idempotency_key: "core09:transfer-unbound:1" },
      command_id: "resource.copy",
      payload: {
        resource_kind: "wiki",
        resource_id: source.id,
        expected_resource_version: 2,
        target_room_id: unboundRoom.id,
        target_resource_id: "wiki-core09-transfer-rejected",
        reason: "This target is not on the persisted connection allow-list."
      }
    })).rejects.toThrow("resource_transfer_target_room_not_bound");
    expect(await store.getWiki("wiki-core09-transfer-rejected")).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not create Room membership and rechecks delegated access on every request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-delegation-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const absentMember = "human:core09-absent";

    await expect(runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:connection:no-membership",
      payload: {
        connector_id: "connector-no-membership", app_id: "app-no-membership",
        delegated_principal: { kind: "human", participant_id: absentMember },
        allowed_room_ids: [roomId], ingress_classes: ["query"]
      }
    })).rejects.toThrow("external_app_connection_scope_room_access_denied:workspace_membership_missing");
    expect(await store.getWorkspaceMember(absentMember)).toBeUndefined();
    expect(await store.getRoomMember(roomId, absentMember)).toBeUndefined();
    expect(await store.listExternalAppConnections({ workspaceId: "workspace" })).toEqual([]);

    const memberId = "human:core09-delegated-member";
    await store.addWorkspaceMember({ participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId, participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:connection:delegated",
      payload: {
        connector_id: "connector-delegated", app_id: "app-delegated",
        delegated_principal: { kind: "human", participant_id: memberId },
        allowed_room_ids: [roomId], ingress_classes: ["query"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const input = {
      evidence: { connector_id: "connector-delegated", app_id: "app-delegated" },
      target: { requested_room_id: roomId, correlation_id: "core09-delegated-read" },
      query_id: "activity.history.list"
    } as const;
    await expect(adapter.query(input)).resolves.toMatchObject({ result: { items: [] } });

    await store.removeRoomMember({ roomId, participantId: memberId, actorId: localOwnerParticipantId });
    await expect(adapter.query(input)).rejects.toMatchObject({ code: "external_app_room_permission_denied" });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("uses current Agent permission and stops immediately after that Agent is removed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-agent-delegation-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const agentId = "agent-core09-delegated";
    const now = "2026-08-10T00:00:00.000Z";
    await store.createAgent({
      id: agentId, name: "Core09 delegated Agent", role: "Reader", instructions: "Core09 fixture.",
      backend_id: "samurai-native", enabled: true, created_at: now, updated_at: now
    });
    await store.setRoomAgentPermissions({
      roomId, agentId, canView: true, canEdit: true, canExecute: true, actorId: localOwnerParticipantId
    });
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:connection:agent-delegated",
      payload: {
        connector_id: "connector-agent-delegated", app_id: "app-agent-delegated",
        delegated_principal: { kind: "agent", agent_id: agentId, requested_by_participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId], ingress_classes: ["query"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const request = {
      evidence: { connector_id: "connector-agent-delegated", app_id: "app-agent-delegated" },
      target: { requested_room_id: roomId, correlation_id: "core09-agent-delegated" },
      query_id: "activity.history.list"
    } as const;

    await expect(adapter.query(request)).resolves.toMatchObject({ result: { items: [] } });
    await store.patchAgent({ id: agentId, enabled: false });
    await expect(adapter.query(request)).rejects.toMatchObject({ code: "external_app_delegated_principal_inactive" });
    await store.patchAgent({ id: agentId, enabled: true });
    await store.removeRoomAgent({ roomId, agentId, actorId: localOwnerParticipantId });
    await expect(adapter.query(request)).rejects.toMatchObject({ code: "external_app_room_permission_denied" });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("records Policy, Profile, and Soul requests as Activity without directly changing human-owned data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-human-change-request-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:human-change-request:connection",
      payload: {
        connector_id: "connector-human-change-request",
        app_id: "app-human-change-request",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId],
        ingress_classes: ["domain_operation"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const evidence = { connector_id: "connector-human-change-request", app_id: "app-human-change-request" };
    const settingsBefore = await store.getSettings();

    for (const requestKind of ["policy", "profile", "soul"] as const) {
      const result = await adapter.domainOperation({
        evidence,
        target: {
          requested_room_id: roomId,
          correlation_id: `core09-human-change-request:${requestKind}`,
          idempotency_key: `core09:human-change-request:${requestKind}`
        },
        command_id: `${requestKind}.change.request`,
        payload: {
          proposed_change_summary: `Request human review for ${requestKind}.`,
          affected_fields: ["display_name"]
        }
      });
      expect(result.result).toMatchObject({
        request_kind: requestKind,
        status: "requested",
        activity: {
          room_id: roomId,
          status: "completed"
        }
      });
    }

    await expect(adapter.domainOperation({
      evidence,
      target: {
        requested_room_id: roomId,
        correlation_id: "core09-human-change-request:secret",
        idempotency_key: "core09:human-change-request:secret"
      },
      command_id: "policy.change.request",
      payload: {
        proposed_change_summary: "token=must-not-be-recorded",
        affected_fields: ["retention_days"]
      }
    })).rejects.toThrow("human_change_request_secret_value_not_allowed");
    expect(await store.getSettings()).toEqual(settingsBefore);
    expect((await store.listActivities({ workspaceId: "workspace", roomId })).filter((activity) =>
      activity.instruction_summary.includes("Request human")
    )).toHaveLength(3);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("rejects external Activity authority injection and unsupported Resource kinds before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-activity-boundary-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:activity-boundary:connection",
      payload: {
        connector_id: "connector-activity-boundary", app_id: "app-activity-boundary",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId], ingress_classes: ["activity_ingest"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const base = {
      evidence: { connector_id: "connector-activity-boundary", app_id: "app-activity-boundary" },
      target: { requested_room_id: roomId, correlation_id: "core09-activity-boundary" },
      idempotency_key: "core09:activity-boundary:1", instruction_summary: "Boundary check.", status: "completed" as const,
      result_summary: "No write on rejected input."
    };
    const before = await store.listActivities({ workspaceId: "workspace", roomId });
    await expect(adapter.activityIngest({
      ...base,
      principal: { kind: "human", participant_id: localOwnerParticipantId }
    } as never)).rejects.toThrow();
    await expect(adapter.activityIngest({
      ...base,
      resource_usage: [{ resource_ref: { kind: "automation_job", id: "forged", uri: "automation-jobs/forged" }, stage: "read" }]
    })).rejects.toThrow("activity_external_resource_kind_not_allowed");
    expect(await store.listActivities({ workspaceId: "workspace", roomId })).toEqual(before);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });
});
