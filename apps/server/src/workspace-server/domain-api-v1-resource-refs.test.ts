import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { publicOperationResult, resolveRoomWorkResourceRefs, roomWorkInstructionForPublicInput } from "./domain-api-v1";

describe("Domain API v1 Room Work resource refs", () => {
  it("passes only the public selector to Completion and returns its canonical ref", async () => {
    const resolver = {
      getResourceRefForRoom: vi.fn(async () => ({
        kind: "knowledge" as const,
        id: "knowledge_1",
        uri: ".versions/knowledge_1/2.md",
        version: "2",
        label: "Server title"
      }))
    };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "knowledge", id: "knowledge_1", version: 2 }] }
    )).resolves.toEqual([{
      kind: "knowledge",
      id: "knowledge_1",
      uri: ".versions/knowledge_1/2.md",
      version: "2",
      label: "Server title"
    }]);

    expect(resolver.getResourceRefForRoom).toHaveBeenCalledWith(
      { workspaceId: "workspace_1", accountId: "account_1" },
      { targetRoomId: "room_1", resourceId: "knowledge_1", kind: "knowledge", version: 2 }
    );
    expect(JSON.stringify(resolver.getResourceRefForRoom.mock.calls[0])).not.toContain("uri");
  });

  it("rejects client-owned uri/label and unsupported resource kinds before lookup", async () => {
    const resolver = { getResourceRefForRoom: vi.fn() };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "knowledge", id: "knowledge_1", version: 2, uri: "client://wrong" }] }
    )).rejects.toMatchObject({ code: "domain_api_resource_refs_invalid", status: 400 });
    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "policy", id: "policy_1", version: 1 }] }
    )).rejects.toMatchObject({ code: "domain_api_resource_refs_invalid", status: 400 });
    expect(resolver.getResourceRefForRoom).not.toHaveBeenCalled();
  });

  it("propagates Completion authorization failures instead of falling back to the client ref", async () => {
    const resolver = {
      getResourceRefForRoom: vi.fn(async () => {
        throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
      })
    };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "skill", id: "skill_1", version: "4" }] }
    )).rejects.toMatchObject({ code: "workspace_completion_resource_not_found", status: 404 });
  });

  it("gives a resource-only Work an explicit instruction body", () => {
    expect(roomWorkInstructionForPublicInput({}, [{
      kind: "knowledge",
      id: "knowledge_1",
      uri: ".versions/knowledge_1/2.md",
      version: "2"
    }])).toBe("Review the referenced resources.");
    expect(roomWorkInstructionForPublicInput({}, [])).toBeUndefined();
    expect(roomWorkInstructionForPublicInput({ instruction: "  Follow up.  " }, [])).toBe("Follow up.");
  });

  it("projects completed artifact and Generated Surface refs through the public Work view", () => {
    const refs = [
      { kind: "artifact", id: "artifact_work_view", uri: "artifacts/artifact_work_view/revisions/1.md", label: "Work artifact" },
      { kind: "artifact_revision", id: "artifact_revision_work_view", parent_id: "artifact_work_view", uri: "artifacts/artifact_work_view/revisions/1.md", version: "2026-09-09T00:00:00.000Z", label: "Work artifact r1" },
      { kind: "generated_surface", id: "surface_work_view", uri: "surfaces/surface_work_view", label: "Work surface" },
      { kind: "generated_surface_revision", id: "surface_revision_work_view", parent_id: "surface_work_view", uri: "surfaces/surface_work_view/revisions/1.html", label: "Work surface r1" }
    ];
    const projected = publicOperationResult("room.work.view", {
      work: {
        workspaceId: "workspace_1",
        id: "work_view",
        roomId: "room_1",
        requesterAccountId: "account_1",
        defaultAgentId: "agent_1",
        defaultAgentVersion: 1,
        title: "Publish the result",
        objective: "Publish the result",
        status: "completed",
        stopState: "none",
        instructionVersion: 1,
        controlGeneration: 0,
        operationId: "operation_work_view",
        version: 1,
        resourceRefs: [],
        assignees: [{
          id: "assignee_work_view",
          workId: "work_view",
          agentId: "agent_1",
          agentVersion: 1,
          instructionVersion: 1,
          generation: 0,
          attempt: 1,
          priority: 0,
          status: "completed",
          version: 1,
          result: {
            run_id: "run_work_view",
            status: "completed",
            output_summary: "Published",
            resource_refs: refs,
            provider_private: "must not cross the public boundary"
          },
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z"
        }],
        executionReservations: [],
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z"
      },
      instructions: [],
      comments: [],
      reactions: [],
      controls: []
    }) as Record<string, any>;

    expect(projected.assignees[0].result).toEqual({ summary: "Published", resource_refs: refs });
    expect(projected.assignees[0].result).not.toHaveProperty("run_id");
    expect(projected.assignees[0].result).not.toHaveProperty("provider_private");
  });

  it("keeps a legacy Assignment result as summary-only and rejects an unsafe output ref", () => {
    const base = {
      work: {
        workspaceId: "workspace_1",
        id: "work_legacy",
        roomId: "room_1",
        requesterAccountId: "account_1",
        defaultAgentId: "agent_1",
        defaultAgentVersion: 1,
        title: "Legacy result",
        objective: "Legacy result",
        status: "completed",
        stopState: "none",
        instructionVersion: 1,
        controlGeneration: 0,
        operationId: "operation_legacy",
        version: 1,
        resourceRefs: [],
        assignees: [{
          id: "assignee_legacy",
          workId: "work_legacy",
          agentId: "agent_1",
          agentVersion: 1,
          instructionVersion: 1,
          generation: 0,
          attempt: 1,
          priority: 0,
          status: "completed",
          version: 1,
          result: { output_summary: "Old result", status: "completed" },
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z"
        }],
        executionReservations: [],
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z"
      },
      instructions: [],
      comments: [],
      reactions: [],
      controls: []
    };
    const legacy = publicOperationResult("room.work.view", base) as Record<string, any>;
    expect(legacy.assignees[0].result).toEqual({ summary: "Old result" });
    expect(() => publicOperationResult("room.work.view", {
      ...base,
      work: {
        ...base.work,
        assignees: [{ ...base.work.assignees[0], result: { resource_refs: [{ kind: "knowledge", id: "secret", uri: "knowledge/secret", version: "1" }] } }]
      }
    })).toThrowError("room_work_resource_reference_invalid");
    expect(() => publicOperationResult("room.work.view", {
      ...base,
      work: {
        ...base.work,
        assignees: [{ ...base.work.assignees[0], result: { resource_refs: [{ kind: "artifact_revision", id: "artifact_revision_orphan", uri: "artifacts/artifact_orphan/revisions/1.md" }] } }]
      }
    })).toThrowError("room_work_resource_reference_invalid");
  });
});
