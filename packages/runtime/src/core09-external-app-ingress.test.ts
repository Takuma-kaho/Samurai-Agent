import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, ExternalAppContextError } from "./index.js";

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
